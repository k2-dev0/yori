import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MAX_BATCH_SIZE, MAX_EVENT_BODY_BYTES } from '../../api/contract.js';
import { collectFromHook, flushCollector } from '../collect.js';
import {
  ackBodyFor,
  ackResponse,
  buildHook,
  codexMessageLine,
  codexSessionLine,
  createCollectorFixture,
  installFetchMock,
  jsonResponse,
  parseSentBatches,
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
});
