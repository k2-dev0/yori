import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { flushCollector } from '../collect.js';
import {
  ackResponse,
  buildCollectorConfig,
  codexMessageLine,
  codexSessionLine,
  createCollectorFixture,
  installFetchMock,
  lineByteOffset,
  parseSentBatches,
  runCollectorCli,
  writeTranscript,
} from './support.js';

describe('collector CLI', () => {
  it('未登録sourceを保留し、登録後に別プロセスのflushが送信する', async () => {
    const fixture = await createCollectorFixture({ binding: null });
    const projectId = randomUUID();
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const secret = 'CLI-RAW-LOG-SECRET';
      const lines = [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'CLI経由の本文' }),
        `{"timestamp":"2026-09-21T00:00:02.000Z","type":"event_msg","payload":${secret}`,
      ];
      await writeTranscript(transcript, lines);
      const configPath = path.join(fixture.root, 'collector.json');
      await writeFile(configPath, JSON.stringify(fixture.config), 'utf8');
      const hook = {
        session_id: 'session-1',
        transcript_path: transcript,
        cwd: fixture.repoDir,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'hookのpromptは使わない',
        turn_id: 'turn-1',
      };

      const first = await runCollectorCli(['collect', '--source', 'codex', '--config', configPath], {
        stdin: JSON.stringify(hook),
        env: { YORI_TEST_TOKEN: 'token-a' },
      });
      assert.equal(first.code, 0, `CLIが失敗した: ${first.stderr}`);
      assert.equal(mock.requests.length, 0, '未登録のまま送信している');

      const registered = buildCollectorConfig({
        state_dir: fixture.stateDir,
        projects: [{ repository: 'github.com/Org/Repo', project_id: projectId }],
      });
      await flushCollector({ config: registered, token: 'token-a' });
      assert.equal(mock.requests.length, 1);
      const [batch] = parseSentBatches(mock.requests);
      assert.equal(batch.project_id, projectId);
      assert.deepEqual(
        batch.events.map((event) => [event.source, event.text]),
        [['codex', 'CLI経由の本文']],
      );

      // CLIプロセスの終了をまたいでもcursorが残り、再実行で再送しない。
      const second = await runCollectorCli(['collect', '--source', 'codex', '--config', configPath], {
        stdin: JSON.stringify(hook),
        env: { YORI_TEST_TOKEN: 'token-a' },
      });
      assert.equal(second.code, 0, `2回目のCLIが失敗した: ${second.stderr}`);
      await flushCollector({ config: registered, token: 'token-a' });
      assert.equal(mock.requests.length, 1, '再実行で同じ発言を再送している');
      assert.ok(!mock.requests[0].body.includes(secret), '診断対象の生ログを送信している');

      // CLI診断はlistCollectorDiagnosticsの本番consumer。code/offsetを出し、本文は出さない。
      await writeFile(configPath, JSON.stringify(registered), 'utf8');
      const diagnostics = await runCollectorCli(['diagnostics', '--config', configPath], { env: { YORI_TEST_TOKEN: 'token-a' } });
      assert.equal(diagnostics.code, 0, `diagnosticsが失敗した: ${diagnostics.stderr}`);
      assert.ok(diagnostics.stdout.trim().length > 0, '診断結果が出力されていない');
      assert.ok(diagnostics.stdout.includes(String(lineByteOffset(lines, 2))), `診断のoffsetがない: ${diagnostics.stdout}`);
      assert.ok(!diagnostics.stdout.includes(secret), '診断へ生ログを出力している');
      const parsedDiagnostics = JSON.parse(diagnostics.stdout) as unknown;
      assert.ok(Array.isArray(parsedDiagnostics) && parsedDiagnostics.length > 0, '診断がJSON配列ではない');
      assert.equal(typeof (parsedDiagnostics[0] as { code?: unknown }).code, 'string');
      const firstOffset = (parsedDiagnostics[0] as { byteOffset?: unknown }).byteOffset;
      assert.ok(firstOffset === null || typeof firstOffset === 'number', 'byteOffsetの型が不正');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('同じstate_dirへの併走collectでも両sessionを保持し、重複しない', async () => {
    const fixture = await createCollectorFixture({ binding: null });
    const projectId = randomUUID();
    const mock = installFetchMock(ackResponse);
    try {
      const transcriptA = path.join(fixture.root, 'a.jsonl');
      const transcriptB = path.join(fixture.root, 'b.jsonl');
      await writeTranscript(transcriptA, [
        codexSessionLine('session-a'),
        codexMessageLine({ sessionId: 'session-a', messageId: 'a-1', role: 'user', text: 'Aの本文' }),
      ]);
      await writeTranscript(transcriptB, [
        codexSessionLine('session-b'),
        codexMessageLine({ sessionId: 'session-b', messageId: 'b-1', role: 'user', text: 'Bの本文' }),
      ]);
      const configPath = path.join(fixture.root, 'collector.json');
      await writeFile(configPath, JSON.stringify(fixture.config), 'utf8');
      const hookFor = (sessionId: string, transcriptPath: string) => ({
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: fixture.repoDir,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'hookのprompt',
      });

      const [resultA, resultB] = await Promise.all([
        runCollectorCli(['collect', '--source', 'codex', '--config', configPath], {
          stdin: JSON.stringify(hookFor('session-a', transcriptA)),
          env: { YORI_TEST_TOKEN: 'token-a' },
        }),
        runCollectorCli(['collect', '--source', 'codex', '--config', configPath], {
          stdin: JSON.stringify(hookFor('session-b', transcriptB)),
          env: { YORI_TEST_TOKEN: 'token-a' },
        }),
      ]);
      assert.equal(resultA.code, 0, `並行CLI Aが失敗した: ${resultA.stderr}`);
      assert.equal(resultB.code, 0, `並行CLI Bが失敗した: ${resultB.stderr}`);
      assert.equal(mock.requests.length, 0);

      const registered = buildCollectorConfig({
        state_dir: fixture.stateDir,
        projects: [{ repository: 'github.com/Org/Repo', project_id: projectId }],
      });
      await flushCollector({ config: registered, token: 'token-a' });
      const events = mock.requests.flatMap((request) => parseSentBatches([request]).flatMap((batch) => batch.events));
      assert.equal(events.length, 2);
      assert.deepEqual(
        events.map((event) => [event.source_session_id, event.source_message_id, event.sequence_no]).sort(),
        [
          ['session-a', 'a-1', 1],
          ['session-b', 'b-1', 1],
        ],
      );
      assert.ok(events.every((event) => event.source_scope === 'github.com/Org/Repo'));
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('保留がないflushは成功し、未対応のsource指定は非0で終了する', async () => {
    const fixture = await createCollectorFixture({ binding: null });
    try {
      const configPath = path.join(fixture.root, 'collector.json');
      await writeFile(configPath, JSON.stringify(fixture.config), 'utf8');

      const emptyFlush = await runCollectorCli(['flush', '--config', configPath], { env: { YORI_TEST_TOKEN: 'token-a' } });
      assert.equal(emptyFlush.code, 0, `保留がないflushが失敗した: ${emptyFlush.stderr}`);

      const invalidSource = await runCollectorCli(['collect', '--source', 'other_agent', '--config', configPath], {
        stdin: JSON.stringify({ session_id: 'session-1', transcript_path: path.join(fixture.root, 'x.jsonl'), cwd: fixture.repoDir }),
        env: { YORI_TEST_TOKEN: 'token-a' },
      });
      assert.notEqual(invalidSource.code, 0);
    } finally {
      await fixture.cleanup();
    }
  });
});
