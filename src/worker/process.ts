import type { Pool } from 'pg';
import type { ClaimedJob } from '../jobs/queue.js';
import type { WorkerConfig } from './config.js';

// Redの足場。Greenでlease/対象revision検証、Jev呼出し、分析・関係の同一TX適用、
// 後続job（build_documents / execute_search）の登録を実装する。
export async function processJob(_pool: Pool, _job: ClaimedJob, _config: WorkerConfig): Promise<void> {
  // 未実装: 呼出し-sideの挙動はテストで確認する。
}

// Redの足場。Greenで承認確認後にfailed/blocked_policyのjobと検索受付をpendingへ戻す。
export async function retryJob(_pool: Pool, _jobId: string, _config: WorkerConfig): Promise<boolean> {
  return false;
}
