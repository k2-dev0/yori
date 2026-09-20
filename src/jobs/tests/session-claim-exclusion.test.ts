import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { insertMessage, insertSession, resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { claimJobs, type ClaimedJob } from '../queue.js';

const pool = createPool(requireDatabaseUrl());
let workspace: WorkspaceFixture;

// テスト専用のadvisory gate key。queue側のsession lockのnamespace(実装予定)とは別にし、EVENT_WRITE_LOCK_NAMESPACE(20260922)とも衝突させない。
const GATE_NAMESPACE = 20260924;
const GATE_KEY = 1;
const GATE_WAIT_TIMEOUT_MS = 5_000;
const GATE_POLL_INTERVAL_MS = 25;

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

// 挿入順をcreated_atで固定し、先行jobの判定をテスト側で安定させる。
let jobClock = Date.now();
interface InsertJobOptions {
  kind?: 'classify_message' | 'route_search';
  sessionId: string;
  messageId: string | null;
  targetRevision?: number;
  priority?: number;
}

async function insertJob(options: InsertJobOptions): Promise<string> {
  const id = uuidv7();
  jobClock += 1;
  await pool.query(
    `INSERT INTO jobs (id, kind, status, priority, session_id, message_id, target_revision, payload, idempotency_key, next_run_at, created_at)
     VALUES ($1, $2, 'pending', $3, $4, $5, $6, '{}'::jsonb, $7, now(), $8)`,
    [
      id,
      options.kind ?? 'classify_message',
      options.priority ?? 0,
      options.sessionId,
      options.messageId,
      options.targetRevision ?? 1,
      `job-${id}`,
      new Date(jobClock),
    ],
  );
  return id;
}

async function insertSessionMessage(sessionId: string, sequenceNo: number): Promise<string> {
  const { messageId } = await insertMessage(pool, { sessionId, sourceMessageId: `msg-${randomUUID()}`, sequenceNo });
  return messageId;
}

async function jobStatus(jobId: string): Promise<string> {
  const result = await pool.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [jobId]);
  return result.rows[0].status;
}

// AのUPDATEをgateで停止させ、waiterがpg_locksへ現れるまでboundedに待つ。sleep頼みの確率同期はしない。
async function waitForGateWaiter(): Promise<void> {
  const deadline = Date.now() + GATE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM pg_locks
        WHERE locktype = 'advisory' AND granted = false AND classid = $1::oid AND objid = $2::oid`,
      [GATE_NAMESPACE, GATE_KEY],
    );
    if (result.rows[0].count > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, GATE_POLL_INTERVAL_MS));
  }
  throw new Error('claimのUPDATEがgateで停止しなかった');
}

describe('session単位のclaim排他', () => {
  it('後着の先行seqはrunning中の同session classifyを追い越してclaimされない', async () => {
    const sessionId = await insertSession(pool, {
      projectId: workspace.projectId,
      employeeId: workspace.employeeId,
      sourceSessionId: `race-${randomUUID()}`,
    });
    const laterMessageId = await insertSessionMessage(sessionId, 2);
    const laterJobId = await insertJob({ sessionId, messageId: laterMessageId });

    await pool.query(`
      CREATE FUNCTION yori_test_gate_session_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${laterJobId}'::uuid AND OLD.status = 'pending' AND NEW.status = 'running' THEN
          PERFORM pg_advisory_xact_lock(${GATE_NAMESPACE}, ${GATE_KEY});
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await pool.query(
      'CREATE TRIGGER yori_test_gate_session_claim BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION yori_test_gate_session_claim()',
    );

    const gateClient = await pool.connect();
    let firstClaim: Promise<ClaimedJob[]> | undefined;
    let secondClaim: Promise<ClaimedJob[]> | undefined;
    try {
      await gateClient.query('SELECT pg_advisory_lock($1::int, $2::int)', [GATE_NAMESPACE, GATE_KEY]);
      // seq2はAの選択時点で唯一の保存済みjobなのでAはclaimを開始できる。
      firstClaim = claimJobs(pool, { kinds: ['classify_message'], limit: 5 });
      await waitForGateWaiter();

      // AのUPDATE停止中に、遅着のseq1・同sessionのroute_search・別sessionのclassifyが到着する。
      const earlierMessageId = await insertSessionMessage(sessionId, 1);
      const earlierJobId = await insertJob({ sessionId, messageId: earlierMessageId });
      const routeJobId = await insertJob({ sessionId, messageId: laterMessageId, kind: 'route_search', priority: 100 });
      const otherSessionId = await insertSession(pool, {
        projectId: workspace.projectId,
        employeeId: workspace.employeeId,
        sourceSessionId: `race-other-${randomUUID()}`,
      });
      const otherMessageId = await insertSessionMessage(otherSessionId, 1);
      const otherJobId = await insertJob({ sessionId: otherSessionId, messageId: otherMessageId });

      secondClaim = claimJobs(pool, { kinds: ['classify_message', 'route_search'], limit: 10 });
      const secondClaimed = await secondClaim;

      await gateClient.query('SELECT pg_advisory_unlock($1::int, $2::int)', [GATE_NAMESPACE, GATE_KEY]);
      const firstClaimed = await firstClaim;

      assert.deepEqual(firstClaimed.map((job) => job.id), [laterJobId], '先行seq到着前のclaimがseq2を確保できていない');
      const runningClassify = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM jobs WHERE session_id = $1 AND kind = 'classify_message' AND status = 'running'`,
        [sessionId],
      );
      assert.equal(runningClassify.rows[0].count, 1, '同sessionでclassifyが二重runningになった');
      assert.deepEqual(
        secondClaimed.map((job) => job.id).sort(),
        [routeJobId, otherJobId].sort(),
        `同sessionの後着seqをclaimした、またはroute_search/別sessionが進まない: ${secondClaimed.map((job) => job.id).join(', ')}`,
      );
      assert.equal(await jobStatus(earlierJobId), 'pending', 'running中のseq2がある間にseq1がclaimされた');
      assert.equal(await jobStatus(routeJobId), 'running', 'route_searchが停止した');
      assert.equal(await jobStatus(otherJobId), 'running', '別sessionのclaimが停止した');
    } finally {
      await gateClient.query('SELECT pg_advisory_unlock($1::int, $2::int)', [GATE_NAMESPACE, GATE_KEY]).catch(() => undefined);
      await Promise.allSettled([firstClaim, secondClaim]);
      await pool.query('DROP TRIGGER IF EXISTS yori_test_gate_session_claim ON jobs').catch(() => undefined);
      await pool.query('DROP FUNCTION IF EXISTS yori_test_gate_session_claim()').catch(() => undefined);
      gateClient.release();
    }
  });
});
