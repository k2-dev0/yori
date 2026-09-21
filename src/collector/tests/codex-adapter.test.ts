import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SUPPORTED_CODEX_CLI_VERSION, parseCodexTranscriptLine } from '../adapters/codex.js';
import { codexMessageLine, codexSessionLine } from './support.js';

describe('Codex transcriptアダプター', () => {
  it('session_metaのsession IDと確認済みcli_versionを返す', () => {
    assert.deepEqual(parseCodexTranscriptLine(codexSessionLine('session-1')), {
      kind: 'session',
      source_session_id: 'session-1',
      transcript_version: SUPPORTED_CODEX_CLI_VERSION,
    });
  });

  it('item_completedのUserMessage/AgentMessageだけを本文・日時付きで返す', () => {
    assert.deepEqual(
      parseCodexTranscriptLine(
        codexMessageLine({
          sessionId: 'session-1',
          messageId: 'item-user',
          role: 'user',
          text: 'ユーザー本文\nと改行',
          timestamp: '2026-09-21T10:00:01.000+09:00',
        }),
      ),
      {
        kind: 'message',
        source_session_id: 'session-1',
        transcript_version: null,
        source_message_id: 'item-user',
        occurred_at: '2026-09-21T10:00:01.000+09:00',
        role: 'user',
        text: 'ユーザー本文\nと改行',
      },
    );
    assert.deepEqual(
      parseCodexTranscriptLine(codexMessageLine({ sessionId: 'session-1', messageId: 'item-commentary', role: 'assistant', text: '途中経過', phase: 'commentary' })),
      {
        kind: 'message',
        source_session_id: 'session-1',
        transcript_version: null,
        source_message_id: 'item-commentary',
        occurred_at: '2026-09-21T00:00:01.000Z',
        role: 'assistant',
        text: '途中経過',
      },
    );
    assert.deepEqual(
      parseCodexTranscriptLine(codexMessageLine({ sessionId: 'session-1', messageId: 'item-final', role: 'assistant', text: '最終回答', phase: 'final_answer' })),
      {
        kind: 'message',
        source_session_id: 'session-1',
        transcript_version: null,
        source_message_id: 'item-final',
        occurred_at: '2026-09-21T00:00:01.000Z',
        role: 'assistant',
        text: '最終回答',
      },
    );
  });

  it('response_item・推論・ツール・コンパクション・形式違いは取り込まない', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-09-21T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '注入コンテキスト' }] },
      }),
      JSON.stringify({
        timestamp: '2026-09-21T00:00:03.000Z',
        type: 'event_msg',
        payload: { type: 'item_completed', thread_id: 'session-1', item: { id: 'reason-1', type: 'Reasoning', content: [{ type: 'text', text: '内部推論' }] } },
      }),
      JSON.stringify({
        timestamp: '2026-09-21T00:00:04.000Z',
        type: 'event_msg',
        payload: { type: 'item_completed', thread_id: 'session-1', item: { id: 'call-1', type: 'FunctionCall', name: 'shell', arguments: '{}' } },
      }),
      JSON.stringify({
        timestamp: '2026-09-21T00:00:05.000Z',
        type: 'event_msg',
        payload: { type: 'item_completed', thread_id: 'session-1', item: { id: 'tool-1', type: 'FunctionCallOutput', output: 'ツール出力' } },
      }),
      JSON.stringify({ timestamp: '2026-09-21T00:00:06.000Z', type: 'event_msg', payload: { type: 'token_count', total: 10 } }),
      JSON.stringify({ timestamp: '2026-09-21T00:00:07.000Z', type: 'compacted', payload: { summary: '要約本文' } }),
      JSON.stringify({
        timestamp: '2026-09-21T00:00:08.000Z',
        type: 'event_msg',
        payload: { type: 'item_completed', thread_id: 'session-1', item: { id: 'agent-wrong-case', type: 'AgentMessage', content: [{ type: 'text', text: '形式違い' }] } },
      }),
    ];
    for (const line of lines) {
      assert.deepEqual(parseCodexTranscriptLine(line), { kind: 'ignored' }, line);
    }
  });

  it('未知recordとJSON破損を区別する', () => {
    assert.deepEqual(parseCodexTranscriptLine(JSON.stringify({ timestamp: '2026-09-21T00:00:09.000Z', type: 'future_record', payload: {} })), {
      kind: 'unknown',
    });
    assert.deepEqual(parseCodexTranscriptLine('{"timestamp":"2026-09-21T00:00:10.000Z","type":'), { kind: 'invalid' });
  });
});
