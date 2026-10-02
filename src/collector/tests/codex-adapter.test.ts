import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { SUPPORTED_CODEX_CLI_VERSIONS, parseCodexTranscriptLine, readCodexTurnContexts } from '../adapters/codex.js';
import { codexMessageLine, codexSessionLine, makeTempDir, removeTempDir, writeTranscript } from './support.js';

describe('Codex transcriptアダプター', () => {
  it('session_metaのsession IDと確認済みcli_versionを返す', () => {
    assert.deepEqual(parseCodexTranscriptLine(codexSessionLine('session-1')), {
      kind: 'session',
      source_session_id: 'session-1',
      transcript_version: SUPPORTED_CODEX_CLI_VERSIONS.at(-1),
    });
  });

  it('item_completedのUserMessageとturn最終AgentMessageだけを本文・日時付きで返す', () => {
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
      { kind: 'ignored' },
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
    const records: [recordType: string, line: string][] = [
      ['response_item', JSON.stringify({ timestamp: '2026-09-21T00:00:02.000Z', type: 'response_item', payload: { type: 'message' } })],
      ['Reasoning', JSON.stringify({ timestamp: '2026-09-21T00:00:03.000Z', type: 'event_msg', payload: { type: 'item_completed', thread_id: 'session-1', item: { id: 'reason-1', type: 'Reasoning' } } })],
      ['FunctionCall', JSON.stringify({ timestamp: '2026-09-21T00:00:04.000Z', type: 'event_msg', payload: { type: 'item_completed', thread_id: 'session-1', item: { id: 'call-1', type: 'FunctionCall' } } })],
      ['FunctionCallOutput', JSON.stringify({ timestamp: '2026-09-21T00:00:05.000Z', type: 'event_msg', payload: { type: 'item_completed', thread_id: 'session-1', item: { id: 'tool-1', type: 'FunctionCallOutput' } } })],
      ['token_count', JSON.stringify({ timestamp: '2026-09-21T00:00:06.000Z', type: 'event_msg', payload: { type: 'token_count', total: 10 } })],
      ['compacted', JSON.stringify({ timestamp: '2026-09-21T00:00:07.000Z', type: 'compacted', payload: {} })],
      ['AgentMessage_wrong_case', JSON.stringify({ timestamp: '2026-09-21T00:00:08.000Z', type: 'event_msg', payload: { type: 'item_completed', thread_id: 'session-1', item: { id: 'agent-wrong-case', type: 'AgentMessage', content: [{ type: 'text', text: 'fixture-wrong-case-text' }] } } })],
    ];
    for (const [recordType, line] of records) {
      assert.deepEqual(parseCodexTranscriptLine(line), { kind: 'ignored' }, recordType);
    }
  });

  it('未知recordとJSON破損を区別する', () => {
    assert.deepEqual(parseCodexTranscriptLine(JSON.stringify({ timestamp: '2026-09-21T00:00:09.000Z', type: 'future_record', payload: {} })), {
      kind: 'unknown',
    });
    assert.deepEqual(parseCodexTranscriptLine('{"timestamp":"2026-09-21T00:00:10.000Z","type":'), { kind: 'invalid' });
  });

  it('Desktop確認版0.155.0-alpha.16.4と旧確認版0.155.0-alpha.9.2のsession_metaを既存shapeで返す', () => {
    for (const cliVersion of ['0.155.0-alpha.16.4', '0.155.0-alpha.9.2']) {
      assert.deepEqual(parseCodexTranscriptLine(codexSessionLine('session-1', cliVersion)), {
        kind: 'session',
        source_session_id: 'session-1',
        transcript_version: cliVersion,
      });
    }
  });

  it('Desktop確認版のUserMessageとfinal AgentMessageをturn identityで返し、commentaryと追加fieldを混入しない', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-09-21T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 'session-1',
          turn_id: 'FIXTURE_TURN_ID',
          item: {
            id: 'item-user',
            type: 'UserMessage',
            extra: 'FIXTURE_USER_EXTRA',
            content: [
              { type: 'text', text: 'fixture-user-text' },
              { type: 'input_text' },
            ],
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-21T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 'session-1',
          turn_id: 'FIXTURE_TURN_ID',
          item: {
            id: 'item-commentary',
            type: 'AgentMessage',
            phase: 'commentary',
            extra: 'FIXTURE_ASSISTANT_EXTRA',
            content: [
              { type: 'Text', text: 'fixture-assistant-commentary-text' },
              { type: 'Reasoning' },
            ],
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-21T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 'session-1',
          turn_id: 'FIXTURE_TURN_ID',
          item: { id: 'item-final', type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'fixture-assistant-final-text' }] },
        },
      }),
    ];
    assert.deepEqual(parseCodexTranscriptLine(lines[0]), {
      kind: 'message',
      source_session_id: 'session-1',
      transcript_version: null,
      source_message_id: 'turn:FIXTURE_TURN_ID:user',
      occurred_at: '2026-09-21T00:00:01.000Z',
      role: 'user',
      text: 'fixture-user-text',
    });
    assert.deepEqual(parseCodexTranscriptLine(lines[1]), { kind: 'ignored' });
    assert.deepEqual(parseCodexTranscriptLine(lines[2]), {
      kind: 'message',
      source_session_id: 'session-1',
      transcript_version: null,
      source_message_id: 'turn:FIXTURE_TURN_ID:assistant',
      occurred_at: '2026-09-21T00:00:03.000Z',
      role: 'assistant',
      text: 'fixture-assistant-final-text',
    });
  });

  it('会話ログのturn_contextからturnごとのmodelと思考量を引き、回答行にだけ付ける', async () => {
    const dir = await makeTempDir();
    try {
      const transcript = path.join(dir, 'codex.jsonl');
      const turnContext = (turnId: string, payload: Record<string, unknown>) => JSON.stringify({ type: 'turn_context', payload: { turn_id: turnId, ...payload } });
      const itemLine = (item: Record<string, unknown>) =>
        JSON.stringify({
          timestamp: '2026-09-21T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'item_completed', thread_id: 'session-1', turn_id: 'turn-1', item },
        });
      await writeTranscript(transcript, [
        turnContext('turn-1', { model: 'gpt-5.6-sol', effort: 'high' }),
        turnContext('turn-2', { model: 'gpt-6-astra' }),
        turnContext('turn-3', { effort: 'low' }),
        '{"type":"turn_context", broken',
      ]);

      const contexts = readCodexTurnContexts(transcript);
      assert.deepEqual(
        [...contexts],
        [
          ['turn-1', { model_id: 'gpt-5.6-sol', reasoning_effort: 'high' }],
          ['turn-2', { model_id: 'gpt-6-astra' }],
        ],
      );
      assert.deepEqual([...readCodexTurnContexts(path.join(dir, 'missing.jsonl'))], [], '読めないfileを空の表にしていない');

      const answer = parseCodexTranscriptLine(
        itemLine({ id: 'item-final', type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: '回答' }] }),
        () => contexts,
      );
      assert.deepEqual(answer, {
        kind: 'message',
        model_id: 'gpt-5.6-sol',
        reasoning_effort: 'high',
        source_session_id: 'session-1',
        transcript_version: null,
        source_message_id: 'turn:turn-1:assistant',
        occurred_at: '2026-09-21T00:00:01.000Z',
        role: 'assistant',
        text: '回答',
      });
      const question = parseCodexTranscriptLine(itemLine({ id: 'item-user', type: 'UserMessage', content: [{ type: 'text', text: '質問' }] }), () => contexts);
      assert.ok(question.kind === 'message' && question.model_id === undefined && question.reasoning_effort === undefined, 'user発言にmodelを付けている');
    } finally {
      await removeTempDir(dir);
    }
  });

  it('既知の非会話top-level recordをignoredとして扱う', () => {
    const records: [recordType: string, line: string][] = [
      ['turn_context', JSON.stringify({ timestamp: '2026-09-21T00:00:04.000Z', type: 'turn_context', payload: { turn_id: 'fixture-turn' } })],
      ['token_usage_record', JSON.stringify({ timestamp: '2026-09-21T00:00:05.000Z', type: 'token_usage_record', payload: { total_tokens: 1 } })],
      ['world_state', JSON.stringify({ timestamp: '2026-09-21T00:00:06.000Z', type: 'world_state', payload: {} })],
      ['response_item', JSON.stringify({ timestamp: '2026-09-21T00:00:07.000Z', type: 'response_item', payload: { type: 'message' } })],
      // top-level typeだけで分類し、payload欠落でも未知record診断の対象にしない。
      ['turn_context_without_payload', JSON.stringify({ timestamp: '2026-09-21T00:00:08.000Z', type: 'turn_context' })],
    ];
    for (const [recordType, line] of records) {
      assert.deepEqual(parseCodexTranscriptLine(line), { kind: 'ignored' }, recordType);
    }
    assert.deepEqual(parseCodexTranscriptLine(JSON.stringify({ timestamp: '2026-09-21T00:00:09.000Z', type: 'future_record', payload: {} })), {
      kind: 'unknown',
    });
  });

  it('Reasoning・CommandExecution・FileChange・Extensionとtool call/outputを取り込まない', () => {
    const items = [
      { id: 'reasoning-1', type: 'Reasoning' },
      { id: 'command-1', type: 'CommandExecution' },
      { id: 'file-1', type: 'FileChange' },
      { id: 'extension-1', type: 'Extension' },
      { id: 'tool-call-1', type: 'FunctionCall' },
      { id: 'tool-output-1', type: 'FunctionCallOutput' },
    ];
    for (const item of items) {
      const line = JSON.stringify({
        timestamp: '2026-09-21T00:00:10.000Z',
        type: 'event_msg',
        payload: { type: 'item_completed', thread_id: 'session-1', item },
      });
      assert.deepEqual(parseCodexTranscriptLine(line), { kind: 'ignored' }, item.type);
    }
  });
});
