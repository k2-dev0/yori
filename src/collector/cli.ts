import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { EVENT_SOURCES, type EventSource } from '../api/contract.js';
import { collectFromHook, flushCollector } from './collect.js';
import { notifyFromHook } from './notify.js';
import { loadCollectorConfig, type CollectorConfig } from './config.js';
import { closeCollectorState, collectorNamespace, listCollectorDiagnostics, openCollectorState } from './state.js';

const hookSchema = z.object({
  session_id: z.string().min(1),
  transcript_path: z.string().min(1),
  cwd: z.string().min(1),
});

// CLIの終了コードは固定。raw error・本文・URL資格情報はstdout/stderrへ出さない。
function fail(code: string): never {
  process.stderr.write(`collector: ${code}\n`);
  process.exit(1);
}

function parseCommandLine(argv: string[]): { command: string; source?: string; configPath: string } {
  const [command, ...rest] = argv;
  if (command === undefined || (command !== 'collect' && command !== 'notify' && command !== 'flush' && command !== 'diagnostics')) {
    fail('unknown_command');
  }
  let source: string | undefined;
  let configPath: string | undefined;
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (key === undefined || value === undefined) {
      fail('invalid_arguments');
    }
    if (key === '--source') {
      source = value;
    } else if (key === '--config') {
      configPath = value;
    } else {
      fail('invalid_arguments');
    }
  }
  if (configPath === undefined) {
    fail('invalid_arguments');
  }
  if ((command === 'collect' || command === 'notify') && (source === undefined || !EVENT_SOURCES.includes(source as EventSource))) {
    fail('invalid_source');
  }
  return { command, source, configPath };
}

function readToken(config: CollectorConfig): string {
  const token = process.env[config.token_env];
  if (token === undefined || token.length === 0) {
    fail('missing_token');
  }
  return token;
}

async function main(): Promise<void> {
  const { command, source, configPath } = parseCommandLine(process.argv.slice(2));
  let config: CollectorConfig;
  try {
    config = loadCollectorConfig(configPath);
  } catch {
    fail('invalid_config');
  }
  const token = readToken(config);

  if (command === 'collect' || command === 'notify') {
    let hookInput: unknown;
    try {
      hookInput = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
      fail('invalid_hook_input');
    }
    const hook = hookSchema.safeParse(hookInput);
    if (!hook.success) {
      fail('invalid_hook_input');
    }
    if (command === 'collect') {
      await collectFromHook({ source: source as EventSource, hook: hook.data, config, token });
    } else {
      await notifyFromHook({ source: source as EventSource, hook: hook.data, config, token });
    }
    return;
  }
  if (command === 'flush') {
    await flushCollector({ config, token });
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
