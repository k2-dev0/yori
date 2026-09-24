import type { Pool, PoolClient } from 'pg';
import { validate as validateUuid, v7 as uuidv7 } from 'uuid';
import { completeJob, type ClaimedJob } from '../jobs/queue.js';
import type { WorkerConfig } from './config.js';
import {
  CANDIDATE_IMPLEMENTATION_RATIONALE_QUESTION_PREFIX,
  CANDIDATE_RELEVANCE_CRITERIA,
  CANDIDATE_RELEVANCE_QUESTION_PREFIX,
  CANDIDATE_RELEVANCES,
  CANDIDATE_REUSABLE_PROCEDURE_QUESTION_PREFIX,
  CANDIDATE_SIMILAR_CONSTRAINTS_QUESTION_PREFIX,
  CANDIDATE_SIMILAR_SYMPTOM_OR_REQUEST_QUESTION_PREFIX,
  CANDIDATE_STATEMENT_STATUS_CRITERIA,
  CANDIDATE_STATEMENT_STATUS_QUESTION_PREFIX,
  CANDIDATE_STATEMENT_STATUSES,
  CANDIDATE_TARGET_MATCH_QUESTION_PREFIX,
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
  type CandidateStatementStatus,
  type JevChoiceQuestion,
  type JevRequest,
  type JevState,
} from './contract.js';
import { InputBudgetError, loadJobTarget, type JobTarget } from './context.js';
import { loadPinnedGeneration, VoyageEmbeddingProvider, type EmbeddingGeneration } from './embedding.js';
import { GenerationMismatchError, TargetMissingError, LeaseLostError, PolicyBlockedError, StaleApplyError } from './errors.js';
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
import { recordJevUsage } from './usage.js';
import {
  exploreSearchContext,
  revalidateRelatedEvidence,
  type ExplorationResult,
  type RelatedEvidenceDraft,
} from './exploration.js';

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
  question: string | null;
  embedding_generation_id: string | null;
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

// Jevへ送った候補ごとの独立Choice質問。overallとstatement_statusはrelevance_kindと別fieldで保持する。
type CandidateQuestionKind = 'overall' | 'statement_status' | CandidateRelevanceKind;

interface RawChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

interface CandidateAssessment {
  candidate: Candidate;
  relevance: CandidateRelevance;
  relevanceKinds: CandidateRelevanceKind[];
  statementStatus: CandidateStatementStatus;
  answers: Partial<Record<CandidateQuestionKind, RawChoiceAnswer>>;
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
  input: { target: JobTarget; generation: EmbeddingGeneration; queryVector: readonly number[]; question: string },
): Promise<Candidate[]> {
  // 検索の識別子経路は検索質問から抽出する。autoはinput原文、manualは受付へ保存した質問を使う。
  const identifiers = extractEntityReferences(input.question);
  const startedAt = Date.now();
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
    // DB候補検索のdurationだけをproject/generation scopeで観測する。本文・質問は保存しない。
    await client.query(
      `INSERT INTO search_duration_samples (id, company_id, project_id, generation_id, duration_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv7(), input.target.companyId, input.target.projectId, input.generation.id, Math.max(0, Date.now() - startedAt)],
    );
    await client.query('COMMIT');
    return [...candidates.values()].sort((left, right) => right.rrfScore - left.rrfScore || compareCandidates(left, right));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// overall relevanceと、計画9.3の6つの独立Choice質問を候補ごとに組み立てる。
function buildCandidateQuestions(candidates: readonly Candidate[]): {
  questions: Record<string, JevChoiceQuestion>;
  index: Map<string, { candidate: Candidate; kind: CandidateQuestionKind }>;
} {
  const questions: Record<string, JevChoiceQuestion> = {};
  const index = new Map<string, { candidate: Candidate; kind: CandidateQuestionKind }>();
  const addQuestion = (
    candidate: Candidate,
    kind: CandidateQuestionKind,
    prefix: string,
    instructions: string,
    criteria: Record<string, string>,
  ): void => {
    const questionId = `${prefix}:${candidateKey(candidate)}#0`;
    questions[questionId] = { type: 'choice', instructions, criteria: { ...criteria } };
    index.set(questionId, { candidate, kind });
  };
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    addQuestion(
      candidate,
      'overall',
      CANDIDATE_RELEVANCE_QUESTION_PREFIX,
      `state.candidatesのcandidate_id=${key}が現在の質問へどれだけ答えるかoverall relevanceを選ぶ。`,
      CANDIDATE_RELEVANCE_CRITERIA,
    );
    addQuestion(
      candidate,
      'target_match',
      CANDIDATE_TARGET_MATCH_QUESTION_PREFIX,
      `candidate_id=${key}が現在の質問の対象と一致するか選ぶ。`,
      CANDIDATE_YES_NO_CRITERIA,
    );
    addQuestion(
      candidate,
      'similar_symptom_or_request',
      CANDIDATE_SIMILAR_SYMPTOM_OR_REQUEST_QUESTION_PREFIX,
      `candidate_id=${key}の症状または修正依頼が現在の質問と類似しているか選ぶ。`,
      CANDIDATE_YES_NO_CRITERIA,
    );
    addQuestion(
      candidate,
      'similar_constraints',
      CANDIDATE_SIMILAR_CONSTRAINTS_QUESTION_PREFIX,
      `candidate_id=${key}の環境・制約が現在の質問と近いか選ぶ。`,
      CANDIDATE_YES_NO_CRITERIA,
    );
    addQuestion(
      candidate,
      'implementation_rationale',
      CANDIDATE_IMPLEMENTATION_RATIONALE_QUESTION_PREFIX,
      `candidate_id=${key}が実装理由の根拠になるか選ぶ。`,
      CANDIDATE_YES_NO_CRITERIA,
    );
    addQuestion(
      candidate,
      'reusable_procedure',
      CANDIDATE_REUSABLE_PROCEDURE_QUESTION_PREFIX,
      `candidate_id=${key}の解決方法または調査手順を再利用できるか選ぶ。`,
      CANDIDATE_YES_NO_CRITERIA,
    );
    addQuestion(
      candidate,
      'statement_status',
      CANDIDATE_STATEMENT_STATUS_QUESTION_PREFIX,
      `candidate_id=${key}の発言が提案・完了報告・検証済み報告のどれかstatement_statusを選ぶ。実行証跡の有無は推定しない。`,
      CANDIDATE_STATEMENT_STATUS_CRITERIA,
    );
  }
  return { questions, index };
}

// Jevへ候補本文と質問を送り、回答を候補ごとのrelevance・relevance_kindへ写す。
async function evaluateCandidates(
  pool: Pool,
  input: { target: JobTarget; config: WorkerConfig; candidates: readonly Candidate[]; jobKind: string; question: string },
): Promise<CandidateAssessment[]> {
  const { questions, index } = buildCandidateQuestions(input.candidates);
  // Jevの現在質問はmanual受付の質問、autoはinput原文。入力identityは検索対象messageのまま固定する。
  const state: JevState = {
    policy_version: WORKER_POLICY_VERSION,
    current: {
      message_id: input.target.messageId,
      revision: input.target.targetRevision,
      role: input.target.role,
      occurred_at: input.target.occurredAt,
      parts: [{ offset: 0, length: input.question.length, text: input.question }],
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
    assessments.set(candidateKey(candidate), {
      candidate,
      relevance: 'unrelated',
      relevanceKinds: [],
      statementStatus: 'unknown',
      answers: {},
    });
  }
  for (const [questionId, question] of index.entries()) {
    const answer = validated.answers[questionId];
    const assessment = assessments.get(candidateKey(question.candidate));
    if (answer === undefined || assessment === undefined) {
      continue;
    }
    assessment.answers[question.kind] = {
      choice: answer.choice,
      probabilities: { ...answer.probabilities },
      confidence: answer.confidence,
    };
    if (question.kind === 'overall') {
      if ((CANDIDATE_RELEVANCES as readonly string[]).includes(answer.choice)) {
        assessment.relevance = answer.choice as CandidateRelevance;
      }
      continue;
    }
    if (question.kind === 'statement_status') {
      if ((CANDIDATE_STATEMENT_STATUSES as readonly string[]).includes(answer.choice)) {
        assessment.statementStatus = answer.choice as CandidateStatementStatus;
      }
      continue;
    }
    if (answer.choice === 'yes' && !assessment.relevanceKinds.includes(question.kind)) {
      assessment.relevanceKinds.push(question.kind);
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
  // source messageのcurrent_revision確認とsaveのcommitまで、同じmessages行を共有lockで保持する。
  // eventsのrevision更新と競合した場合は検索commitか改訂のどちらかが先に確定し、旧原文のmatched保存を作らない。
  const sources = await client.query<EvidenceRow>(
    `SELECT s.message_id, s.message_revision, m.current_revision, m.sequence_no, m.session_id,
            sess.project_id AS session_project_id, m.role, sess.employee_id, m.occurred_at, rev.text
       FROM search_document_sources s
       JOIN messages m ON m.id = s.message_id
       JOIN sessions sess ON sess.id = m.session_id
       JOIN message_revisions rev ON rev.message_id = s.message_id AND rev.revision = s.message_revision
      WHERE s.document_id = $1 AND s.revision = $2
      ORDER BY s.display_order
      FOR SHARE OF m`,
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
  return { stale: document.rows[0].stale, evidence: sources.rows };
}

function buildMatch(
  assessment: CandidateAssessment,
  valid: { stale: boolean; evidence: readonly EvidenceRow[] },
  related: readonly RelatedEvidenceDraft[],
  truncated: boolean,
): unknown {
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
  const relatedEvidence = related.map((draft) => ({
    message_id: draft.messageId,
    revision: draft.revision,
    employee_id: draft.employeeId,
    role: draft.role,
    occurred_at: draft.occurredAt.toISOString(),
    text: draft.text,
    source_kind: draft.sourceKind,
    // relation/related_to_*は訂正・撤回だけが返す。単一relationは従来fieldを維持し、
    // 複数targetは同じmessageのrelated原文1件に全relationをrelations配列で併記する。
    ...(draft.relations === undefined || draft.relations.length === 0
      ? {}
      : {
          relation: draft.relations[0]?.relation,
          related_to_message_id: draft.relations[0]?.relatedToMessageId,
          related_to_revision: draft.relations[0]?.relatedToRevision,
          ...(draft.relations.length > 1
            ? {
                relations: draft.relations.map((relation) => ({
                  relation: relation.relation,
                  related_to_message_id: relation.relatedToMessageId,
                  related_to_revision: relation.relatedToRevision,
                })),
              }
            : {}),
        }),
    // 結果取得時のlink経路再検証に使う内部field。API view組立時に除去する。
    ...(draft.linkIds === undefined || draft.linkIds.length === 0 ? {} : { _link_ids: draft.linkIds }),
  }));
  return {
    case_or_document_id: assessment.candidate.documentId,
    relevance: assessment.relevance,
    relevance_kind: assessment.relevanceKinds,
    statement_status: assessment.statementStatus,
    // claim_statusは報告の種類。reported_verifiedをツール実証済みへ格上げしない。
    claim_status: agentReported ? 'agent_reported' : 'not_reported',
    evidence,
    related_evidence: relatedEvidence,
    related_evidence_ids: [...new Set(relatedEvidence.map((item) => item.message_id))],
    truncated,
  };
}

// Jevへ渡した全候補のvalidated Choice回答を、採用有無とともにresultへ残す。
// 原文・credential・外部error bodyは複製せず、choice/probabilities/confidenceだけを保存する。
function buildCandidateEvaluations(evaluations: readonly CandidateAssessment[], adoptedKey: string | null): unknown[] {
  return evaluations.map((assessment) => ({
    document_id: assessment.candidate.documentId,
    revision: assessment.candidate.revision,
    relevance: assessment.relevance,
    relevance_kind: assessment.relevanceKinds,
    statement_status: assessment.statementStatus,
    adopted: adoptedKey !== null && candidateKey(assessment.candidate) === adoptedKey,
    answers: assessment.answers,
  }));
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

// 探索前の代表候補選定。loadValidCandidateと同じ再検証を短いTXで行い、外部HTTPの前に確定する。
// 保存TXでも同じ選定をやり直すため、探索中に候補が無効化された場合は保存されない。
async function selectPrimaryCandidate(
  pool: Pool,
  input: { target: JobTarget; generation: EmbeddingGeneration; evaluations: readonly CandidateAssessment[] },
): Promise<{ assessment: CandidateAssessment; valid: { stale: boolean; evidence: EvidenceRow[] }; primaryKey: string } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const assessment of rankAccepted(input.evaluations)) {
      const valid = await loadValidCandidate(client, input.target, input.generation, assessment.candidate);
      if (valid !== null) {
        await client.query('COMMIT');
        return { assessment, valid, primaryKey: candidateKey(assessment.candidate) };
      }
    }
    await client.query('COMMIT');
    return null;
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
    evaluations: readonly CandidateAssessment[];
    exploration: ExplorationResult | null;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockedJob = await client.query<{ message_id: string | null; session_id: string | null; payload: unknown }>(
      `SELECT message_id, session_id, payload FROM jobs
        WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_expires_at > now()
          AND target_revision IS NOT DISTINCT FROM $3
        FOR UPDATE`,
      [input.job.id, input.job.leaseToken, input.job.targetRevision],
    );
    const currentJob = lockedJob.rows[0];
    if (currentJob === undefined) {
      throw new LeaseLostError('jobのlease所有を確認できません');
    }
    // 開始時target/requestとDB現在値のidentityを再検証する。payload objectの開始時値は信用しない。
    if (
      currentJob.message_id !== input.target.messageId ||
      currentJob.session_id !== input.target.sessionId ||
      searchRequestIdFromPayload(currentJob.payload) !== input.request.id
    ) {
      throw new StaleApplyError('jobのidentityまたはpayloadが変化しました');
    }
    const request = await client.query<{ status: string; embedding_generation_id: string | null }>(
      `SELECT status, embedding_generation_id FROM search_requests
        WHERE id = $1 AND status = 'running'
          AND input_id = $2 AND input_revision = $3 AND input_sequence_no = $4
          AND company_id = $5 AND project_id = $6 AND employee_id = $7 AND session_id = $8
          AND search_action = 'new_search'
        FOR UPDATE`,
      [
        input.request.id,
        input.target.messageId,
        input.target.targetRevision,
        input.target.sequenceNo,
        input.target.companyId,
        input.target.projectId,
        input.target.employeeId,
        input.target.sessionId,
      ],
    );
    if (request.rows.length === 0) {
      throw new StaleApplyError('search_requestのidentityまたはscopeが変化しました');
    }
    // 開始時に固定した世代を候補比較・結果のindex_statusまで一貫して使う。
    const expectedGenerationId = input.generation === null ? null : input.generation.id;
    if (request.rows[0].embedding_generation_id !== expectedGenerationId) {
      throw new StaleApplyError('search_requestの固定世代が変化しました');
    }
    // input messageのscope正本（message/session/project）を共有lockし、commitまで所属変更を待たせる。
    const inputMessage = await client.query<{
      current_revision: number;
      session_id: string;
      sequence_no: number;
      employee_id: string;
      project_id: string;
      company_id: string;
    }>(
      `SELECT m.current_revision, m.session_id, m.sequence_no, s.employee_id, s.project_id, p.company_id
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         JOIN projects p ON p.id = s.project_id
        WHERE m.id = $1
        FOR SHARE OF m, s, p`,
      [input.request.input_id],
    );
    const inputRow = inputMessage.rows[0];
    if (inputRow === undefined) {
      throw new StaleApplyError('input messageがありません');
    }
    if (
      inputRow.session_id !== input.target.sessionId ||
      inputRow.sequence_no !== input.target.sequenceNo ||
      inputRow.employee_id !== input.target.employeeId ||
      inputRow.project_id !== input.target.projectId ||
      inputRow.company_id !== input.target.companyId
    ) {
      // 入力の所属session/employee/projectが変化した場合は結果を保存せず、jobも完了しない。
      throw new StaleApplyError('input messageのscopeが変化しました');
    }
    if (inputRow.current_revision !== input.request.input_revision) {
      // 候補判定後・保存時に入力本文が改訂されたら、old inputの結果を保存せずexpiredで終端する。
      await expireStaleSearch(client, input.job, input.target, input.request);
      await client.query('COMMIT');
      return;
    }

    const warnings: SearchWarning[] = [...input.warnings];
    let match: unknown = null;
    let adoptedKey: string | null = null;
    let outcome = 'no_match';
    if (input.generation !== null) {
      for (const assessment of rankAccepted(input.evaluations)) {
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
        let related: RelatedEvidenceDraft[] = [];
        let truncated = false;
        if (input.exploration !== null && input.exploration.primaryKey === candidateKey(assessment.candidate)) {
          related = await revalidateRelatedEvidence(client, input.target, input.exploration.related);
          truncated = input.exploration.truncated;
          warnings.push(...input.exploration.warnings);
        }
        match = buildMatch(assessment, valid, related, truncated);
        adoptedKey = candidateKey(assessment.candidate);
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
      candidate_evaluations: buildCandidateEvaluations(input.evaluations, adoptedKey),
      warnings,
    };
    const updated = await client.query(
      `UPDATE search_requests
          SET status = 'completed', outcome = $2, result = $3::jsonb, stage = 'completed', error_code = NULL, updated_at = now()
        WHERE id = $1 AND status = 'running'
          AND input_id = $4 AND input_revision = $5 AND input_sequence_no = $6
          AND company_id = $7 AND project_id = $8 AND employee_id = $9 AND session_id = $10
          AND search_action = 'new_search'
        RETURNING id`,
      [
        input.request.id,
        outcome,
        JSON.stringify(result),
        input.target.messageId,
        input.target.targetRevision,
        input.target.sequenceNo,
        input.target.companyId,
        input.target.projectId,
        input.target.employeeId,
        input.target.sessionId,
      ],
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

// execute_searchのpayloadから対象search_request IDを取り出す。有効なUUID以外はnullを返し、対象を推測しない。
export function searchRequestIdFromPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const requestId = (payload as { search_request_id?: unknown }).search_request_id;
  return typeof requestId === 'string' && validateUuid(requestId) ? requestId : null;
}

// jobのmessage/revisionとsearch_requestのscope・input revision・new_searchを照合する。
async function loadSearchRequest(pool: Pool, target: JobTarget, requestId: string): Promise<SearchRequestRow> {
  const result = await pool.query<SearchRequestRow>(
    `SELECT id, trigger, search_action, status, result, input_id, input_revision, input_sequence_no, question,
              embedding_generation_id
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

// 検索要求の開始世代を固定する。既存pinはproject切替後も再利用し、NULLなら現在activeを
// request行のロック下で保存してから返す。activeが無ければnullを返し、外部送信しない。
async function resolveSearchGeneration(
  pool: Pool,
  input: { target: JobTarget; request: SearchRequestRow; config: WorkerConfig },
): Promise<EmbeddingGeneration | null> {
  let generationId = input.request.embedding_generation_id;
  if (generationId === null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const request = await client.query<{ embedding_generation_id: string | null }>(
        'SELECT embedding_generation_id FROM search_requests WHERE id = $1 FOR UPDATE',
        [input.request.id],
      );
      if (request.rows.length === 0) {
        throw new StaleApplyError('search_requestの固定世代を確認できません');
      }
      generationId = request.rows[0].embedding_generation_id;
      if (generationId === null) {
        const project = await client.query<{ active_generation_id: string | null }>(
          'SELECT active_generation_id FROM projects WHERE id = $1 AND company_id = $2 FOR SHARE',
          [input.target.projectId, input.target.companyId],
        );
        if (project.rows.length === 0) {
          throw new GenerationMismatchError('projectがありません');
        }
        const activeId = project.rows[0].active_generation_id;
        if (activeId !== null) {
          await client.query(
            'UPDATE search_requests SET embedding_generation_id = $2, updated_at = now() WHERE id = $1 AND embedding_generation_id IS NULL',
            [input.request.id, activeId],
          );
          generationId = activeId;
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  if (generationId === null) {
    return null;
  }
  return loadPinnedGeneration(pool, { companyId: input.target.companyId, generationId }, input.config);
}

// execute_search 1件を処理する。期待される外部障害はprocessJob側でjob/search状態へ反映する。
export async function processExecuteSearch(pool: Pool, job: ClaimedJob, config: WorkerConfig): Promise<void> {
  const target = await loadJobTarget(pool, job);
  if (target === null) {
    throw new TargetMissingError('検索対象のinput revisionがありません');
  }
  // job sessionがmessage所属sessionと一致しないjobは、外部送信もrequest running更新もせず終端する。
  if (job.sessionId === null || job.sessionId !== target.sessionId) {
    throw new TargetMissingError('execute_searchのjob sessionがmessage所属と一致しません');
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
  // 検索質問はmanual受付へ保存した質問、autoは固定input revisionの原文を使う。
  const question = request.trigger === 'manual' ? request.question : target.text;
  if (question === null) {
    throw new TargetMissingError('manual検索の質問がありません');
  }
  // 外部HTTPへ進む前に、対象requestだけをrunningにする。
  await markSearchRunning(pool, job, target, request);
  const generation = await resolveSearchGeneration(pool, { target, request, config });
  if (generation === null) {
    await saveSearchResult(pool, { job, target, request, generation: null, warnings: [], evaluations: [], exploration: null });
    return;
  }
  // Jev本文予算は現在質問と候補本文の合計。質問だけで使い切る場合はno_matchに偽装せず恒久failedにする。
  const tokenizer = await loadVoyageTokenizer();
  const questionTokens = tokenizer.encode(question).ids.length;
  if (questionTokens >= SEARCH_CANDIDATE_BUDGET_TOKENS) {
    throw new InputBudgetError();
  }
  const provider = new VoyageEmbeddingProvider(pool, config);
  const queryVector = await provider.embedQuery(question, generation);
  const candidates = await loadCandidates(pool, { target, generation, queryVector, question });
  const { selected, warnings } = await selectCandidates(candidates, questionTokens);
  if (selected.length === 0) {
    if (candidates.length > 0) {
      // 候補は存在するが全件が質問込みtoken予算に収まらない。no_matchに偽装せず恒久failedにする。
      throw new InputBudgetError();
    }
    await saveSearchResult(pool, { job, target, request, generation, warnings, evaluations: [], exploration: null });
    return;
  }
  const assessments = await evaluateCandidates(pool, { target, config, candidates: selected, jobKind: job.kind, question });
  let exploration: ExplorationResult | null = null;
  if (generation !== null && assessments.length > 0) {
    const primary = await selectPrimaryCandidate(pool, { target, generation, evaluations: assessments });
    // 代表根拠の一意なsession群を起点に、別sessionの過去事例でも周辺・継続探索を行う。
    if (primary !== null) {
      exploration = await exploreSearchContext({
        pool,
        target,
        config,
        tokenizer,
        generationId: generation.id,
        primaryKey: primary.primaryKey,
        primaryDocumentId: primary.assessment.candidate.documentId,
        primaryDocumentRevision: primary.assessment.candidate.revision,
        primaryEvidence: primary.valid.evidence,
        question,
        jobKind: job.kind,
      });
    }
  }
  await saveSearchResult(pool, {
    job,
    target,
    request,
    generation,
    warnings,
    evaluations: assessments,
    exploration,
  });
}
