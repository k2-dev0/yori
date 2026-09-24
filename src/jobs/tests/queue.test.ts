import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validate as isUuid, version as uuidVersion, v7 as uuidv7 } from 'uuid';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import {
  countRows,
  insertMessage,
  insertSession,
  resetDatabase,
  seedWorkspace,
  type WorkspaceFixture,
} from '../../db/tests/fixtures.js';
import { blockJob, claimJobs, completeJob, enqueueJob, failJob, recoverExpiredJobs } from '../queue.js';

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

function assertUuidV7(value: unknown): void {
  assert.equal(typeof value, 'string', `UUIDが文字列ではない: ${String(value)}`);
  assert.ok(isUuid(value as string), `UUID形式ではない: ${String(value)}`);
  assert.equal(uuidVersion(value as string), 7, `UUIDv7ではない: ${String(value)}`);
}

async function seedSession(): Promise<string> {
  return insertSession(pool, {
    projectId: workspace.projectId,
    employeeId: workspace.employeeId,
    sourceSessionId: `session-${randomUUID()}`,
  });
}

async function seedMessage(sessionId: string, sequenceNo: number): Promise<string> {
  const { messageId } = await insertMessage(pool, {
    sessionId,
    sourceMessageId: `msg-${randomUUID()}`,
    sequenceNo,
  });
  return messageId;
}

interface InsertJobOptions {
  kind?: 'classify_message' | 'route_search';
  status?: string;
  priority?: number;
  sessionId?: string | null;
  messageId?: string | null;
  targetRevision?: number | null;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
  nextRunAt?: Date;
  errorCode?: string | null;
}

// 挿入順が分かるようcreated_atを1msずつ進める。先行jobの判定をテストで安定させるため。
let jobClock = Date.now();
async function insertJob(options: InsertJobOptions = {}): Promise<string> {
  const id = uuidv7();
  jobClock += 1;
  await pool.query(
    // next_run_atの既定はDB時刻にする。host時計とDB時計のskewで未到来扱いになるのを避ける。
    `INSERT INTO jobs (id, kind, status, priority, session_id, message_id, target_revision, payload, idempotency_key, lease_token, lease_expires_at, next_run_at, error_code, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8, $9, $10, COALESCE($11, now()), $12, $13)`,
    [
      id,
      options.kind ?? 'classify_message',
      options.status ?? 'pending',
      options.priority ?? 0,
      options.sessionId ?? null,
      options.messageId ?? null,
      options.targetRevision ?? null,
      `job-${id}`,
      options.leaseToken ?? null,
      options.leaseExpiresAt ?? null,
      options.nextRunAt ?? null,
      options.errorCode ?? null,
      new Date(jobClock),
    ],
  );
  return id;
}

async function jobRow(jobId: string): Promise<{ status: string; lease_token: string | null; error_code: string | null; next_run_at: Date }> {
  const result = await pool.query<{ status: string; lease_token: string | null; error_code: string | null; next_run_at: Date }>(
    'SELECT status, lease_token, error_code, next_run_at FROM jobs WHERE id = $1',
    [jobId],
  );
  return result.rows[0];
}

describe('ジョブ登録', () => {
  it('同じ冪等キーのenqueueはjobを1件に保つ', async () => {
    const sessionId = await seedSession();
    const messageId = await seedMessage(sessionId, 1);
    const first = await enqueueJob(pool, {
      kind: 'classify_message',
      idempotencyKey: 'classify:msg-1:1',
      sessionId,
      messageId,
      targetRevision: 1,
      payload: { message_id: messageId },
    });
    assertUuidV7(first);

    const second = await enqueueJob(pool, {
      kind: 'classify_message',
      idempotencyKey: 'classify:msg-1:1',
      sessionId,
      messageId,
      targetRevision: 1,
      payload: { message_id: messageId },
    });
    assert.equal(second, first, '同じ冪等キーで別IDが返った');
    assert.equal(await countRows(pool, 'jobs'), 1);
  });
});

describe('ジョブclaimとlease', () => {
  it('並行claimは二重取得せず、claimごとに新しいlease tokenを付ける', async () => {
    for (let index = 0; index < 3; index += 1) {
      const sessionId = await seedSession();
      const messageId = await seedMessage(sessionId, 1);
      await insertJob({ sessionId, messageId, targetRevision: 1 });
    }

    const now = Date.now();
    const [left, right] = await Promise.all([
      claimJobs(pool, { kinds: ['classify_message'], limit: 2 }),
      claimJobs(pool, { kinds: ['classify_message'], limit: 2 }),
    ]);
    const claimed = [...left, ...right];
    assert.equal(claimed.length, 3, '二重取得または取得漏れがある');
    assert.equal(new Set(claimed.map((job) => job.id)).size, 3, '同じjobが二重にclaimされた');
    assert.equal(new Set(claimed.map((job) => job.leaseToken)).size, 3, 'lease tokenがclaimごとに新しくない');
    for (const job of claimed) {
      assertUuidV7(job.leaseToken);
      assert.ok(job.leaseExpiresAt.getTime() > now, 'lease期限が過去になっている');
    }

    const running = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM jobs WHERE status = 'running'");
    assert.equal(running.rows[0].count, 3);
  });

  it('lease期限切れのjobは回収されて再claimできる', async () => {
    const sessionId = await seedSession();
    const messageId = await seedMessage(sessionId, 1);
    const oldToken = randomUUID();
    const jobId = await insertJob({
      sessionId,
      messageId,
      targetRevision: 1,
      status: 'running',
      leaseToken: oldToken,
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });

    const recovered = await recoverExpiredJobs(pool);
    assert.equal(recovered, 1, '期限切れjobが回収されていない');
    const row = await jobRow(jobId);
    assert.equal(row.status, 'pending');
    assert.equal(row.lease_token, null);

    const claimed = await claimJobs(pool, { kinds: ['classify_message'], limit: 1 });
    assert.equal(claimed.length, 1, '回収後のjobが再claimできない');
    assert.equal(claimed[0].id, jobId);
    assert.notEqual(claimed[0].leaseToken, oldToken, '回収前のlease tokenが再利用された');
  });

  it('回収後の再claimでは旧tokenの完了を拒否し、新tokenとrevision一致の完了だけを受け付ける', async () => {
    const sessionId = await seedSession();
    const messageId = await seedMessage(sessionId, 1);
    const oldToken = randomUUID();
    const jobId = await insertJob({
      sessionId,
      messageId,
      targetRevision: 2,
      status: 'running',
      leaseToken: oldToken,
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });

    assert.equal(await recoverExpiredJobs(pool), 1, '期限切れjobが回収されていない');
    const reclaimed = await claimJobs(pool, { kinds: ['classify_message'], limit: 1 });
    assert.equal(reclaimed.length, 1, '回収後に再claimできない');
    assert.equal(reclaimed[0].id, jobId);
    const newToken = reclaimed[0].leaseToken;
    assert.notEqual(newToken, oldToken, '回収前のlease tokenが再利用された');

    assert.equal(await completeJob(pool, { jobId, leaseToken: oldToken, targetRevision: 2 }), false, '旧tokenで完了できた');
    assert.equal(await completeJob(pool, { jobId, leaseToken: newToken, targetRevision: 3 }), false, 'target_revision不一致で完了できた');
    assert.equal((await jobRow(jobId)).status, 'running', '拒否時にjobが完了扱いになった');

    assert.equal(await completeJob(pool, { jobId, leaseToken: newToken, targetRevision: 2 }), true, '新tokenとrevision一致の完了が拒否された');
    const completed = await jobRow(jobId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.lease_token, null);
  });

  it('next_run_atが未来のjobはclaimしない', async () => {
    const dueSession = await seedSession();
    const dueMessage = await seedMessage(dueSession, 1);
    const dueJob = await insertJob({ sessionId: dueSession, messageId: dueMessage, targetRevision: 1 });

    const futureSession = await seedSession();
    const futureMessage = await seedMessage(futureSession, 1);
    await insertJob({
      sessionId: futureSession,
      messageId: futureMessage,
      targetRevision: 1,
      nextRunAt: new Date(Date.now() + 3_600_000),
    });

    const claimed = await claimJobs(pool, { kinds: ['classify_message'], limit: 5 });
    assert.deepEqual(
      claimed.map((job) => job.id),
      [dueJob],
      'next_run_at前のjobをclaimした、または到来済みjobを取得できていない',
    );
  });
});

describe('ジョブ完了と失敗', () => {
  it('未失効lease・job id・対象revisionが一致しない完了は拒否される', async () => {
    const sessionId = await seedSession();
    const messageId = await seedMessage(sessionId, 1);
    const leaseToken = randomUUID();
    const jobId = await insertJob({
      sessionId,
      messageId,
      targetRevision: 2,
      status: 'running',
      leaseToken,
      leaseExpiresAt: new Date(Date.now() + 3_600_000),
    });

    assert.equal(await completeJob(pool, { jobId, leaseToken: randomUUID(), targetRevision: 2 }), false, '旧tokenで完了できた');
    assert.equal(await completeJob(pool, { jobId, leaseToken, targetRevision: 3 }), false, '対象revision不一致で完了できた');
    assert.equal((await jobRow(jobId)).status, 'running');

    assert.equal(await completeJob(pool, { jobId, leaseToken, targetRevision: 2 }), true, '一致する完了が拒否された');
    const completed = await jobRow(jobId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.lease_token, null);

    const expiredToken = randomUUID();
    const expiredJobId = await insertJob({
      sessionId,
      messageId,
      targetRevision: 1,
      status: 'running',
      leaseToken: expiredToken,
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });
    assert.equal(await completeJob(pool, { jobId: expiredJobId, leaseToken: expiredToken, targetRevision: 1 }), false, '失効leaseで完了できた');
    assert.equal((await jobRow(expiredJobId)).status, 'running');
  });

  it('一時障害は指数バックオフでpending、恒久エラーはfailedとして残す', async () => {
    const sessionId = await seedSession();
    const messageId = await seedMessage(sessionId, 1);

    const retryToken = randomUUID();
    const retryJobId = await insertJob({
      sessionId,
      messageId,
      targetRevision: 1,
      status: 'running',
      leaseToken: retryToken,
      leaseExpiresAt: new Date(Date.now() + 3_600_000),
    });
    const retryAfterMs = 5_000;
    const before = Date.now();
    assert.equal(
      await failJob(pool, { jobId: retryJobId, leaseToken: retryToken, errorCode: 'provider_timeout', retryable: true, retryAfterMs }),
      true,
      '再試行可能な失敗が記録されない',
    );
    const retried = await jobRow(retryJobId);
    assert.equal(retried.status, 'pending');
    assert.equal(retried.lease_token, null);
    assert.equal(retried.error_code, 'provider_timeout');
    assert.ok(
      retried.next_run_at.getTime() >= before + retryAfterMs - 100,
      `Retry-Afterより早い再実行が設定された: ${retried.next_run_at.toISOString()}`,
    );

    const permanentToken = randomUUID();
    const permanentJobId = await insertJob({
      sessionId,
      messageId,
      targetRevision: 1,
      status: 'running',
      leaseToken: permanentToken,
      leaseExpiresAt: new Date(Date.now() + 3_600_000),
    });
    assert.equal(
      await failJob(pool, { jobId: permanentJobId, leaseToken: permanentToken, errorCode: 'invalid_input', retryable: false }),
      true,
      '恒久エラーが記録されない',
    );
    const failed = await jobRow(permanentJobId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.lease_token, null);
    assert.equal(failed.error_code, 'invalid_input');
  });

  it('ポリシー未確認はblocked_policyとして保持し、claim対象から外す', async () => {
    const sessionId = await seedSession();
    const messageId = await seedMessage(sessionId, 1);
    const leaseToken = randomUUID();
    const jobId = await insertJob({
      sessionId,
      messageId,
      targetRevision: 1,
      status: 'running',
      leaseToken,
      leaseExpiresAt: new Date(Date.now() + 3_600_000),
    });

    assert.equal(await blockJob(pool, { jobId, leaseToken, errorCode: 'policy_unconfirmed' }), true, 'blocked_policyを記録できない');
    const blocked = await jobRow(jobId);
    assert.equal(blocked.status, 'blocked_policy');
    assert.equal(blocked.lease_token, null);

    const claimed = await claimJobs(pool, { kinds: ['classify_message'], limit: 5 });
    assert.equal(claimed.length, 0, 'blocked_policyのjobをclaimした');
  });
});

describe('セッション内の分類順序', () => {
  it('登録順・created_at・priorityがsequence_noと逆でも分類はsequence_no昇順でclaimされる', async () => {
    const sessionId = await seedSession();
    // 後続sequence_noを先に保存・先にjob登録し、created_atとpriorityを逆転させる。
    const laterMessage = await seedMessage(sessionId, 2);
    const earlierMessage = await seedMessage(sessionId, 1);
    const laterJobId = await insertJob({ sessionId, messageId: laterMessage, targetRevision: 1, priority: 100 });
    const earlierJobId = await insertJob({ sessionId, messageId: earlierMessage, targetRevision: 1, priority: 0 });

    const first = await claimJobs(pool, { kinds: ['classify_message'], limit: 5 });
    assert.deepEqual(first.map((job) => job.id), [earlierJobId], 'sequence_no 1より後続を先にclaimした');

    await completeJob(pool, { jobId: earlierJobId, leaseToken: first[0].leaseToken, targetRevision: 1 });
    const second = await claimJobs(pool, { kinds: ['classify_message'], limit: 5 });
    assert.deepEqual(second.map((job) => job.id), [laterJobId], '先行job完了後に後続jobをclaimできない');
  });

  it('同messageではtarget_revision昇順でclaimされる', async () => {
    const sessionId = await seedSession();
    const messageId = await seedMessage(sessionId, 1);
    const revisionTwoJobId = await insertJob({ sessionId, messageId, targetRevision: 2, priority: 100 });
    const revisionOneJobId = await insertJob({ sessionId, messageId, targetRevision: 1, priority: 0 });

    const first = await claimJobs(pool, { kinds: ['classify_message'], limit: 5 });
    assert.deepEqual(first.map((job) => job.id), [revisionOneJobId], 'target_revision 1より2を先にclaimした');

    await completeJob(pool, { jobId: revisionOneJobId, leaseToken: first[0].leaseToken, targetRevision: 1 });
    const second = await claimJobs(pool, { kinds: ['classify_message'], limit: 5 });
    assert.deepEqual(second.map((job) => job.id), [revisionTwoJobId], 'target_revision 1完了後に2をclaimできない');
  });

  it('未受信のsequence_noを待たず、保存済みjobのsequence_no順に進む', async () => {
    // sequence_no 1が未受信でも、保存済みのsequence_no 2はclaimできる。
    const onlyLaterSession = await seedSession();
    const onlyLaterMessage = await seedMessage(onlyLaterSession, 2);
    const onlyLaterJobId = await insertJob({ sessionId: onlyLaterSession, messageId: onlyLaterMessage, targetRevision: 1 });

    // 途中のsequence_no 2が未受信でも、完了済みのsequence_no 1より後をclaimできる。
    const gapSession = await seedSession();
    const firstMessage = await seedMessage(gapSession, 1);
    const thirdMessage = await seedMessage(gapSession, 3);
    await insertJob({ sessionId: gapSession, messageId: firstMessage, targetRevision: 1, status: 'completed' });
    const thirdJobId = await insertJob({ sessionId: gapSession, messageId: thirdMessage, targetRevision: 1 });

    const claimed = await claimJobs(pool, { kinds: ['classify_message'], limit: 5 });
    assert.deepEqual(
      claimed.map((job) => job.id).sort(),
      [onlyLaterJobId, thirdJobId].sort(),
      '未受信のsequence_noを待って保存済みjobをclaimできていない',
    );
  });

  it('先行jobがpending(未到来)・running・failed・blocked_policyの間は後続jobをclaimしない', async () => {
    const blockedSuccessors: string[] = [];
    const claimableJobs: string[] = [];
    const blockingCases: Array<{ name: string; predecessor: InsertJobOptions }> = [
      { name: 'failed', predecessor: { status: 'failed', errorCode: 'provider_error' } },
      { name: 'blocked_policy', predecessor: { status: 'blocked_policy', errorCode: 'policy_unconfirmed' } },
      {
        name: 'running',
        predecessor: { status: 'running', leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 3_600_000) },
      },
      { name: 'pending(未到来)', predecessor: { status: 'pending', nextRunAt: new Date(Date.now() + 3_600_000) } },
    ];
    for (const { predecessor } of blockingCases) {
      const sessionId = await seedSession();
      const firstMessage = await seedMessage(sessionId, 1);
      const secondMessage = await seedMessage(sessionId, 2);
      await insertJob({ sessionId, messageId: firstMessage, targetRevision: 1, ...predecessor });
      blockedSuccessors.push(await insertJob({ sessionId, messageId: secondMessage, targetRevision: 1, priority: 100 }));

      // 別sessionのjobは先行jobの状態に関係なくclaimできる。
      const otherSessionId = await seedSession();
      const otherMessage = await seedMessage(otherSessionId, 1);
      claimableJobs.push(await insertJob({ sessionId: otherSessionId, messageId: otherMessage, targetRevision: 1 }));
    }

    // 先行jobが完了済みなら後続をclaimできる（同sessionを常に止める実装ではないことの確認）。
    const completedSessionId = await seedSession();
    const completedFirstMessage = await seedMessage(completedSessionId, 1);
    const completedSecondMessage = await seedMessage(completedSessionId, 2);
    await insertJob({ sessionId: completedSessionId, messageId: completedFirstMessage, targetRevision: 1, status: 'completed' });
    claimableJobs.push(await insertJob({ sessionId: completedSessionId, messageId: completedSecondMessage, targetRevision: 1 }));

    const claimed = await claimJobs(pool, { kinds: ['classify_message'], limit: 50 });
    const claimedIds = claimed.map((job) => job.id);
    assert.deepEqual(claimedIds.slice().sort(), claimableJobs.slice().sort(), '先行jobの状態を無視した、または別sessionを止めた');
    for (const successorId of blockedSuccessors) {
      assert.ok(!claimedIds.includes(successorId), 'blockedされるべき後続jobをclaimした');
    }
  });

  it('同セッションの並行claimは1回のlimit>1でも後続jobを同時に取得しない', async () => {
    const sessionId = await seedSession();
    const secondMessage = await seedMessage(sessionId, 2);
    const firstMessage = await seedMessage(sessionId, 1);
    // 後続を先に・高priorityで登録しても、対象は同sessionで最も先行する1件だけ。
    const secondJobId = await insertJob({ sessionId, messageId: secondMessage, targetRevision: 1, priority: 100 });
    const firstJobId = await insertJob({ sessionId, messageId: firstMessage, targetRevision: 1, priority: 0 });

    const otherSessionId = await seedSession();
    const otherMessage = await seedMessage(otherSessionId, 1);
    const otherJobId = await insertJob({ sessionId: otherSessionId, messageId: otherMessage, targetRevision: 1 });

    const [left, right] = await Promise.all([
      claimJobs(pool, { kinds: ['classify_message'], limit: 5 }),
      claimJobs(pool, { kinds: ['classify_message'], limit: 5 }),
    ]);
    const claimedIds = [...left, ...right].map((job) => job.id);
    assert.equal(new Set(claimedIds).size, claimedIds.length, '同じjobが二重にclaimされた');
    assert.deepEqual(
      claimedIds.slice().sort(),
      [firstJobId, otherJobId].sort(),
      '1回のlimit>1で同セッションの後続jobを取得した、または別sessionを止めた',
    );

    const firstClaim = left.find((job) => job.id === firstJobId) ?? right.find((job) => job.id === firstJobId);
    assert.ok(firstClaim, '先行jobのleaseが取得できない');
    await completeJob(pool, { jobId: firstJobId, leaseToken: firstClaim.leaseToken, targetRevision: 1 });
    const next = await claimJobs(pool, { kinds: ['classify_message'], limit: 5 });
    assert.deepEqual(next.map((job) => job.id), [secondJobId], '先行job完了後に後続jobをclaimできない');
  });

  it('route_searchは同セッションの分類jobの状態に依存せずclaimされる', async () => {
    const pendingSession = await seedSession();
    const pendingMessage = await seedMessage(pendingSession, 1);
    const routeNextMessage = await seedMessage(pendingSession, 2);
    await insertJob({ sessionId: pendingSession, messageId: pendingMessage, targetRevision: 1, priority: 10 });
    const routeAfterPendingId = await insertJob({ kind: 'route_search', sessionId: pendingSession, messageId: routeNextMessage, priority: 100 });

    const first = await claimJobs(pool, { kinds: ['classify_message', 'route_search'], limit: 1 });
    assert.deepEqual(first.map((job) => job.id), [routeAfterPendingId], 'route_searchが分類jobに負けた');

    // 分類jobがrunning・failed・blocked_policyでもroute_searchはclaimできる。
    const expectedRouteIds: string[] = [];
    const blockedStatuses = ['running', 'failed', 'blocked_policy'] as const;
    for (const status of blockedStatuses) {
      const sessionId = await seedSession();
      const classifyMessage = await seedMessage(sessionId, 1);
      const routeMessage = await seedMessage(sessionId, 2);
      const predecessor: InsertJobOptions =
        status === 'running'
          ? { status, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 3_600_000) }
          : { status, errorCode: status === 'failed' ? 'provider_error' : 'policy_unconfirmed' };
      await insertJob({ sessionId, messageId: classifyMessage, targetRevision: 1, ...predecessor });
      expectedRouteIds.push(await insertJob({ kind: 'route_search', sessionId, messageId: routeMessage, priority: 100 }));
    }
    const routes = await claimJobs(pool, { kinds: ['route_search'], limit: 5 });
    assert.deepEqual(routes.map((job) => job.id).sort(), expectedRouteIds.slice().sort(), '分類jobの状態がroute_searchを止めている');
  });
});
