import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { EVENT_WRITE_LOCK_NAMESPACE } from '../api/contract.js';
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
  VOYAGE_PROVIDER,
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
  type PriorSearch,
} from './context.js';
import {
  JevCallError,
  callJev,
  extractJevResponseModel,
  extractJevUsage,
  validateJevResponse,
} from './jev.js';
import { aggregateEvaluations, type AggregatedEvaluation, type PartEvaluation } from './analysis.js';
import { resolveReuse } from './reuse.js';
import {
  applyDocumentEmbeddings,
  applyDocumentPlan,
  loadDocumentBuildPlan,
  markPendingRevisionsFailed,
} from './documents.js';
import { ensureActiveGeneration, loadPinnedGeneration, VoyageEmbeddingProvider } from './embedding.js';
import { processExecuteSearch, searchRequestIdFromPayload } from './search.js';
import { enqueueContinuityJudgment, processJudgeContinuity } from './continuity.js';
import { GenerationMismatchError, LeaseLostError, PolicyBlockedError, StaleApplyError, TargetMissingError } from './errors.js';
import { VoyageCallError } from './voyage.js';
import { hasActiveProviderApproval } from './approvals.js';

// strategyTermsはreuse不適格で新規検索へ戻る場合にも使う。
type RouteDecision =
  | { kind: 'skip' }
  | { kind: 'new_search'; strategyTerms: string[] }
  | { kind: 'reuse'; priorSearch: PriorSearch; strategyTerms: string[] };

interface CachedEvaluation {
  responseModel: string;
  answers: Record<string, JevAnswer>;
}

// 承認条件を満たす有効な承認があるか。各HTTP送信の直前に呼ぶ。
async function hasActiveApproval(pool: Pool, companyId: string, config: WorkerConfig): Promise<boolean> {
  return hasActiveProviderApproval(pool, {
    companyId,
    provider: JEV_PROVIDER,
    accountRef: config.accountRef,
    endpoint: config.apiUrl,
  });
}

// Voyage送信の承認確認。build_documentsのretryも同じ条件を使う。
async function hasActiveVoyageApproval(pool: Pool, companyId: string, config: WorkerConfig): Promise<boolean> {
  return hasActiveProviderApproval(pool, {
    companyId,
    provider: VOYAGE_PROVIDER,
    accountRef: config.voyageAccountRef,
    endpoint: config.voyageApiUrl,
  });
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
        AND requested_model = $5 AND confidence_threshold = $6 AND policy_version = $7 AND questions_version = $8 AND state_hash = $9
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

// 完了済み評価だけを保存する。同時missはstate_hash単位のlockで直列化し、lock待ちtimeout時だけ二重評価を許容する。
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
       (id, company_id, provider, account_ref, endpoint, requested_model, confidence_threshold, policy_version, questions_version, state_hash, answers, response_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
     ON CONFLICT (company_id, provider, account_ref, endpoint, requested_model, confidence_threshold, policy_version, questions_version, state_hash)
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
       (id, company_id, provider, account_ref, endpoint, operation, requested_model, response_model, input_tokens, output_tokens, duration_ms, success, error_code)
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

// 同じstate_hashのJev評価を直列化するadvisory lockのkey1。key2はstate_hash先頭4byteから導出する。
const JEV_EVALUATION_LOCK_NAMESPACE = 20261001;
// lock待ちの上限。poolのquery_timeout（15秒）より短くし、client側timeoutで待機queryが残る状態を作らない。
// 超過時はlockなしで評価へ進み、検索を止めない（この場合だけ二重評価になり得る）。
const JEV_EVALUATION_LOCK_WAIT_MAX_MS = 12_000;

type PlannedEvaluation = EvaluationPlan['evaluations'][number];

// cacheを検証して評価へ変換する。検証できないcacheはundefinedとし、外部評価へ進める。
function evaluationFromCache(planned: PlannedEvaluation, cached: CachedEvaluation | undefined): PartEvaluation | undefined {
  if (cached === undefined) {
    return undefined;
  }
  try {
    const validated = validateJevResponse(
      { model: cached.responseModel, answers: cached.answers, usage: { input_tokens: null, output_tokens: null } },
      planned.request.questions,
    );
    return { part: planned.part, answers: validated.answers, candidates: planned.candidates, responseModel: validated.model };
  } catch {
    return undefined;
  }
}

// route_searchと分類は同じuser発言を同じstateで評価する。同時にcache missしても外部評価を1回にするため、
// state_hash単位のsession advisory lockを外部評価の間だけ保持する。transaction・row lockは保持しない。
// 接続断ではlockが自動解放される。lock待ちがtimeoutした時はlockなしで続行する（二重評価を許容し、停止しない）。
async function acquireEvaluationLock(pool: Pool, stateHash: Buffer, config: WorkerConfig): Promise<PoolClient | null> {
  const client = await pool.connect();
  try {
    const waitMs = Math.max(1, Math.min(Math.round(config.requestTimeoutMs), JEV_EVALUATION_LOCK_WAIT_MAX_MS));
    await client.query(`SET lock_timeout = ${waitMs}`);
    await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [JEV_EVALUATION_LOCK_NAMESPACE, stateHash.readInt32BE(0)]);
    await client.query('RESET lock_timeout');
    return client;
  } catch {
    // lock状態が不確かな接続はpoolへ戻さず破棄する。接続終了でsession lockも解放される。
    client.release(true);
    return null;
  }
}

async function releaseEvaluationLock(client: PoolClient | null, stateHash: Buffer): Promise<void> {
  if (client === null) {
    return;
  }
  try {
    await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [JEV_EVALUATION_LOCK_NAMESPACE, stateHash.readInt32BE(0)]);
    client.release();
  } catch (error) {
    // unlockできない接続はpoolへ戻さず破棄し、session lockを残さない。
    client.release(error instanceof Error ? error : true);
  }
}

// 承認確認→完了済みcache→同state評価のlock→cache再確認→外部呼出しの順で各partを評価する。所有を失った場合は適用しない。
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
    const fromCache = evaluationFromCache(planned, await loadCachedEvaluation(pool, target.companyId, config, planned.stateHash));
    if (fromCache !== undefined) {
      evaluations.push(fromCache);
      continue;
    }
    const lock = await acquireEvaluationLock(pool, planned.stateHash, config);
    try {
      // lock待ちの間に同じstateを評価した側のcacheがあれば、外部送信せず再利用する。
      const afterWait = evaluationFromCache(planned, await loadCachedEvaluation(pool, target.companyId, config, planned.stateHash));
      evaluations.push(afterWait ?? (await callPlannedEvaluation(pool, target, job, planned, config)));
    } finally {
      await releaseEvaluationLock(lock, planned.stateHash);
    }
  }
  return evaluations;
}

async function callPlannedEvaluation(
  pool: Pool,
  target: JobTarget,
  job: ClaimedJob,
  planned: PlannedEvaluation,
  config: WorkerConfig,
): Promise<PartEvaluation> {
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
    return { part: planned.part, answers: validated.answers, candidates: planned.candidates, responseModel: validated.model };
  } catch (error) {
    const code = error instanceof JevCallError ? error.code : 'provider_contract_invalid';
    // 応答本文からmodelを取得できた場合は、検証失敗でも取得できた値だけを記録する。
    await recordUsage(pool, target, job.kind, config, false, durationMs, code, extractJevUsage(json), extractJevResponseModel(json));
    throw error instanceof JevCallError ? error : new JevCallError('provider_contract_invalid', false);
  }
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
         (id, message_id, revision, policy_version, retention_category, primary_intent, technical_labels, decision_action,
          continuity, statement_status, is_searchable, response_models, state_hash, parts, strategy_terms)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb, $13, $14::jsonb, $15::text[])
       ON CONFLICT (message_id, revision, policy_version) DO UPDATE
         SET retention_category = EXCLUDED.retention_category,
             primary_intent = EXCLUDED.primary_intent,
             technical_labels = EXCLUDED.technical_labels,
             strategy_terms = EXCLUDED.strategy_terms,
             decision_action = EXCLUDED.decision_action,
             continuity = EXCLUDED.continuity,
             statement_status = EXCLUDED.statement_status,
             is_searchable = EXCLUDED.is_searchable,
             response_models = EXCLUDED.response_models,
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
        JSON.stringify(aggregate.responseModels),
        stateHash,
        JSON.stringify(aggregate.parts),
        aggregate.strategyTerms,
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
           (id, from_message_id, from_message_revision, to_message_id, to_message_revision, relation, is_explicit, evidence_ranges, policy_version)
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
      WHERE input_message_id = $1 AND input_message_revision = $2 AND policy_version = $3 AND trigger = 'auto'`,
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
    if (decision.kind === 'reuse') {
      // イベント受付と同じ社員単位ロックを先に取り、複数入力の行ロック順の逆転を防ぐ。
      // 外部評価は完了済みなので、このロックをHTTP待ちの間に保持しない。
      await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [
        EVENT_WRITE_LOCK_NAMESPACE,
        `${target.companyId}:${target.employeeId}`,
      ]);
    }
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
    // 評価した先行受付とchainをこの保存TX内で再検証し、元入力のロックをcommitまで保持する。
    const reuse = decision.kind === 'reuse' ? await resolveReuse(client, target, decision.priorSearch) : null;
    if (reuse?.eligible && reuse.originRequestId !== null) {
      await client.query(
        `UPDATE search_requests
            SET status = 'pending', outcome = NULL, error_code = NULL, search_action = 'reuse',
                stage = 'awaiting_reused_search', reused_from_request_id = $2,
                result = NULL, updated_at = now()
          WHERE id = $1`,
        [searchRequestId, reuse.originRequestId],
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
                stage = 'awaiting_search', condition_hash = $2, reused_from_request_id = NULL,
                result = NULL, strategy_terms = $3::text[], updated_at = now()
          WHERE id = $1`,
        [searchRequestId, condition, decision.strategyTerms],
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
      WHERE input_message_id = $1 AND input_message_revision = $2 AND policy_version = $3 AND trigger = 'auto' AND status = 'failed'`,
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

// build_documentsはsessionの現行revisionから決定的な文書を作り、承認済みVoyageで埋め込んで公開する。
async function processBuild(pool: Pool, job: ClaimedJob, config: WorkerConfig): Promise<void> {
  const target = await loadJobTarget(pool, job);
  if (target === null) {
    throw new TargetMissingError('対象message/revisionがありません');
  }
  // 対象messageが既に改訂されたstale workerは、現在の文書計画へ古いjobを適用せずlease条件付きで完了する。
  if (target.currentRevision !== target.targetRevision) {
    const completed = await completeJob(pool, {
      jobId: job.id,
      leaseToken: job.leaseToken,
      targetRevision: job.targetRevision,
    });
    if (!completed) {
      throw new LeaseLostError('jobを完了できません');
    }
    return;
  }
  // session継続のバックグラウンド判定をsessionごとに1件だけ遅延登録する。検索時のJev判定を不要にする。
  await enqueueContinuityJudgment(pool, target);
  // 文書planの制限的変更（publication削除・is_searchable・revision状態）は、世代spec検証より先に
  // 外部HTTP前のTXで反映する。世代不一致・retired/failedでも除外対象を残さない。
  const { chunks, snapshot, checkpoint } = await loadDocumentBuildPlan(pool, target.sessionId);
  const pending = await applyDocumentPlan(
    pool,
    job,
    { companyId: target.companyId, projectId: target.projectId, sessionId: target.sessionId },
    snapshot,
    chunks,
    checkpoint,
  );
  if (pending.length === 0) {
    // 埋め込み待ちが無ければ世代の作成/検証は不要。lease条件付きで完了する。
    const completed = await completeJob(pool, { jobId: job.id, leaseToken: job.leaseToken, targetRevision: job.targetRevision });
    if (!completed) {
      throw new LeaseLostError('jobを完了できません');
    }
    return;
  }
  // 埋め込み待ちがある時だけ世代を検証/作成する。spec不一致・retired/failedは自動切替せず恒久失敗にする。
  const generation = await ensureActiveGeneration(pool, target, config);
  const provider = new VoyageEmbeddingProvider(pool, config);
  let vectors: number[][];
  try {
    vectors = await provider.embedDocuments(
      pending.map((item) => item.content),
      generation,
    );
  } catch (error) {
    // 恒久providerエラーだけ、保持しているpending revisionをfailedにする。
    // policy blocked・retryable・stale・lease喪失はpendingのまま保持する。
    if (
      error instanceof VoyageCallError &&
      !error.retryable &&
      (error.code === 'provider_rejected' || error.code === 'provider_contract_invalid')
    ) {
      await markPendingRevisionsFailed(pool, job, pending);
    }
    throw error;
  }
  await applyDocumentEmbeddings(pool, job, target, generation, pending, vectors, snapshot);
}

async function processRoute(pool: Pool, job: ClaimedJob, config: WorkerConfig): Promise<void> {
  const target = await loadJobTarget(pool, job);
  if (target === null) {
    throw new TargetMissingError('対象message/revisionがありません');
  }
  await resetSearchForRetry(pool, target);
  // 自動検索の質問は入力原文そのものなので、Jevの経路判定と並行して質問の埋め込みを先に作り、
  // execute_searchではembedding cacheから即時に取り出す。route処理の完了前に必ず待ち合わせる。
  const prewarm = prewarmQueryEmbedding(pool, target, config);
  try {
    await routeWithEvaluation(pool, job, target, config);
  } finally {
    await prewarm;
  }
}

// active世代で入力原文のquery埋め込みを作り、embedding cacheへ保存する。承認確認・cache・usage記録は通常と同じ経路を使う。
// 失敗（未承認・世代なし・provider障害）は経路判定と検索結果へ影響させず、execute_searchが通常どおり埋め込む。
async function prewarmQueryEmbedding(pool: Pool, target: JobTarget, config: WorkerConfig): Promise<void> {
  try {
    const project = await pool.query<{ active_generation_id: string | null }>(
      'SELECT active_generation_id FROM projects WHERE id = $1 AND company_id = $2',
      [target.projectId, target.companyId],
    );
    const generationId = project.rows[0]?.active_generation_id ?? null;
    if (generationId === null || !(await hasActiveVoyageApproval(pool, target.companyId, config))) {
      return;
    }
    const generation = await loadPinnedGeneration(pool, { companyId: target.companyId, generationId }, config);
    await new VoyageEmbeddingProvider(pool, config).embedQuery(target.text, generation);
  } catch {
    // 先行実行は最適化に限る。
  }
}

async function routeWithEvaluation(pool: Pool, job: ClaimedJob, target: JobTarget, config: WorkerConfig): Promise<void> {
  const priorMessages = await loadPriorMessages(pool, target);
  const priorSearch = await loadPriorSearch(pool, target);
  const plan = planEvaluations(target, priorMessages, priorSearch, config);
  const evaluations = await evaluatePlan(pool, target, job, plan, config);
  const aggregate = aggregateEvaluations(evaluations, config.confidenceThreshold);
  let decision: RouteDecision = { kind: 'new_search', strategyTerms: aggregate.strategyTerms };
  if (aggregate.searchAction === 'skip') {
    decision = { kind: 'skip' };
  } else if (
    aggregate.searchAction === 'reuse' &&
    aggregate.sameConditions &&
    aggregate.continuity === 'same_topic' &&
    plan.evaluations.every((evaluation) => evaluation.priorSearchIncluded) &&
    plan.priorSearch !== undefined
  ) {
    decision = { kind: 'reuse', priorSearch: plan.priorSearch, strategyTerms: aggregate.strategyTerms };
  }
  const condition = conditionHash(
    target,
    priorMessages.map((prior) => ({ messageId: prior.messageId, revision: prior.revision, text: prior.text })),
  );
  await applyRouteDecision(pool, job, target, decision, condition);
}

function errorCodeOf(error: unknown): { code: string; retryable: boolean; retryAfterMs?: number; detail?: string } {
  if (error instanceof InputBudgetError) {
    return { code: 'input_budget_exceeded', retryable: false };
  }
  if (error instanceof TargetMissingError) {
    return { code: 'target_missing', retryable: false };
  }
  if (error instanceof GenerationMismatchError) {
    return { code: 'embedding_generation_mismatch', retryable: false };
  }
  if (error instanceof JevCallError || error instanceof VoyageCallError) {
    // 両providerが同じcodeを返すため、切り分け用にprovider名と検証条件の識別子を残す。
    const provider = error instanceof JevCallError ? 'jev' : 'voyage';
    const detail = error.detail === undefined ? provider : `${provider}:${error.detail}`;
    return { code: error.code, retryable: error.retryable, retryAfterMs: error.retryAfterMs, detail };
  }
  return { code: 'internal_error', retryable: false };
}

// 障害時もsearch受付はfailedとcodeを持ち、no_matchにしない。所有喪失時は状態を変えない。
// route_searchは既存のauto入力更新を維持し、execute_searchはpayloadが指す1件だけを更新する。
async function markSearchFailed(client: PoolClient, job: ClaimedJob, code: string, detail: string | null): Promise<void> {
  if (job.kind === 'route_search') {
    if (job.messageId === null || job.targetRevision === null) {
      return;
    }
    await client.query(
      `UPDATE search_requests
          SET status = 'failed', error_code = $4, error_detail = $5, outcome = NULL, updated_at = now()
        WHERE input_message_id = $1 AND input_message_revision = $2 AND policy_version = $3 AND trigger = 'auto'`,
      [job.messageId, job.targetRevision, WORKER_POLICY_VERSION, code, detail],
    );
    return;
  }
  if (job.kind === 'execute_search') {
    // payloadが不正ならどのrequestの障害か特定できないため、無関係requestを更新しない。
    const requestId = searchRequestIdFromPayload(job.payload);
    if (requestId === null) {
      return;
    }
    // payloadのIDだけでなく、jobのmessage/revisionとrequestのscope（message→session→project→company）が
    // DB正本で一致する場合だけfailedにする。payload側のscopeを信用しない。
    await client.query(
      `UPDATE search_requests sr
          SET status = 'failed', error_code = $2, error_detail = $6, outcome = NULL, updated_at = now()
        WHERE sr.id = $1
          AND sr.status IN ('running', 'pending', 'failed')
          AND EXISTS (
            SELECT 1
              FROM messages m
              JOIN sessions s ON s.id = m.session_id
              JOIN projects p ON p.id = s.project_id
             WHERE m.id = sr.input_message_id
               AND sr.input_message_id = $3
               AND sr.input_message_revision = $4
               AND sr.input_sequence_no = m.sequence_no
               AND sr.session_id = m.session_id
               AND sr.employee_id = s.employee_id
               AND sr.project_id = s.project_id
               AND sr.company_id = p.company_id
               AND sr.session_id = $5
          )`,
      [requestId, code, job.messageId, job.targetRevision, job.sessionId, detail],
    );
  }
}

async function handleProcessError(pool: Pool, job: ClaimedJob, error: unknown): Promise<void> {
  if (error instanceof LeaseLostError || error instanceof StaleApplyError) {
    // 所有喪失・状態変化時は公開もjob状態変更もせず、lease期限後の回収へ委ねる。
    // execute_searchのsearch_requestも更新しない（lease喪失時はrunningのまま残し、回収後のownerに委ねる）。
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (job.kind === 'execute_search') {
      // 外部待機中にjob identity/payloadが変わっていたら、旧ownerはjobもrequestも更新しない。
      // 開始直後のinvalid UUID/NULL session等はsnapshotが一致するため従来どおりfailedにできる。
      const identity = await client.query(
        `SELECT 1 FROM jobs
          WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_expires_at > now()
            AND target_revision IS NOT DISTINCT FROM $3
            AND message_id IS NOT DISTINCT FROM $4
            AND session_id IS NOT DISTINCT FROM $5
            AND payload = $6::jsonb
          FOR UPDATE`,
        [job.id, job.leaseToken, job.targetRevision, job.messageId, job.sessionId, JSON.stringify(job.payload ?? {})],
      );
      if (identity.rows.length === 0) {
        await client.query('ROLLBACK');
        return;
      }
    }
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
      await markSearchFailed(client, job, 'provider_policy_unverified', null);
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
    await markSearchFailed(client, job, failure.code, failure.detail ?? null);
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
    if (job.kind === 'build_documents') {
      await processBuild(pool, job, config);
      return;
    }
    if (job.kind === 'execute_search') {
      await processExecuteSearch(pool, job, config);
      return;
    }
    if (job.kind === 'judge_continuity') {
      await processJudgeContinuity(pool, job, config);
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
    session_id: string | null;
    message_id: string | null;
    target_revision: number | null;
    payload: unknown;
  }>('SELECT id, kind, status, session_id, message_id, target_revision, payload FROM jobs WHERE id = $1', [jobId]);
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
  if (companyId === undefined) {
    return false;
  }
  // build_documentsはVoyage、execute_searchはVoyageとJev両方、classify/routeはJevの承認を使う。
  // 別providerの承認を流用しない。
  const approved =
    job.kind === 'build_documents'
      ? await hasActiveVoyageApproval(pool, companyId, config)
      : job.kind === 'execute_search'
        ? (await hasActiveVoyageApproval(pool, companyId, config)) && (await hasActiveApproval(pool, companyId, config))
        : await hasActiveApproval(pool, companyId, config);
  if (!approved) {
    return false;
  }
  // execute_searchはpayloadが指すrequestだけをpendingへ戻す。payload不正なら再開しない。
  const executeSearchRequestId = job.kind === 'execute_search' ? searchRequestIdFromPayload(job.payload) : null;
  if (job.kind === 'execute_search' && executeSearchRequestId === null) {
    return false;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (job.kind === 'execute_search' && executeSearchRequestId !== null) {
      // 1) lockなしでscopeを事前照合し、requestが固定したgeneration IDを読む。
      const pinned = await client.query<{ embedding_generation_id: string | null; company_id: string }>(
        `SELECT sr.embedding_generation_id, p.company_id
           FROM search_requests sr
           JOIN messages m ON m.id = sr.input_message_id
           JOIN sessions s ON s.id = m.session_id
           JOIN projects p ON p.id = s.project_id
          WHERE sr.id = $1
            AND sr.input_message_id = $2
            AND sr.input_message_revision = $3
            AND sr.input_sequence_no = m.sequence_no
            AND sr.session_id = m.session_id
            AND sr.employee_id = s.employee_id
            AND sr.project_id = s.project_id
            AND sr.company_id = p.company_id
            AND sr.session_id = $4`,
        [executeSearchRequestId, job.message_id, job.target_revision, job.session_id],
      );
      const pinnedRow = pinned.rows[0];
      if (pinnedRow === undefined) {
        await client.query('ROLLBACK');
        return false;
      }
      const pinnedGenerationId = pinnedRow.embedding_generation_id;
      if (pinnedGenerationId !== null) {
        // 2) generation削除とlock順序を揃えるため、requestより先にgeneration行をKEY SHAREでlockする。
        //    既に削除済みならretryしない。
        const generation = await client.query(
          'SELECT 1 FROM embedding_generations WHERE id = $1 AND company_id = $2 FOR KEY SHARE',
          [pinnedGenerationId, pinnedRow.company_id],
        );
        if (generation.rows.length === 0) {
          await client.query('ROLLBACK');
          return false;
        }
      }
      // 3) requestをlockし直し、identity・scope・固定generation IDが不変な場合だけ再開する。
      const scoped = await client.query(
        `SELECT 1
           FROM search_requests sr
           JOIN messages m ON m.id = sr.input_message_id
           JOIN sessions s ON s.id = m.session_id
           JOIN projects p ON p.id = s.project_id
          WHERE sr.id = $1
            AND sr.input_message_id = $2
            AND sr.input_message_revision = $3
            AND sr.input_sequence_no = m.sequence_no
            AND sr.session_id = m.session_id
            AND sr.employee_id = s.employee_id
            AND sr.project_id = s.project_id
            AND sr.company_id = p.company_id
            AND sr.session_id = $4
            AND sr.embedding_generation_id IS NOT DISTINCT FROM $5
          FOR SHARE OF sr`,
        [executeSearchRequestId, job.message_id, job.target_revision, job.session_id, pinnedGenerationId],
      );
      if (scoped.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }
    }
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
          WHERE input_message_id = $1 AND input_message_revision = $2 AND policy_version = $3 AND trigger = 'auto'`,
        [job.message_id, job.target_revision, WORKER_POLICY_VERSION],
      );
    } else if (job.kind === 'execute_search' && executeSearchRequestId !== null) {
      // scope一致でもrequestの状態が復帰対象でなければ、jobだけpendingにせずrollbackする。
      const reset = await client.query(
        `UPDATE search_requests
            SET status = 'pending', outcome = NULL, error_code = NULL, stage = NULL, updated_at = now()
          WHERE id = $1 AND status IN ('running', 'pending', 'failed')
          RETURNING id`,
        [executeSearchRequestId],
      );
      if (reset.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }
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
