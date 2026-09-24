import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import {
  BUILD_DOCUMENTS_PRIORITY,
  DEFAULT_JOB_LEASE_MS,
  EXECUTE_SEARCH_PRIORITY,
  blockJob,
  completeJob,
  enqueueJob,
  failJob,
  renewJobLease,
  type ClaimedJob,
} from '../jobs/queue.js';
import {
  JEV_PROVIDER,
  JEV_QUESTIONS_VERSION,
  WORKER_POLICY_VERSION,
  type JevAnswer,
  type JevUsage,
} from './contract.js';
import type { WorkerConfig } from './config.js';
import {
  InputBudgetError,
  loadJobTarget,
  loadPriorMessages,
  loadPriorSearch,
  planEvaluations,
  type EvaluationPlan,
  type JobTarget,
} from './context.js';
import { JevCallError, callJev, validateJevResponse } from './jev.js';
import { aggregateEvaluations, type AggregatedEvaluation, type PartEvaluation } from './analysis.js';
import { resolveReuse } from './reuse.js';

class PolicyBlockedError extends Error {}
class LeaseLostError extends Error {}
class TargetMissingError extends Error {}

interface RouteDecision {
  kind: 'new_search' | 'reuse' | 'skip';
  originRequestId?: string;
}

interface CachedEvaluation {
  responseModel: string;
  answers: Record<string, JevAnswer>;
}

// 承認条件を満たす有効な承認があるか。各HTTP送信の直前に呼ぶ。
async function hasActiveApproval(pool: Pool, companyId: string, config: WorkerConfig): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
       FROM provider_policy_approvals
      WHERE company_id = $1 AND provider = $2 AND account_ref = $3 AND endpoint = $4
        AND active AND learning_disabled
        AND confirmed_at <= now()
        AND (terms_checked_at IS NULL OR terms_checked_at <= now())
      LIMIT 1`,
    [companyId, JEV_PROVIDER, config.accountRef, config.apiUrl],
  );
  return result.rows.length > 0;
}

// 応答modelが不明な旧cache行は再利用せず、実評価で更新するまでcache-hitにしない。
async function loadCachedEvaluation(
  pool: Pool,
  companyId: string,
  config: WorkerConfig,
  stateHash: Buffer,
): Promise<CachedEvaluation | undefined> {
  const result = await pool.query<CachedEvaluation>(
    `SELECT response_model AS "responseModel", answers
       FROM jev_evaluations
      WHERE company_id = $1 AND provider = $2 AND account_ref = $3 AND endpoint = $4
        AND model = $5 AND confidence_threshold = $6 AND policy_version = $7 AND questions_version = $8 AND state_hash = $9
        AND response_model IS NOT NULL`,
    [
      companyId,
      JEV_PROVIDER,
      config.accountRef,
      config.apiUrl,
      config.model,
      config.confidenceThreshold,
      WORKER_POLICY_VERSION,
      JEV_QUESTIONS_VERSION,
      stateHash,
    ],
  );
  return result.rows[0];
}

// 完了済み評価だけを保存する。同時missでの二重外部評価は許容する。
// 旧行の応答modelがNULLの時は実評価の応答modelと回答で更新し、不明なまま再利用させない。
async function saveCachedEvaluation(
  pool: Pool,
  companyId: string,
  config: WorkerConfig,
  stateHash: Buffer,
  responseModel: string,
  answers: Record<string, JevAnswer>,
): Promise<void> {
  await pool.query(
    `INSERT INTO jev_evaluations
       (id, company_id, provider, account_ref, endpoint, model, confidence_threshold, policy_version, questions_version, state_hash, answers, response_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
     ON CONFLICT (company_id, provider, account_ref, endpoint, model, confidence_threshold, policy_version, questions_version, state_hash)
     DO UPDATE SET answers = EXCLUDED.answers, response_model = EXCLUDED.response_model
     WHERE jev_evaluations.response_model IS NULL`,
    [
      uuidv7(),
      companyId,
      JEV_PROVIDER,
      config.accountRef,
      config.apiUrl,
      config.model,
      config.confidenceThreshold,
      WORKER_POLICY_VERSION,
      JEV_QUESTIONS_VERSION,
      stateHash,
      JSON.stringify(answers),
      responseModel,
    ],
  );
}

// 応答本文を取得できた場合だけ、検証結果とは独立に応答modelを取り出す。推測補完はしない。
function extractResponseModel(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const model = (raw as { model?: unknown }).model;
  return typeof model === 'string' && model.length > 0 ? model : null;
}

function extractUsage(raw: unknown): JevUsage {
  if (typeof raw !== 'object' || raw === null) {
    return { input_tokens: null, output_tokens: null };
  }
  const usage = (raw as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) {
    return { input_tokens: null, output_tokens: null };
  }
  const input = (usage as { input_tokens?: unknown }).input_tokens;
  const output = (usage as { output_tokens?: unknown }).output_tokens;
  return {
    input_tokens: typeof input === 'number' && Number.isInteger(input) && input >= 0 ? input : null,
    output_tokens: typeof output === 'number' && Number.isInteger(output) && output >= 0 ? output : null,
  };
}

// usage_eventsは試行ごとに1行。原文・key・外部error bodyは保存しない。
async function recordUsage(
  pool: Pool,
  target: JobTarget,
  jobKind: string,
  config: WorkerConfig,
  success: boolean,
  durationMs: number,
  errorCode: string | null,
  usage: JevUsage,
  responseModel: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO usage_events
       (id, company_id, provider, account_ref, endpoint, operation, model, response_model, input_tokens, output_tokens, duration_ms, success, error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      uuidv7(),
      target.companyId,
      JEV_PROVIDER,
      config.accountRef,
      config.apiUrl,
      jobKind,
      config.model,
      responseModel,
      usage.input_tokens,
      usage.output_tokens,
      Math.max(0, Math.round(durationMs)),
      success,
      errorCode,
    ],
  );
}

async function renewLeaseOrThrow(pool: Pool, job: ClaimedJob, config: WorkerConfig): Promise<void> {
  const renewed = await renewJobLease(pool, {
    jobId: job.id,
    leaseToken: job.leaseToken,
    leaseMs: config.leaseMs ?? DEFAULT_JOB_LEASE_MS,
  });
  if (!renewed) {
    throw new LeaseLostError('leaseを延長できません');
  }
}

// 承認確認→完了済みcache→外部呼出しの順で各partを評価する。所有を失った場合は適用しない。
async function evaluatePlan(
  pool: Pool,
  target: JobTarget,
  job: ClaimedJob,
  plan: EvaluationPlan,
  config: WorkerConfig,
): Promise<PartEvaluation[]> {
  const evaluations: PartEvaluation[] = [];
  for (const planned of plan.evaluations) {
    if (!(await hasActiveApproval(pool, target.companyId, config))) {
      throw new PolicyBlockedError('承認がありません');
    }
    const cached = await loadCachedEvaluation(pool, target.companyId, config, planned.stateHash);
    if (cached !== undefined) {
      try {
        const validated = validateJevResponse(
          { model: cached.responseModel, answers: cached.answers, usage: { input_tokens: null, output_tokens: null } },
          planned.request.questions,
        );
        evaluations.push({
          part: planned.part,
          answers: validated.answers,
          candidates: planned.candidates,
          responseModel: validated.model,
        });
        continue;
      } catch {
        // 検証できないcacheは使わず外部評価へ進む。
      }
    }
    await renewLeaseOrThrow(pool, job, config);
    // lease更新のDB待機中に承認が失効していたら、HTTP送信の直前にもう一度確認して送信しない。
    if (!(await hasActiveApproval(pool, target.companyId, config))) {
      throw new PolicyBlockedError('承認がありません');
    }
    const started = Date.now();
    let json: unknown;
    let durationMs: number;
    try {
      const called = await callJev(config, planned.bodyText);
      json = called.json;
      durationMs = called.durationMs;
    } catch (error) {
      const jevError = error instanceof JevCallError ? error : new JevCallError('provider_unavailable', true);
      await recordUsage(
        pool,
        target,
        job.kind,
        config,
        false,
        Date.now() - started,
        jevError.code,
        { input_tokens: null, output_tokens: null },
        null,
      );
      throw jevError;
    }
    try {
      const validated = validateJevResponse(json, planned.request.questions);
      await recordUsage(pool, target, job.kind, config, true, durationMs, null, validated.usage, validated.model);
      await saveCachedEvaluation(pool, target.companyId, config, planned.stateHash, validated.model, validated.answers);
      evaluations.push({
        part: planned.part,
        answers: validated.answers,
        candidates: planned.candidates,
        responseModel: validated.model,
      });
    } catch (error) {
      const code = error instanceof JevCallError ? error.code : 'provider_contract_invalid';
      // 応答本文からmodelを取得できた場合は、検証失敗でも取得できた値だけを記録する。
      await recordUsage(pool, target, job.kind, config, false, durationMs, code, extractUsage(json), extractResponseModel(json));
      throw error instanceof JevCallError ? error : new JevCallError('provider_contract_invalid', false);
    }
  }
  return evaluations;
}

// 現在revisionがjobの対象と一致する時だけ分析・関係・後続jobを同一TXで適用する。
async function applyAnalysis(
  pool: Pool,
  job: ClaimedJob,
  target: JobTarget,
  stateHash: Buffer,
  aggregate: AggregatedEvaluation,
): Promise<void> {
  const client = await pool.connect();
  const started = Date.now();
  try {
    await client.query('BEGIN');
    const message = await client.query<{ current_revision: number }>('SELECT current_revision FROM messages WHERE id = $1 FOR UPDATE', [
      target.messageId,
    ]);
    const currentRevision = message.rows[0]?.current_revision;
    if (currentRevision !== target.targetRevision) {
      // 古いrevisionは現在の状態へ適用せず、jobだけ終了する。
      const completed = await completeJob(client, { jobId: job.id, leaseToken: job.leaseToken, targetRevision: job.targetRevision });
      if (!completed) {
        await client.query('ROLLBACK');
        return;
      }
      await client.query('COMMIT');
      return;
    }
    await client.query(
      `INSERT INTO message_analysis
         (id, message_id, revision, policy_version, retention, primary_intent, technical_labels, decision_action,
          continuity, statement_status, is_searchable, model_version, state_hash, parts)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14::jsonb)
       ON CONFLICT (message_id, revision, policy_version) DO UPDATE
         SET retention = EXCLUDED.retention,
             primary_intent = EXCLUDED.primary_intent,
             technical_labels = EXCLUDED.technical_labels,
             decision_action = EXCLUDED.decision_action,
             continuity = EXCLUDED.continuity,
             statement_status = EXCLUDED.statement_status,
             is_searchable = EXCLUDED.is_searchable,
             model_version = EXCLUDED.model_version,
             state_hash = EXCLUDED.state_hash,
             parts = EXCLUDED.parts,
             updated_at = now()`,
      [
        uuidv7(),
        target.messageId,
        target.targetRevision,
        WORKER_POLICY_VERSION,
        aggregate.retention,
        aggregate.primaryIntent,
        JSON.stringify(aggregate.technicalLabels),
        aggregate.decisionAction,
        aggregate.continuity,
        aggregate.statementStatus,
        aggregate.isSearchable,
        aggregate.modelVersion,
        stateHash,
        JSON.stringify(aggregate.parts),
      ],
    );
    for (const relation of aggregate.relations) {
      // 対象発言が書込前に改訂されていたら、古いrevisionへの関係を確定しない。
      const targetMessage = await client.query<{ current_revision: number }>('SELECT current_revision FROM messages WHERE id = $1', [
        relation.targetMessageId,
      ]);
      if (targetMessage.rows[0]?.current_revision !== relation.targetRevision) {
        continue;
      }
      await client.query(
        `INSERT INTO message_relations
           (id, source_message_id, source_revision, target_message_id, target_revision, relation, is_explicit, evidence_ranges, policy_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         ON CONFLICT DO NOTHING`,
        [
          uuidv7(),
          target.messageId,
          target.targetRevision,
          relation.targetMessageId,
          relation.targetRevision,
          relation.relation,
          relation.isExplicit,
          JSON.stringify(relation.evidenceRanges),
          WORKER_POLICY_VERSION,
        ],
      );
    }
    await enqueueJob(client, {
      kind: 'build_documents',
      idempotencyKey: `build_documents:${target.messageId}:${target.targetRevision}:${WORKER_POLICY_VERSION}`,
      priority: BUILD_DOCUMENTS_PRIORITY,
      sessionId: target.sessionId,
      messageId: target.messageId,
      targetRevision: target.targetRevision,
      payload: { retention: aggregate.retention, is_searchable: aggregate.isSearchable },
    });
    const completed = await completeJob(client, { jobId: job.id, leaseToken: job.leaseToken, targetRevision: job.targetRevision });
    if (!completed) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query('COMMIT');
    await pool
      .query(`UPDATE message_analysis SET apply_duration_ms = $4 WHERE message_id = $1 AND revision = $2 AND policy_version = $3`, [
        target.messageId,
        target.targetRevision,
        WORKER_POLICY_VERSION,
        Math.max(0, Date.now() - started),
      ])
      .catch(() => undefined);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function conditionHash(target: JobTarget, priorMessages: readonly { messageId: string; revision: number; text: string }[]): Buffer {
  const value = {
    company_id: target.companyId,
    project_id: target.projectId,
    employee_id: target.employeeId,
    session_id: target.sessionId,
    input_id: target.messageId,
    input_revision: target.targetRevision,
    input_text: target.text,
    context: priorMessages.map((prior) => ({ message_id: prior.messageId, revision: prior.revision, text: prior.text })),
    policy_version: WORKER_POLICY_VERSION,
  };
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest();
}

async function findSearchRequestId(client: PoolClient, target: JobTarget): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id
       FROM search_requests
      WHERE input_id = $1 AND input_revision = $2 AND policy_version = $3 AND trigger = 'auto'`,
    [target.messageId, target.targetRevision, WORKER_POLICY_VERSION],
  );
  return result.rows[0]?.id ?? null;
}

// ルート判定を検索受付と同一TXで反映し、jobを完了する。適用時にlease/対象revisionを再確認する。
async function applyRouteDecision(
  pool: Pool,
  job: ClaimedJob,
  target: JobTarget,
  decision: RouteDecision,
  condition: Buffer,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const message = await client.query<{ current_revision: number }>('SELECT current_revision FROM messages WHERE id = $1 FOR UPDATE', [
      target.messageId,
    ]);
    if (message.rows[0]?.current_revision !== target.targetRevision) {
      const completed = await completeJob(client, { jobId: job.id, leaseToken: job.leaseToken, targetRevision: job.targetRevision });
      if (!completed) {
        await client.query('ROLLBACK');
        return;
      }
      await client.query('COMMIT');
      return;
    }
    const searchRequestId = await findSearchRequestId(client, target);
    if (searchRequestId === null) {
      throw new TargetMissingError('search_requestがありません');
    }
    if (decision.kind === 'reuse') {
      await client.query(
        `UPDATE search_requests
            SET status = 'pending', outcome = NULL, error_code = NULL, search_action = 'reuse',
                stage = 'awaiting_reused_search', reused_from_request_id = $2, original_request_id = $2,
                result = NULL, updated_at = now()
          WHERE id = $1`,
        [searchRequestId, decision.originRequestId],
      );
    } else if (decision.kind === 'skip') {
      await client.query(
        `UPDATE search_requests
            SET status = 'completed', outcome = 'skipped', error_code = NULL, search_action = 'skip',
                stage = 'completed', reused_from_request_id = NULL, result = NULL, updated_at = now()
          WHERE id = $1`,
        [searchRequestId],
      );
    } else {
      await client.query(
        `UPDATE search_requests
            SET status = 'pending', outcome = NULL, error_code = NULL, search_action = 'new_search',
                stage = 'awaiting_search', condition_hash = $2, reused_from_request_id = NULL, original_request_id = NULL,
                result = NULL, updated_at = now()
          WHERE id = $1`,
        [searchRequestId, condition],
      );
      await enqueueJob(client, {
        kind: 'execute_search',
        idempotencyKey: `execute_search:${searchRequestId}:${WORKER_POLICY_VERSION}`,
        priority: EXECUTE_SEARCH_PRIORITY,
        sessionId: target.sessionId,
        messageId: target.messageId,
        targetRevision: target.targetRevision,
        payload: { search_request_id: searchRequestId },
      });
    }
    const completed = await completeJob(client, { jobId: job.id, leaseToken: job.leaseToken, targetRevision: job.targetRevision });
    if (!completed) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// route_search処理の開始時、自動再試行着手として障害中の受付をpendingへ戻す。
async function resetSearchForRetry(pool: Pool, target: JobTarget): Promise<void> {
  await pool.query(
    `UPDATE search_requests
        SET status = 'pending', error_code = NULL, outcome = NULL, updated_at = now()
      WHERE input_id = $1 AND input_revision = $2 AND policy_version = $3 AND trigger = 'auto' AND status = 'failed'`,
    [target.messageId, target.targetRevision, WORKER_POLICY_VERSION],
  );
}

async function processClassify(pool: Pool, job: ClaimedJob, config: WorkerConfig): Promise<void> {
  const target = await loadJobTarget(pool, job);
  if (target === null) {
    throw new TargetMissingError('対象message/revisionがありません');
  }
  const priorMessages = await loadPriorMessages(pool, target);
  const priorSearch = await loadPriorSearch(pool, target);
  const plan = planEvaluations(target, priorMessages, priorSearch, config);
  const evaluations = await evaluatePlan(pool, target, job, plan, config);
  const aggregate = aggregateEvaluations(evaluations, config.confidenceThreshold);
  await applyAnalysis(pool, job, target, plan.stateHash, aggregate);
}

async function processRoute(pool: Pool, job: ClaimedJob, config: WorkerConfig): Promise<void> {
  const target = await loadJobTarget(pool, job);
  if (target === null) {
    throw new TargetMissingError('対象message/revisionがありません');
  }
  await resetSearchForRetry(pool, target);
  const priorMessages = await loadPriorMessages(pool, target);
  const priorSearch = await loadPriorSearch(pool, target);
  const plan = planEvaluations(target, priorMessages, priorSearch, config);
  const evaluations = await evaluatePlan(pool, target, job, plan, config);
  const aggregate = aggregateEvaluations(evaluations, config.confidenceThreshold);
  let decision: RouteDecision = { kind: 'new_search' };
  if (aggregate.searchAction === 'skip') {
    decision = { kind: 'skip' };
  } else if (
    aggregate.searchAction === 'reuse' &&
    aggregate.sameConditions &&
    aggregate.continuity === 'same_topic' &&
    plan.evaluations.every((evaluation) => evaluation.priorSearchIncluded)
  ) {
    const reuse = await resolveReuse(pool, target, plan.priorSearch);
    if (reuse.eligible && reuse.originRequestId !== null) {
      decision = { kind: 'reuse', originRequestId: reuse.originRequestId };
    }
  }
  const condition = conditionHash(
    target,
    priorMessages.map((prior) => ({ messageId: prior.messageId, revision: prior.revision, text: prior.text })),
  );
  await applyRouteDecision(pool, job, target, decision, condition);
}

function errorCodeOf(error: unknown): { code: string; retryable: boolean; retryAfterMs?: number } {
  if (error instanceof InputBudgetError) {
    return { code: 'input_budget_exceeded', retryable: false };
  }
  if (error instanceof TargetMissingError) {
    return { code: 'target_missing', retryable: false };
  }
  if (error instanceof JevCallError) {
    return { code: error.code, retryable: error.retryable, retryAfterMs: error.retryAfterMs };
  }
  return { code: 'internal_error', retryable: false };
}

// 障害時もsearch受付はfailedとcodeを持ち、no_matchにしない。所有喪失時は状態を変えない。
async function markSearchFailed(client: PoolClient, job: ClaimedJob, code: string): Promise<void> {
  if (job.kind !== 'route_search' || job.messageId === null || job.targetRevision === null) {
    return;
  }
  await client.query(
    `UPDATE search_requests
        SET status = 'failed', error_code = $4, outcome = NULL, updated_at = now()
      WHERE input_id = $1 AND input_revision = $2 AND policy_version = $3 AND trigger = 'auto'`,
    [job.messageId, job.targetRevision, WORKER_POLICY_VERSION, code],
  );
}

async function handleProcessError(pool: Pool, job: ClaimedJob, error: unknown): Promise<void> {
  if (error instanceof LeaseLostError) {
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (error instanceof PolicyBlockedError) {
      const blocked = await blockJob(client, {
        jobId: job.id,
        leaseToken: job.leaseToken,
        errorCode: 'provider_policy_unverified',
      });
      if (!blocked) {
        await client.query('ROLLBACK');
        return;
      }
      await markSearchFailed(client, job, 'provider_policy_unverified');
      await client.query('COMMIT');
      return;
    }
    const failure = errorCodeOf(error);
    const failed = await failJob(client, {
      jobId: job.id,
      leaseToken: job.leaseToken,
      errorCode: failure.code,
      retryable: failure.retryable,
      retryAfterMs: failure.retryAfterMs,
    });
    if (!failed) {
      await client.query('ROLLBACK');
      return;
    }
    await markSearchFailed(client, job, failure.code);
    await client.query('COMMIT');
  } catch (persistError) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw persistError;
  } finally {
    client.release();
  }
}

// 1 jobを処理する。期待される外部障害・契約違反はjob状態へ反映し、想定外だけthrowする。
export async function processJob(pool: Pool, job: ClaimedJob, config: WorkerConfig): Promise<void> {
  try {
    if (job.kind === 'classify_message') {
      await processClassify(pool, job, config);
      return;
    }
    if (job.kind === 'route_search') {
      await processRoute(pool, job, config);
      return;
    }
    throw new TargetMissingError('未対応のjob種別です');
  } catch (error) {
    await handleProcessError(pool, job, error);
  }
}

// failed/blocked_policyのjobを、現在の承認確認後にpendingへ戻す。検索受付も同一TXで戻す。
export async function retryJob(pool: Pool, jobId: string, config: WorkerConfig): Promise<boolean> {
  const jobResult = await pool.query<{
    id: string;
    kind: string;
    status: string;
    message_id: string | null;
    target_revision: number | null;
  }>('SELECT id, kind, status, message_id, target_revision FROM jobs WHERE id = $1', [jobId]);
  const job = jobResult.rows[0];
  if (!job || (job.status !== 'failed' && job.status !== 'blocked_policy') || job.message_id === null || job.target_revision === null) {
    return false;
  }
  const companyResult = await pool.query<{ company_id: string }>(
    `SELECT p.company_id
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN projects p ON p.id = s.project_id
      WHERE m.id = $1`,
    [job.message_id],
  );
  const companyId = companyResult.rows[0]?.company_id;
  if (companyId === undefined || !(await hasActiveApproval(pool, companyId, config))) {
    return false;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE jobs
          SET status = 'pending', error_code = NULL, lease_token = NULL, lease_expires_at = NULL, next_run_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('failed', 'blocked_policy')
        RETURNING id`,
      [jobId],
    );
    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    if (job.kind === 'route_search') {
      await client.query(
        `UPDATE search_requests
            SET status = 'pending', outcome = NULL, error_code = NULL, stage = NULL, updated_at = now()
          WHERE input_id = $1 AND input_revision = $2 AND policy_version = $3 AND trigger = 'auto'`,
        [job.message_id, job.target_revision, WORKER_POLICY_VERSION],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
