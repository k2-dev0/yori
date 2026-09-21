import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { collectFromHook, flushCollector, ingestTranscript } from '../collect.js';
import { closeCollectorState, collectorNamespace, openCollectorState } from '../state.js';
import { buildCollectorConfig } from './support.js';
import {
  ackResponse,
  appendTranscript,
  assertStateDoesNotContain,
  buildHook,
  codexMessageLine,
  codexSessionLine,
  claudeMessageLine,
  createCollectorFixture,
  createGitRepository,
  installFetchMock,
  jsonResponse,
  makeTempDir,
  parseSentBatches,
  removeTempDir,
  sentEvents,
  writeTranscript,
} from './support.js';

describe('会話の収集', () => {
  it('Codexのuser/AI発言を本文・日時・順序を保持して送信し、再読込で再送しない', async () => {
    const projectId = randomUUID();
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: projectId } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({
          sessionId: 'session-1',
          messageId: 'item-user',
          role: 'user',
          text: 'ユーザー本文',
          timestamp: '2026-09-21T10:00:01.000+09:00',
        }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-commentary', role: 'assistant', text: '途中経過', phase: 'commentary' }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-final', role: 'assistant', text: '最終回答', phase: 'final_answer' }),
      ]);
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };

      await collectFromHook(options);

      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0].url, 'https://api.example.test/v1/events');
      assert.equal(mock.requests[0].method, 'POST');
      assert.equal(mock.requests[0].headers.authorization, 'Bearer token-a');
      const [batch] = parseSentBatches(mock.requests);
      assert.equal(batch.project_id, projectId);
      assert.deepEqual(
        batch.events.map((event) => event.sequence_no),
        [1, 2, 3],
      );
      assert.deepEqual(
        batch.events.map((event) => event.role),
        ['user', 'assistant', 'assistant'],
      );
      assert.deepEqual(
        batch.events.map((event) => event.text),
        ['ユーザー本文', '途中経過', '最終回答'],
      );
      assert.deepEqual(
        batch.events.map((event) => event.source_message_id),
        ['item-user', 'item-commentary', 'item-final'],
      );
      assert.deepEqual(
        batch.events.map((event) => new Date(event.occurred_at).toISOString()),
        ['2026-09-21T01:00:01.000Z', '2026-09-21T00:00:01.000Z', '2026-09-21T00:00:01.000Z'],
      );
      for (const event of batch.events) {
        assert.equal(event.source, 'codex');
        assert.equal(event.source_scope, 'github.com/Org/Repo');
        assert.equal(event.source_session_id, 'session-1');
        assert.equal(event.revision, 1);
        assert.ok(event.idempotency_key.length > 0 && event.idempotency_key.length <= 512);
      }
      assert.equal(new Set(batch.events.map((event) => event.idempotency_key)).size, 3);

      await collectFromHook(options);
      assert.equal(mock.requests.length, 1, '追記がない再読込で再送している');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('Claude Codeのuser/AI発言だけを収集し、ツール出力・推論・要約を送らない', async () => {
    const projectId = randomUUID();
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: projectId } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'claude.jsonl');
      await writeTranscript(transcript, [
        claudeMessageLine({ sessionId: 'session-claude', uuid: 'u-1', role: 'user', content: '最初の依頼' }),
        claudeMessageLine({
          sessionId: 'session-claude',
          uuid: 'a-1',
          role: 'assistant',
          content: [
            { type: 'text', text: '回答本文' },
            { type: 'thinking', thinking: '推論' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
          ],
        }),
        claudeMessageLine({
          sessionId: 'session-claude',
          uuid: 'u-tool',
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ツール出力' }],
        }),
        claudeMessageLine({
          sessionId: 'session-claude',
          uuid: 'a-thinking',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '推論だけ' }],
        }),
        claudeMessageLine({
          sessionId: 'session-claude',
          uuid: 'u-compact',
          role: 'user',
          content: 'コンパクション要約',
          extra: { isCompactSummary: true },
        }),
        JSON.stringify({ type: 'system', sessionId: 'session-claude', version: '2.1.220', content: 'システム指示' }),
        claudeMessageLine({
          sessionId: 'session-claude',
          uuid: 'u-2',
          role: 'user',
          content: [{ type: 'text', text: '続きの依頼' }],
        }),
      ]);
      await collectFromHook({
        source: 'claude_code',
        hook: buildHook({ session_id: 'session-claude', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });

      const events = sentEvents(mock.requests);
      assert.deepEqual(
        events.map((event) => [event.role, event.text]),
        [
          ['user', '最初の依頼'],
          ['assistant', '回答本文'],
          ['user', '続きの依頼'],
        ],
      );
      for (const event of events) {
        assert.equal(event.source, 'claude_code');
        assert.equal(event.source_session_id, 'session-claude');
        assert.equal(event.source_scope, 'github.com/Org/Repo');
      }
      assert.deepEqual(
        events.map((event) => event.sequence_no),
        [1, 2, 3],
      );
      assert.ok(!JSON.stringify(events).includes('ツール出力'));
      assert.ok(!JSON.stringify(events).includes('コンパクション要約'));
      assert.ok(!JSON.stringify(events).includes('システム指示'));
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('再起動しても重複せず、同文の別発言を区別する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '同じ本文' }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'assistant', text: '同じ本文' }),
      ]);
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };

      await collectFromHook(options);
      const first = sentEvents(mock.requests);
      assert.equal(first.length, 2);
      assert.deepEqual(
        first.map((event) => event.source_message_id),
        ['item-1', 'item-2'],
      );
      assert.equal(new Set(first.map((event) => event.idempotency_key)).size, 2, '同文の別発言が同じidempotency_keyになっている');

      // プロセス再起動相当でstateを開き直しても、同じ発言は再送しない。
      await collectFromHook(options);
      assert.equal(mock.requests.length, 1);

      await appendTranscript(transcript, `${codexMessageLine({ sessionId: 'session-1', messageId: 'item-3', role: 'user', text: '同じ本文' })}\n`);
      await collectFromHook(options);
      const added = sentEvents(mock.requests.slice(1));
      assert.deepEqual(
        added.map((event) => event.source_message_id),
        ['item-3'],
      );
      assert.equal(added[0].sequence_no, 3);
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('sessionごとにsequenceを独立して採番する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcriptA = path.join(fixture.root, 'a.jsonl');
      const transcriptB = path.join(fixture.root, 'b.jsonl');
      await writeTranscript(transcriptA, [
        codexSessionLine('session-a'),
        codexMessageLine({ sessionId: 'session-a', messageId: 'a-1', role: 'user', text: 'Aの発言' }),
      ]);
      await writeTranscript(transcriptB, [
        codexSessionLine('session-b'),
        codexMessageLine({ sessionId: 'session-b', messageId: 'b-1', role: 'user', text: 'Bの発言' }),
      ]);

      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-a', transcript_path: transcriptA, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });
      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-b', transcript_path: transcriptB, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });

      const events = sentEvents(mock.requests);
      assert.equal(events.length, 2);
      assert.deepEqual(
        events.map((event) => [event.source_session_id, event.sequence_no]),
        [
          ['session-a', 1],
          ['session-b', 1],
        ],
      );
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('未登録repositoryは本文を読まず保留し、登録後のflushで送信する', async () => {
    const secret = 'UNREGISTERED-RAW-LOG-SECRET';
    const fixture = await createCollectorFixture({ binding: null });
    const projectId = randomUUID();
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '保留される本文' }),
        `{"timestamp":"2026-09-21T00:00:02.000Z","type":"event_msg","payload":${secret}`,
      ]);

      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });
      assert.equal(mock.requests.length, 0, '未登録repositoryから送信している');
      await assertStateDoesNotContain(fixture.stateDir, secret);

      const registered = buildCollectorConfig({
        state_dir: fixture.stateDir,
        projects: [{ repository: 'github.com/Org/Repo', project_id: projectId }],
      });
      await flushCollector({ config: registered, token: 'token-a' });

      assert.equal(mock.requests.length, 1, '登録後のflushで保留分が送信されていない');
      const [batch] = parseSentBatches(mock.requests);
      assert.equal(batch.project_id, projectId);
      assert.deepEqual(
        batch.events.map((event) => [event.source_message_id, event.text]),
        [['item-1', '保留される本文']],
      );
      assert.ok(!mock.requests[0].body.includes(secret));

      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: registered,
        token: 'token-a',
      });
      assert.equal(mock.requests.length, 1, 'flush後に同じ発言を再送している');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('別repositoryのbatchへイベントを混ぜず、source_scopeを案件ごとに固定する', async () => {
    const root = await makeTempDir();
    const projectA = randomUUID();
    const projectB = randomUUID();
    const mock = installFetchMock(ackResponse);
    try {
      const repoA = path.join(root, 'repo-a');
      const repoB = path.join(root, 'repo-b');
      await createGitRepository(repoA, 'https://github.com/Org/A.git');
      await createGitRepository(repoB, 'git@github.com:Org/B.git');
      const config = buildCollectorConfig({
        state_dir: path.join(root, 'state'),
        projects: [
          { repository: 'github.com/Org/A', project_id: projectA },
          { repository: 'github.com/Org/B', project_id: projectB },
        ],
      });
      const transcriptA = path.join(root, 'a.jsonl');
      const transcriptB = path.join(root, 'b.jsonl');
      await writeTranscript(transcriptA, [
        codexSessionLine('session-a'),
        codexMessageLine({ sessionId: 'session-a', messageId: 'a-1', role: 'user', text: 'Aの本文' }),
      ]);
      await writeTranscript(transcriptB, [
        codexSessionLine('session-b'),
        codexMessageLine({ sessionId: 'session-b', messageId: 'b-1', role: 'user', text: 'Bの本文' }),
      ]);

      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-a', transcript_path: transcriptA, cwd: repoA }),
        config,
        token: 'token-a',
      });
      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-b', transcript_path: transcriptB, cwd: repoB }),
        config,
        token: 'token-a',
      });

      assert.equal(mock.requests.length, 2);
      const batches = parseSentBatches(mock.requests);
      const batchA = batches.find((batch) => batch.project_id === projectA);
      const batchB = batches.find((batch) => batch.project_id === projectB);
      assert.ok(batchA, 'project Aのbatchがない');
      assert.ok(batchB, 'project Bのbatchがない');
      assert.deepEqual(
        batchA.events.map((event) => [event.source_scope, event.text]),
        [['github.com/Org/A', 'Aの本文']],
      );
      assert.deepEqual(
        batchB.events.map((event) => [event.source_scope, event.text]),
        [['github.com/Org/B', 'Bの本文']],
      );
    } finally {
      mock.restore();
      await removeTempDir(root);
    }
  });

  it('state_dirとSQLiteファイルを0700/0600で作成する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '権限確認' }),
      ]);
      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });

      assert.equal(statSync(fixture.stateDir).mode & 0o777, 0o700, 'state_dirが0700ではない');
      const dbPath = path.join(fixture.stateDir, 'collector.sqlite3');
      assert.equal(statSync(dbPath).mode & 0o777, 0o600, 'SQLiteファイルが0600ではない');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('既存sourceのproject再割当を拒否し、未送信分を別案件へ流さない', async () => {
    const projectA = randomUUID();
    const projectB = randomUUID();
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: projectA } });
    const mock = installFetchMock(() => jsonResponse(500, { error: { code: 'internal_error' } }));
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '未送信の本文' }),
      ]);
      const hook = buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir });
      await collectFromHook({ source: 'codex', hook, config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, 1);
      const originalBody = mock.requests[0].body;

      const reassigned = buildCollectorConfig({
        state_dir: fixture.stateDir,
        projects: [{ repository: 'github.com/Org/Repo', project_id: projectB }],
      });
      mock.setResponder(ackResponse);
      await flushCollector({ config: reassigned, token: 'token-a' });
      assert.equal(mock.requests.length, 1, '再割当後のprojectへ送信している');
      assert.ok(!parseSentBatches(mock.requests).some((batch) => batch.project_id === projectB));

      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, 2, '再割当を拒否した後に元のprojectへ再送できていない');
      assert.equal(mock.requests[1].body, originalBody);
      const [batch] = parseSentBatches([mock.requests[1]]);
      assert.equal(batch.project_id, projectA);
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('同じsessionを並行collectしても同じ発言を重複して取り込まない', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '並行1' }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'assistant', text: '並行2' }),
      ]);
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };

      await Promise.all([collectFromHook(options), collectFromHook(options)]);

      const events = sentEvents(mock.requests);
      const keysByMessage = new Map(events.map((event) => [event.source_message_id, event.idempotency_key]));
      assert.deepEqual([...keysByMessage.keys()].sort(), ['item-1', 'item-2'], '同じ発言を重複して取り込んでいる');
      assert.equal(new Set(events.map((event) => event.sequence_no)).size, 2);
      for (const request of mock.requests) {
        const [batch] = parseSentBatches([request]);
        assert.equal(new Set(batch.events.map((event) => event.source_message_id)).size, batch.events.length, '同一batch内で発言が重複している');
      }

      const requestsBefore = mock.requests.length;
      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, requestsBefore, '並行collect後にoutboxが残っている');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('transcriptが別inodeへ差し替わっても旧offsetを新fileへ適用せず、全発言を重複なく取り込む', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '差替え前' }),
      ]);
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };
      await collectFromHook(options);
      assert.equal(mock.requests.length, 1);

      // 同じpathへ別inodeのfileを置き、旧cursorのoffsetを新fileの途中として扱わないことを確認する。
      const replacement = path.join(fixture.root, 'replacement.jsonl');
      await writeTranscript(replacement, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '差替え前' }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'assistant', text: '差替え後' }),
      ]);
      renameSync(replacement, transcript);

      await collectFromHook(options);
      assert.equal(mock.requests.length, 2, '別inodeの全文を読み直していない');
      assert.deepEqual(
        sentEvents([mock.requests[1]]).map((event) => [event.source_message_id, event.sequence_no]),
        [['item-2', 2]],
      );
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('設定から外れたprojectのoutboxは、別の登録済みprojectのcollectでも送らない', async () => {
    const root = await makeTempDir();
    const removedProject = randomUUID();
    const activeProject = randomUUID();
    const mock = installFetchMock(ackResponse);
    try {
      const repoA = path.join(root, 'repo-a');
      const repoB = path.join(root, 'repo-b');
      await createGitRepository(repoA, 'https://github.com/Org/A.git');
      await createGitRepository(repoB, 'https://github.com/Org/B.git');
      const stateDir = path.join(root, 'state');
      const configA = buildCollectorConfig({
        state_dir: stateDir,
        projects: [{ repository: 'github.com/Org/A', project_id: removedProject }],
      });
      const transcriptA = path.join(root, 'a.jsonl');
      await writeTranscript(transcriptA, [
        codexSessionLine('session-a'),
        codexMessageLine({ sessionId: 'session-a', messageId: 'a-1', role: 'user', text: '撤去される本文' }),
      ]);
      // 送信前にプロセスが落ちた状態を作る: ingestだけ行い、outboxをbackoff/failedなしで保持する。
      const state = openCollectorState(stateDir);
      try {
        const result = ingestTranscript(state, {
          namespace: collectorNamespace(configA.api_url, 'token-a'),
          source: 'codex',
          hook: buildHook({ session_id: 'session-a', transcript_path: transcriptA, cwd: repoA }),
          repository: 'github.com/Org/A',
          projectId: removedProject,
        });
        assert.equal(result.held, false);
      } finally {
        closeCollectorState(state);
      }
      assert.equal(mock.requests.length, 0);

      // repo Aを設定から外し、repo Bだけを登録してcollectする。Aの未送信outboxは保持する。
      const configB = buildCollectorConfig({
        state_dir: stateDir,
        projects: [{ repository: 'github.com/Org/B', project_id: activeProject }],
      });
      const transcriptB = path.join(root, 'b.jsonl');
      await writeTranscript(transcriptB, [
        codexSessionLine('session-b'),
        codexMessageLine({ sessionId: 'session-b', messageId: 'b-1', role: 'user', text: 'Bの本文' }),
      ]);
      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-b', transcript_path: transcriptB, cwd: repoB }),
        config: configB,
        token: 'token-a',
      });

      assert.equal(mock.requests.length, 1);
      const [sentAfterRemoval] = parseSentBatches([mock.requests[0]]);
      assert.equal(sentAfterRemoval.project_id, activeProject, '設定から外れたprojectのoutboxを送信している');
      assert.ok(!mock.requests[0].body.includes('撤去される本文'));

      // 設定へAを戻したflushでは、保持していたoutboxを元のprojectへ送信できる。
      await flushCollector({ config: configA, token: 'token-a' });
      assert.equal(mock.requests.length, 2, '保持したoutboxを設定復帰後のflushで送れていない');
      const [restored] = parseSentBatches([mock.requests[1]]);
      assert.equal(restored.project_id, removedProject);
      assert.deepEqual(
        restored.events.map((event) => event.source_message_id),
        ['a-1'],
      );
    } finally {
      mock.restore();
      await removeTempDir(root);
    }
  });
});
