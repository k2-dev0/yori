import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { collectFromHook } from '../collect.js';
import {
  ackResponse,
  buildHook,
  claudeMessageLine,
  createCollectorFixture,
  installFetchMock,
  parseSentBatches,
  runCollectorCli,
  sentEvents,
  writeTranscript,
} from './support.js';

function codexTurnLine(input: {
  sessionId: string;
  turnId: string;
  itemId: string;
  role: 'user' | 'assistant';
  text: string;
  phase?: 'commentary' | 'final_answer';
}): string {
  const item =
    input.role === 'user'
      ? { id: input.itemId, type: 'UserMessage', content: [{ type: 'text', text: input.text }] }
      : {
          id: input.itemId,
          type: 'AgentMessage',
          phase: input.phase ?? 'final_answer',
          content: [{ type: 'Text', text: input.text }],
        };
  return JSON.stringify({
    timestamp: '2026-09-30T00:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: input.sessionId, turn_id: input.turnId, item },
  });
}

describe('hookの安定fieldを使う会話収集', () => {
  it('未知Codex版でもuser promptとturn最終assistant messageだけを保存し、再実行とbackfillで重複しない', async () => {
    const projectId = randomUUID();
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: projectId } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const lines = [
        JSON.stringify({
          timestamp: '2026-09-30T00:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'session-1', cli_version: '99.0.0-future' },
        }),
        codexTurnLine({ sessionId: 'session-1', turnId: 'turn-1', itemId: 'item-user', role: 'user', text: 'タスクAを実装してください' }),
        codexTurnLine({
          sessionId: 'session-1',
          turnId: 'turn-1',
          itemId: 'item-commentary',
          role: 'assistant',
          phase: 'commentary',
          text: '影響範囲を調査します',
        }),
        codexTurnLine({
          sessionId: 'session-1',
          turnId: 'turn-1',
          itemId: 'item-final',
          role: 'assistant',
          phase: 'final_answer',
          text: '実装できました！',
        }),
      ];
      await writeTranscript(transcript, lines);
      const configPath = path.join(fixture.root, 'collector.json');
      await writeFile(configPath, JSON.stringify(fixture.config), 'utf8');

      const userHook = {
        session_id: 'session-1',
        transcript_path: transcript,
        cwd: fixture.repoDir,
        hook_event_name: 'UserPromptSubmit',
        turn_id: 'turn-1',
        prompt: 'タスクAを実装してください',
      };
      const stopHook = {
        session_id: 'session-1',
        transcript_path: transcript,
        cwd: fixture.repoDir,
        hook_event_name: 'Stop',
        turn_id: 'turn-1',
        stop_hook_active: false,
        last_assistant_message: '実装できました！',
      };

      const userResult = await runCollectorCli(['collect', '--source', 'codex', '--config', configPath], {
        stdin: JSON.stringify(userHook),
        env: { YORI_TEST_TOKEN: 'token-a' },
      });
      assert.equal(userResult.code, 0, userResult.stderr);
      const stopResult = await runCollectorCli(['collect', '--source', 'codex', '--config', configPath], {
        stdin: JSON.stringify(stopHook),
        env: { YORI_TEST_TOKEN: 'token-a' },
      });
      assert.equal(stopResult.code, 0, stopResult.stderr);

      assert.deepEqual(
        sentEvents(mock.requests).map((event) => [event.source_message_id, event.role, event.text, event.revision]),
        [
          ['turn:turn-1:user', 'user', 'タスクAを実装してください', 1],
          ['turn:turn-1:assistant', 'assistant', '実装できました！', 1],
        ],
      );
      assert.ok(sentEvents(mock.requests).every((event) => Number.isFinite(Date.parse(event.occurred_at))));

      await runCollectorCli(['collect', '--source', 'codex', '--config', configPath], {
        stdin: JSON.stringify(stopHook),
        env: { YORI_TEST_TOKEN: 'token-a' },
      });
      assert.equal(mock.requests.length, 2, '同じStop hookを再送している');

      await runCollectorCli(['collect', '--source', 'codex', '--config', configPath], {
        stdin: JSON.stringify({ ...stopHook, last_assistant_message: '追加修正も完了しました' }),
        env: { YORI_TEST_TOKEN: 'token-a' },
      });
      assert.deepEqual(
        sentEvents(mock.requests.slice(2)).map((event) => [event.source_message_id, event.text, event.revision]),
        [['turn:turn-1:assistant', '追加修正も完了しました', 2]],
      );

      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });
      assert.equal(mock.requests.length, 3, '同じturnをtranscript backfillで二重送信している');
      assert.ok(!JSON.stringify(mock.requests).includes('影響範囲を調査します'), 'commentaryを送信している');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('未知Claude Code版でも既知構造のuser/assistant発言を収集する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'claude.jsonl');
      await writeTranscript(transcript, [
        claudeMessageLine({ sessionId: 'session-claude', uuid: 'user-1', role: 'user', content: '依頼本文', version: '99.0.0-future' }),
        claudeMessageLine({ sessionId: 'session-claude', uuid: 'assistant-1', role: 'assistant', content: '最終回答', version: '99.0.0-future' }),
      ]);

      await collectFromHook({
        source: 'claude_code',
        hook: buildHook({ session_id: 'session-claude', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });

      const [batch] = parseSentBatches(mock.requests);
      assert.deepEqual(
        batch.events.map((event) => [event.source_message_id, event.role, event.text]),
        [
          ['user-1', 'user', '依頼本文'],
          ['assistant-1', 'assistant', '最終回答'],
        ],
      );
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });
});
