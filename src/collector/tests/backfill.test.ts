import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { BackfillExecutionError, backfillCollector } from '../backfill.js';
import {
  ackResponse,
  buildCollectorConfig,
  createCollectorFixture,
  installFetchMock,
  jsonResponse,
  parseSentBatches,
  runCollectorCli,
  writeTranscript,
  type CapturedRequest,
} from './support.js';

const API_URL = 'https://api.example.test';
const REPOSITORY = 'github.com/Org/Repo';

function codexSession(sessionId: string, cwd: string, source: unknown = 'cli'): string {
  return JSON.stringify({
    timestamp: '2026-09-21T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: sessionId, cwd, source, cli_version: '0.156.1' },
  });
}

function codexMessage(sessionId: string, messageId: string, role: 'user' | 'assistant', text: string): string {
  return JSON.stringify({
    timestamp: '2026-09-21T00:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: sessionId,
      item:
        role === 'user'
          ? { id: messageId, type: 'UserMessage', content: [{ type: 'text', text }] }
          : { id: messageId, type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text }] },
    },
  });
}

function claudeMessage(sessionId: string, cwd: string, uuid: string, role: 'user' | 'assistant', text: string): string {
  return JSON.stringify({
    type: role,
    uuid,
    sessionId,
    cwd,
    timestamp: '2026-09-21T00:00:01.000Z',
    version: '2.1.220',
    message: { role, content: text },
  });
}

function deepSeekLines(sessionId: string, cwd: string, userText: string, assistantText: string): string[] {
  return [
    JSON.stringify({ type: 'session', id: sessionId, cwd, version: 4, delegationDepth: 0, isSeeded: false, createdAt: 1_789_000_000_000 }),
    JSON.stringify({
      type: 'user/message',
      seq: 2,
      time: 1_789_000_000_001,
      data: { id: `${sessionId}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] },
    }),
    JSON.stringify({
      type: 'assistant/message',
      seq: 3,
      time: 1_789_000_000_002,
      data: {
        turn: 1,
        message: {
          id: `${sessionId}-assistant`,
          role: 'assistant',
          source: { kind: 'model' },
          content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: assistantText }],
        },
      },
    }),
    JSON.stringify({ type: 'turn/end', seq: 4, time: 1_789_000_000_003, data: { turn: 1, reason: { kind: 'completed' } } }),
  ];
}

async function installHistory(home: string, repository: string): Promise<{ secret: string; sessionId: string }> {
  const secret = 'BACKFILL-PRIVATE-CONTENT';
  const codexSessions = path.join(home, '.codex', 'sessions', '2026', '09');
  const codexArchive = path.join(home, '.codex', 'archived_sessions');
  await mkdir(codexSessions, { recursive: true });
  await mkdir(codexArchive, { recursive: true });
  await writeTranscript(path.join(codexSessions, 'root.jsonl'), [
    codexSession('codex-root', repository),
    codexMessage('codex-root', 'codex-user', 'user', secret),
    codexMessage('codex-root', 'codex-assistant', 'assistant', 'codex final'),
  ]);
  await writeTranscript(path.join(codexArchive, 'archive.jsonl'), [codexSession('codex-archive', repository), codexMessage('codex-archive', 'archive-user', 'user', 'archive')]);
  await writeTranscript(path.join(codexSessions, 'subagent.jsonl'), [codexSession('codex-subagent', repository, { subagent: 'worker' })]);
  await writeTranscript(path.join(codexSessions, 'other.jsonl'), [codexSession('codex-other', '/other'), codexMessage('codex-other', 'other-user', 'user', secret)]);

  const claudeProject = path.join(home, '.claude', 'projects', 'fixture-project');
  await mkdir(path.join(claudeProject, 'subagents'), { recursive: true });
  await writeTranscript(path.join(claudeProject, 'root.jsonl'), [
    claudeMessage('claude-root', repository, 'claude-user', 'user', 'claude user'),
    claudeMessage('claude-root', repository, 'claude-assistant', 'assistant', 'claude final'),
  ]);
  await writeTranscript(path.join(claudeProject, 'subagents', 'ignored.jsonl'), [claudeMessage('claude-child', repository, 'child-user', 'user', secret)]);

  const sessionId = 'deepseek-root';
  // デスクトップ版は追記のたびにフレームを足す。session行と残りを別フレームにし、連結フレームを読めることを確かめる。
  const sessionsRoot = path.join(home, 'Library', 'Application Support', 'dsh-desktop', 'harness', 'sessions');
  const deepSeekDir = path.join(sessionsRoot, 'fixture-repository', sessionId);
  await mkdir(deepSeekDir, { recursive: true });
  const [sessionLine, ...rest] = deepSeekLines(sessionId, repository, 'DeepSecret AcmeSecret', 'deepseek final');
  const frames = [zstdCompressSync(`${sessionLine}\n`), zstdCompressSync(`${rest.join('\n')}\n`)];
  await writeFile(path.join(deepSeekDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
  // 別リポジトリの会話は同じ置き場所にあっても対象にしない。
  const otherDir = path.join(sessionsRoot, 'other-repository', 'deepseek-other');
  await mkdir(otherDir, { recursive: true });
  await writeFile(path.join(otherDir, 'session.v4.jsonl.zstd'), zstdCompressSync(`${deepSeekLines('deepseek-other', '/other', secret, 'other')[0]}\n`));
  // bridge版の無圧縮fileは読まない。
  const bridgeDir = path.join(home, 'Library', 'Application Support', 'deepseek-bridge', 'dsh-home', 'hash', 'sessions', 'fixture');
  await mkdir(bridgeDir, { recursive: true });
  await writeTranscript(path.join(bridgeDir, 'session.v3.jsonl'), deepSeekLines('deepseek-bridge', repository, secret, 'bridge'));
  return { secret, sessionId };
}

function setupResponse(projectId: string): Response {
  return jsonResponse(200, {
    project_id: projectId,
    repository: REPOSITORY,
    redaction_policy: { version: 1, fields: [], terms: ['AcmeSecret'], suspicion_mode: 'observe', detector_version: 'initial-v1' },
  });
}

function isSetup(request: CapturedRequest): boolean {
  return request.url === `${API_URL}/v1/collector/setup`;
}

describe('collector backfill', { concurrency: false }, () => {
  it('dry-runは3sourceを探索し、本文・path・IDを出さずHTTP/SQLiteを変更しない', async () => {
    const fixture = await createCollectorFixture();
    const home = path.join(fixture.root, 'home');
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const mock = installFetchMock(ackResponse);
    try {
      const { secret, sessionId } = await installHistory(home, realpathSync(fixture.repoDir));
      process.env.HOME = home;
      const summary = await backfillCollector({
        repository: fixture.repoDir,
        config: buildCollectorConfig({ state_dir: fixture.stateDir }),
        token: 'token-a',
        knownSecrets: [],
        dryRun: true,
      });

      assert.deepEqual(summary, {
        status: 'dry_run',
        sources: {
          codex: { sessions: 2, candidates: 3, excluded: 1, versions: ['0.156.1'] },
          claude_code: { sessions: 1, candidates: 2, excluded: 0, versions: ['2.1.220'] },
          deepseek_harness: { sessions: 1, candidates: 2, excluded: 0, versions: ['4'] },
        },
        totals: { sessions: 4, candidates: 7, excluded: 1 },
      });
      assert.equal(mock.requests.length, 0, 'dry-runでHTTP送信している');
      assert.equal(existsSync(fixture.stateDir), false, 'dry-runでSQLite stateを作っている');
      const serialized = JSON.stringify(summary);
      for (const forbidden of [secret, sessionId, fixture.repoDir]) {
        assert.ok(!serialized.includes(forbidden), `dry-run出力へ秘匿値が出ている: ${forbidden}`);
      }
    } finally {
      process.env.HOME = previousHome;
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('DeepSeek本実行は通常pipelineでpolicy/known secretを伏せ、再実行してもrevision・sequence・送信を増やさない', async () => {
    const fixture = await createCollectorFixture();
    const home = path.join(fixture.root, 'home');
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const projectId = randomUUID();
    const mock = installFetchMock((request) => (isSetup(request) ? setupResponse(projectId) : ackResponse(request)));
    try {
      await installHistory(home, realpathSync(fixture.repoDir));
      const input = {
        repository: fixture.repoDir,
        config: buildCollectorConfig({ state_dir: fixture.stateDir }),
        token: 'token-a',
        knownSecrets: ['DeepSecret'],
        dryRun: false as const,
        source: 'deepseek_harness' as const,
      };
      process.env.HOME = home;
      const first = await backfillCollector(input);
      process.env.HOME = home;
      const second = await backfillCollector(input);

      assert.equal(first.status, 'completed');
      assert.deepEqual(second.sources.deepseek_harness, first.sources.deepseek_harness);
      const batches = parseSentBatches(mock.requests.filter((request) => request.url === `${API_URL}/v1/events`));
      const events = batches.flatMap((batch) => batch.events);
      assert.equal(events.length, 2, '再実行でeventを増殖させている');
      assert.deepEqual(
        events.map((event) => [event.source, event.role, event.text, event.sequence_no, event.revision]),
        [
          ['deepseek_harness', 'user', '[REDACTED:known_secret] [REDACTED:business_term]', 1, 1],
          ['deepseek_harness', 'assistant', 'deepseek final', 2, 1],
        ],
      );
    } finally {
      process.env.HOME = previousHome;
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('project未登録・policy解決不能の本実行は本文を処理せずcollector_setup_unavailableで失敗し、送信しない', async () => {
    const fixture = await createCollectorFixture();
    const home = path.join(fixture.root, 'home');
    const previousHome = process.env.HOME;
    const mock = installFetchMock((request) =>
      isSetup(request) ? jsonResponse(404, { error: { code: 'not_found' } }) : ackResponse(request),
    );
    try {
      await installHistory(home, realpathSync(fixture.repoDir));
      process.env.HOME = home;
      await assert.rejects(
        backfillCollector({
          repository: fixture.repoDir,
          config: buildCollectorConfig({ state_dir: fixture.stateDir }),
          token: 'token-a',
          knownSecrets: [],
          dryRun: false,
          source: 'codex',
        }),
        (error: unknown) => error instanceof BackfillExecutionError && error.code === 'collector_setup_unavailable',
      );
      assert.equal(mock.requests.filter(isSetup).length, 1);
      assert.equal(mock.requests.filter((request) => request.url === `${API_URL}/v1/events`).length, 0);
      assert.equal(existsSync(fixture.stateDir), false, 'setup失敗前にSQLite stateを作っている');
    } finally {
      process.env.HOME = previousHome;
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('CLIはsource省略/個別sourceを受理し、cursorと不正引数を固定codeで拒否する', async () => {
    const fixture = await createCollectorFixture();
    const home = path.join(fixture.root, 'home');
    try {
      await installHistory(home, realpathSync(fixture.repoDir));
      const configPath = path.join(fixture.root, 'collector.json');
      await writeFile(configPath, JSON.stringify(buildCollectorConfig({ state_dir: fixture.stateDir })), 'utf8');
      for (const source of [undefined, 'codex', 'claude_code', 'deepseek_harness'] as const) {
        const args = ['backfill', '--repository', fixture.repoDir, '--config', configPath, '--dry-run'];
        if (source !== undefined) {
          args.push('--source', source);
        }
        const result = await runCollectorCli(args, { env: source === undefined ? { HOME: home, YORI_TEST_TOKEN: '' } : { HOME: home, YORI_TEST_TOKEN: 'token-a' } });
        assert.equal(result.code, 0, `${source ?? 'all'}: ${result.stderr}`);
        const output = JSON.parse(result.stdout) as { sources: Record<string, unknown> };
        assert.deepEqual(Object.keys(output.sources), source === undefined ? ['codex', 'claude_code', 'deepseek_harness'] : [source]);
      }
      const cursor = await runCollectorCli(
        ['backfill', '--repository', fixture.repoDir, '--config', configPath, '--dry-run', '--source', 'cursor'],
        { env: { HOME: home, YORI_TEST_TOKEN: 'token-a' } },
      );
      assert.notEqual(cursor.code, 0);
      assert.equal(cursor.stderr, 'collector: invalid_source\n');
      const invalid = await runCollectorCli(['backfill', '--repository', fixture.repoDir, '--config', configPath, '--dry-run', 'extra'], {
        env: { HOME: home, YORI_TEST_TOKEN: 'token-a' },
      });
      assert.notEqual(invalid.code, 0);
      assert.equal(invalid.stderr, 'collector: invalid_arguments\n');
    } finally {
      await fixture.cleanup();
    }
  });
});
