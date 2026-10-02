import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { createDeepSeekTranscriptParser, decompressDeepSeekTranscript } from '../adapters/deepseek.js';

function line(value: unknown): string {
  return JSON.stringify(value);
}

describe('DeepSeek Harness transcriptアダプター', () => {
  it('root sessionのuser本文とcompleted turn最後のassistant本文だけを返す', () => {
    const parser = createDeepSeekTranscriptParser();
    const records = [
      { type: 'session', id: 'session-1', cwd: '/repo', version: 3, delegationDepth: 0, isSeeded: false, createdAt: 1_789_000_000_000 },
      {
        type: 'user/message',
        seq: 2,
        time: 1_789_000_000_001,
        data: { id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'user text' }, { type: 'image', url: 'ignored' }] },
      },
      {
        type: 'assistant/message',
        seq: 3,
        time: 1_789_000_000_002,
        data: {
          turn: 1,
          message: {
            id: 'assistant-intermediate',
            role: 'assistant',
            source: { kind: 'model' },
            content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'intermediate' }, { type: 'tool-call', arguments: 'secret' }],
          },
        },
      },
      {
        type: 'assistant/message',
        seq: 4,
        time: 1_789_000_000_003,
        data: {
          turn: 1,
          message: {
            id: 'assistant-final',
            role: 'assistant',
            source: { kind: 'model' },
            content: [{ type: 'text', text: 'final text' }],
          },
        },
      },
      { type: 'turn/end', seq: 5, time: 1_789_000_000_004, data: { turn: 1, reason: { kind: 'completed' } } },
    ].flatMap((value) => parser.parseLine(line(value)));

    assert.deepEqual(records, [
      { kind: 'session', source_session_id: 'session-1', transcript_version: '3' },
      {
        kind: 'message',
        source_session_id: 'session-1',
        transcript_version: '3',
        source_message_id: 'user-1',
        occurred_at: new Date(1_789_000_000_001).toISOString(),
        role: 'user',
        text: 'user text',
      },
      { kind: 'ignored' },
      { kind: 'ignored' },
      {
        kind: 'message',
        source_session_id: 'session-1',
        transcript_version: '3',
        source_message_id: 'assistant-final',
        occurred_at: new Date(1_789_000_000_003).toISOString(),
        role: 'assistant',
        text: 'final text',
      },
    ]);
  });

  it('reasoning・tool・aborted turn・subagent・seeded・未知version・別repositoryを収集可能sessionにしない', () => {
    for (const session of [
      { type: 'session', id: 'subagent', cwd: '/repo', version: 3, delegationDepth: 1, isSeeded: false },
      { type: 'session', id: 'seeded', cwd: '/repo', version: 3, delegationDepth: 0, isSeeded: true },
      { type: 'session', id: 'future', cwd: '/repo', version: 5, delegationDepth: 0, isSeeded: false },
      { type: 'session', id: 'other', cwd: '/other', version: 3, delegationDepth: 0, isSeeded: false },
    ]) {
      const parser = createDeepSeekTranscriptParser({ repository: '/repo' });
      assert.deepEqual(parser.parseLine(line(session)), [{ kind: 'ignored' }], session.id);
    }

    const parser = createDeepSeekTranscriptParser({ repository: '/repo' });
    const records = [
      { type: 'session', id: 'session-1', cwd: '/repo', version: 3, delegationDepth: 0, isSeeded: false },
      {
        type: 'assistant/message',
        seq: 2,
        time: 1_789_000_000_002,
        data: {
          turn: 1,
          message: {
            id: 'assistant-aborted',
            role: 'assistant',
            source: { kind: 'model' },
            content: [{ type: 'reasoning', text: 'private' }, { type: 'tool-call', arguments: 'secret' }, { type: 'text', text: 'must not collect' }],
          },
        },
      },
      { type: 'tool/result', seq: 3, time: 1_789_000_000_003, data: { message: { content: [{ type: 'tool-result', text: 'secret result' }] } } },
      { type: 'turn/end', seq: 4, time: 1_789_000_000_004, data: { turn: 1, reason: { kind: 'aborted' } } },
    ].flatMap((value) => parser.parseLine(line(value)));

    assert.deepEqual(records, [
      { kind: 'session', source_session_id: 'session-1', transcript_version: '3' },
      { kind: 'ignored' },
      { kind: 'ignored' },
      { kind: 'ignored' },
    ]);
  });

  it('assistant発言には、その発言を生成したmodelを付ける', () => {
    const parser = createDeepSeekTranscriptParser();
    const records = [
      { type: 'session', id: 'session-1', cwd: '/repo', version: 4, delegationDepth: 0, isSeeded: false },
      {
        type: 'assistant/message',
        time: 1_789_000_000_002,
        data: {
          turn: 1,
          message: { id: 'assistant-1', role: 'assistant', source: { kind: 'model', model: 'deepseek-flash' }, content: [{ type: 'text', text: 'answer' }] },
        },
      },
      { type: 'turn/end', time: 1_789_000_000_003, data: { turn: 1, reason: { kind: 'completed' } } },
    ].flatMap((value) => parser.parseLine(line(value)));

    assert.deepEqual(records.at(-1), {
      kind: 'message',
      source_session_id: 'session-1',
      transcript_version: '4',
      source_message_id: 'assistant-1',
      occurred_at: new Date(1_789_000_000_002).toISOString(),
      role: 'assistant',
      model_id: 'deepseek-flash',
      text: 'answer',
    });
  });

  it('v4 sessionの発言には、その会話の版を付ける', () => {
    const parser = createDeepSeekTranscriptParser();
    const records = [
      { type: 'session', id: 'session-4', cwd: '/repo', version: 4, delegationDepth: 0, isSeeded: false, agentPreset: 'standard' },
      { type: 'user/message', seq: 2, time: 1_789_000_000_001, data: { id: 'user-4', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'v4 text' }] } },
    ].flatMap((value) => parser.parseLine(line(value)));
    assert.deepEqual(records, [
      { kind: 'session', source_session_id: 'session-4', transcript_version: '4' },
      { kind: 'message', source_session_id: 'session-4', transcript_version: '4', source_message_id: 'user-4', occurred_at: new Date(1_789_000_000_001).toISOString(), role: 'user', text: 'v4 text' },
    ]);
  });

  it('連結されたzstdフレームを順に展開し、欠けた末尾のフレームから完成した行を作らず、壊れた入力は空にする', () => {
    const [first, second, third] = [zstdCompressSync('line-1\n'), zstdCompressSync('line-2\n'), zstdCompressSync('line-3\n')];
    assert.equal(decompressDeepSeekTranscript(Buffer.concat([first, second, third])).toString('utf8'), 'line-1\nline-2\nline-3\n');
    const truncated = Buffer.concat([first, second, third.subarray(0, third.length - 2)]);
    // 欠けたフレームはNodeの版によって読まれないか、展開できた分だけ返る。どちらでも完成した行は手前の2行だけ。
    const completedLines = decompressDeepSeekTranscript(truncated).toString('utf8').split('\n').slice(0, -1);
    assert.deepEqual(completedLines, ['line-1', 'line-2']);
    assert.equal(decompressDeepSeekTranscript(Buffer.alloc(0)).length, 0);
    assert.equal(decompressDeepSeekTranscript(Buffer.from('not zstd')).length, 0);
  });
});
