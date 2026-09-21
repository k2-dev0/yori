import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SUPPORTED_CLAUDE_CODE_VERSION, parseClaudeTranscriptLine } from '../adapters/claude.js';
import { claudeMessageLine } from './support.js';

function expectedMessage(input: { uuid: string; role: 'user' | 'assistant'; text: string; timestamp?: string; version?: string }) {
  return {
    kind: 'message',
    source_session_id: 'session-claude',
    transcript_version: input.version ?? SUPPORTED_CLAUDE_CODE_VERSION,
    source_message_id: input.uuid,
    occurred_at: input.timestamp ?? '2026-09-21T00:00:01.000Z',
    role: input.role,
    text: input.text,
  };
}

describe('Claude Code transcriptアダプター', () => {
  it('userのstring/text blockとassistantのtext blockだけを返す', () => {
    assert.deepEqual(
      parseClaudeTranscriptLine(claudeMessageLine({ sessionId: 'session-claude', uuid: 'u-string', role: 'user', content: '文字列本文' })),
      expectedMessage({ uuid: 'u-string', role: 'user', text: '文字列本文' }),
    );
    assert.deepEqual(
      parseClaudeTranscriptLine(
        claudeMessageLine({
          sessionId: 'session-claude',
          uuid: 'u-block',
          role: 'user',
          content: [{ type: 'text', text: 'block本文' }],
          timestamp: '2026-09-21T10:00:01.000+09:00',
        }),
      ),
      expectedMessage({ uuid: 'u-block', role: 'user', text: 'block本文', timestamp: '2026-09-21T10:00:01.000+09:00' }),
    );
    assert.deepEqual(
      parseClaudeTranscriptLine(
        claudeMessageLine({
          sessionId: 'session-claude',
          uuid: 'a-text',
          role: 'assistant',
          content: [
            { type: 'text', text: '回答本文' },
            { type: 'thinking', thinking: '内部推論' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
          ],
        }),
      ),
      expectedMessage({ uuid: 'a-text', role: 'assistant', text: '回答本文' }),
    );
  });

  it('tool_result・thinking/tool_useのみのレコードを取り込まない', () => {
    const lines = [
      claudeMessageLine({
        sessionId: 'session-claude',
        uuid: 'u-tool-result',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ツール出力' }],
      }),
      claudeMessageLine({
        sessionId: 'session-claude',
        uuid: 'u-mixed-tool-result',
        role: 'user',
        content: [
          { type: 'text', text: '本文らしきもの' },
          { type: 'tool_result', tool_use_id: 'tool-2', content: [{ type: 'text', text: '再帰的に拾ってはいけない' }] },
        ],
      }),
      claudeMessageLine({
        sessionId: 'session-claude',
        uuid: 'a-thinking',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '推論のみ' },
          { type: 'tool_use', id: 'tool-3', name: 'Read', input: {} },
        ],
      }),
    ];
    for (const line of lines) {
      assert.deepEqual(parseClaudeTranscriptLine(line), { kind: 'ignored' }, line);
    }
  });

  it('meta/compact/sidechain/API error/toolUseResult/sourceToolAssistantUUIDを除外する', () => {
    const extras = [
      { isMeta: true },
      { isCompactSummary: true },
      { isSidechain: true },
      { isApiErrorMessage: true },
      { toolUseResult: { stdout: 'ツール出力' } },
      { sourceToolAssistantUUID: 'assistant-uuid' },
    ];
    for (const extra of extras) {
      const line = claudeMessageLine({ sessionId: 'session-claude', uuid: `u-${Object.keys(extra)[0]}`, role: 'user', content: '除外対象', extra });
      assert.deepEqual(parseClaudeTranscriptLine(line), { kind: 'ignored' }, line);
    }
  });

  it('system/attachment/queue-operationは除外し、未知recordとJSON破損を区別する', () => {
    for (const type of ['system', 'attachment', 'queue-operation']) {
      assert.deepEqual(parseClaudeTranscriptLine(JSON.stringify({ type, sessionId: 'session-claude', version: SUPPORTED_CLAUDE_CODE_VERSION })), {
        kind: 'ignored',
      });
    }
    assert.deepEqual(parseClaudeTranscriptLine(JSON.stringify({ type: 'future_record', sessionId: 'session-claude', version: SUPPORTED_CLAUDE_CODE_VERSION })), {
      kind: 'unknown',
    });
    assert.deepEqual(parseClaudeTranscriptLine('{"type":"user","uuid":'), { kind: 'invalid' });
  });

  it('未知versionも行からは読み取り、対応判定はpipelineへ委ねる', () => {
    assert.deepEqual(
      parseClaudeTranscriptLine(
        claudeMessageLine({ sessionId: 'session-claude', uuid: 'u-unknown', role: 'user', content: '未知版の本文', version: '2.1.221' }),
      ),
      expectedMessage({ uuid: 'u-unknown', role: 'user', text: '未知版の本文', version: '2.1.221' }),
    );
  });
});
