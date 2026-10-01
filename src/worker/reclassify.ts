import type { Pool } from 'pg';
import { WORKER_POLICY_VERSION } from './contract.js';

// 対象は指定案件の、現行revisionの分類で情報源がunknownのままのエージェントの回答だけ。
// 完了済みのclassify_message jobを再実行待ちへ戻す。待機中・実行中・失敗のjobには触れない。
const REQUEUE_CLASSIFICATION_SQL = `
  UPDATE jobs j
     SET status = 'pending', error_code = NULL, lease_token = NULL, lease_expires_at = NULL, next_run_at = now(), updated_at = now()
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    JOIN message_analysis a ON a.message_id = m.id AND a.revision = m.current_revision AND a.policy_version = $2
   WHERE j.kind = 'classify_message' AND j.status = 'completed'
     AND j.message_id = m.id AND j.target_revision = m.current_revision
     AND s.project_id = $1 AND m.role = 'assistant' AND a.information_source = 'unknown'
  RETURNING j.id
`;

// 情報源の分類を持たない既存の回答を分類し直す。戻り値は再実行待ちへ戻した件数。
// 質問定義の版を上げた後に実行する。同じ版の評価cacheが残る発言はJevへ再送されない。
export async function reclassifyMessages(pool: Pool, projectId: string): Promise<number> {
  const requeued = await pool.query(REQUEUE_CLASSIFICATION_SQL, [projectId, WORKER_POLICY_VERSION]);
  return requeued.rowCount ?? 0;
}
