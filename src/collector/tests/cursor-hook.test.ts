import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { closeCollectorState, collectorNamespace, listCollectorDiagnostics, openCollectorState } from '../state.js';
import {
  ackResponse,
  assertStateDoesNotContain,
  buildCollectorConfig,
  createCollectorFixture,
  createGitRepository,
  installFetchMock,
  runCollectorCli,
  sentEvents,
} from './support.js';

function cursorHook(input: {
  event: 'beforeSubmitPrompt' | 'afterAgentResponse';
  workspaceRoots: string[];
  text: string;
  modelId?: string;
}): Record<string, unknown> {
  const common = {
    conversation_id: 'conversation-1',
    generation_id: 'generation-1',
    hook_event_name: input.event,
    cursor_version: '1.7.2',
    workspace_roots: input.workspaceRoots,
    user_email: null,
    transcript_path: null,
    model: 'claude-sonnet-4',
    model_id: input.modelId ?? 'anthropic/claude-sonnet-4',
    model_params: [{ id: 'effort', value: 'high' }],
  };
  return input.event === 'beforeSubmitPrompt' ? { ...common, prompt: input.text, attachments: [] } : { ...common, text: input.text };
}

describe('Cursor公式hookの会話収集', () => {
  it('transcriptなしでuserとassistantを収集し、同一generationの再実行と改訂を冪等に扱う', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const configPath = path.join(fixture.root, 'collector.json');
      await writeFile(configPath, JSON.stringify(fixture.config), 'utf8');
      const run = (hook: Record<string, unknown>) =>
        runCollectorCli(['collect', '--source', 'cursor', '--config', configPath], {
          stdin: JSON.stringify(hook),
          env: { YORI_TEST_TOKEN: 'token-a' },
        });

      const user = cursorHook({ event: 'beforeSubmitPrompt', workspaceRoots: [fixture.repoDir], text: 'Cursorからの依頼' });
      const assistant = cursorHook({ event: 'afterAgentResponse', workspaceRoots: [fixture.repoDir], text: 'Cursorからの回答' });
      assert.equal((await run(user)).code, 0);
      assert.equal((await run(assistant)).code, 0);

      assert.deepEqual(
        sentEvents(mock.requests).map((event) => [
          event.source,
          event.source_session_id,
          event.source_message_id,
          event.role,
          event.text,
          (event as unknown as { model_id?: string }).model_id,
          event.revision,
        ]),
        [
          ['cursor', 'conversation-1', 'generation:generation-1:user', 'user', 'Cursorからの依頼', 'anthropic/claude-sonnet-4', 1],
          ['cursor', 'conversation-1', 'generation:generation-1:assistant', 'assistant', 'Cursorからの回答', 'anthropic/claude-sonnet-4', 1],
        ],
      );

      assert.equal((await run(assistant)).code, 0);
      assert.equal(mock.requests.length, 2, '同じassistant hookを再送している');

      assert.equal(
        (
          await run(
            cursorHook({
              event: 'afterAgentResponse',
              workspaceRoots: [fixture.repoDir],
              text: 'Cursorからの修正版回答',
              modelId: 'openai/gpt-5',
            }),
          )
        ).code,
        0,
      );
      assert.deepEqual(
        sentEvents(mock.requests.slice(2)).map((event) => [event.source_message_id, event.text, (event as unknown as { model_id?: string }).model_id, event.revision]),
        [['generation:generation-1:assistant', 'Cursorからの修正版回答', 'openai/gpt-5', 2]],
      );

      assert.equal(
        (
          await run(
            cursorHook({
              event: 'afterAgentResponse',
              workspaceRoots: [fixture.repoDir],
              text: 'Cursorからの修正版回答',
              modelId: 'google/gemini-pro',
            }),
          )
        ).code,
        0,
      );
      assert.deepEqual(
        sentEvents(mock.requests.slice(3)).map((event) => [event.text, (event as unknown as { model_id?: string }).model_id, event.revision]),
        [['Cursorからの修正版回答', 'google/gemini-pro', 3]],
      );
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('複数の登録repositoryを含むworkspaceは本文を保存せず固定診断を残す', async () => {
    const fixture = await createCollectorFixture({ binding: null });
    const secondRepo = path.join(fixture.root, 'second-repo');
    await createGitRepository(secondRepo, 'https://github.com/Org/Second.git');
    const config = buildCollectorConfig({
      state_dir: fixture.stateDir,
      projects: [
        { repository: 'github.com/Org/Repo', project_id: randomUUID() },
        { repository: 'github.com/Org/Second', project_id: randomUUID() },
      ],
    });
    const configPath = path.join(fixture.root, 'collector.json');
    const rawText = '複数案件へ誤保存してはいけない本文';
    await writeFile(configPath, JSON.stringify(config), 'utf8');
    try {
      const result = await runCollectorCli(['collect', '--source', 'cursor', '--config', configPath], {
        stdin: JSON.stringify(cursorHook({ event: 'beforeSubmitPrompt', workspaceRoots: [fixture.repoDir, secondRepo], text: rawText })),
        env: { YORI_TEST_TOKEN: 'token-a' },
      });
      assert.equal(result.code, 0, result.stderr);

      const state = openCollectorState(fixture.stateDir);
      try {
        assert.deepEqual(listCollectorDiagnostics(state, collectorNamespace(config.api_url, 'token-a')), [
          { code: 'cursor_workspace_ambiguous', byteOffset: null },
        ]);
        assert.equal(state.db.prepare('SELECT count(*) AS count FROM stored_messages').get()?.count, 0);
        assert.equal(state.db.prepare('SELECT count(*) AS count FROM outbox').get()?.count, 0);
      } finally {
        closeCollectorState(state);
      }
      await assertStateDoesNotContain(fixture.stateDir, rawText);
    } finally {
      await fixture.cleanup();
    }
  });
});
