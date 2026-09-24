import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { completeJob, type ClaimedJob } from '../jobs/queue.js';
import type { WorkerConfig } from './config.js';
import {
  CANDIDATE_RELEVANCE_CRITERIA,
  CANDIDATE_RELEVANCE_KINDS,
  CANDIDATE_RELEVANCE_QUESTION_PREFIX,
  CANDIDATE_RELEVANCES,
  CANDIDATE_REUSABLE_PROCEDURE_QUESTION_PREFIX,
  CANDIDATE_SIMILAR_SYMPTOM_QUESTION_PREFIX,
  CANDIDATE_YES_NO_CRITERIA,
  JEV_PROVIDER,
  SEARCH_CANDIDATE_BUDGET_TOKENS,
  SEARCH_CANDIDATE_LIMIT,
  SEARCH_ENTITY_LIMIT,
  SEARCH_MODE_EXACT_VECTOR_AND_ENTITY,
  SEARCH_RRF_RANK_CONSTANT,
  SEARCH_STATEMENT_TIMEOUT_MS,
  SEARCH_VECTOR_LIMIT,
  WORKER_POLICY_VERSION,
  type CandidateRelevance,
  type CandidateRelevanceKind,
  type JevChoiceQuestion,
  type JevRequest,
  type JevState,
  type JevUsage,
} from './contract.js';
import { InputBudgetError, loadJobTarget, type JobTarget } from './context.js';
import { loadFixedGeneration, VoyageEmbeddingProvider, type EmbeddingGeneration } from './embedding.js';
import { TargetMissingError, LeaseLostError, PolicyBlockedError, StaleApplyError } from './errors.js';
import { extractEntityReferences } from './identifiers.js';
import {
  JevCallError,
  buildRequest,
  callJev,
  extractJevResponseModel,
  extractJevUsage,
  serializeRequest,
  validateJevResponse,
} from './jev.js';
import { hasActiveProviderApproval } from './approvals.js';
import { loadVoyageTokenizer } from './tokenizer.js';

// M5のexecute_search処理。開始時に固定した世代で質問を埋め込み、案件内の厳密vector検索と
// 明示識別子の完全一致検索をRRFで統合し、候補をJevで判定して原文evidence付きの結果を保存する。
// 外部HTTP待ちの間は行ロックを持たず、保存TXでlease・request・候補の有効性を再検証する。

interface SearchRequestRow {
  id: string;
  trigger: string;
  search_action: string | null;
  status: string;
  result: unknown;
  input_id: string;
  input_revision: number;
  input_sequence_no: number;
}

interface CandidateSource {
  message_id: string;
  message_revision: number;
  start_offset: number;
  end_offset: number;
  source_kind: string;
}

interface Candidate {
  documentId: string;
  revision: number;
  content: string;
  rrfScore: number;
  sources: CandidateSource[];
}

interface CandidateAssessment {
  candidate: Candidate;
  relevance: CandidateRelevance;
  relevanceKinds: CandidateRelevanceKind[];
}

interface SearchWarning {
  code: string;
  [key: string]: unknown;
}

interface EvidenceRow {
  message_id: string;
  message_revision: number;
  current_revision: number;
  sequence_no: number;
  session_id: string;
  session_project_id: string;
  role: string;
  employee_id: string;
  occurred_at: Date;
  text: string;
}

const RELEVANCE_ORDER: Record<CandidateRelevance, number> = { unrelated: 0, peripheral: 1, useful: 2, direct: 3 };

// 各経路は固定世代・会社・案件・検索可能な公開revisionだけを対象にする。
// 現在inputと同sessionのsequence_no >= input_sequence_noをsourceに含む文書は候補から除外する。
const VECTOR_CANDIDATES_SQL = `
  SELECT e.document_id, e.revision, r.content
    FROM document_embeddings e
    JOIN search_documents d ON d.id = e.document_id
    JOIN document_publications p
      ON p.document_id = e.document_id AND p.generation_id = $4 AND p.revision = e.revision
    JOIN search_document_revisions r
      ON r.document_id = e.document_id AND r.revision = e.revision AND r.status = 'ready'
   WHERE d.company_id = $1
     AND d.project_id = $2
     AND d.is_searchable
     AND e.generation_id = $4
     AND NOT EXISTS (
       SELECT 1
         FROM search_document_sources sx
         JOIN messages mx ON mx.id = sx.message_id
        WHERE sx.document_id = e.document_id
          AND sx.revision = e.revision
          AND mx.session_id = $5
          AND mx.sequence_no >= $6
     )
   ORDER BY e.embedding <=> $3::vector ASC, e.document_id ASC, e.revision ASC
   LIMIT $7
`;

const ENTITY_CANDIDATES_SQL = `
  SELECT DISTINCT e.document_id, e.revision, r.content
    FROM document_entities e
    JOIN search_documents d ON d.id = e.document_id
    JOIN document_publications p
      ON p.document_id = e.document_id AND p.generation_id = $3 AND p.revision = e.revision
    JOIN search_document_revisions r
      ON r.document_id = e.document_id AND r.revision = e.revision AND r.status = 'ready'
   WHERE d.company_id = $1
     AND d.project_id = $2
     AND d.is_searchable
     AND (e.entity_type, e.entity_key) IN (SELECT * FROM unnest($4::text[], $5::text[]))
     AND NOT EXISTS (
       SELECT 1
         FROM search_document_sources sx
         JOIN messages mx ON mx.id = sx.message_id
        WHERE sx.document_id = e.document_id
          AND sx.revision = e.revision
          AND mx.session_id = $6
          AND mx.sequence_no >= $7
     )
   ORDER BY e.document_id ASC, e.revision ASC
   LIMIT $8
`;

const CANDIDATE_SOURCES_SQL = `
  SELECT document_id, revision, message_id, message_revision, start_offset, end_offset, source_kind
    FROM search_document_sources
   WHERE (document_id, revision) IN (SELECT * FROM unnest($1::uuid[], $2::int[]))
   ORDER BY document_id, revision, display_order
`;

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

function candidateKey(candidate: { documentId: string; revision: number }): string {
  return `${candidate.documentId}:${candidate.revision}`;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.documentId !== right.documentId) {
    return left.documentId < right.documentId ? -1 : 1;
  }
  return left.revision - right.revision;
}

interface CandidateRow {
  document_id: string;
  revision: number;
  content: string;
}

// route順位の1/(60+r)を加算し、同じdocument revisionを1件へまとめる。
function mergeRoutes(vectorRows: readonly CandidateRow[], entityRows: readonly CandidateRow[]): Map<string, Candidate> {
  const candidates = new Map<string, Candidate>();
  const addRoute = (rows: readonly CandidateRow[]): void => {
    for (const [index, row] of rows.entries()) {
      const key = `${row.document_id}:${row.revision}`;
      const candidate = candidates.get(key) ?? {
        documentId: row.document_id,
        revision: row.revision,
        content: row.content,
        rrfScore: 0,
        sources: [],
      };
      candidate.rrfScore += 1 / (SEARCH_RRF_RANK_CONSTANT + index + 1);
      candidates.set(key, candidate);
    }
  };
  addRoute(vectorRows);
  addRoute(entityRows);
  return candidates;
}

// 同じ原文range集合の候補を1件へまとめ、安定順のまま上位10件・現在質問+候補本文の8,000 token予算へ収める。
// 重複除外・上限超過・token予算超過は、機械可読なwarningとして結果へ記録する。
async function selectCandidates(
  candidates: readonly Candidate[],
  questionTokens: number,
): Promise<{ selected: Candidate[]; warnings: SearchWarning[] }> {
  if (candidates.length === 0) {
    return { selected: [], warnings: [] };
  }
  const seenRanges = new Set<string>();
  const deduped: Candidate[] = [];
  const duplicateExclusions: { document_id: string; revision: number }[] = [];
  for (const candidate of candidates) {
    const signature = candidate.sources
      .map((source) => `${source.message_id}:${source.message_revision}:${source.start_offset}:${source.end_offset}:${source.source_kind}`)
      .sort()
      .join('|');
    if (seenRanges.has(signature)) {
      duplicateExclusions.push({ document_id: candidate.documentId, revision: candidate.revision });
      continue;
    }
    seenRanges.add(signature);
    deduped.push(candidate);
  }
  const warnings: SearchWarning[] = [];
  if (duplicateExclusions.length > 0) {
    warnings.push({
      code: 'duplicate_source_range_excluded',
      excluded_count: duplicateExclusions.length,
      excluded_documents: duplicateExclusions,
    });
  }
  const tokenizer = await loadVoyageTokenizer();
  const selected: Candidate[] = [];
  const budgetExclusions: { document_id: string; revision: number; candidate_tokens: number }[] = [];
  let totalTokens = questionTokens;
  let limitExcluded = 0;
  for (const [index, candidate] of deduped.entries()) {
    if (selected.length >= SEARCH_CANDIDATE_LIMIT) {
      limitExcluded = deduped.length - index;
      break;
    }
    const candidateTokens = tokenizer.encode(candidate.content).ids.length;
    if (totalTokens + candidateTokens > SEARCH_CANDIDATE_BUDGET_TOKENS) {
      budgetExclusions.push({ document_id: candidate.documentId, revision: candidate.revision, candidate_tokens: candidateTokens });
      continue;
    }
    totalTokens += candidateTokens;
    selected.push(candidate);
  }
  if (limitExcluded > 0) {
    warnings.push({ code: 'candidate_limit_exceeded', excluded_count: limitExcluded, candidate_limit: SEARCH_CANDIDATE_LIMIT });
  }
  if (budgetExclusions.length > 0) {
    warnings.push({
      code: 'candidate_token_budget_exceeded',
      excluded_count: budgetExclusions.length,
      question_tokens: questionTokens,
      selected_tokens: totalTokens,
      budget_tokens: SEARCH_CANDIDATE_BUDGET_TOKENS,
      excluded_documents: budgetExclusions,
    });
  }
  return { selected, warnings };
}

async function loadCandidates(
  pool: Pool,
  input: { target: JobTarget; generation: EmbeddingGeneration; queryVector: readonly number[] },
): Promise<Candidate[]> {
  const identifiers = extractEntityReferences(input.target.text);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`SET LOCAL statement_timeout = ${SEARCH_STATEMENT_TIMEOUT_MS}`);
    const vectorRows = await client.query<CandidateRow>(VECTOR_CANDIDATES_SQL, [
      input.target.companyId,
      input.target.projectId,
      vectorLiteral(input.queryVector),
      input.generation.id,
      input.target.sessionId,
      input.target.sequenceNo,
      SEARCH_VECTOR_LIMIT,
    ]);
    const entityRows =
      identifiers.length === 0
        ? []
        : (
            await client.query<CandidateRow>(ENTITY_CANDIDATES_SQL, [
              input.target.companyId,
              input.target.projectId,
              input.generation.id,
              identifiers.map((reference) => reference.entityType),
              identifiers.map((reference) => reference.entityKey),
              input.target.sessionId,
              input.target.sequenceNo,
              SEARCH_ENTITY_LIMIT,
            ])
          ).rows;
    const candidates = mergeRoutes(vectorRows.rows, entityRows);
    if (candidates.size > 0) {
      const entries = [...candidates.values()];
      const sources = await client.query<CandidateSource & { document_id: string; revision: number }>(CANDIDATE_SOURCES_SQL, [
        entries.map((candidate) => candidate.documentId),
        entries.map((candidate) => candidate.revision),
      ]);
      for (const row of sources.rows) {
        const candidate = candidates.get(`${row.document_id}:${row.revision}`);
        candidate?.sources.push({
          message_id: row.message_id,
          message_revision: row.message_revision,
          start_offset: row.start_offset,
          end_offset: row.end_offset,
          source_kind: row.source_kind,
        });
      }
    }
    await client.query('COMMIT');
    return [...candidates.values()].sort((left, right) => right.rrfScore - left.rrfScore || compareCandidates(left, right));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// 候補ごとのrelevanceと、計画9.3の独立choiceで得られる最小のrelevance_kindを質問する。
function buildCandidateQuestions(candidates: readonly Candidate[]): {
  questions: Record<string, JevChoiceQuestion>;
  index: Map<string, { candidate: Candidate; kind: 'relevance' | 'similar_symptom' | 'reusable_procedure' }>;
} {
  const questions: Record<string, JevChoiceQuestion> = {};
  const index = new Map<string, { candidate: Candidate; kind: 'relevance' | 'similar_symptom' | 'reusable_procedure' }>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const relevanceId = `${CANDIDATE_RELEVANCE_QUESTION_PREFIX}:${key}#0`;
    questions[relevanceId] = {
      type: 'choice',
      instructions: `state.candidatesのcandidate_id=${key}が現在の質問の対象・症状・手順にどれだけ当てはまるかrelevanceを選ぶ。`,
      criteria: { ...CANDIDATE_RELEVANCE_CRITERIA },
    };
    index.set(relevanceId, { candidate, kind: 'relevance' });
    const similarId = `${CANDIDATE_SIMILAR_SYMPTOM_QUESTION_PREFIX}:${key}#0`;
    questions[similarId] = {
      type: 'choice',
      instructions: `candidate_id=${key}の症状または修正依頼が現在の質問と似ているか選ぶ。`,
      criteria: { ...CANDIDATE_YES_NO_CRITERIA },
    };
    index.set(similarId, { candidate, kind: 'similar_symptom' });
    const reusableId = `${CANDIDATE_REUSABLE_PROCEDURE_QUESTION_PREFIX}:${key}#0`;
    questions[reusableId] = {
      type: 'choice',
      instructions: `candidate_id=${key}の解決方法または調査手順を再利用できるか選ぶ。`,
      criteria: { ...CANDIDATE_YES_NO_CRITERIA },
    };
    index.set(reusableId, { candidate, kind: 'reusable_procedure' });
  }
  return { questions, index };
}

// usage_eventsは試行ごとに1行。原文・key・外部error bodyは保存しない。
async function recordJevUsage(
  pool: Pool,
  input: { companyId: string; config: WorkerConfig; jobKind: string },
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
      input.companyId,
      JEV_PROVIDER,
      input.config.accountRef,
      input.config.apiUrl,
      input.jobKind,
      input.config.model,
      responseModel,
      usage.input_tokens,
      usage.output_tokens,
      Math.max(0, Math.round(durationMs)),
      success,
      errorCode,
    ],
  );
}

// Jevへ候補本文と質問を送り、回答を候補ごとのrelevance・relevance_kindへ写す。
async function evaluateCandidates(
  pool: Pool,
  input: { target: JobTarget; config: WorkerConfig; candidates: readonly Candidate[]; jobKind: string },
): Promise<CandidateAssessment[]> {
  const { questions, index } = buildCandidateQuestions(input.candidates);
  const state: JevState = {
    policy_version: WORKER_POLICY_VERSION,
    current: {
      message_id: input.target.messageId,
      revision: input.target.targetRevision,
      role: input.target.role,
      occurred_at: input.target.occurredAt,
      parts: [{ offset: 0, length: input.target.text.length, text: input.target.text }],
    },
    prior_messages: [],
    prior_search: null,
    truncation: { omitted_prior_messages: 0, split_current: false, prior_search_omitted: false },
    candidates: input.candidates.map((candidate) => ({
      candidate_id: candidateKey(candidate),
      document_id: candidate.documentId,
      revision: candidate.revision,
      text: candidate.content,
    })),
  };
  const request: JevRequest = buildRequest(input.config.model, state, questions);
  if (
    !(await hasActiveProviderApproval(pool, {
      companyId: input.target.companyId,
      provider: JEV_PROVIDER,
      accountRef: input.config.accountRef,
      endpoint: input.config.apiUrl,
    }))
  ) {
    throw new PolicyBlockedError('Jevの送信承認がありません');
  }
  const bodyText = serializeRequest(request);
  const started = Date.now();
  let json: unknown;
  let durationMs: number;
  try {
    const called = await callJev(input.config, bodyText);
    json = called.json;
    durationMs = called.durationMs;
  } catch (error) {
    const jevError = error instanceof JevCallError ? error : new JevCallError('provider_unavailable', true);
    await recordJevUsage(
      pool,
      { companyId: input.target.companyId, config: input.config, jobKind: input.jobKind },
      false,
      Date.now() - started,
      jevError.code,
      { input_tokens: null, output_tokens: null },
      null,
    );
    throw jevError;
  }
  let validated;
  try {
    validated = validateJevResponse(json, questions);
  } catch (error) {
    const code = error instanceof JevCallError ? error.code : 'provider_contract_invalid';
    await recordJevUsage(
      pool,
      { companyId: input.target.companyId, config: input.config, jobKind: input.jobKind },
      false,
      durationMs,
      code,
      extractJevUsage(json),
      extractJevResponseModel(json),
    );
    throw error instanceof JevCallError ? error : new JevCallError('provider_contract_invalid', false);
  }
  await recordJevUsage(
    pool,
    { companyId: input.target.companyId, config: input.config, jobKind: input.jobKind },
    true,
    durationMs,
    null,
    validated.usage,
    validated.model,
  );

  const assessments = new Map<string, CandidateAssessment>();
  for (const candidate of input.candidates) {
    assessments.set(candidateKey(candidate), { candidate, relevance: 'unrelated', relevanceKinds: [] });
  }
  for (const [questionId, question] of index.entries()) {
    const answer = validated.answers[questionId];
    const assessment = assessments.get(candidateKey(question.candidate));
    if (answer === undefined || assessment === undefined) {
      continue;
    }
    if (question.kind === 'relevance') {
      if ((CANDIDATE_RELEVANCES as readonly string[]).includes(answer.choice)) {
        assessment.relevance = answer.choice as CandidateRelevance;
      }
      continue;
    }
    if (answer.choice === 'yes') {
      const kind = question.kind === 'similar_symptom' ? CANDIDATE_RELEVANCE_KINDS[0] : CANDIDATE_RELEVANCE_KINDS[1];
      if (!assessment.relevanceKinds.includes(kind)) {
        assessment.relevanceKinds.push(kind);
      }
    }
  }
  return [...assessments.values()];
}

// 判定段階を優先し、同じ段階ではRRF・document IDの安定順にする。useful/directだけを採用する。
function rankAccepted(assessments: readonly CandidateAssessment[]): CandidateAssessment[] {
  return assessments
    .filter((assessment) => assessment.relevance === 'useful' || assessment.relevance === 'direct')
    .sort(
      (left, right) =>
        RELEVANCE_ORDER[right.relevance] - RELEVANCE_ORDER[left.relevance] ||
        right.candidate.rrfScore - left.candidate.rrfScore ||
        compareCandidates(left.candidate, right.candidate),
    );
}

// 保存直前に候補の公開状態と全sourceの現行revision・scopeを再検証する。無効ならnullを返す。
async function loadValidCandidate(
  client: PoolClient,
  target: JobTarget,
  generation: EmbeddingGeneration,
  candidate: Candidate,
): Promise<{ stale: boolean; evidence: EvidenceRow[] } | null> {
  const document = await client.query<{ stale: boolean }>(
    `SELECT p.stale, p.revision
       FROM search_documents d
       JOIN document_publications p
         ON p.document_id = d.id AND p.generation_id = $2 AND p.revision = $3
       JOIN search_document_revisions r
         ON r.document_id = d.id AND r.revision = $3 AND r.status = 'ready'
      WHERE d.id = $1 AND d.company_id = $4 AND d.project_id = $5 AND d.is_searchable
      FOR UPDATE OF d, p, r`,
    [candidate.documentId, generation.id, candidate.revision, target.companyId, target.projectId],
  );
  if (document.rows.length === 0) {
    return null;
  }
  const sources = await client.query<EvidenceRow>(
    `SELECT s.message_id, s.message_revision, m.current_revision, m.sequence_no, m.session_id,
            sess.project_id AS session_project_id, m.role, sess.employee_id, m.occurred_at, rev.text
       FROM search_document_sources s
       JOIN messages m ON m.id = s.message_id
       JOIN sessions sess ON sess.id = m.session_id
       JOIN message_revisions rev ON rev.message_id = s.message_id AND rev.revision = s.message_revision
      WHERE s.document_id = $1 AND s.revision = $2
      ORDER BY s.display_order`,
    [candidate.documentId, candidate.revision],
  );
  if (sources.rows.length === 0) {
    return null;
  }
  for (const source of sources.rows) {
    if (source.current_revision !== source.message_revision) {
      return null;
    }
    if (source.session_id === target.sessionId && source.sequence_no >= target.sequenceNo) {
      return null;
    }
    if (source.session_project_id !== target.projectId) {
      return null;
    }
  }
  return { stale: document.rows[0].stale, evidence: sources.rows };
}

function buildMatch(assessment: CandidateAssessment, valid: { stale: boolean; evidence: readonly EvidenceRow[] }): unknown {
  const seen = new Set<string>();
  const evidence: unknown[] = [];
  for (const source of valid.evidence) {
    const key = `${source.message_id}:${source.message_revision}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    evidence.push({
      message_id: source.message_id,
      revision: source.message_revision,
      employee_id: source.employee_id,
      role: source.role,
      occurred_at: source.occurred_at.toISOString(),
      text: source.text,
    });
  }
  const agentReported = valid.evidence.some((source) => source.role === 'assistant' || source.role === 'agent_report');
  return {
    case_or_document_id: assessment.candidate.documentId,
    relevance_kind: assessment.relevanceKinds,
    claim_status: agentReported ? 'agent_reported' : 'not_reported',
    evidence,
    related_evidence_ids: [],
    truncated: false,
  };
}

async function loadIndexStatus(
  client: PoolClient,
  companyId: string,
  projectId: string,
  generation: EmbeddingGeneration | null,
): Promise<unknown> {
  const counts = await client.query<{ pending: string; failed: string }>(
    `SELECT count(*) FILTER (WHERE r.status IN ('pending', 'embedding'))::text AS pending,
            count(*) FILTER (WHERE r.status = 'failed')::text AS failed
       FROM search_documents d
       JOIN search_document_revisions r ON r.document_id = d.id AND r.revision = d.desired_revision
      WHERE d.company_id = $1 AND d.project_id = $2`,
    [companyId, projectId],
  );
  return {
    pending_documents: Number(counts.rows[0]?.pending ?? '0'),
    failed_documents: Number(counts.rows[0]?.failed ?? '0'),
    embedding_generation_id: generation === null ? null : generation.id,
    search_mode: SEARCH_MODE_EXACT_VECTOR_AND_ENTITY,
  };
}

// 外部HTTPの前に、jobのleaseとpayload requestのscopeを照合して対象requestだけをrunningにする。
// requestの状態はrunning/pending/failedだけを許可し、他の受付や完了済みresultを変更しない。
async function markSearchRunning(pool: Pool, job: ClaimedJob, target: JobTarget, request: SearchRequestRow): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const leased = await client.query(
      `SELECT 1 FROM jobs
        WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_expires_at > now()
          AND target_revision IS NOT DISTINCT FROM $3
        FOR UPDATE`,
      [job.id, job.leaseToken, job.targetRevision],
    );
    if (leased.rows.length === 0) {
      throw new LeaseLostError('jobのlease所有を確認できません');
    }
    const updated = await client.query(
      `UPDATE search_requests
          SET status = 'running', error_code = NULL, outcome = NULL, updated_at = now()
        WHERE id = $1 AND input_id = $2 AND input_revision = $3 AND input_sequence_no = $4
          AND company_id = $5 AND project_id = $6 AND employee_id = $7 AND session_id = $8
          AND search_action = 'new_search' AND status IN ('pending', 'failed', 'running')
        RETURNING id`,
      [
        request.id,
        target.messageId,
        target.targetRevision,
        target.sequenceNo,
        target.companyId,
        target.projectId,
        target.employeeId,
        target.sessionId,
      ],
    );
    if (updated.rows.length === 0) {
      throw new StaleApplyError('search_requestをrunningにできません');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// 呼び出しTXでjob leaseを確認済みの前提で、payloadが指す古いinput revisionの受付だけをexpiredにし、
// 同じTXでjobを完了する。result/outcomeは保存せず、他のrequestは更新しない。
async function expireStaleSearch(client: PoolClient, job: ClaimedJob, target: JobTarget, request: SearchRequestRow): Promise<void> {
  const expired = await client.query(
    `UPDATE search_requests
        SET status = 'expired', error_code = 'input_revision_stale', outcome = NULL, result = NULL,
            stage = 'completed', updated_at = now()
      WHERE id = $1 AND input_id = $2 AND input_revision = $3 AND input_sequence_no = $4
        AND company_id = $5 AND project_id = $6 AND employee_id = $7 AND session_id = $8
        AND status IN ('pending', 'running', 'failed')
      RETURNING id`,
    [
      request.id,
      target.messageId,
      target.targetRevision,
      target.sequenceNo,
      target.companyId,
      target.projectId,
      target.employeeId,
      target.sessionId,
    ],
  );
  if (expired.rows.length === 0) {
    throw new StaleApplyError('search_requestをexpiredにできません');
  }
  const completed = await completeJob(client, { jobId: job.id, leaseToken: job.leaseToken, targetRevision: job.targetRevision });
  if (!completed) {
    throw new LeaseLostError('jobを完了できません');
  }
}

// process開始時点で既にstaleなinputのexecute_searchを、外部HTTPを送らず短いTXで終端する。
async function terminateStaleSearch(pool: Pool, job: ClaimedJob, target: JobTarget, request: SearchRequestRow): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const leased = await client.query(
      `SELECT 1 FROM jobs
        WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_expires_at > now()
          AND target_revision IS NOT DISTINCT FROM $3
        FOR UPDATE`,
      [job.id, job.leaseToken, job.targetRevision],
    );
    if (leased.rows.length === 0) {
      throw new LeaseLostError('jobのlease所有を確認できません');
    }
    await expireStaleSearch(client, job, target, request);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// 完了済みrequestの再実行は結果を増殖させず、同じjobをlease条件付きで完了させる。
async function completeExistingJob(pool: Pool, job: ClaimedJob): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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

// 保存TXでlease・request・input revisionを再検証し、有効な代表1件のevidenceだけを保存する。
// 無効候補だけならno_match。lease喪失時はsearch_request/jobとも旧ownerは更新しない（回収後に委ねる）。
// 保存時に入力revisionが改訂されていた場合は、old inputの結果を保存せずexpiredで終端する。
async function saveSearchResult(
  pool: Pool,
  input: {
    job: ClaimedJob;
    target: JobTarget;
    request: SearchRequestRow;
    generation: EmbeddingGeneration | null;
    warnings: readonly SearchWarning[];
    accepted: readonly CandidateAssessment[];
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const leased = await client.query(
      `SELECT 1 FROM jobs
        WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_expires_at > now()
          AND target_revision IS NOT DISTINCT FROM $3
        FOR UPDATE`,
      [input.job.id, input.job.leaseToken, input.job.targetRevision],
    );
    if (leased.rows.length === 0) {
      throw new LeaseLostError('jobのlease所有を確認できません');
    }
    const request = await client.query<{ status: string }>('SELECT status FROM search_requests WHERE id = $1 FOR UPDATE', [input.request.id]);
    const requestStatus = request.rows[0]?.status;
    if (requestStatus === undefined) {
      throw new TargetMissingError('search_requestがありません');
    }
    if (requestStatus !== 'running') {
      throw new StaleApplyError('search_requestがrunningではありません');
    }
    const inputMessage = await client.query<{ current_revision: number; session_project_id: string; project_company_id: string }>(
      `SELECT m.current_revision, s.project_id AS session_project_id, p.company_id AS project_company_id
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         JOIN projects p ON p.id = s.project_id
        WHERE m.id = $1
        FOR UPDATE OF m`,
      [input.request.input_id],
    );
    const inputRow = inputMessage.rows[0];
    if (
      inputRow === undefined ||
      inputRow.current_revision !== input.request.input_revision ||
      inputRow.session_project_id !== input.target.projectId ||
      inputRow.project_company_id !== input.target.companyId
    ) {
      // 候補判定後・保存時に入力が改訂されたら、old inputの結果を保存せずexpiredで終端する。
      await expireStaleSearch(client, input.job, input.target, input.request);
      await client.query('COMMIT');
      return;
    }

    const warnings: SearchWarning[] = [...input.warnings];
    let match: unknown = null;
    let outcome = 'no_match';
    if (input.generation !== null) {
      for (const assessment of input.accepted) {
        const valid = await loadValidCandidate(client, input.target, input.generation, assessment.candidate);
        if (valid === null) {
          continue;
        }
        if (valid.stale) {
          warnings.push({
            code: 'stale_publication',
            document_id: assessment.candidate.documentId,
            revision: assessment.candidate.revision,
          });
        }
        match = buildMatch(assessment, valid);
        outcome = 'matched';
        break;
      }
    }
    const indexStatus = await loadIndexStatus(client, input.target.companyId, input.target.projectId, input.generation);
    const result = {
      request_id: input.request.id,
      input_id: input.target.messageId,
      input_revision: input.target.targetRevision,
      trigger: input.request.trigger,
      search_action: input.request.search_action ?? 'new_search',
      reused_from_request_id: null,
      status: 'completed',
      outcome,
      project_id: input.target.projectId,
      index_status: indexStatus,
      matches: match === null ? [] : [match],
      warnings,
    };
    const updated = await client.query(
      `UPDATE search_requests
          SET status = 'completed', outcome = $2, result = $3::jsonb, stage = 'completed', error_code = NULL, updated_at = now()
        WHERE id = $1 AND status = 'running'
        RETURNING id`,
      [input.request.id, outcome, JSON.stringify(result)],
    );
    if (updated.rows.length === 0) {
      throw new StaleApplyError('search_requestを更新できません');
    }
    const completed = await completeJob(client, { jobId: input.job.id, leaseToken: input.job.leaseToken, targetRevision: input.job.targetRevision });
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

// execute_searchのpayloadから対象search_request IDを取り出す。不正ならnullを返し、対象を推測しない。
export function searchRequestIdFromPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const requestId = (payload as { search_request_id?: unknown }).search_request_id;
  return typeof requestId === 'string' && requestId.length > 0 ? requestId : null;
}

// jobのmessage/revisionとsearch_requestのscope・input revision・new_searchを照合する。
async function loadSearchRequest(pool: Pool, target: JobTarget, requestId: string): Promise<SearchRequestRow> {
  const result = await pool.query<SearchRequestRow>(
    `SELECT id, trigger, search_action, status, result, input_id, input_revision, input_sequence_no
       FROM search_requests
      WHERE id = $1
        AND input_id = $2 AND input_revision = $3 AND input_sequence_no = $4
        AND company_id = $5 AND project_id = $6 AND employee_id = $7 AND session_id = $8`,
    [
      requestId,
      target.messageId,
      target.targetRevision,
      target.sequenceNo,
      target.companyId,
      target.projectId,
      target.employeeId,
      target.sessionId,
    ],
  );
  const request = result.rows[0];
  if (request === undefined) {
    throw new TargetMissingError('execute_searchのsearch_requestがjobの対象と一致しません');
  }
  return request;
}

// execute_search 1件を処理する。期待される外部障害はprocessJob側でjob/search状態へ反映する。
export async function processExecuteSearch(pool: Pool, job: ClaimedJob, config: WorkerConfig): Promise<void> {
  const target = await loadJobTarget(pool, job);
  if (target === null) {
    throw new TargetMissingError('検索対象のinput revisionがありません');
  }
  const requestId = searchRequestIdFromPayload(job.payload);
  if (requestId === null) {
    throw new TargetMissingError('search_request_idがありません');
  }
  const request = await loadSearchRequest(pool, target, requestId);
  if (request.status === 'completed' && request.result !== null) {
    await completeExistingJob(pool, job);
    return;
  }
  // 既に古いinput revisionのexecute_searchは、無限回収せずsearch_requestをexpiredにしてjobを完了する。
  if (target.currentRevision !== target.targetRevision) {
    await terminateStaleSearch(pool, job, target, request);
    return;
  }
  if (request.search_action !== 'new_search') {
    throw new TargetMissingError('new_search以外のexecute_searchは処理しません');
  }
  // 外部HTTPへ進む前に、対象requestだけをrunningにする。
  await markSearchRunning(pool, job, target, request);
  const generation = await loadFixedGeneration(pool, { companyId: target.companyId, projectId: target.projectId }, config);
  if (generation === null) {
    await saveSearchResult(pool, { job, target, request, generation: null, warnings: [], accepted: [] });
    return;
  }
  // Jev本文予算は現在質問と候補本文の合計。質問だけで使い切る場合はno_matchに偽装せず恒久failedにする。
  const tokenizer = await loadVoyageTokenizer();
  const questionTokens = tokenizer.encode(target.text).ids.length;
  if (questionTokens >= SEARCH_CANDIDATE_BUDGET_TOKENS) {
    throw new InputBudgetError();
  }
  const provider = new VoyageEmbeddingProvider(pool, config);
  const queryVector = await provider.embedQuery(target.text, generation);
  const candidates = await loadCandidates(pool, { target, generation, queryVector });
  const { selected, warnings } = await selectCandidates(candidates, questionTokens);
  if (selected.length === 0) {
    await saveSearchResult(pool, { job, target, request, generation, warnings, accepted: [] });
    return;
  }
  const assessments = await evaluateCandidates(pool, { target, config, candidates: selected, jobKind: job.kind });
  await saveSearchResult(pool, {
    job,
    target,
    request,
    generation,
    warnings,
    accepted: rankAccepted(assessments),
  });
}
