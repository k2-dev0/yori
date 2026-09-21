import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MAX_BATCH_SIZE, MAX_EVENT_BODY_BYTES } from '../../api/contract.js';
import { collectFromHook, flushCollector, ingestTranscript } from '../collect.js';
import { closeCollectorState, collectorNamespace, openCollectorState } from '../state.js';
import {
  ackBodyFor,
  ackResponse,
  appendTranscript,
  buildCollectorConfig,
  buildHook,
  codexMessageLine,
  codexSessionLine,
  createCollectorFixture,
  createGitRepository,
  installFetchMock,
  jsonResponse,
  makeTempDir,
  parseSentBatches,
  removeTempDir,
  sentEvents,
  type FetchMock,
  type FetchResponder,
  writeTranscript,
} from './support.js';

// 1件のCodex発言を送信失敗させてoutboxへ残す。以降のflushで再送挙動を検証する。
async function seedFailedOutbox(fixture: Awaited<ReturnType<typeof createCollectorFixture>>, mock: FetchMock, token = 'token-a'): Promise<string> {
  const transcript = path.join(fixture.root, 'codex.jsonl');
  await writeTranscript(transcript, [
    codexSessionLine('session-1'),
    codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '再送対象の本文' }),
  ]);
  await collectFromHook({
    source: 'codex',
    hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
    config: fixture.config,
    token,
  });
  assert.equal(mock.requests.length, 1, 'collectが送信を試みていない');
  return mock.requests[0].body;
}

describe('outbox送信', () => {
  it('202のresultsが件数・識別子・revision・型まで一致した時だけackし、欠落・不正では保持する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(() => jsonResponse(500, { error: { code: 'internal_error' } }));
    try {
      const originalBody = await seedFailedOutbox(fixture, mock);
      const badResponders: FetchResponder[] = [
        () => jsonResponse(202, {}),
        () => jsonResponse(202, { results: [] }),
        (request) => jsonResponse(202, ackBodyFor(request, (event) => ({ idempotency_key: `${event.idempotency_key}-other` }))),
        (request) => jsonResponse(202, ackBodyFor(request, () => ({ revision: 99 }))),
        (request) => jsonResponse(202, ackBodyFor(request, () => ({ message_id: null }))),
        (request) => jsonResponse(202, ackBodyFor(request, () => ({ message_id: '' }))),
        (request) => jsonResponse(202, ackBodyFor(request, () => ({ message_id: 'not-a-uuid' }))),
        (request) => jsonResponse(202, ackBodyFor(request, () => ({ request_id: 42 }))),
        (request) => jsonResponse(202, ackBodyFor(request, () => ({ request_id: '' }))),
        (request) => {
          const body = ackBodyFor(request);
          return jsonResponse(202, { results: [...body.results, body.results[0]] });
        },
        () => new Response('not json', { status: 202 }),
        (request) => jsonResponse(200, ackBodyFor(request)),
        (request) => jsonResponse(302, ackBodyFor(request)),
      ];

      for (let index = 0; index < badResponders.length; index += 1) {
        mock.setResponder(badResponders[index]);
        await flushCollector({ config: fixture.config, token: 'token-a' });
        assert.equal(mock.requests.length, index + 2, `非ack応答 ${index} でoutboxを削除している`);
        assert.equal(mock.requests[mock.requests.length - 1].body, originalBody, `非ack応答 ${index} で再送bodyが変わっている`);
      }

      mock.setResponder(ackResponse);
      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, badResponders.length + 2);
      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, badResponders.length + 2, 'ack後の再送でoutboxを消していない');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('通信障害・429/5xx/恒久エラーでは同じbodyを保持し、明示flushで同じ識別子を再送する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(() => {
      throw new TypeError('fetch failed');
    });
    try {
      const originalBody = await seedFailedOutbox(fixture, mock);

      // 自動collectはbackoff対象。時刻を待たない再collectでは同じbatchを再試行しない。
      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-1', transcript_path: path.join(fixture.root, 'codex.jsonl'), cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });
      assert.equal(mock.requests.length, 1, '自動collectがbackoffを待たず再試行している');

      const failureResponders: FetchResponder[] = [
        () => new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } }),
        () => jsonResponse(500, { error: { code: 'internal_error' } }),
        () => jsonResponse(401, { error: { code: 'unauthorized' } }),
        () => jsonResponse(403, { error: { code: 'forbidden' } }),
        () => jsonResponse(400, { error: { code: 'invalid_request' } }),
        () => jsonResponse(409, { error: { code: 'conflict' } }),
        () => {
          throw new TypeError('fetch failed');
        },
      ];
      for (let index = 0; index < failureResponders.length; index += 1) {
        mock.setResponder(failureResponders[index]);
        await flushCollector({ config: fixture.config, token: 'token-a' });
        assert.equal(mock.requests.length, index + 2, `失敗応答 ${index} で送信をスキップまたは連打している`);
        assert.equal(mock.requests[mock.requests.length - 1].body, originalBody);
      }

      mock.setResponder(ackResponse);
      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, failureResponders.length + 2);
      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, failureResponders.length + 2);
      for (const request of mock.requests) {
        assert.equal(request.body, originalBody);
        assert.equal(request.headers.authorization, 'Bearer token-a');
      }
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('恒久エラーはfailedとして自動collectを抑止し、明示flushのackで復帰する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(() => jsonResponse(401, { error: { code: 'unauthorized' } }));
    const transcript = path.join(fixture.root, 'codex.jsonl');
    const hook = buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir });
    try {
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '最初の本文' }),
      ]);
      await collectFromHook({ source: 'codex', hook, config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, 1, '恒久エラーの初回collectが送信していない');

      // failed中は新規発言を取り込んでも自動collectで送信しない（backoff待ちとは別の抑止）。
      await appendTranscript(transcript, `${codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'assistant', text: '次の本文' })}\n`);
      await collectFromHook({ source: 'codex', hook, config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, 1, 'failed中の自動collectが再送している');

      // 明示flushはfailedでも再試行し、ackでfailedを解除する。
      mock.setResponder(ackResponse);
      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, 2);
      const [batch] = parseSentBatches([mock.requests[1]]);
      assert.deepEqual(
        batch.events.map((event) => event.source_message_id),
        ['item-1', 'item-2'],
      );

      await appendTranscript(transcript, `${codexMessageLine({ sessionId: 'session-1', messageId: 'item-3', role: 'user', text: '復帰後の本文' })}\n`);
      await collectFromHook({ source: 'codex', hook, config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, 3, 'ack後にfailedが解除されず自動collectが抑止されている');
      assert.deepEqual(
        sentEvents([mock.requests[2]]).map((event) => event.source_message_id),
        ['item-3'],
      );
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('batchを100件以内に分割し、全件をsequence順に重複なく送る', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const lines = Array.from({ length: 150 }, (_, index) =>
        codexMessageLine({
          sessionId: 'session-1',
          messageId: `item-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          text: `本文-${index}`,
        }),
      );
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [codexSessionLine('session-1'), ...lines]);
      const hook = buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir });
      await collectFromHook({ source: 'codex', hook, config: fixture.config, token: 'token-a' });
      assert.ok(sentEvents(mock.requests).length <= MAX_BATCH_SIZE, '1回の送信予算100件を超えている');

      let previousRequests = -1;
      for (let attempt = 0; attempt < 5 && mock.requests.length !== previousRequests; attempt += 1) {
        previousRequests = mock.requests.length;
        await flushCollector({ config: fixture.config, token: 'token-a' });
      }

      const events = sentEvents(mock.requests);
      assert.equal(events.length, 150);
      assert.equal(new Set(events.map((event) => event.source_message_id)).size, 150);
      assert.deepEqual(
        events.map((event) => event.sequence_no),
        Array.from({ length: 150 }, (_, index) => index + 1),
      );
      for (const request of mock.requests) {
        assert.ok(parseSentBatches([request])[0].events.length <= MAX_BATCH_SIZE);
        assert.ok(Buffer.byteLength(request.body, 'utf8') <= MAX_EVENT_BODY_BYTES);
      }
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('1MiBを超えるbatchはbody上限以内へ分割する', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const lines = Array.from({ length: 30 }, (_, index) =>
        codexMessageLine({ sessionId: 'session-1', messageId: `item-${index}`, role: 'user', text: `${`${index}`.padStart(4, '0')}${'y'.repeat(40_000)}` }),
      );
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [codexSessionLine('session-1'), ...lines]);
      const hook = buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir });
      await collectFromHook({ source: 'codex', hook, config: fixture.config, token: 'token-a' });

      let previousRequests = -1;
      for (let attempt = 0; attempt < 5 && mock.requests.length !== previousRequests; attempt += 1) {
        previousRequests = mock.requests.length;
        await flushCollector({ config: fixture.config, token: 'token-a' });
      }

      const events = sentEvents(mock.requests);
      assert.equal(events.length, 30);
      assert.equal(new Set(events.map((event) => event.source_message_id)).size, 30);
      for (const request of mock.requests) {
        assert.ok(Buffer.byteLength(request.body, 'utf8') <= MAX_EVENT_BODY_BYTES, '1MiBを超えるbodyを送っている');
      }
      assert.ok(mock.requests.length >= 2, '1MiB超のbatchを分割していない');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('tokenが変わったnamespaceのoutboxを新資格情報で送らない', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(() => jsonResponse(500, { error: { code: 'internal_error' } }));
    try {
      const originalBody = await seedFailedOutbox(fixture, mock, 'token-a');

      mock.setResponder(ackResponse);
      await flushCollector({ config: fixture.config, token: 'token-b' });
      assert.equal(mock.requests.length, 1, '別tokenのnamespaceへ送信している');
      assert.ok(mock.requests.every((request) => request.headers.authorization !== 'Bearer token-b'));

      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, 2);
      assert.equal(mock.requests[1].body, originalBody);
      assert.equal(mock.requests[1].headers.authorization, 'Bearer token-a');

      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, 2, 'ack後にoutboxを消していない');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('同じproject_idの複数repositoryをすべて送信し、設定から外れたrepositoryのoutboxは保持する', async () => {
    const root = await makeTempDir();
    const projectId = randomUUID();
    const mock = installFetchMock(ackResponse);
    try {
      const repoA = path.join(root, 'repo-a');
      const repoB = path.join(root, 'repo-b');
      await createGitRepository(repoA, 'https://github.com/Org/A.git');
      await createGitRepository(repoB, 'https://github.com/Org/B.git');
      const stateDir = path.join(root, 'state');
      const config = buildCollectorConfig({
        state_dir: stateDir,
        projects: [
          { repository: 'github.com/Org/A', project_id: projectId },
          { repository: 'github.com/Org/B', project_id: projectId },
        ],
      });
      const transcriptA = path.join(root, 'a.jsonl');
      const transcriptB = path.join(root, 'b.jsonl');
      await writeTranscript(transcriptA, [
        codexSessionLine('session-a'),
        codexMessageLine({ sessionId: 'session-a', messageId: 'a-1', role: 'user', text: 'repository Aの本文' }),
      ]);
      await writeTranscript(transcriptB, [
        codexSessionLine('session-b'),
        codexMessageLine({ sessionId: 'session-b', messageId: 'b-1', role: 'user', text: 'repository Bの本文' }),
      ]);

      const namespace = collectorNamespace(config.api_url, 'token-a');
      const ingest = (state: ReturnType<typeof openCollectorState>, sessionId: string, transcriptPath: string, cwd: string, repository: string) =>
        ingestTranscript(state, {
          namespace,
          source: 'codex',
          hook: buildHook({ session_id: sessionId, transcript_path: transcriptPath, cwd }),
          repository,
          projectId,
        });

      // 送信前に両repository分をingestし、outboxの2ペアを並べる。
      const state = openCollectorState(stateDir);
      try {
        assert.equal(ingest(state, 'session-a', transcriptA, repoA, 'github.com/Org/A').held, false);
        assert.equal(ingest(state, 'session-b', transcriptB, repoB, 'github.com/Org/B').held, false);
      } finally {
        closeCollectorState(state);
      }
      assert.equal(mock.requests.length, 0);

      await flushCollector({ config, token: 'token-a' });
      assert.deepEqual(
        sentEvents(mock.requests)
          .map((event) => [event.source_scope, event.text])
          .sort(),
        [
          ['github.com/Org/A', 'repository Aの本文'],
          ['github.com/Org/B', 'repository Bの本文'],
        ].sort(),
      );

      // 続きの発言を追加し、片方のrepositoryを設定から外しても、そのoutboxだけ保持する。
      await appendTranscript(transcriptA, `${codexMessageLine({ sessionId: 'session-a', messageId: 'a-2', role: 'assistant', text: 'Aの続き' })}\n`);
      await appendTranscript(transcriptB, `${codexMessageLine({ sessionId: 'session-b', messageId: 'b-2', role: 'assistant', text: 'Bの続き' })}\n`);
      const state2 = openCollectorState(stateDir);
      try {
        assert.equal(ingest(state2, 'session-a', transcriptA, repoA, 'github.com/Org/A').held, false);
        assert.equal(ingest(state2, 'session-b', transcriptB, repoB, 'github.com/Org/B').held, false);
      } finally {
        closeCollectorState(state2);
      }

      // 同じprojectのsourceが設定から外れている間は、既存のproject単位の保護どおりoutboxを保持する。
      const configWithoutB = buildCollectorConfig({ state_dir: stateDir, projects: [{ repository: 'github.com/Org/A', project_id: projectId }] });
      await flushCollector({ config: configWithoutB, token: 'token-a' });
      assert.equal(mock.requests.length, 2, '設定から外れたrepositoryを含むprojectのoutboxを送信している');
      assert.ok(!mock.requests.slice(2).some((request) => request.body.includes('Bの続き')));

      // 両repositoryを設定へ戻したflushで、保持していたoutboxを元のscopeへ送る。
      await flushCollector({ config, token: 'token-a' });
      assert.deepEqual(
        sentEvents(mock.requests.slice(2))
          .map((event) => [event.source_message_id, event.source_scope])
          .sort(),
        [
          ['a-2', 'github.com/Org/A'],
          ['b-2', 'github.com/Org/B'],
        ].sort(),
      );
    } finally {
      mock.restore();
      await removeTempDir(root);
    }
  });

  it('改行入りIDの組が衝突せず、送信失敗で両方をoutboxへ残して別keyで送る', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(() => jsonResponse(500, { error: { code: 'internal_error' } }));
    const transcriptA = path.join(fixture.root, 'newline-a.jsonl');
    const transcriptB = path.join(fixture.root, 'newline-b.jsonl');
    // join('\n')では'a\nb'/'c'と'a'/'b\nc'が同じhash入力になる組。
    const hookA = buildHook({ session_id: 'a\nb', transcript_path: transcriptA, cwd: fixture.repoDir });
    const hookB = buildHook({ session_id: 'a', transcript_path: transcriptB, cwd: fixture.repoDir });
    try {
      await writeTranscript(transcriptA, [
        codexSessionLine('a\nb'),
        codexMessageLine({ sessionId: 'a\nb', messageId: 'c', role: 'user', text: '改行IDの本文A' }),
      ]);
      await writeTranscript(transcriptB, [
        codexSessionLine('a'),
        codexMessageLine({ sessionId: 'a', messageId: 'b\nc', role: 'user', text: '改行IDの本文B' }),
      ]);

      // 送信を失敗させ、衝突する組の両方がoutboxへ残ることを確認する。
      await collectFromHook({ source: 'codex', hook: hookA, config: fixture.config, token: 'token-a' });
      await collectFromHook({ source: 'codex', hook: hookB, config: fixture.config, token: 'token-a' });
      const state = openCollectorState(fixture.stateDir);
      try {
        const outboxCount = Number((state.db.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count);
        assert.equal(outboxCount, 2, '改行入りIDの組がoutboxで衝突している');
      } finally {
        closeCollectorState(state);
      }

      // ackで両方を送り、keyが異なることと原文・元IDが保持されることを確認する。
      const failedRequests = mock.requests.length;
      mock.setResponder(ackResponse);
      await flushCollector({ config: fixture.config, token: 'token-a' });
      const events = sentEvents(mock.requests.slice(failedRequests));
      assert.equal(events.length, 2, '衝突する組の両方を送信していない');
      assert.equal(new Set(events.map((event) => event.idempotency_key)).size, 2, '改行入りIDの組が同じidempotency_keyになっている');
      assert.deepEqual(
        events.map((event) => [event.source_session_id, event.source_message_id, event.text]).sort(),
        [
          ['a', 'b\nc', '改行IDの本文B'],
          ['a\nb', 'c', '改行IDの本文A'],
        ].sort(),
      );

      // ack後の再取込・flushではoutboxが増えず、再送もしない。
      await collectFromHook({ source: 'codex', hook: hookA, config: fixture.config, token: 'token-a' });
      await collectFromHook({ source: 'codex', hook: hookB, config: fixture.config, token: 'token-a' });
      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, failedRequests + 1, 'ack後の再取込で同じ発言を再送している');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('先行分をack済みでも、改行位置違いのID組は後続と異なるkeyになる', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    const transcriptA = path.join(fixture.root, 'newline-a.jsonl');
    const transcriptB = path.join(fixture.root, 'newline-b.jsonl');
    const hookA = buildHook({ session_id: 'a\nb', transcript_path: transcriptA, cwd: fixture.repoDir });
    const hookB = buildHook({ session_id: 'a', transcript_path: transcriptB, cwd: fixture.repoDir });
    try {
      await writeTranscript(transcriptA, [
        codexSessionLine('a\nb'),
        codexMessageLine({ sessionId: 'a\nb', messageId: 'c', role: 'user', text: '先行分の本文' }),
      ]);
      await writeTranscript(transcriptB, [
        codexSessionLine('a'),
        codexMessageLine({ sessionId: 'a', messageId: 'b\nc', role: 'user', text: '後続分の本文' }),
      ]);

      await collectFromHook({ source: 'codex', hook: hookA, config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, 1, '先行分を送信していない');
      const firstKey = sentEvents([mock.requests[0]])[0].idempotency_key;

      await collectFromHook({ source: 'codex', hook: hookB, config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, 2, '先行ack後の後続分を送信していない');
      const second = sentEvents([mock.requests[1]])[0];
      assert.equal(second.source_session_id, 'a');
      assert.equal(second.source_message_id, 'b\nc');
      assert.notEqual(firstKey, second.idempotency_key, '改行位置違いのID組が同じkeyになっている');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('アップグレード前の方式で保存済みのoutboxは、再送でも保存済みkey・本文のまま送る', async () => {
    const projectId = randomUUID();
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: projectId } });
    const mock = installFetchMock(() => jsonResponse(500, { error: { code: 'internal_error' } }));
    try {
      const namespace = collectorNamespace(fixture.config.api_url, 'token-a');
      // 変更前のjoin('\n')方式で生成済みのoutbox行をSQLite fixtureとして再現する。
      const legacyKey = createHash('sha256')
        .update([namespace, 'codex', 'github.com/Org/Repo', 'session-1', 'item-1', '1'].join('\n'))
        .digest('hex');
      const state = openCollectorState(fixture.stateDir);
      try {
        state.db
          .prepare(
            `INSERT INTO outbox (namespace, idempotency_key, project_id, source, source_scope, source_session_id, source_message_id, sequence_no, revision, role, occurred_at, text, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            namespace,
            legacyKey,
            projectId,
            'codex',
            'github.com/Org/Repo',
            'session-1',
            'item-1',
            1,
            1,
            'user',
            '2026-09-21T00:00:01.000Z',
            'アップグレード前の本文',
            Date.now(),
          );
      } finally {
        closeCollectorState(state);
      }

      // 保存済み行の再送でもkey・bodyを再計算せず、同じ内容で送る。
      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, 1);
      const failedBody = mock.requests[0].body;
      mock.setResponder(ackResponse);
      await flushCollector({ config: fixture.config, token: 'token-a' });
      assert.equal(mock.requests.length, 2);
      assert.equal(mock.requests[1].body, failedBody, '保存済みoutboxの再送bodyが変わっている');
      const [event] = sentEvents([mock.requests[1]]);
      assert.equal(event.idempotency_key, legacyKey, '保存済みのidempotency_keyを書き換えている');
      assert.equal(event.text, 'アップグレード前の本文', '保存済みの本文を書き換えている');
      assert.equal(event.source_message_id, 'item-1');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });
});
