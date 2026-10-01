import type { Pool, PoolClient } from 'pg';
import type { EventRole } from '../api/contract.js';
import { JUDGE_CONTINUITY_PRIORITY, completeJob, enqueueJob, type ClaimedJob } from '../jobs/queue.js';
import { hasActiveProviderApproval } from './approvals.js';
import type { WorkerConfig } from './config.js';
import { JEV_PROVIDER, WORKER_POLICY_VERSION, type JevChoiceQuestion, type JevRequest, type JevState } from './contract.js';
import type { JobTarget } from './context.js';
import { LeaseLostError, PolicyBlockedError } from './errors.js';
import { JevCallError, buildRequest, callJev, extractJevResponseModel, extractJevUsage, serializeRequest, validateJevResponse } from './jev.js';
import { recordJevUsage } from './usage.js';

// 推定session継続のバックグラウンド判定。検索のたびにJevで判定していた「作業が続いているか」を、
// sessionごとに1回だけ判定してsession_continuity_judgmentsへ保存する。検索時はDBを引くだけにする。
// 「今の質問の参考になるか」は質問ごとに変わるため、検索時に埋め込みの近さで確認する（exploration.ts）。

// 質問文・criteriaを変えた時に判定をやり直すための版。
export const CONTINUITY_QUESTIONS_VERSION = 'continuity-1';
// 文書構築から判定までの待ち。sessionの冒頭がある程度たまってから判定する。
export const CONTINUITY_JUDGE_DELAY_MS = 10 * 60_000;
// 判定に使う各sessionの発言数と、1発言あたりの文字数上限。
const CONTEXT_MESSAGES = 5;
const CONTEXT_MESSAGE_MAX_CHARS = 300;
// 同社員の直前session数。以前の検索時探索（前後各3）のうち、後続側は後続session自身の判定で扱う。
const ADJACENT_SESSION_LIMIT = 3;
// 1回の判定に含める候補session数の上限。
const CANDIDATE_LIMIT = 6;
// 明示Issue／PR entity。file/functionは継続候補の根拠に使わない。
const CONTINUITY_ENTITY_TYPES = ['issue', 'pull_request'];

const CONTINUITY_CRITERIA = {
  continuous: '候補sessionの作業を引き継いでいる',
  separate: '別の作業',
  unknown: '判断不能',
};

export function continuityQuestionId(candidateSessionId: string): string {
  return `session_continuity:${candidateSessionId}#0`;
}

// 文書構築のたびに呼び、sessionごとに1件だけ判定jobを遅延登録する（冪等キーで重複させない）。
export async function enqueueContinuityJudgment(pool: Pool | PoolClient, target: JobTarget): Promise<void> {
  await enqueueJob(pool, {
    kind: 'judge_continuity',
    idempotencyKey: `judge_continuity:${target.sessionId}:${WORKER_POLICY_VERSION}:${CONTINUITY_QUESTIONS_VERSION}`,
    priority: JUDGE_CONTINUITY_PRIORITY,
    sessionId: target.sessionId,
    messageId: target.messageId,
    targetRevision: target.targetRevision,
    nextRunAt: new Date(Date.now() + CONTINUITY_JUDGE_DELAY_MS),
  });
}

interface SessionScope {
  id: string;
  companyId: string;
  projectId: string;
  employeeId: string;
  startedAt: Date;
}

interface ContextRow {
  message_id: string;
  revision: number;
  role: EventRole;
  occurred_at: Date;
  text: string;
}

async function loadSessionScope(pool: Pool, sessionId: string): Promise<SessionScope | null> {
  const result = await pool.query<{ id: string; company_id: string; project_id: string; employee_id: string; started_at: Date }>(
    `SELECT s.id, p.company_id, s.project_id, s.employee_id, s.started_at
       FROM sessions s JOIN projects p ON p.id = s.project_id
      WHERE s.id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { id: row.id, companyId: row.company_id, projectId: row.project_id, employeeId: row.employee_id, startedAt: row.started_at };
}

// 同社員・同案件の直前session（最大3）と、このsessionの公開文書と同じIssue/PR entityを持つsession。
// 明示link（active/revoked）でつながる組は候補にしない。候補を選んだ後で、どちら向きでも判定済みの組を除く
// （判定済みを先に除くと、より古いsessionが繰り上がって候補範囲が広がるため）。
export async function loadContinuityCandidates(pool: Pool, scope: SessionScope): Promise<string[]> {
  const notLinked = `
        AND NOT EXISTS (
          SELECT 1 FROM session_links l
           WHERE l.company_id = $1 AND l.project_id = $2
             AND ((l.from_session_id = $3 AND l.to_session_id = s.id) OR (l.from_session_id = s.id AND l.to_session_id = $3))
        )`;
  const adjacent = await pool.query<{ id: string }>(
    `SELECT s.id FROM sessions s JOIN projects p ON p.id = s.project_id
      WHERE p.company_id = $1 AND s.project_id = $2 AND s.id <> $3 AND s.employee_id = $4 AND s.started_at <= $5
        ${notLinked}
      ORDER BY s.started_at DESC, s.id DESC
      LIMIT ${ADJACENT_SESSION_LIMIT}`,
    [scope.companyId, scope.projectId, scope.id, scope.employeeId, scope.startedAt],
  );
  const entity = await pool.query<{ id: string }>(
    `SELECT DISTINCT s.id, s.started_at FROM sessions s
       JOIN search_documents d ON d.session_id = s.id AND d.company_id = $1 AND d.project_id = $2 AND d.is_searchable
       JOIN document_entities e ON e.document_id = d.id
      WHERE s.project_id = $2 AND s.id <> $3
        AND e.entity_type = ANY($4::text[])
        AND (e.entity_type, e.entity_key) IN (
          SELECT oe.entity_type, oe.entity_key
            FROM document_entities oe
            JOIN search_documents od ON od.id = oe.document_id
           WHERE od.session_id = $3 AND od.company_id = $1 AND od.project_id = $2 AND oe.entity_type = ANY($4::text[])
        )
        ${notLinked}
      ORDER BY s.started_at DESC, s.id DESC
      LIMIT ${CANDIDATE_LIMIT}`,
    [scope.companyId, scope.projectId, scope.id, CONTINUITY_ENTITY_TYPES],
  );
  const candidates = [...new Set([...adjacent.rows.map((row) => row.id), ...entity.rows.map((row) => row.id)])].slice(0, CANDIDATE_LIMIT);
  if (candidates.length === 0) {
    return [];
  }
  const judged = await pool.query<{ other: string }>(
    `SELECT CASE WHEN session_id = $1 THEN candidate_session_id ELSE session_id END AS other
       FROM session_continuity_judgments
      WHERE policy_version = $2
        AND ((session_id = $1 AND candidate_session_id = ANY($3::uuid[])) OR (candidate_session_id = $1 AND session_id = ANY($3::uuid[])))`,
    [scope.id, WORKER_POLICY_VERSION, candidates],
  );
  const judgedIds = new Set(judged.rows.map((row) => row.other));
  return candidates.filter((candidate) => !judgedIds.has(candidate));
}

async function loadContext(pool: Pool, sessionId: string, order: 'first' | 'last'): Promise<ContextRow[]> {
  const result = await pool.query<ContextRow>(
    `SELECT m.id AS message_id, m.current_revision AS revision, m.role, m.occurred_at, r.text
       FROM messages m
       JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
      WHERE m.session_id = $1
      ORDER BY m.sequence_no ${order === 'first' ? 'ASC' : 'DESC'}
      LIMIT ${CONTEXT_MESSAGES}`,
    [sessionId],
  );
  return order === 'first' ? result.rows : [...result.rows].reverse();
}

function contextText(rows: readonly ContextRow[]): string {
  return rows.map((row) => `[${row.role}] ${row.text.slice(0, CONTEXT_MESSAGE_MAX_CHARS)}`).join('\n');
}

// judge_continuity 1件を処理する。対象sessionの冒頭と各候補sessionの末尾を1回のJev requestで判定し、
// 高信頼のcontinuousだけを継続として保存する。判定済み・候補なしは外部送信せず完了する。
export async function processJudgeContinuity(pool: Pool, job: ClaimedJob, config: WorkerConfig): Promise<void> {
  const scope = job.sessionId === null ? null : await loadSessionScope(pool, job.sessionId);
  const candidates = scope === null ? [] : await loadContinuityCandidates(pool, scope);
  const current = scope === null || candidates.length === 0 ? [] : await loadContext(pool, scope.id, 'first');
  if (scope === null || candidates.length === 0 || current.length === 0) {
    await finish(pool, job, scope, []);
    return;
  }
  const approved = await hasActiveProviderApproval(pool, {
    companyId: scope.companyId,
    provider: JEV_PROVIDER,
    accountRef: config.accountRef,
    endpoint: config.apiUrl,
  });
  if (!approved) {
    throw new PolicyBlockedError('Jevの送信承認がありません');
  }
  const questions: Record<string, JevChoiceQuestion> = {};
  for (const candidateId of candidates) {
    const context = contextText(await loadContext(pool, candidateId, 'last'));
    questions[continuityQuestionId(candidateId)] = {
      type: 'choice',
      instructions: `継続元候補session ${candidateId} の末尾:\n${context}\n現在のsession（state.current）がこの候補sessionの作業を引き継いでいるかを選ぶ。話題が近いだけなら別の作業とする。`,
      criteria: { ...CONTINUITY_CRITERIA },
    };
  }
  const first = current[0] as ContextRow;
  const currentText = contextText(current);
  const state: JevState = {
    policy_version: WORKER_POLICY_VERSION,
    current: {
      message_id: first.message_id,
      revision: first.revision,
      role: first.role,
      occurred_at: first.occurred_at.toISOString(),
      parts: [{ offset: 0, length: currentText.length, text: currentText }],
    },
    prior_messages: [],
    prior_search: null,
    truncation: { omitted_prior_messages: 0, split_current: false, prior_search_omitted: false },
  };
  const request: JevRequest = buildRequest(config.model, state, questions);
  const usageInput = { companyId: scope.companyId, config, jobKind: job.kind };
  const started = Date.now();
  let json: unknown;
  let durationMs: number;
  try {
    const called = await callJev(config, serializeRequest(request));
    json = called.json;
    durationMs = called.durationMs;
  } catch (error) {
    const jevError = error instanceof JevCallError ? error : new JevCallError('provider_unavailable', true);
    await recordJevUsage(pool, usageInput, false, Date.now() - started, jevError.code, { input_tokens: null, output_tokens: null }, null);
    throw jevError;
  }
  let validated;
  try {
    validated = validateJevResponse(json, questions);
  } catch (error) {
    const code = error instanceof JevCallError ? error.code : 'provider_contract_invalid';
    await recordJevUsage(pool, usageInput, false, durationMs, code, extractJevUsage(json), extractJevResponseModel(json));
    throw error instanceof JevCallError ? error : new JevCallError('provider_contract_invalid', false);
  }
  await recordJevUsage(pool, usageInput, true, durationMs, null, validated.usage, validated.model);
  const judgments = candidates.map((candidateId) => {
    const answer = validated.answers[continuityQuestionId(candidateId)];
    return {
      candidateId,
      continuous: answer !== undefined && answer.choice === 'continuous' && answer.confidence >= config.confidenceThreshold,
    };
  });
  await finish(pool, job, scope, judgments);
}

// 判定結果とjob完了を同一TXで保存する。lease喪失時は保存しない。
async function finish(
  pool: Pool,
  job: ClaimedJob,
  scope: SessionScope | null,
  judgments: ReadonlyArray<{ candidateId: string; continuous: boolean }>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (scope !== null) {
      for (const judgment of judgments) {
        await client.query(
          `INSERT INTO session_continuity_judgments
             (company_id, project_id, session_id, candidate_session_id, continuous, policy_version, questions_version)
           SELECT $1, $2, $3, c.id, $5, $6, $7
             FROM sessions c WHERE c.id = $4 AND c.project_id = $2
           ON CONFLICT (session_id, candidate_session_id, policy_version) DO NOTHING`,
          [
            scope.companyId,
            scope.projectId,
            scope.id,
            judgment.candidateId,
            judgment.continuous,
            WORKER_POLICY_VERSION,
            CONTINUITY_QUESTIONS_VERSION,
          ],
        );
      }
    }
    const completed = await completeJob(client, { jobId: job.id, leaseToken: job.leaseToken, targetRevision: job.targetRevision });
    if (!completed) {
      throw new LeaseLostError('jobを完了できません');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
