import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MAX_BATCH_SIZE, MAX_EVENT_BODY_BYTES } from '../../api/contract.js';
import { collectFromHook, flushCollector } from '../collect.js';
import { closeCollectorState, listCollectorDiagnostics, openCollectorState } from '../state.js';
import {
  ackResponse,
  appendTranscript,
  assertStateDoesNotContain,
  buildHook,
  claudeMessageLine,
  codexMessageLine,
  codexSessionLine,
  createCollectorFixture,
  installFetchMock,
  lineByteOffset,
  parseSentBatches,
  sentEvents,
  writeTranscript,
} from './support.js';

describe('transcript差分と診断', () => {
  it('未完の末尾行は次回に回し、完成後に一度だけ取り込む', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const sessionLine = codexSessionLine('session-1');
      const firstLine = codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '1件目' });
      const secondLine = codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'assistant', text: '2件目' });
      await writeTranscript(transcript, [sessionLine, firstLine], { trailingNewline: false });
      await appendTranscript(transcript, `\n${secondLine.slice(0, 25)}`);

      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };
      await collectFromHook(options);
      assert.deepEqual(
        sentEvents(mock.requests).map((event) => event.source_message_id),
        ['item-1'],
        '未完行を取り込んでいる',
      );
      assert.equal(mock.requests.length, 1);

      await appendTranscript(transcript, `${secondLine.slice(25)}\n`);
      await collectFromHook(options);
      assert.deepEqual(
        sentEvents(mock.requests.slice(1)).map((event) => event.source_message_id),
        ['item-2'],
      );
      assert.equal(mock.requests.length, 2);
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('同一inodeの同サイズ書換えを検知し、本文変更をrevisionとして送る', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const sessionLine = codexSessionLine('session-1');
      const before = [sessionLine, codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'AAAA' })];
      const after = [sessionLine, codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'BBBB' })];
      assert.equal(Buffer.byteLength(before.join('\n'), 'utf8'), Buffer.byteLength(after.join('\n'), 'utf8'), 'fixtureは同サイズであること');

      await writeTranscript(transcript, before);
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };
      await collectFromHook(options);
      assert.deepEqual(
        sentEvents(mock.requests).map((event) => [event.text, event.revision]),
        [['AAAA', 1]],
      );

      await writeTranscript(transcript, after);
      await collectFromHook(options);
      const events = sentEvents(mock.requests);
      assert.equal(events.length, 2, '同一inodeの書換えを検知していない');
      assert.deepEqual(
        events.map((event) => [event.source_message_id, event.text, event.revision, event.sequence_no]),
        [
          ['item-1', 'AAAA', 1, 1],
          ['item-1', 'BBBB', 2, 1],
        ],
      );
      assert.notEqual(events[0].idempotency_key, events[1].idempotency_key);

      await collectFromHook(options);
      assert.equal(mock.requests.length, 2, '変更がないのに再送している');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('log切替・短縮で0から再読込しても重複せず、sessionのsequenceを維持する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const sessionLine = codexSessionLine('session-1');
      const m1 = codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '1件目' });
      const m2 = codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'assistant', text: '2件目' });
      const m3 = codexMessageLine({ sessionId: 'session-1', messageId: 'item-3', role: 'user', text: '3件目' });
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [sessionLine, m1]);
      const hook = buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir });
      const options = { source: 'codex' as const, hook, config: fixture.config, token: 'token-a' };
      await collectFromHook(options);
      assert.deepEqual(
        sentEvents(mock.requests).map((event) => event.sequence_no),
        [1],
      );

      // 新inodeへ置換（rotation）。同一session IDの全文を再読込しても重複しない。
      const rotated = path.join(fixture.root, 'rotated.jsonl');
      await writeTranscript(rotated, [sessionLine, m1, m2]);
      await rename(rotated, transcript);
      await collectFromHook(options);
      assert.deepEqual(
        sentEvents(mock.requests.slice(1)).map((event) => [event.source_message_id, event.sequence_no]),
        [['item-2', 2]],
      );

      // 同一inodeの短縮。cursorを0へ戻して重複を除く。
      await writeTranscript(transcript, [sessionLine, m1]);
      await collectFromHook(options);
      assert.equal(mock.requests.length, 2, '短縮後の再読込で再送している');

      // 別fileへログ切替。同じsessionのsequenceを継続する。
      const switched = path.join(fixture.root, 'switched.jsonl');
      await writeTranscript(switched, [sessionLine, m3]);
      await collectFromHook({ ...options, hook: buildHook({ session_id: 'session-1', transcript_path: switched, cwd: fixture.repoDir }) });
      assert.deepEqual(
        sentEvents(mock.requests.slice(2)).map((event) => [event.source_message_id, event.sequence_no]),
        [['item-3', 3]],
      );
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('未知版のCodexは取り込まず保留し、対応版への書換え後に回収する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const message = codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '対応版の本文' });
      const unknownVersion = codexSessionLine('session-1', '0.155.0-alpha.9.3');
      const supportedVersion = codexSessionLine('session-1');
      assert.equal(Buffer.byteLength(unknownVersion, 'utf8'), Buffer.byteLength(supportedVersion, 'utf8'));
      await writeTranscript(transcript, [unknownVersion, message]);
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };
      await collectFromHook(options);
      assert.equal(mock.requests.length, 0, '未知版から本文を取り込んでいる');

      const state = openCollectorState(fixture.stateDir);
      const diagnostics = listCollectorDiagnostics(state);
      closeCollectorState(state);
      assert.ok(diagnostics.some((diagnostic) => diagnostic.byteOffset === 0), '未知版の診断offsetがない');

      await writeTranscript(transcript, [supportedVersion, message]);
      await collectFromHook(options);
      assert.deepEqual(
        sentEvents(mock.requests).map((event) => event.source_message_id),
        ['item-1'],
      );
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('未知版のClaude Codeは取り込まず保留し、対応版への書換え後に回収する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'claude.jsonl');
      const unknown = claudeMessageLine({ sessionId: 'session-claude', uuid: 'u-1', role: 'user', content: '対応版の本文', version: '2.1.221' });
      const supported = claudeMessageLine({ sessionId: 'session-claude', uuid: 'u-1', role: 'user', content: '対応版の本文' });
      assert.equal(Buffer.byteLength(unknown, 'utf8'), Buffer.byteLength(supported, 'utf8'));
      await writeTranscript(transcript, [unknown]);
      const options = {
        source: 'claude_code' as const,
        hook: buildHook({ session_id: 'session-claude', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };
      await collectFromHook(options);
      assert.equal(mock.requests.length, 0, '未知版から本文を取り込んでいる');

      await writeTranscript(transcript, [supported]);
      await collectFromHook(options);
      assert.deepEqual(
        sentEvents(mock.requests).map((event) => event.text),
        ['対応版の本文'],
      );
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('不正NUL・サロゲート・本文/識別子超過・JSON破損・行超過を診断し、本文を保存も送信もしない', async () => {
    const secrets = ['RAW-LOG-SECRET-JSON', 'RAW-LOG-SECRET-NUL', 'RAW-LOG-SECRET-SURROGATE', 'RAW-LOG-SECRET-LONG', 'RAW-LOG-SECRET-ID', 'RAW-LOG-SECRET-LINE'];
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const lines = [
        codexSessionLine('session-1'),
        `{"timestamp":"2026-09-21T00:00:01.000Z","type":"event_msg","payload":"${secrets[0]}`,
        codexMessageLine({ sessionId: 'session-1', messageId: 'nul', role: 'user', text: `NUL\u0000${secrets[1]}` }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'surrogate', role: 'user', text: `サロゲート\uD800${secrets[2]}` }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'long', role: 'user', text: `${secrets[3]}${'a'.repeat(65_537)}` }),
        codexMessageLine({ sessionId: 'session-1', messageId: `${secrets[4]}${'i'.repeat(1024)}`, role: 'user', text: '長い識別子' }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'huge-line', role: 'user', text: `${secrets[5]}${'o'.repeat(1_100_000)}` }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'valid', role: 'user', text: '保存対象のみ' }),
      ];
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, lines);
      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });

      assert.deepEqual(
        sentEvents(mock.requests).map((event) => [event.source_message_id, event.text]),
        [['valid', '保存対象のみ']],
      );
      for (const secret of secrets) {
        await assertStateDoesNotContain(fixture.stateDir, secret);
      }
      assert.ok(!JSON.stringify(mock.requests.map((request) => request.body)).includes(secrets[0]));

      const state = openCollectorState(fixture.stateDir);
      const diagnostics = listCollectorDiagnostics(state);
      closeCollectorState(state);
      const offsets = diagnostics.map((diagnostic) => diagnostic.byteOffset);
      assert.ok(offsets.includes(lineByteOffset(lines, 1)), `JSON破損行のoffsetがない: ${JSON.stringify(offsets)}`);
      assert.ok(offsets.includes(lineByteOffset(lines, 6)), `行超過のoffsetがない: ${JSON.stringify(offsets)}`);
      assert.ok(diagnostics.every((diagnostic) => diagnostic.code.length > 0));
      assert.ok(!JSON.stringify(diagnostics).includes('RAW-LOG-SECRET'));
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('1回の読取/送信予算を守り、全件を重複なく回収する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const sessionLine = codexSessionLine('session-1');
      const lines = Array.from({ length: 90 }, (_, index) =>
        codexMessageLine({
          sessionId: 'session-1',
          messageId: `budget-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          text: `${`${index}`.padStart(6, '0')}${'x'.repeat(60_000)}`,
        }),
      );
      const transcript = path.join(fixture.root, 'budget.jsonl');
      await writeTranscript(transcript, [sessionLine, ...lines]);
      const config = fixture.config;
      const token = 'token-a';
      const hook = buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir });

      await collectFromHook({ source: 'codex', hook, config, token });
      const afterFirst = sentEvents(mock.requests).length;
      assert.ok(afterFirst < 90, `4MiB予算を超えて1回で全件読んでいる: ${afterFirst}`);

      let previousRequests = -1;
      for (let attempt = 0; attempt < 10 && mock.requests.length !== previousRequests; attempt += 1) {
        previousRequests = mock.requests.length;
        await flushCollector({ config, token });
      }

      const events = sentEvents(mock.requests);
      assert.equal(events.length, 90);
      assert.equal(new Set(events.map((event) => event.source_message_id)).size, 90, '重複送信がある');
      assert.deepEqual(
        events.map((event) => event.sequence_no).sort((left, right) => left - right),
        Array.from({ length: 90 }, (_, index) => index + 1),
      );
      for (const request of mock.requests) {
        assert.ok(Buffer.byteLength(request.body, 'utf8') <= MAX_EVENT_BODY_BYTES, '1MiBを超えるbodyを送っている');
        assert.ok(parseSentBatches([request])[0].events.length <= MAX_BATCH_SIZE);
      }
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });
});
