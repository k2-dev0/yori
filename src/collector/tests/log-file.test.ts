import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { MAX_BATCH_SIZE, MAX_EVENT_BODY_BYTES } from '../../api/contract.js';
import { collectFromHook, flushCollector } from '../collect.js';
import { closeCollectorState, collectorNamespace, getCursor, listCollectorDiagnostics, openCollectorState } from '../state.js';
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

// 短い本文のままUTF-8で指定byte長のCodexログ行を作る。1MiB境界の検証に使う。
function codexPaddedLine(targetBytes: number, messageId: string): string {
  const build = (padding: number) =>
    JSON.stringify({
      timestamp: '2026-09-21T00:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'session-1',
        item: { id: messageId, type: 'UserMessage', content: [{ type: 'text', text: '短い本文' }] },
      },
      padding: 'x'.repeat(padding),
    });
  const baseBytes = Buffer.byteLength(build(0), 'utf8');
  assert.ok(targetBytes >= baseBytes, '指定byte長が小さい');
  return build(targetBytes - baseBytes);
}

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

  it('session_metaだけの初回収集でも対応版を保存し、別呼出しの発言を重複なく回収する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [codexSessionLine('session-1')]);
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };

      // 初回はmetadataだけ。送信はせず、対応版をstateへ残してcursorを進める。
      await collectFromHook(options);
      assert.equal(mock.requests.length, 0, '発言ゼロのmetadataだけで送信している');

      // 別呼出し（再起動相当の再open）で追記した発言を回収する。
      await appendTranscript(
        transcript,
        `${codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'metadata直後の発言' })}\n`,
      );
      await collectFromHook(options);
      assert.deepEqual(
        sentEvents(mock.requests).map((event) => [event.source_message_id, event.sequence_no]),
        [['item-1', 1]],
      );

      // 再読込・再openで同じ発言を再送しない。
      await collectFromHook(options);
      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, 1, '再読込で再送している');

      // 続く発言も同じsessionのsequenceで回収する。
      await appendTranscript(
        transcript,
        `${codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'assistant', text: '続く発言' })}\n`,
      );
      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.deepEqual(
        sentEvents(mock.requests.slice(1)).map((event) => [event.source_message_id, event.sequence_no]),
        [['item-2', 2]],
      );
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('session_meta直後の未完first messageを完成後のcollect/flushで回収し、再読込しない', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const message = codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '未完だった最初の発言' });
      await writeTranscript(transcript, [codexSessionLine('session-1'), message.slice(0, 20)], { trailingNewline: false });
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };

      await collectFromHook(options);
      assert.equal(mock.requests.length, 0, '未完行を送信している');

      // 完成したfirst messageをflush（再起動相当の再open）で回収する。
      await appendTranscript(transcript, `${message.slice(20)}\n`);
      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.deepEqual(
        sentEvents(mock.requests).map((event) => [event.source_message_id, event.sequence_no]),
        [['item-1', 1]],
      );

      await collectFromHook(options);
      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, 1, '再読込で再送している');
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

  it('保留scanは先行発言をrollbackし、対応版修正後に同じ順で一意のsequenceへ回収する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'claude.jsonl');
      const first = claudeMessageLine({ sessionId: 'session-claude', uuid: 'u-1', role: 'user', content: '先行の正常発言' });
      const unknown = claudeMessageLine({ sessionId: 'session-claude', uuid: 'u-2', role: 'assistant', content: '未知版の発言', version: '2.1.999' });
      const supported = claudeMessageLine({ sessionId: 'session-claude', uuid: 'u-2', role: 'assistant', content: '未知版の発言' });
      await writeTranscript(transcript, [first, unknown]);
      const options = {
        source: 'claude_code' as const,
        hook: buildHook({ session_id: 'session-claude', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };

      await collectFromHook(options);
      assert.equal(mock.requests.length, 0, '保留したscanの先行発言を送信している');

      const state = openCollectorState(fixture.stateDir);
      const diagnostics = listCollectorDiagnostics(state);
      closeCollectorState(state);
      assert.ok(
        diagnostics.some(
          (diagnostic) => diagnostic.code === 'transcript_unknown_version' && diagnostic.byteOffset === lineByteOffset([first, unknown], 1),
        ),
        '保留診断のoffsetがない',
      );

      await writeTranscript(transcript, [first, supported]);
      await collectFromHook(options);
      const events = sentEvents(mock.requests);
      assert.deepEqual(
        events.map((event) => [event.source_message_id, event.sequence_no]),
        [
          ['u-1', 1],
          ['u-2', 2],
        ],
      );
      assert.equal(new Set(events.map((event) => event.sequence_no)).size, 2, 'sequenceが重複している');

      await collectFromHook(options);
      assert.equal(mock.requests.length, 1, '修正後に同じ発言を再送している');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('session mismatchで保留したscanもrollbackし、原因修正後に一意のsequenceで回収する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const sessionLine = codexSessionLine('session-1');
      const first = codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '正常な先行発言' });
      const mismatched = codexMessageLine({ sessionId: 'session-2', messageId: 'item-2', role: 'assistant', text: '不一致sessionの発言' });
      const fixed = codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'assistant', text: '不一致sessionの発言' });
      const lines = [sessionLine, first, mismatched];
      await writeTranscript(transcript, lines);
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };

      await collectFromHook(options);
      assert.equal(mock.requests.length, 0, '保留したscanの先行発言を送信している');

      const state = openCollectorState(fixture.stateDir);
      const diagnostics = listCollectorDiagnostics(state);
      closeCollectorState(state);
      assert.ok(
        diagnostics.some((diagnostic) => diagnostic.code === 'session_id_mismatch' && diagnostic.byteOffset === lineByteOffset(lines, 2)),
        'session mismatchの診断offsetがない',
      );

      await writeTranscript(transcript, [sessionLine, first, fixed]);
      await collectFromHook(options);
      assert.deepEqual(
        sentEvents(mock.requests).map((event) => [event.source_message_id, event.sequence_no]),
        [
          ['item-1', 1],
          ['item-2', 2],
        ],
      );
      await collectFromHook(options);
      assert.equal(mock.requests.length, 1, '修正後に同じ発言を再送している');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('保留scanは以前の確定データを削除せず、原因解消後の後続だけを回収する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const sessionLine = codexSessionLine('session-1');
      const confirmed = codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '確定済みの本文' });
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };
      await writeTranscript(transcript, [sessionLine, confirmed]);
      await collectFromHook(options);
      assert.deepEqual(sentEvents(mock.requests).map((event) => event.source_message_id), ['item-1']);

      // 確定後に未知版metadataが現れても、先行分は保持したまま保留する。
      await writeTranscript(transcript, [sessionLine, confirmed, codexSessionLine('session-1', '0.155.0-alpha.9.3')]);
      await collectFromHook(options);
      assert.equal(mock.requests.length, 1, '保留中に確定済みの発言を再送している');

      // 対応版へ修正すると、確定済みitem-1は再送せず後続だけを一意のsequenceで回収する。
      const next = codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'assistant', text: '保留後の本文' });
      await writeTranscript(transcript, [sessionLine, confirmed, next]);
      await collectFromHook(options);
      assert.equal(mock.requests.length, 2);
      assert.deepEqual(
        sentEvents([mock.requests[1]]).map((event) => [event.source_message_id, event.sequence_no]),
        [['item-2', 2]],
      );
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('1MiBちょうどの行は取り込み、1MiB+1byteの行は本文を保存せず診断する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const boundary = codexPaddedLine(1024 * 1024, 'boundary');
      const oversize = codexPaddedLine(1024 * 1024 + 1, 'oversize');
      const valid = codexMessageLine({ sessionId: 'session-1', messageId: 'valid', role: 'user', text: '後続の正常行' });
      const lines = [codexSessionLine('session-1'), boundary, oversize, valid];
      await writeTranscript(transcript, lines);
      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });

      assert.deepEqual(
        sentEvents(mock.requests).map((event) => [event.source_message_id, event.sequence_no]),
        [
          ['boundary', 1],
          ['valid', 2],
        ],
      );

      const state = openCollectorState(fixture.stateDir);
      const diagnostics = listCollectorDiagnostics(state);
      closeCollectorState(state);
      assert.ok(
        diagnostics.some((diagnostic) => diagnostic.code === 'transcript_line_too_long' && diagnostic.byteOffset === lineByteOffset(lines, 2)),
        '1MiB+1byteの行の診断offsetがない',
      );
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('4MiB超の巨大行でも予算を守り、次回は途中から読み捨てて後続の正常行を回収する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const lines = [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'huge', role: 'user', text: 'x'.repeat(5 * 1024 * 1024) }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'valid', role: 'user', text: '巨大行の後の正常行' }),
      ];
      await writeTranscript(transcript, lines);
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };

      await collectFromHook(options);
      assert.equal(mock.requests.length, 0, '4MiB予算を超えて巨大行を読んでいる');

      for (let attempt = 0; attempt < 3 && mock.requests.length === 0; attempt += 1) {
        await flushCollector({ config: fixture.config, token: 'token-a' });
      }
      assert.deepEqual(
        sentEvents(mock.requests).map((event) => [event.source_message_id, event.sequence_no]),
        [['valid', 1]],
      );
      assert.equal(mock.requests.length, 1);

      const state = openCollectorState(fixture.stateDir);
      const diagnostics = listCollectorDiagnostics(state);
      closeCollectorState(state);
      assert.ok(
        diagnostics.some((diagnostic) => diagnostic.code === 'transcript_line_too_long' && diagnostic.byteOffset === lineByteOffset(lines, 1)),
        '巨大行の診断offsetがない',
      );
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('未完の巨大行は進行offsetを保存し、改行追記後に後続行を回収する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const sessionLine = codexSessionLine('session-1');
      const huge = codexMessageLine({ sessionId: 'session-1', messageId: 'huge', role: 'user', text: 'x'.repeat(3 * 1024 * 1024) });
      const valid = codexMessageLine({ sessionId: 'session-1', messageId: 'valid', role: 'user', text: '改行追記後の正常行' });
      await writeTranscript(transcript, [sessionLine, huge], { trailingNewline: false });
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };

      await collectFromHook(options);
      assert.equal(mock.requests.length, 0, '未完の巨大行から発言を取り込んでいる');

      const namespace = collectorNamespace(fixture.config.api_url, 'token-a');
      const state = openCollectorState(fixture.stateDir);
      const cursor = getCursor(state, namespace, 'codex', 'session-1', transcript);
      closeCollectorState(state);
      assert.equal(cursor?.skip_start, lineByteOffset([sessionLine], 1), '巨大行の開始offsetを保存していない');
      assert.equal(cursor?.skip_offset, statSync(transcript).size, 'EOFまでの読取offsetを保存していない');

      await appendTranscript(transcript, `\n${valid}\n`);
      await collectFromHook(options);
      assert.deepEqual(
        sentEvents(mock.requests).map((event) => [event.source_message_id, event.sequence_no]),
        [['valid', 1]],
      );

      const stateAfter = openCollectorState(fixture.stateDir);
      const cursorAfter = getCursor(stateAfter, namespace, 'codex', 'session-1', transcript);
      closeCollectorState(stateAfter);
      assert.equal(cursorAfter?.skip_start, null, 'skip完了後も状態が残っている');

      await collectFromHook(options);
      assert.equal(mock.requests.length, 1, '再読込で再送している');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('skip中に別inodeへ差し替わったらskip状態を捨てて新fileを先頭から読む', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const sessionLine = codexSessionLine('session-1');
      await writeTranscript(transcript, [
        sessionLine,
        codexMessageLine({ sessionId: 'session-1', messageId: 'huge', role: 'user', text: 'x'.repeat(2 * 1024 * 1024) }),
      ], { trailingNewline: false });
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };
      await collectFromHook(options);
      assert.equal(mock.requests.length, 0);

      // 旧fileより大きい別inodeへ置換し、inode検知でskip状態を捨てることを確認する。
      const replacement = path.join(fixture.root, 'replacement.jsonl');
      await writeTranscript(replacement, [
        sessionLine,
        codexMessageLine({ sessionId: 'session-1', messageId: 'valid', role: 'user', text: '差替え後の正常行' }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'filler', role: 'user', text: 'y'.repeat(3 * 1024 * 1024) }),
      ]);
      await rename(replacement, transcript);

      await collectFromHook(options);
      assert.deepEqual(
        sentEvents(mock.requests).map((event) => [event.source_message_id, event.sequence_no]),
        [['valid', 1]],
      );
      await collectFromHook(options);
      assert.equal(mock.requests.length, 1, '別inodeの再読込で再送している');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('旧schemaのfile_cursorsを持つstateを開いてskip列を追加し、収集を継続する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      mkdirSync(fixture.stateDir, { recursive: true });
      const legacy = new DatabaseSync(path.join(fixture.stateDir, 'collector.sqlite3'));
      legacy.exec(`
        CREATE TABLE file_cursors (
          namespace TEXT NOT NULL,
          source TEXT NOT NULL,
          source_session_id TEXT NOT NULL,
          transcript_path TEXT NOT NULL,
          byte_offset INTEGER NOT NULL,
          device TEXT NOT NULL,
          inode TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          fingerprint_length INTEGER NOT NULL,
          fingerprint TEXT NOT NULL,
          PRIMARY KEY (namespace, source, source_session_id, transcript_path)
        )`);
      legacy.close();

      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '旧schemaからの本文' }),
      ]);
      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });
      assert.deepEqual(
        sentEvents(mock.requests).map((event) => [event.source_message_id, event.sequence_no]),
        [['item-1', 1]],
      );

      const state = openCollectorState(fixture.stateDir);
      const cursor = getCursor(state, collectorNamespace(fixture.config.api_url, 'token-a'), 'codex', 'session-1', transcript);
      closeCollectorState(state);
      assert.equal(cursor?.skip_start, null);
      assert.equal(cursor?.skip_offset, null);
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('不正なsource_message_idはoutboxへ入れず診断し、正常な後続発言を送る', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const lines = [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'bad\u0000id', role: 'user', text: '不正IDの本文' }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'bad\uD800id', role: 'user', text: 'サロゲートIDの本文' }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-valid', role: 'assistant', text: '正常な後続本文' }),
      ];
      await writeTranscript(transcript, lines);
      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });

      assert.deepEqual(
        sentEvents(mock.requests).map((event) => [event.source_message_id, event.sequence_no]),
        [['item-valid', 1]],
      );
      assert.ok(!JSON.stringify(mock.requests.map((request) => request.body)).includes('不正IDの本文'));
      assert.ok(!JSON.stringify(mock.requests.map((request) => request.body)).includes('サロゲートIDの本文'));

      const state = openCollectorState(fixture.stateDir);
      const diagnostics = listCollectorDiagnostics(state);
      closeCollectorState(state);
      for (const index of [1, 2]) {
        assert.ok(
          diagnostics.some((diagnostic) => diagnostic.code === 'message_invalid_identifier' && diagnostic.byteOffset === lineByteOffset(lines, index)),
          `${index}行目の不正ID診断がない`,
        );
      }
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('不正なsession_idは収集境界で拒否し、同じstateの正常sessionを詰まらせない', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const invalidSessionId = 'bad\u0000session';
      const invalidTranscript = path.join(fixture.root, 'invalid.jsonl');
      const normalTranscript = path.join(fixture.root, 'normal.jsonl');
      await writeTranscript(invalidTranscript, [
        claudeMessageLine({ sessionId: invalidSessionId, uuid: 'u-bad', role: 'user', content: '不正sessionの本文' }),
      ]);
      await writeTranscript(normalTranscript, [
        codexSessionLine('session-ok'),
        codexMessageLine({ sessionId: 'session-ok', messageId: 'ok-1', role: 'user', text: '正常sessionの本文' }),
      ]);

      await collectFromHook({
        source: 'claude_code',
        hook: buildHook({ session_id: invalidSessionId, transcript_path: invalidTranscript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });
      assert.equal(mock.requests.length, 0, '不正session_idから送信している');

      const state = openCollectorState(fixture.stateDir);
      const diagnostics = listCollectorDiagnostics(state);
      const sourceCount = Number((state.db.prepare('SELECT COUNT(*) AS count FROM sources').get() as { count: number }).count);
      const sessionCount = Number((state.db.prepare('SELECT COUNT(*) AS count FROM source_sessions').get() as { count: number }).count);
      closeCollectorState(state);
      assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'session_invalid_identifier'), '不正session_idの診断がない');
      assert.equal(sourceCount, 0, '不正session_idのsourceを保存している');
      assert.equal(sessionCount, 0, '不正session_idのsessionを保存している');

      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-ok', transcript_path: normalTranscript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });
      assert.deepEqual(
        sentEvents(mock.requests).map((event) => [event.source_message_id, event.text]),
        [['ok-1', '正常sessionの本文']],
      );
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });
});
