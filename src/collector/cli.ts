import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { EventSource } from '../api/contract.js';
import {
  BACKFILL_SOURCES,
  BackfillArgumentError,
  BackfillExecutionError,
  backfillCollector,
  type BackfillSource,
} from './backfill.js';
import { collectFromHook, flushCollector } from './collect.js';
import { notifyFromHook, notifyLateFromHook } from './notify.js';
import { parseCursorHookInput } from './adapters/cursor.js';
import { loadCollectorConfig, type CollectorConfig } from './config.js';
import { parseKnownSecretsEnv } from './known-secrets.js';
import { closeCollectorState, collectorNamespace, listCollectorDiagnostics, openCollectorState } from './state.js';

const transcriptHookSchema = z.object({
  session_id: z.string().min(1),
  transcript_path: z.string().min(1),
  cwd: z.string().min(1),
  hook_event_name: z.string().min(1).optional(),
  turn_id: z.string().min(1).optional(),
  prompt: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().nullable().optional(),
});

// CLIの終了コードは固定。raw error・本文・URL資格情報はstdout/stderrへ出さない。
function fail(code: string): never {
  process.stderr.write(`collector: ${code}\n`);
  process.exit(1);
}

const HOOK_SOURCES = ['codex', 'claude_code', 'cursor', 'deepseek_harness'] as const;

function parseCommandLine(argv: string[]): {
  command: string;
  source?: string;
  configPath: string;
  repository?: string;
  dryRun: boolean;
} {
  const [command, ...rest] = argv;
  if (
    command === undefined ||
    (command !== 'collect' &&
      command !== 'notify' &&
      command !== 'notify-late' &&
      command !== 'flush' &&
      command !== 'diagnostics' &&
      command !== 'backfill')
  ) {
    fail('unknown_command');
  }
  let source: string | undefined;
  let configPath: string | undefined;
  let repository: string | undefined;
  let dryRun = false;
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (key === '--dry-run') {
      if (command !== 'backfill' || dryRun) {
        fail('invalid_arguments');
      }
      dryRun = true;
      continue;
    }
    const value = rest[index + 1];
    if (key === undefined || value === undefined || value.startsWith('--')) {
      fail('invalid_arguments');
    }
    if (key === '--source') {
      source = value;
    } else if (key === '--config') {
      configPath = value;
    } else if (key === '--repository') {
      repository = value;
    } else {
      fail('invalid_arguments');
    }
    index += 1;
  }
  if (configPath === undefined) {
    fail('invalid_arguments');
  }
  if (
    (command === 'collect' || command === 'notify' || command === 'notify-late') &&
    (source === undefined || !HOOK_SOURCES.includes(source as (typeof HOOK_SOURCES)[number]))
  ) {
    fail('invalid_source');
  }
  if ((command === 'notify' || command === 'notify-late') && source === 'cursor') {
    fail('invalid_source');
  }
  if (command === 'backfill') {
    if (repository === undefined || !path.isAbsolute(repository)) {
      fail('invalid_arguments');
    }
    if (source !== undefined && !BACKFILL_SOURCES.includes(source as BackfillSource)) {
      fail('invalid_source');
    }
  } else if (repository !== undefined || dryRun) {
    fail('invalid_arguments');
  }
  return { command, source, configPath, repository, dryRun };
}

function readToken(config: CollectorConfig): string {
  const token = process.env[config.token_env];
  if (token === undefined || token.length === 0) {
    fail('missing_token');
  }
  return token;
}

async function main(): Promise<void> {
  const { command, source, configPath, repository, dryRun } = parseCommandLine(process.argv.slice(2));
  let config: CollectorConfig;
  try {
    config = loadCollectorConfig(configPath);
  } catch {
    fail('invalid_config');
  }
  // dry-runはHTTP/SQLiteを使わないためtokenを要求しない。本実行と既存commandは従来どおり必須。
  const token = command === 'backfill' && dryRun ? '' : readToken(config);

  if (command === 'collect' || command === 'notify' || command === 'notify-late' || command === 'flush' || command === 'backfill') {
    // known secretは本文を読む前にlocal envから検証し、不正時はfixed codeでfail-closedにする。
    // parseに成功するとenvから削除され、SQLite・outbox・log・送信bodyへ生値を残さない。
    let knownSecrets: string[];
    try {
      knownSecrets = parseKnownSecretsEnv(process.env);
    } catch {
      fail('invalid_known_secrets');
    }
    if (command === 'flush') {
      await flushCollector({ config, token, knownSecrets });
      return;
    }
    if (command === 'backfill') {
      let summary;
      try {
        summary = await backfillCollector({
          repository: repository as string,
          config,
          token,
          knownSecrets,
          dryRun,
          ...(source === undefined ? {} : { source: source as BackfillSource }),
        });
      } catch (error) {
        if (error instanceof BackfillArgumentError) {
          fail('invalid_arguments');
        }
        if (error instanceof BackfillExecutionError) {
          fail(error.code);
        }
        throw error;
      }
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      return;
    }
    let hookInput: unknown;
    try {
      hookInput = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
      fail('invalid_hook_input');
    }
    if (command === 'collect') {
      if (source === 'cursor') {
        const hook = parseCursorHookInput(hookInput);
        if (hook === null) {
          fail('invalid_hook_input');
        }
        await collectFromHook({ source, hook, config, token, knownSecrets });
        return;
      }
      const hook = transcriptHookSchema.safeParse(hookInput);
      if (!hook.success) {
        fail('invalid_hook_input');
      }
      await collectFromHook({ source: source as EventSource, hook: hook.data, config, token, knownSecrets });
    } else if (command === 'notify') {
      const hook = transcriptHookSchema.safeParse(hookInput);
      if (!hook.success) {
        fail('invalid_hook_input');
      }
      await notifyFromHook({ source: source as EventSource, hook: hook.data, config, token, knownSecrets });
    } else {
      const hook = transcriptHookSchema.safeParse(hookInput);
      if (!hook.success) {
        fail('invalid_hook_input');
      }
      await notifyLateFromHook({ source: source as EventSource, hook: hook.data, config, token, knownSecrets });
    }
    return;
  }

  // 診断は固定code/byteOffsetだけのJSON配列。本文や通知コンテキストは出さない。
  const state = openCollectorState(config.state_dir);
  try {
    const diagnostics = listCollectorDiagnostics(state, collectorNamespace(config.api_url, token));
    process.stdout.write(`${JSON.stringify(diagnostics)}\n`);
  } finally {
    closeCollectorState(state);
  }
}

main().catch(() => {
  process.stderr.write('collector: internal_error\n');
  process.exitCode = 1;
});
