import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { processJob } from '../process.js';
import {
  buildWorkerConfig,
  claimJobForMessage,
  countJobsByKind,
  jevChoices,
  jevReply,
  readAnalysis,
  readEvaluations,
  readJob,
  readSearchRequest,
  seedApproval,
  seedSession,
  seedUserMessage,
  startApprovedJev,
  startFakeJev,
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

describe('Jev評価キャッシュ', () => {
  it('同じstateのrouteはclassifyの完了済み評価を再利用し、外部呼出しを増やさない', async () => {
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: 'キャッシュ確認の対象発言' });
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({
      body: jevReply(request, jevChoices({ retention: 'substantive', search_action: 'new_search' })),
    }));
    try {
      const config = buildWorkerConfig(server.baseUrl);
      const classifyJob = await claimJobForMessage(pool, 'classify_message', seeded.messageId);
      await processJob(pool, classifyJob, config);
      assert.equal(server.requests.length, 1, 'classifyが外部評価していない');
      assert.ok(await readAnalysis(pool, seeded.messageId, 1), 'classifyの分析が保存されていない');

      const routeJob = await claimJobForMessage(pool, 'route_search', seeded.messageId);
      await processJob(pool, routeJob, config);
      assert.equal(server.requests.length, 1, 'cacheがあるのにrouteが再評価している');
      assert.equal((await readJob(pool, routeJob.id)).status, 'completed');
      const request = await readSearchRequest(pool, seeded.searchRequestId);
      assert.equal(request.search_action, 'new_search');
      assert.equal(await countJobsByKind(pool, 'execute_search'), 1);
    } finally {
      await server.close();
    }
  });

  it('承認失効時は完了済みcacheがあっても送信せずblocked_policyにする', async () => {
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: '失効cacheの対象発言' });
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({
      body: jevReply(request, jevChoices({ retention: 'substantive', search_action: 'new_search' })),
    }));
    try {
      const config = buildWorkerConfig(server.baseUrl);
      const classifyJob = await claimJobForMessage(pool, 'classify_message', seeded.messageId);
      await processJob(pool, classifyJob, config);
      assert.equal(server.requests.length, 1);
      await pool.query('UPDATE provider_policy_approvals SET active = false WHERE company_id = $1 AND endpoint = $2', [
        workspace.companyId,
        config.apiUrl,
      ]);

      const routeJob = await claimJobForMessage(pool, 'route_search', seeded.messageId);
      await processJob(pool, routeJob, config);
      assert.equal((await readJob(pool, routeJob.id)).status, 'blocked_policy');
      assert.equal(server.requests.length, 1, '承認失効後もcacheから外部送信している');
      const request = await readSearchRequest(pool, seeded.searchRequestId);
      assert.equal(request.status, 'failed');
      assert.equal(request.error_code, 'provider_policy_unverified');
    } finally {
      await server.close();
    }
  });

  it('別endpoint/accountのcacheは共有しない', async () => {
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: 'cache境界の対象発言' });
    const first = await startApprovedJev(pool, workspace.companyId, (request) => ({
      body: jevReply(request, jevChoices({ retention: 'substantive', search_action: 'new_search' })),
    }));
    const second = await startFakeJev((request) => ({
      body: jevReply(request, jevChoices({ retention: 'substantive', search_action: 'new_search' })),
    }));
    try {
      const firstConfig = buildWorkerConfig(first.baseUrl);
      const classifyJob = await claimJobForMessage(pool, 'classify_message', seeded.messageId);
      await processJob(pool, classifyJob, firstConfig);
      assert.equal(first.requests.length, 1);

      const secondConfig = buildWorkerConfig(second.baseUrl, { accountRef: 'acct-b' });
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: secondConfig.apiUrl, accountRef: 'acct-b' });
      const routeJob = await claimJobForMessage(pool, 'route_search', seeded.messageId);
      await processJob(pool, routeJob, secondConfig);
      assert.equal(second.requests.length, 1, '別endpoint/accountでもcacheを共有している');
      assert.equal(first.requests.length, 1);
      assert.equal((await readJob(pool, routeJob.id)).status, 'completed');
      assert.equal(await countJobsByKind(pool, 'execute_search'), 1);
    } finally {
      await first.close();
      await second.close();
    }
  });
  it('応答modelがNULLの旧cacheは再評価し、実応答modelで置き換える', async () => {
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: '旧cache再評価の対象' });
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({
      body: { ...jevReply(request, jevChoices({ retention: 'substantive', search_action: 'new_search' })), model: 'jev-actual-3' },
    }));
    try {
      const config = buildWorkerConfig(server.baseUrl);
      const classifyJob = await claimJobForMessage(pool, 'classify_message', seeded.messageId);
      await processJob(pool, classifyJob, config);
      assert.equal(server.requests.length, 1);
      await pool.query('UPDATE jev_evaluations SET response_model = NULL WHERE company_id = $1', [workspace.companyId]);

      const routeJob = await claimJobForMessage(pool, 'route_search', seeded.messageId);
      await processJob(pool, routeJob, config);
      assert.equal(server.requests.length, 2, '応答model不明の旧cacheを再利用している');
      assert.equal((await readJob(pool, routeJob.id)).status, 'completed');

      const evaluations = await readEvaluations(pool, workspace.companyId);
      assert.equal(evaluations.length, 1, 'cache行が増えている');
      assert.equal(evaluations[0].model, 'jev-latest', '要求modelをcache keyとして保持していない');
      assert.equal(evaluations[0].response_model, 'jev-actual-3', '実応答modelで旧cacheを更新していない');
    } finally {
      await server.close();
    }
  });

  it('cache-hitでも実応答modelを分類のmodel_versionへ伝搬する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: 'cache経由分類の対象' });
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({
      body: { ...jevReply(request, jevChoices({ retention: 'substantive', search_action: 'new_search' })), model: 'jev-cached-9' },
    }));
    try {
      const config = buildWorkerConfig(server.baseUrl);
      const routeJob = await claimJobForMessage(pool, 'route_search', seeded.messageId);
      await processJob(pool, routeJob, config);
      assert.equal(server.requests.length, 1);

      const classifyJob = await claimJobForMessage(pool, 'classify_message', seeded.messageId);
      await processJob(pool, classifyJob, config);
      assert.equal(server.requests.length, 1, 'cacheがあるのにclassifyが再評価している');
      const analysis = await readAnalysis(pool, seeded.messageId, 1);
      assert.ok(analysis, 'cache経由の分析が保存されていない');
      assert.equal(analysis.model_version, 'jev-cached-9', '応答modelがcache経由で伝搬していない');
      assert.equal(analysis.parts[0]?.model_version, 'jev-cached-9', 'partの応答modelが伝搬していない');
    } finally {
      await server.close();
    }
  });
});
