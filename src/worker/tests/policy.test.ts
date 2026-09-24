import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { processJob, retryJob } from '../process.js';
import {
  buildWorkerConfig,
  claimJobForMessage,
  countAnalysis,
  jevChoices,
  jevReply,
  readAnalysis,
  readJob,
  readRevision,
  readSearchRequest,
  readUsageEvents,
  seedApproval,
  seedSession,
  seedUserMessage,
  sleep,
  startFakeJev,
  usageEventRows,
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

async function processLane(messageId: string, kind: 'classify_message' | 'route_search', server: FakeJevServer): Promise<string> {
  const job = await claimJobForMessage(pool, kind, messageId);
  await processJob(pool, job, buildWorkerConfig(server.baseUrl));
  return job.id;
}

// job rowのlock待ちでrenewalのUPDATEが滞留していることをpg_stat_activityで観測する。
async function waitForLeaseRenewalLockWait(timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'
          AND query ILIKE '%UPDATE jobs%' AND query ILIKE '%lease_expires_at%' AND query NOT ILIKE '%pg_stat_activity%'`,
    );
    if (Number(result.rows[0]?.count ?? '0') > 0) {
      return true;
    }
    await sleep(20);
  }
  return false;
}

describe('外部送信・障害', () => {
  it('承認がない間は外部送信せずblocked_policyとして原文を保持する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const text = '承認前の原文は保持する';
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text });
    const server = await startFakeJev(() => ({ body: {} }));
    try {
      const classifyJobId = await processLane(seeded.messageId, 'classify_message', server);
      assert.equal((await readJob(pool, classifyJobId)).status, 'blocked_policy', '未承認の分類がblocked_policyでない');
      assert.equal(server.requests.length, 0, '未承認なのに外部送信している');
      assert.equal(await countAnalysis(pool), 0);
      assert.equal((await readRevision(pool, seeded.messageId, 1))?.text, text, '未承認で原文が消えている');

      const routeJobId = await processLane(seeded.messageId, 'route_search', server);
      assert.equal((await readJob(pool, routeJobId)).status, 'blocked_policy', '未承認の振り分けがblocked_policyでない');
      assert.equal(server.requests.length, 0, '未承認なのに外部送信している');
      const request = await readSearchRequest(pool, seeded.searchRequestId);
      assert.equal(request.status, 'failed', '検索受付がfailedでない');
      assert.equal(request.error_code, 'provider_policy_unverified');
      assert.notEqual(request.outcome, 'no_match', '未承認をno_matchにしている');
    } finally {
      await server.close();
    }
  });

  it('承認の失効・endpoint不一致・account不一致では送信しない', async () => {
    const server = await startFakeJev(() => ({ body: {} }));
    try {
      const config = buildWorkerConfig(server.baseUrl);
      const cases: Array<{ label: string; approval: { active?: boolean; endpoint?: string; accountRef?: string } }> = [
        { label: '承認失効', approval: { active: false } },
        { label: 'endpoint不一致', approval: { endpoint: `${server.baseUrl}/other` } },
        { label: 'account不一致', approval: { accountRef: 'acct-b' } },
      ];
      for (const testCase of cases) {
        const sessionId = await seedSession(pool, workspace);
        const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: `${testCase.label}の確認` });
        await seedApproval(pool, {
          companyId: workspace.companyId,
          endpoint: testCase.approval.endpoint ?? config.apiUrl,
          accountRef: testCase.approval.accountRef,
          active: testCase.approval.active,
        });
        const jobId = await processLane(seeded.messageId, 'classify_message', server);
        assert.equal((await readJob(pool, jobId)).status, 'blocked_policy', `${testCase.label}: blocked_policyでない`);
      }
      assert.equal(server.requests.length, 0, '承認不一致なのに外部送信している');
    } finally {
      await server.close();
    }
  });

  it('規約確認日がNULLの承認ではJevへ送信せずblocked_policyとして原文を保持する', async () => {
    const server = await startFakeJev(() => ({ body: {} }));
    const config = buildWorkerConfig(server.baseUrl);
    try {
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: config.apiUrl, termsCheckedAt: null });
      const sessionId = await seedSession(pool, workspace);
      const text = '規約確認日が未設定なら送信しない';
      const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text });
      const classifyJobId = await processLane(seeded.messageId, 'classify_message', server);
      assert.equal((await readJob(pool, classifyJobId)).status, 'blocked_policy', 'NULL確認日の承認で外部送信している');
      assert.equal(server.requests.length, 0, 'NULL確認日なのに外部送信している');
      assert.equal((await readRevision(pool, seeded.messageId, 1))?.text, text, 'NULL確認日で原文が消えた');
    } finally {
      await server.close();
    }
  });

  it('承認済みの外部呼出し成功で分析を適用し、usageを本文なしで記録する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const text = '承認済みの分類対象本文';
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text });
    const server = await startFakeJev((request) => ({
      body: jevReply(request, jevChoices({ retention: 'substantive', primary_intent: 'implementation' })),
    }));
    try {
      const config = buildWorkerConfig(server.baseUrl);
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: config.apiUrl, active: true });
      const jobId = await processLane(seeded.messageId, 'classify_message', server);
      assert.equal(server.requests.length, 1, '承認済みでもJev呼出しが1回でない');
      const sent = server.requests[0];
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, '/v1/systemone');
      assert.equal(sent.headers.authorization, 'Bearer test-key');
      assert.equal(sent.body.model, 'jev-latest');
      assert.ok(Buffer.byteLength(sent.rawBody, 'utf8') <= config.inputBudgetBytes, '送信bodyが入力予算を超えている');

      const analysis = await readAnalysis(pool, seeded.messageId, 1);
      assert.ok(analysis, '承認済みなのに分析が保存されていない');
      assert.equal(analysis.retention, 'substantive');
      assert.equal((await readJob(pool, jobId)).status, 'completed');

      const usageRows = await usageEventRows(pool, workspace.companyId);
      assert.ok(usageRows.length >= 1, 'usage_eventsが記録されていない');
      for (const rowText of usageRows) {
        assert.equal(rowText.includes(text), false, 'usage_eventsへ原文が混入している');
      }
    } finally {
      await server.close();
    }
  });

  it('429とtimeoutはpending、401と応答契約不正はfailedとして原文を保持する', async () => {
    const seeded = [
      await seedUserMessage(pool, { workspace, sessionId: await seedSession(pool, workspace), sequenceNo: 1, text: '429の応答' }),
      await seedUserMessage(pool, { workspace, sessionId: await seedSession(pool, workspace), sequenceNo: 1, text: 'timeoutの応答' }),
      await seedUserMessage(pool, { workspace, sessionId: await seedSession(pool, workspace), sequenceNo: 1, text: '401の応答' }),
      await seedUserMessage(pool, { workspace, sessionId: await seedSession(pool, workspace), sequenceNo: 1, text: '契約不正の応答' }),
    ];
    let call = 0;
    const server = await startFakeJev((request) => {
      call += 1;
      if (call === 1) {
        return { status: 429, body: { error: 'rate_limited' } };
      }
      if (call === 2) {
        return { delayMs: 200, body: jevReply(request, jevChoices()) };
      }
      if (call === 3) {
        return { status: 401, body: { error: 'unauthorized' } };
      }
      return { body: { model: 'jev-latest', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } } };
    });
    try {
      const config = buildWorkerConfig(server.baseUrl, { requestTimeoutMs: 50 });
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: config.apiUrl, active: true });
      const statuses: string[] = [];
      for (const input of seeded) {
        const job = await claimJobForMessage(pool, 'classify_message', input.messageId);
        await processJob(pool, job, config);
        const stored = await readJob(pool, job.id);
        statuses.push(stored.status);
        assert.ok(stored.error_code !== null, `${input.messageId}: error_codeが記録されていない`);
      }
      assert.deepEqual(statuses, ['pending', 'pending', 'failed', 'failed'], `job状態が不正: ${statuses.join(',')}`);
      assert.equal(await countAnalysis(pool), 0, '失敗応答を分析へ適用している');
      for (const input of seeded) {
        assert.ok((await readRevision(pool, input.messageId, 1))?.text, '失敗時に原文が消えている');
      }
      assert.ok((await usageEventRows(pool, workspace.companyId)).length >= 4, '試行ごとのusage_eventsがない');
    } finally {
      await server.close();
    }
  });

  it('blocked_policyの明示retryは承認確認後にjobと検索受付をpendingへ戻す', async () => {
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: '再開対象の発言' });
    const blockedServer = await startFakeJev(() => ({ body: {} }));
    try {
      const classifyJobId = await processLane(seeded.messageId, 'classify_message', blockedServer);
      const routeJobId = await processLane(seeded.messageId, 'route_search', blockedServer);
      assert.equal((await readJob(pool, classifyJobId)).status, 'blocked_policy');
      assert.equal((await readJob(pool, routeJobId)).status, 'blocked_policy');
      assert.equal((await readSearchRequest(pool, seeded.searchRequestId)).status, 'failed');

      const retryServer = await startFakeJev((request) => ({
        body: jevReply(request, jevChoices({ retention: 'substantive', search_action: 'new_search' })),
      }));
      try {
        const config = buildWorkerConfig(retryServer.baseUrl);
        await seedApproval(pool, { companyId: workspace.companyId, endpoint: config.apiUrl, active: true });
        assert.equal(await retryJob(pool, classifyJobId, config), true, '分類jobの明示retryがfalse');
        assert.equal((await readJob(pool, classifyJobId)).status, 'pending');
        assert.equal(await retryJob(pool, routeJobId, config), true, '振り分けjobの明示retryがfalse');
        assert.equal((await readJob(pool, routeJobId)).status, 'pending');
        assert.equal((await readSearchRequest(pool, seeded.searchRequestId)).status, 'pending', '検索受付がpendingへ戻っていない');

        const retried = await claimJobForMessage(pool, 'classify_message', seeded.messageId);
        await processJob(pool, retried, config);
        assert.ok(await readAnalysis(pool, seeded.messageId, 1), '再開後に分析が保存されていない');
      } finally {
        await retryServer.close();
      }
    } finally {
      await blockedServer.close();
    }
  });

  it('承認がないjobの明示retryは状態を戻さない', async () => {
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: '未承認のまま再開しない' });
    const server = await startFakeJev(() => ({ body: {} }));
    try {
      const jobId = await processLane(seeded.messageId, 'classify_message', server);
      assert.equal(await retryJob(pool, jobId, buildWorkerConfig(server.baseUrl)), false, '未承認なのにretryが成功した');
      assert.equal((await readJob(pool, jobId)).status, 'blocked_policy');
      assert.equal(server.requests.length, 0);
    } finally {
      await server.close();
    }
  });
  it('lease更新のDB待機中に承認が失効したら、送信せずblocked_policyにする', async () => {
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: '承認失効の競合確認' });
    const server = await startFakeJev((request) => ({
      body: jevReply(request, jevChoices({ retention: 'substantive', search_action: 'new_search' })),
    }));
    try {
      const config = buildWorkerConfig(server.baseUrl);
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: config.apiUrl, active: true });
      const job = await claimJobForMessage(pool, 'classify_message', seeded.messageId);
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [job.id]);
        const processing = processJob(pool, job, config);
        // 固定sleepで順序を偽証せず、renewalがlock待ちになったことを観測してから承認を失効させる。
        assert.ok(await waitForLeaseRenewalLockWait(), 'lease更新がjob rowのlock待ちにならない');
        await pool.query('UPDATE provider_policy_approvals SET active = false WHERE company_id = $1 AND endpoint = $2', [
          workspace.companyId,
          config.apiUrl,
        ]);
        await blocker.query('COMMIT');
        await processing;
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
      }
      assert.equal((await readJob(pool, job.id)).status, 'blocked_policy', '承認失効後もlease更新を抜けて送信している');
      assert.equal(server.requests.length, 0, 'lease待機中の承認失効後も外部送信している');
    } finally {
      await server.close();
    }
  });

  it('応答契約不正では取得できた応答modelをusageへ記録し、応答なし失敗はNULLにする', async () => {
    const broken = await seedUserMessage(pool, { workspace, sessionId: await seedSession(pool, workspace), sequenceNo: 1, text: '契約modelの確認' });
    const unavailable = await seedUserMessage(pool, { workspace, sessionId: await seedSession(pool, workspace), sequenceNo: 1, text: '応答なし失敗の確認' });
    const server = await startFakeJev((request, rawBody) => {
      if (rawBody.includes('契約modelの確認')) {
        return { body: { model: 'jev-broken-2', answers: {}, usage: { input_tokens: 3, output_tokens: 4 } } };
      }
      return { status: 503, body: { error: 'unavailable' } };
    });
    try {
      const config = buildWorkerConfig(server.baseUrl);
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: config.apiUrl, active: true });
      const brokenJob = await claimJobForMessage(pool, 'classify_message', broken.messageId);
      await processJob(pool, brokenJob, config);
      const unavailableJob = await claimJobForMessage(pool, 'classify_message', unavailable.messageId);
      await processJob(pool, unavailableJob, config);
      assert.equal((await readJob(pool, brokenJob.id)).status, 'failed');
      assert.equal((await readJob(pool, unavailableJob.id)).status, 'pending');

      const usage = await readUsageEvents(pool, workspace.companyId);
      const brokenRow = usage.find((row) => row.error_code === 'provider_contract_invalid');
      assert.ok(brokenRow, '契約不正のusageが記録されていない');
      assert.equal(brokenRow.model, 'jev-latest', '要求modelを保持していない');
      assert.equal(brokenRow.response_model, 'jev-broken-2', '検証失敗時に取得できた応答modelを記録していない');
      const unavailableRow = usage.find((row) => row.error_code === 'provider_unavailable');
      assert.ok(unavailableRow, '応答なし失敗のusageが記録されていない');
      assert.equal(unavailableRow.model, 'jev-latest');
      assert.equal(unavailableRow.response_model, null, '応答なし失敗で応答modelを埋めている');
    } finally {
      await server.close();
    }
  });
});
