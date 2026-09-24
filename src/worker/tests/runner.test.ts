import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { claimJobs } from '../../jobs/queue.js';
import { runWorker } from '../runner.js';
import {
  buildWorkerConfig,
  countJobsByKind,
  jevChoices,
  jevReply,
  readAnalysis,
  readJob,
  readSearchRequest,
  seedSession,
  seedUserMessage,
  sleep,
  startApprovedJev,
} from './support.js';

const pool = createPool(requireDatabaseUrl());
let workspace: WorkspaceFixture;

before(async () => {
  await runMigrations(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
  workspace = await seedWorkspace(pool);
});

after(async () => {
  await pool.end();
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await sleep(20);
  }
  assert.fail('条件がtimeoutまでに成立しない');
}

async function bothCompleted(classifyJobId: string, routeJobId: string): Promise<boolean> {
  return (await readJob(pool, classifyJobId)).status === 'completed' && (await readJob(pool, routeJobId)).status === 'completed';
}

describe('worker runner', () => {
  it('classify/routeの2 laneでjobを処理し、abortで新規claimを止める', async () => {
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: 'runnerで処理する発言' });
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({
      body: jevReply(request, jevChoices({ retention: 'substantive', search_action: 'new_search' })),
    }));
    const controller = new AbortController();
    try {
      const running = runWorker({
        pool,
        config: buildWorkerConfig(server.baseUrl),
        pollIntervalMs: 10,
        signal: controller.signal,
      });
      await waitFor(() => bothCompleted(seeded.classifyJobId, seeded.routeJobId));
      controller.abort();
      await running;
      assert.ok(server.requests.length >= 1, 'runnerがJevを呼んでいない');
      assert.ok(await readAnalysis(pool, seeded.messageId, 1), 'classifyの分析が保存されていない');
      const request = await readSearchRequest(pool, seeded.searchRequestId);
      assert.equal(request.search_action, 'new_search');
      assert.equal(await countJobsByKind(pool, 'build_documents'), 1);
      assert.equal(await countJobsByKind(pool, 'execute_search'), 1);
      // M4以降のrunnerはclassifyとbuild_documentsを同じ外部処理laneでclaimし、execute_searchはM5までclaimしない。
      assert.equal((await readJob(pool, seeded.classifyJobId)).status, 'completed');
      assert.equal((await readJob(pool, seeded.routeJobId)).status, 'completed');
    } finally {
      controller.abort();
      await server.close();
    }
  });

  it('起動時の回収でlease期限切れjobをpendingへ戻して処理する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: '回収対象の発言' });
    const [claimed] = await claimJobs(pool, { kinds: ['classify_message'], limit: 1, leaseMs: 1 });
    assert.ok(claimed, 'classify jobをclaimできない');
    assert.equal((await readJob(pool, claimed.id)).status, 'running');
    await sleep(30);

    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({
      body: jevReply(request, jevChoices({ retention: 'substantive', search_action: 'new_search' })),
    }));
    const controller = new AbortController();
    try {
      const running = runWorker({
        pool,
        config: buildWorkerConfig(server.baseUrl),
        pollIntervalMs: 10,
        signal: controller.signal,
      });
      await waitFor(() => bothCompleted(seeded.classifyJobId, seeded.routeJobId));
      controller.abort();
      await running;
      assert.equal((await readJob(pool, seeded.classifyJobId)).status, 'completed');
      assert.ok(await readAnalysis(pool, seeded.messageId, 1), '回収後に分析が保存されていない');
    } finally {
      controller.abort();
      await server.close();
    }
  });
  it('poll待機を繰り返してもabort listenerを増やさず、停止後に解放する', async () => {
    const controller = new AbortController();
    const running = runWorker({
      pool,
      config: buildWorkerConfig('http://127.0.0.1:1'),
      pollIntervalMs: 5,
      signal: controller.signal,
    });
    try {
      await waitFor(async () => getEventListeners(controller.signal, 'abort').length > 0);
      // 複数poll分待っても、laneごとの現在の待機1件を超えてlistenerが累積しない。
      await sleep(60);
      const during = getEventListeners(controller.signal, 'abort').length;
      assert.ok(during >= 1, `待機中のabort listenerがない: ${during}`);
      assert.ok(during <= 3, `poll待機でabort listenerが累積している: ${during}`);
    } finally {
      controller.abort();
      await running;
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, '停止後もabort listenerが残っている');
  });
});
