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
  loadSessionMessages,
  markPendingRevisionsFailed,
  planDocumentChunks,
} from './documents.js';
import { ensureActiveGeneration, VoyageEmbeddingProvider } from './embedding.js';
import { processExecuteSearch, searchRequestIdFromPayload } from './search.js';
import { GenerationMismatchError, LeaseLostError, PolicyBlockedError, StaleApplyError, TargetMissingError } from './errors.js';
import { VoyageCallError } from './voyage.js';
import { hasActiveProviderApproval } from './approvals.js';

type RouteDecision = { kind: 'new_search' | 'skip' } | { kind: 'reuse'; priorSearch: PriorSearch };

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
      await recordUsage(pool, target, job.kind, config, false, durationMs, code, extractJevUsage(json), extractJevResponseModel(json));
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
                stage = 'awaiting_reused_search', reused_from_request_id = $2, original_request_id = $2,
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
  // 文書planの制限的変更（publication削除・is_searchable・revision状態）は、世代spec検証より先に
  // 外部HTTP前のTXで反映する。世代不一致・retired/failedでも除外対象を残さない。
  const { messages, snapshot } = await loadSessionMessages(pool, target.sessionId);
  const chunks = await planDocumentChunks(target.sessionId, messages);
  const pending = await applyDocumentPlan(
    pool,
    job,
    { companyId: target.companyId, projectId: target.projectId, sessionId: target.sessionId },
    snapshot,
    chunks,
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
  await applyDocumentEmbeddings(pool, job, target, generation, pending, vectors);
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
    plan.evaluations.every((evaluation) => evaluation.priorSearchIncluded) &&
    plan.priorSearch !== undefined
  ) {
    decision = { kind: 'reuse', priorSearch: plan.priorSearch };
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
  if (error instanceof GenerationMismatchError) {
    return { code: 'embedding_generation_mismatch', retryable: false };
  }
  if (error instanceof JevCallError || error instanceof VoyageCallError) {
    return { code: error.code, retryable: error.retryable, retryAfterMs: error.retryAfterMs };
  }
  return { code: 'internal_error', retryable: false };
}

// 障害時もsearch受付はfailedとcodeを持ち、no_matchにしない。所有喪失時は状態を変えない。
// route_searchは既存のauto入力更新を維持し、execute_searchはpayloadが指す1件だけを更新する。
async function markSearchFailed(client: PoolClient, job: ClaimedJob, code: string): Promise<void> {
  if (job.kind === 'route_search') {
    if (job.messageId === null || job.targetRevision === null) {
      return;
    }
    await client.query(
      `UPDATE search_requests
          SET status = 'failed', error_code = $4, outcome = NULL, updated_at = now()
        WHERE input_id = $1 AND input_revision = $2 AND policy_version = $3 AND trigger = 'auto'`,
      [job.messageId, job.targetRevision, WORKER_POLICY_VERSION, code],
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
          SET status = 'failed', error_code = $2, outcome = NULL, updated_at = now()
        WHERE sr.id = $1
          AND sr.status IN ('running', 'pending', 'failed')
          AND EXISTS (
            SELECT 1
              FROM messages m
              JOIN sessions s ON s.id = m.session_id
              JOIN projects p ON p.id = s.project_id
             WHERE m.id = sr.input_id
               AND sr.input_id = $3
               AND sr.input_revision = $4
               AND sr.input_sequence_no = m.sequence_no
               AND sr.session_id = m.session_id
               AND sr.employee_id = s.employee_id
               AND sr.project_id = s.project_id
               AND sr.company_id = p.company_id
               AND sr.session_id = $5
          )`,
      [requestId, code, job.messageId, job.targetRevision, job.sessionId],
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
    if (job.kind === 'build_documents') {
      await processBuild(pool, job, config);
      return;
    }
    if (job.kind === 'execute_search') {
      await processExecuteSearch(pool, job, config);
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
      // payloadのrequestがjobのmessage/revisionとDB正本のscopeに一致する場合だけ再開する。
      // 不一致ならjobもrequestも変更せずrollbackする。
      const scoped = await client.query(
        `SELECT 1
           FROM search_requests sr
           JOIN messages m ON m.id = sr.input_id
           JOIN sessions s ON s.id = m.session_id
           JOIN projects p ON p.id = s.project_id
          WHERE sr.id = $1
            AND sr.input_id = $2
            AND sr.input_revision = $3
            AND sr.input_sequence_no = m.sequence_no
            AND sr.session_id = m.session_id
            AND sr.employee_id = s.employee_id
            AND sr.project_id = s.project_id
            AND sr.company_id = p.company_id
            AND sr.session_id = $4
          FOR SHARE OF sr`,
        [executeSearchRequestId, job.message_id, job.target_revision, job.session_id],
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
          WHERE input_id = $1 AND input_revision = $2 AND policy_version = $3 AND trigger = 'auto'`,
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
