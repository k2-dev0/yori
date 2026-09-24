import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { processJob } from '../process.js';
import {
  buildWorkerConfig,
  claimJobForMessage,
  countAnalysis,
  countJobsByKind,
  jevChoices,
  jevReply,
  matchedResult,
  minutesAgo,
  minutesFromNow,
  readJob,
  readSearchRequest,
  seedApproval,
  seedMessage,
  seedSearchRequest,
  seedSession,
  seedUserMessage,
  setJobStatus,
  startFakeJev,
  type FakeJevServer,
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

async function processRoute(messageId: string, server: FakeJevServer): Promise<string> {
  const job = await claimJobForMessage(pool, 'route_search', messageId);
  await processJob(pool, job, buildWorkerConfig(server.baseUrl));
  return job.id;
}

describe('検索振り分け', () => {
  it('分類がblockedでもroute_searchは独立してnew_searchを登録する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: '新しい症状が出ました' });
    await setJobStatus(pool, seeded.classifyJobId, 'blocked_policy');
    const server = await startFakeJev((request) => ({
      body: jevReply(request, jevChoices({ retention: 'substantive', search_action: 'new_search' })),
    }));
    try {
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: buildWorkerConfig(server.baseUrl).apiUrl });
      const jobId = await processRoute(seeded.messageId, server);
      assert.equal(server.requests.length, 1, 'Jev呼出し回数が1回でない');
      const request = await readSearchRequest(pool, seeded.searchRequestId);
      assert.equal(request.search_action, 'new_search', 'search_actionが保存されていない');
      assert.equal(request.status, 'pending', 'new_searchの受付はpendingのままにする');
      assert.equal(request.error_code, null);
      assert.equal(request.reused_from_request_id, null);
      assert.equal(request.result, null);
      assert.equal(await countJobsByKind(pool, 'execute_search'), 1, 'execute_search jobがpendingで保存されていない');
      assert.equal((await readJob(pool, seeded.classifyJobId)).status, 'blocked_policy', '経路が分類jobの状態を変えている');
      assert.equal((await readJob(pool, jobId)).status, 'completed');
      assert.equal(await countAnalysis(pool), 0, 'routeが分類結果を適用している');
    } finally {
      await server.close();
    }
  });

  it('条件不変の承認はreuseとして先行requestを参照し、結果をコピーしない', async () => {
    const sessionId = await seedSession(pool, workspace);
    const evidence = await seedMessage(pool, { sessionId, sequenceNo: 1, role: 'assistant', text: '以前のキャッシュ修正報告' });
    const prior = await seedMessage(pool, { sessionId, sequenceNo: 2, role: 'user', text: '前回の質問' });
    const priorRequestId = await seedSearchRequest(pool, {
      workspace,
      sessionId,
      inputId: prior.messageId,
      sequenceNo: 2,
      status: 'completed',
      outcome: 'matched',
      searchAction: 'new_search',
      result: matchedResult([
        {
          messageId: evidence.messageId,
          revision: 1,
          employeeId: workspace.employeeId,
          role: 'assistant',
          occurredAt: new Date().toISOString(),
          text: '以前のキャッシュ修正報告',
        },
      ]),
      createdAt: minutesAgo(5),
      expiresAt: minutesFromNow(5),
    });
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 3, text: '同じ症状です' });
    const server = await startFakeJev((request) => ({
      body: jevReply(
        request,
        jevChoices({ retention: 'progress_only', search_action: 'reuse', continuity: 'same_topic', same_conditions: 'yes' }),
      ),
    }));
    try {
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: buildWorkerConfig(server.baseUrl).apiUrl });
      await processRoute(seeded.messageId, server);
      const request = await readSearchRequest(pool, seeded.searchRequestId);
      assert.equal(request.reused_from_request_id, priorRequestId, '先行requestを参照していない');
      assert.equal(request.result, null, '先行結果を新規結果としてコピーしている');
      assert.equal(await countJobsByKind(pool, 'execute_search'), 0, 'reuseで新規検索を登録している');
    } finally {
      await server.close();
    }
  });

  it('進行のみのskipはcompleted/skippedとして検索を登録しない', async () => {
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: '続けてください' });
    const server = await startFakeJev((request) => ({
      body: jevReply(request, jevChoices({ retention: 'progress_only', search_action: 'skip' })),
    }));
    try {
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: buildWorkerConfig(server.baseUrl).apiUrl });
      await processRoute(seeded.messageId, server);
      const request = await readSearchRequest(pool, seeded.searchRequestId);
      assert.equal(request.status, 'completed');
      assert.equal(request.outcome, 'skipped');
      assert.equal(request.reused_from_request_id, null);
      assert.equal(await countJobsByKind(pool, 'execute_search'), 0, 'skipでexecute_searchを登録している');
    } finally {
      await server.close();
    }
  });
});
