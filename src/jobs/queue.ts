import type { Pool } from 'pg';

// route_search は分類待ちに依存させず、常に分類より先に処理する。
export const ROUTE_SEARCH_PRIORITY = 100;
export const CLASSIFY_MESSAGE_PRIORITY = 10;
export const DEFAULT_JOB_LEASE_MS = 60_000;

export const JOB_KINDS = ['classify_message', 'route_search'] as const;
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

// M1 Red時点では契約exportのみ。冪等キーで1件だけ登録する実装はM1 Greenで行う。
export async function enqueueJob(_pool: Pool, _input: EnqueueJobInput): Promise<string> {
  return '';
}

// M1 Red時点では契約exportのみ。SELECT ... FOR UPDATE SKIP LOCKEDとlease付与はM1 Greenで行う。
export async function claimJobs(_pool: Pool, _input: ClaimJobsInput): Promise<ClaimedJob[]> {
  return [];
}

// M1 Red時点では契約exportのみ。job id・lease token・対象revision・lease未失効の一致検証はM1 Greenで行う。
export async function completeJob(_pool: Pool, _input: CompleteJobInput): Promise<boolean> {
  return false;
}

// M1 Red時点では契約exportのみ。指数バックオフ・jitter・Retry-Afterとfailedの保持はM1 Greenで行う。
export async function failJob(_pool: Pool, _input: FailJobInput): Promise<boolean> {
  return false;
}

// M1 Red時点では契約exportのみ。blocked_policyとして保持し自動再試行を止める実装はM1 Greenで行う。
export async function blockJob(_pool: Pool, _input: BlockJobInput): Promise<boolean> {
  return false;
}

// M1 Red時点では契約exportのみ。lease期限切れjobのpending復帰はM1 Greenで行う。
export async function recoverExpiredJobs(_pool: Pool): Promise<number> {
  return 0;
}
