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
});
