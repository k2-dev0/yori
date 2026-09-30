import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDeepSeekTranscriptParser } from '../adapters/deepseek.js';

function line(value: unknown): string {
  return JSON.stringify(value);
}

describe('DeepSeek Harness transcriptアダプター', () => {
  it('v3 root sessionのuser本文とcompleted turn最後のassistant本文だけを返す', () => {
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
      { type: 'session', id: 'future', cwd: '/repo', version: 4, delegationDepth: 0, isSeeded: false },
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
});
