import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { DEFAULT_JOB_LEASE_MS, EXECUTE_SEARCH_PRIORITY, type ClaimedJob } from '../jobs/queue.js';
import type { WorkerConfig } from './config.js';
import { WORKER_POLICY_VERSION } from './contract.js';
import { processJob } from './process.js';

export interface SearchEvalCase {
  name: string;
  question: string;
  expected_message_ids: string[];
  // 合格条件。省略時は代表根拠になること。in_candidatesはJevの判定へ渡った候補に入ること。
  pass_when?: 'adopted' | 'in_candidates';
  // 一次資料だけを求める明示検索として実行する。省略時は指定なし。
  primary_only?: boolean;
}

export interface SearchEvalCaseResult {
  name: string;
  status: 'hit' | 'miss' | 'error';
  in_candidates: boolean;
  candidate_position: number | null;
  relevance: string | null;
  // 正解の候補を引いた検索経路。候補に入らなかった時はnull。
  retrieval_kinds: string[] | null;
  error_code: string | null;
}

export type SearchEvalResult =
  | { ok: true; report: { total: number; hits: number; cases: SearchEvalCaseResult[] } }
  | { ok: false; code: string };

// 評価用の一時的な会話・発言。1ケース1会話にし、終了時に会話ごと削除する。
const EVAL_SOURCE_NAMESPACE = 'search-eval';
const INSERT_SESSION_SQL = `
  INSERT INTO sessions (id, project_id, employee_id, source, source_namespace, source_session_id, started_at)
  VALUES ($1::uuid, $2, $3, 'codex', $4, $1::uuid::text, now())`;
const INSERT_MESSAGE_SQL = `
  INSERT INTO messages (id, session_id, source_message_id, sequence_no, role, occurred_at, current_revision)
  VALUES ($1::uuid, $2, $1::uuid::text, 1, 'user', now(), 1)`;
const INSERT_REVISION_SQL = 'INSERT INTO message_revisions (message_id, revision, text, content_hash) VALUES ($1, 1, $2, $3)';
// 本番の手動検索と同じ受付を作る。jobは稼働中のworkerに横取りされないよう、最初から実行中で作る。
const INSERT_REQUEST_SQL = `
  INSERT INTO search_requests
    (id, company_id, project_id, employee_id, session_id, input_message_id, input_message_revision, input_sequence_no,
     trigger, status, outcome, search_action, stage, policy_version, question, idempotency_key, condition_hash, primary_only)
  VALUES ($1::uuid, $2, $3, $4, $5, $6, 1, 1, 'manual', 'pending', NULL, 'new_search', 'awaiting_search', $7, $8, $1::uuid::text, $9, $10)`;
const INSERT_RUNNING_JOB_SQL = `
  INSERT INTO jobs (id, kind, status, priority, session_id, message_id, target_revision, payload, idempotency_key,
                    lease_token, lease_expires_at, attempts)
  VALUES ($1::uuid, 'execute_search', 'running', $2, $3, $4, 1, $5, $1::uuid::text, $6, $7, 1)`;
// 候補は文書単位で保存されるため、正解の発言IDと照合できるよう文書のsource発言へ引き直す。
const CANDIDATE_MESSAGES_SQL = `
  SELECT document_id, document_revision, message_id
    FROM search_document_sources
   WHERE (document_id, document_revision) IN (SELECT * FROM unnest($1::uuid[], $2::int[]))`;

const storedResultSchema = z.looseObject({
  matches: z.array(z.looseObject({ evidence: z.array(z.looseObject({ message_id: z.string() })).optional() })).optional(),
  candidate_evaluations: z.array(z.looseObject({ document_id: z.string(), revision: z.number(), relevance: z.string(), retrieval_kinds: z.array(z.string()).optional() })).optional(),
});

interface EvalScope {
  company_id: string;
  employee_id: string;
  projectId: string;
}

// 1ケースを一時的な会話で実行し、結果を読んでから会話ごと削除する。失敗しても削除する。
async function evaluateSearchCase(pool: Pool, config: WorkerConfig, scope: EvalScope, item: SearchEvalCase): Promise<SearchEvalCaseResult> {
  const [sessionId, messageId, requestId, jobId, leaseToken] = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()];
  const hash = createHash('sha256').update(item.question, 'utf8').digest();
  const missing = { name: item.name, in_candidates: false, candidate_position: null, relevance: null, retrieval_kinds: null };
  const leaseExpiresAt = new Date(Date.now() + DEFAULT_JOB_LEASE_MS);
  const payload = { search_request_id: requestId };
  const job: ClaimedJob = { id: jobId, kind: 'execute_search', priority: EXECUTE_SEARCH_PRIORITY, sessionId, messageId, targetRevision: 1, payload, leaseToken, leaseExpiresAt, attempts: 1 };
  try {
    await pool.query(INSERT_SESSION_SQL, [sessionId, scope.projectId, scope.employee_id, EVAL_SOURCE_NAMESPACE]);
    await pool.query(INSERT_MESSAGE_SQL, [messageId, sessionId]);
    await pool.query(INSERT_REVISION_SQL, [messageId, item.question, hash]);
    const request = [requestId, scope.company_id, scope.projectId, scope.employee_id, sessionId, messageId, WORKER_POLICY_VERSION, item.question, hash, item.primary_only === true];
    await pool.query(INSERT_REQUEST_SQL, request);
    await pool.query(INSERT_RUNNING_JOB_SQL, [jobId, EXECUTE_SEARCH_PRIORITY, sessionId, messageId, payload, leaseToken, leaseExpiresAt]);
    await processJob(pool, job, config);
    const stored = await pool.query<{ status: string; error_code: string | null; result: unknown }>(
      'SELECT status, error_code, result FROM search_requests WHERE id = $1',
      [requestId],
    );
    const row = stored.rows[0];
    if (row === undefined || row.status !== 'completed') {
      return { ...missing, status: 'error', error_code: row?.error_code ?? 'search_not_completed' };
    }
    const result = storedResultSchema.parse(row.result ?? {});
    const evaluations = result.candidate_evaluations ?? [];
    const sources = await pool.query<{ document_id: string; document_revision: number; message_id: string }>(CANDIDATE_MESSAGES_SQL, [
      evaluations.map((evaluation) => evaluation.document_id),
      evaluations.map((evaluation) => evaluation.revision),
    ]);
    const expected = new Set(item.expected_message_ids);
    const isExpected = (documentId: string, revision: number): boolean =>
      sources.rows.some((source) => source.document_id === documentId && source.document_revision === revision && expected.has(source.message_id));
    const position = evaluations.findIndex((evaluation) => isExpected(evaluation.document_id, evaluation.revision));
    const adopted = (result.matches?.[0]?.evidence ?? []).some((evidence) => expected.has(evidence.message_id));
    const relevance = evaluations[position]?.relevance ?? null;
    const candidatePosition = position >= 0 ? position + 1 : null;
    // 合格条件が「候補に入ること」のケースは、代表根拠にならなくても当たりにする。
    const passed = item.pass_when === 'in_candidates' ? position >= 0 : adopted;
    return { name: item.name, status: passed ? 'hit' : 'miss', in_candidates: position >= 0, candidate_position: candidatePosition, relevance, retrieval_kinds: evaluations[position]?.retrieval_kinds ?? null, error_code: null };
  } catch {
    return { ...missing, status: 'error', error_code: 'internal_error' };
  } finally {
    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  }
}

// 正解つきの質問を本番と同じ検索処理へ流し、正解が代表根拠になったかをケースごとに報告する。
// 対象DBへ一時的な会話・発言・検索の受付・jobを書き込み、ケースごとに削除する。本番DBへ向けて実行しない。
export async function evaluateSearchCases(
  pool: Pool,
  config: WorkerConfig,
  projectId: string,
  cases: readonly SearchEvalCase[],
): Promise<SearchEvalResult> {
  const owner = await pool.query<{ company_id: string; employee_id: string }>(
    // 所属の登録がない案件にも会話は保存されるため、持ち主は案件の既存の会話から選ぶ。検索の範囲は社員で絞らない。
    `SELECT p.company_id, s.employee_id FROM projects p JOIN sessions s ON s.project_id = p.id
      WHERE p.id = $1 ORDER BY s.employee_id LIMIT 1`,
    [projectId],
  );
  const scope = owner.rows[0];
  if (scope === undefined) {
    return { ok: false, code: 'project_not_found' };
  }
  const results: SearchEvalCaseResult[] = [];
  for (const item of cases) {
    results.push(await evaluateSearchCase(pool, config, { ...scope, projectId }, item));
  }
  return { ok: true, report: { total: results.length, hits: results.filter((result) => result.status === 'hit').length, cases: results } };
}
