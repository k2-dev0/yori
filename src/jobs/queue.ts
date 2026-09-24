import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';

// route_search は分類待ちに依存させず、常に分類より先に処理する。
export const ROUTE_SEARCH_PRIORITY = 100;
export const EXECUTE_SEARCH_PRIORITY = 80;
export const BUILD_DOCUMENTS_PRIORITY = 20;
export const CLASSIFY_MESSAGE_PRIORITY = 10;
export const DEFAULT_JOB_LEASE_MS = 60_000;

// 同一sessionの分類claimを直列化するadvisory lock key1。key2はsession_idから導出する。
const SESSION_CLAIM_LOCK_NAMESPACE = 20260923;

export const JOB_KINDS = ['classify_message', 'route_search', 'build_documents', 'execute_search'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'blocked_policy'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface EnqueueJobInput {
  kind: JobKind;
  idempotencyKey: string;
  priority?: number;
  sessionId?: string;
  messageId?: string;
  targetRevision?: number;
  payload?: Record<string, unknown>;
  nextRunAt?: Date;
}

export interface ClaimJobsInput {
  kinds: readonly JobKind[];
  limit: number;
  leaseMs?: number;
}

export interface ClaimedJob {
  id: string;
  kind: JobKind;
  priority: number;
  sessionId: string | null;
  messageId: string | null;
  targetRevision: number | null;
  payload: unknown;
  leaseToken: string;
  leaseExpiresAt: Date;
  attempts: number;
}

export interface CompleteJobInput {
  jobId: string;
  leaseToken: string;
  targetRevision: number | null;
}

export interface FailJobInput {
  jobId: string;
  leaseToken: string;
  errorCode: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface BlockJobInput {
  jobId: string;
  leaseToken: string;
  errorCode: string;
}

const MAX_CLAIM_LIMIT = 100;
const MAX_LEASE_MS = 24 * 60 * 60 * 1_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60 * 60 * 1_000;

interface JobRow {
  id: string;
  kind: JobKind;
  priority: number;
  session_id: string | null;
  message_id: string | null;
  target_revision: number | null;
  payload: unknown;
  attempts: number;
}

// due pendingをpriority DESC・作成順で安定に選ぶ。分類は同sessionの先行jobが未完了の間は後続を除外する。
// 分類の順序はmessage.sequence_no→target_revisionで決め、未受信のsequence_noは待たない。
const CLAIM_JOBS_SQL = `
  SELECT j.id, j.kind, j.priority, j.session_id, j.message_id, j.target_revision, j.payload, j.attempts
    FROM jobs j
   WHERE j.status = 'pending'
     AND j.next_run_at <= now()
     AND j.kind = ANY($1::text[])
     AND (
       j.kind <> 'classify_message'
       OR NOT EXISTS (
         SELECT 1
           FROM jobs o
          WHERE o.session_id = j.session_id
            AND o.kind = 'classify_message'
            AND o.id <> j.id
            AND (
              o.status = 'running'
              OR (
                o.status IN ('pending', 'failed', 'blocked_policy')
                AND EXISTS (
                  SELECT 1
                    FROM messages om
                    JOIN messages m ON m.id = j.message_id
                   WHERE om.id = o.message_id
                     AND (om.sequence_no, o.target_revision) < (m.sequence_no, j.target_revision)
                )
              )
            )
       )
     )
   ORDER BY j.priority DESC, j.created_at ASC, j.id ASC
   LIMIT $2
   FOR UPDATE OF j SKIP LOCKED
`;

// session lock取得後の新snapshotで、running中の同session分類や先行sequence_no/revisionが無いかを再確認する。
// 同TX内で追加したrunningもこの文で観測する。
const RECHECK_CLASSIFY_JOB_SQL = `
  SELECT 1
    FROM jobs j
   WHERE j.id = $1
     AND j.kind = 'classify_message'
     AND j.status = 'pending'
     AND j.next_run_at <= now()
     AND NOT EXISTS (
       SELECT 1
         FROM jobs o
        WHERE o.session_id = j.session_id
          AND o.kind = 'classify_message'
          AND o.id <> j.id
          AND (
            o.status = 'running'
            OR (
              o.status IN ('pending', 'failed', 'blocked_policy')
              AND EXISTS (
                SELECT 1
                  FROM messages om
                  JOIN messages m ON m.id = j.message_id
                 WHERE om.id = o.message_id
                   AND (om.sequence_no, o.target_revision) < (m.sequence_no, j.target_revision)
              )
            )
          )
     )
`;

// 冪等キーが同じenqueueは既存jobのIDを返し、jobを増殖させない。
export async function enqueueJob(pool: Pool | PoolClient, input: EnqueueJobInput): Promise<string> {
  if (input.idempotencyKey.length === 0) {
    throw new Error('idempotencyKeyは必須です');
  }
  if (input.priority !== undefined && !Number.isInteger(input.priority)) {
    throw new Error('priorityは整数で指定してください');
  }
  if (input.nextRunAt !== undefined && !Number.isFinite(input.nextRunAt.getTime())) {
    throw new Error('nextRunAtが不正です');
  }
  const id = uuidv7();
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO jobs (id, kind, priority, session_id, message_id, target_revision, payload, idempotency_key, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      id,
      input.kind,
      input.priority ?? 0,
      input.sessionId ?? null,
      input.messageId ?? null,
      input.targetRevision ?? null,
      input.payload ?? {},
      input.idempotencyKey,
      input.nextRunAt ?? new Date(),
    ],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow) {
    return insertedRow.id;
  }
  const existing = await pool.query<{ id: string }>('SELECT id FROM jobs WHERE idempotency_key = $1', [input.idempotencyKey]);
  return existing.rows[0].id;
}

// 短いTXでSKIP LOCKEDし、session単位のtry lockと再確認を通ったjobだけをrunningへ移す。
// 分類は同sessionのrunning中claimをtry advisory xact lockで直列化し、route_searchと別sessionは止めない。
export async function claimJobs(pool: Pool, input: ClaimJobsInput): Promise<ClaimedJob[]> {
  const kinds = [...new Set(input.kinds.filter(isJobKind))];
  if (kinds.length === 0) {
    return [];
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_CLAIM_LIMIT) {
    throw new Error(`limitは1..${MAX_CLAIM_LIMIT}の整数で指定してください`);
  }
  const leaseMs = input.leaseMs ?? DEFAULT_JOB_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) {
    throw new Error(`leaseMsは1..${MAX_LEASE_MS}で指定してください`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const picked = await client.query<JobRow>(CLAIM_JOBS_SQL, [kinds, input.limit]);
    const claimed: ClaimedJob[] = [];
    // 分類中のsessionはxact lockを保持し、他claimはtry lockの失敗でskipする。
    const lockedSessionIds = new Set<string>();
    const busySessionIds = new Set<string>();
    for (const row of picked.rows) {
      if (row.kind === 'classify_message') {
        if (row.session_id !== null) {
          if (busySessionIds.has(row.session_id)) {
            continue;
          }
          if (!lockedSessionIds.has(row.session_id)) {
            const lock = await client.query<{ locked: boolean }>(
              'SELECT pg_try_advisory_xact_lock($1::int, hashtext($2)) AS locked',
              [SESSION_CLAIM_LOCK_NAMESPACE, row.session_id],
            );
            if (!lock.rows[0].locked) {
              busySessionIds.add(row.session_id);
              continue;
            }
            lockedSessionIds.add(row.session_id);
          }
        }
        const recheck = await client.query(RECHECK_CLASSIFY_JOB_SQL, [row.id]);
        if (recheck.rows.length === 0) {
          continue;
        }
      }
      const leaseToken = uuidv7();
      const leaseExpiresAt = new Date(Date.now() + leaseMs);
      const updated = await client.query<{ attempts: number }>(
        `UPDATE jobs
            SET status = 'running', lease_token = $2, lease_expires_at = $3, attempts = attempts + 1, updated_at = now()
          WHERE id = $1 AND status = 'pending'
          RETURNING attempts`,
        [row.id, leaseToken, leaseExpiresAt],
      );
      const attempts = updated.rows[0]?.attempts;
      if (attempts === undefined) {
        continue;
      }
      claimed.push({
        id: row.id,
        kind: row.kind,
        priority: row.priority,
        sessionId: row.session_id,
        messageId: row.message_id,
        targetRevision: row.target_revision,
        payload: row.payload,
        leaseToken,
        leaseExpiresAt,
        attempts,
      });
    }
    await client.query('COMMIT');
    return claimed;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// job id・lease token・対象revision・未失効leaseがすべて一致する完了だけを受け付ける。
export async function completeJob(pool: Pool | PoolClient, input: CompleteJobInput): Promise<boolean> {
  const result = await pool.query(
    `UPDATE jobs
        SET status = 'completed', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = $1
        AND status = 'running'
        AND lease_token = $2
        AND lease_expires_at > now()
        AND target_revision IS NOT DISTINCT FROM $3::integer`,
    [input.jobId, input.leaseToken, input.targetRevision],
  );
  return result.rowCount === 1;
}

// 一時障害はRetry-Afterと指数バックオフ+jitterでpendingへ戻し、恒久エラーはfailedとして保持する。
export async function failJob(pool: Pool | PoolClient, input: FailJobInput): Promise<boolean> {
  const retryAfterMs = input.retryAfterMs ?? 0;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
    throw new Error('retryAfterMsが不正です');
  }
  const leaseCondition = `id = $1 AND status = 'running' AND lease_token = $2 AND lease_expires_at > now()`;
  if (input.retryable) {
    const result = await pool.query(
      `UPDATE jobs
          SET status = 'pending',
              lease_token = NULL,
              lease_expires_at = NULL,
              error_code = $3,
              next_run_at = now() + interval '1 second' * (
                GREATEST($4::double precision, LEAST($5::double precision * POWER(2, LEAST(attempts, 10)), $6::double precision))
                * (1 + random() * 0.1) / 1000.0
              ),
              updated_at = now()
        WHERE ${leaseCondition}`,
      [input.jobId, input.leaseToken, input.errorCode, retryAfterMs, RETRY_BASE_MS, RETRY_MAX_MS],
    );
    return result.rowCount === 1;
  }
  const result = await pool.query(
    `UPDATE jobs
        SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, error_code = $3, updated_at = now()
      WHERE ${leaseCondition}`,
    [input.jobId, input.leaseToken, input.errorCode],
  );
  return result.rowCount === 1;
}

// ポリシー未確認はblocked_policyとして保持し、外部送信を伴う自動再試行を止める。
export async function blockJob(pool: Pool | PoolClient, input: BlockJobInput): Promise<boolean> {
  const result = await pool.query(
    `UPDATE jobs
        SET status = 'blocked_policy', lease_token = NULL, lease_expires_at = NULL, error_code = $3, updated_at = now()
      WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_expires_at > now()`,
    [input.jobId, input.leaseToken, input.errorCode],
  );
  return result.rowCount === 1;
}

// 長いmulti-part処理の間、所有を保ったままleaseを延長する。延長できなければ所有喪失。
export async function renewJobLease(pool: Pool | PoolClient, input: { jobId: string; leaseToken: string; leaseMs: number }): Promise<boolean> {
  if (!Number.isFinite(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > MAX_LEASE_MS) {
    throw new Error(`leaseMsは1..${MAX_LEASE_MS}で指定してください`);
  }
  const result = await pool.query(
    `UPDATE jobs
        SET lease_expires_at = now() + interval '1 millisecond' * $3, updated_at = now()
      WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_expires_at > now()`,
    [input.jobId, input.leaseToken, input.leaseMs],
  );
  return result.rowCount === 1;
}

// lease期限切れのrunning jobをpendingへ戻し、停止したworkerのjobを回収する。
export async function recoverExpiredJobs(pool: Pool): Promise<number> {
  const result = await pool.query(
    `UPDATE jobs
        SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}

// 外部入力のkindが契約したjob種別か判定する。
function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}
