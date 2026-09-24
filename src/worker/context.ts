import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { EventRole } from '../api/contract.js';
import type { ClaimedJob } from '../jobs/queue.js';
import {
  CONTEXT_MESSAGE_LIMIT,
  WORKER_POLICY_VERSION,
  type JevPriorSearch,
  type JevState,
  type JevStateMessage,
  type JevStatePart,
  type JevRequest,
} from './contract.js';
import type { WorkerConfig } from './config.js';
import { buildQuestions, buildRequest, serializeRequest } from './jev.js';

// 質問定義だけでは予算に収まらない明示エラー。再試行しても解決しない。
export class InputBudgetError extends Error {
  constructor() {
    super('入力予算に質問定義と現在発言が収まりません');
  }
}

export interface JobTarget {
  messageId: string;
  sessionId: string;
  projectId: string;
  companyId: string;
  employeeId: string;
  role: EventRole;
  sequenceNo: number;
  currentRevision: number;
  targetRevision: number;
  text: string;
  occurredAt: string;
}

export interface PriorMessage {
  messageId: string;
  revision: number;
  role: EventRole;
  occurredAt: string;
  text: string;
}

export interface PriorSearch {
  requestId: string;
  inputId: string;
  inputRevision: number;
  inputSequenceNo: number;
  status: string;
  outcome: string | null;
  searchAction: string | null;
  policyVersion: string;
  reusedFromRequestId: string | null;
  originalRequestId: string | null;
  expiresAt: Date | null;
  result: unknown;
  inputText: string | null;
  inputCurrentRevision: number | null;
}

export interface PlannedEvaluation {
  request: JevRequest;
  bodyText: string;
  stateHash: Buffer;
  part: JevStatePart;
  candidates: Array<{ messageId: string; revision: number }>;
  priorSearchIncluded: boolean;
}

export interface EvaluationPlan {
  evaluations: PlannedEvaluation[];
  stateHash: Buffer;
  priorSearch: PriorSearch | undefined;
}

interface TargetRow {
  message_id: string;
  session_id: string;
  sequence_no: number;
  role: EventRole;
  current_revision: number;
  occurred_at: Date;
  project_id: string;
  employee_id: string;
  company_id: string;
  text: string | null;
}

interface PriorRow {
  message_id: string;
  current_revision: number;
  role: EventRole;
  occurred_at: Date;
  text: string;
}

interface PriorSearchRow {
  id: string;
  input_id: string;
  input_revision: number;
  input_sequence_no: number;
  status: string;
  outcome: string | null;
  search_action: string | null;
  policy_version: string;
  reused_from_request_id: string | null;
  original_request_id: string | null;
  expires_at: Date | null;
  result: unknown;
  input_text: string | null;
  input_current_revision: number | null;
}

// jobが固定したmessage revisionの原文と、承認・usage判定に必要な会社/案件/社員を読む。
export async function loadJobTarget(pool: Pool, job: ClaimedJob): Promise<JobTarget | null> {
  if (job.messageId === null || job.targetRevision === null) {
    return null;
  }
  const result = await pool.query<TargetRow>(
    `SELECT m.id AS message_id, m.session_id, m.sequence_no, m.role, m.current_revision, m.occurred_at,
            s.project_id, s.employee_id, p.company_id, r.text
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN projects p ON p.id = s.project_id
       LEFT JOIN message_revisions r ON r.message_id = m.id AND r.revision = $2
      WHERE m.id = $1`,
    [job.messageId, job.targetRevision],
  );
  const row = result.rows[0];
  if (!row || row.text === null) {
    return null;
  }
  return {
    messageId: row.message_id,
    sessionId: row.session_id,
    projectId: row.project_id,
    companyId: row.company_id,
    employeeId: row.employee_id,
    role: row.role,
    sequenceNo: row.sequence_no,
    currentRevision: row.current_revision,
    targetRevision: job.targetRevision,
    text: row.text,
    occurredAt: row.occurred_at.toISOString(),
  };
}

// 対象sequenceより前の同session発言を、最新revisionで新しい順に最大6件読む。
export async function loadPriorMessages(pool: Pool, target: JobTarget): Promise<PriorMessage[]> {
  const result = await pool.query<PriorRow>(
    `SELECT m.id AS message_id, m.current_revision, m.role, m.occurred_at, r.text
       FROM messages m
       JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
      WHERE m.session_id = $1 AND m.sequence_no < $2 AND m.id <> $3
      ORDER BY m.sequence_no DESC, m.id DESC
      LIMIT $4`,
    [target.sessionId, target.sequenceNo, target.messageId, CONTEXT_MESSAGE_LIMIT],
  );
  return result.rows.map((row) => ({
    messageId: row.message_id,
    revision: row.current_revision,
    role: row.role,
    occurredAt: row.occurred_at.toISOString(),
    text: row.text,
  }));
}

const PRIOR_SEARCH_SELECT = `SELECT sr.id, sr.input_id, sr.input_revision, sr.input_sequence_no, sr.status, sr.outcome, sr.search_action,
            sr.policy_version, sr.reused_from_request_id, sr.original_request_id, sr.expires_at, sr.result,
            r.text AS input_text, m.current_revision AS input_current_revision
       FROM search_requests sr
       JOIN messages m ON m.id = sr.input_id
       LEFT JOIN message_revisions r ON r.message_id = sr.input_id AND r.revision = sr.input_revision`;

function toPriorSearch(row: PriorSearchRow): PriorSearch {
  return {
    requestId: row.id,
    inputId: row.input_id,
    inputRevision: row.input_revision,
    inputSequenceNo: row.input_sequence_no,
    status: row.status,
    outcome: row.outcome,
    searchAction: row.search_action,
    policyVersion: row.policy_version,
    reusedFromRequestId: row.reused_from_request_id,
    originalRequestId: row.original_request_id,
    expiresAt: row.expires_at,
    result: row.result,
    inputText: row.input_text,
    inputCurrentRevision: row.input_current_revision,
  };
}

// 直近の先行検索を1件だけ読み、古い有効候補へ飛ばないようにする。policy/状態の適格性はreuse側で判定する。
// manualは追加検索であり自動継続の比較対象ではないため、自動routeのprior_searchにはautoだけを使う。
export async function loadPriorSearch(pool: Pool, target: JobTarget): Promise<PriorSearch | undefined> {
  const result = await pool.query<PriorSearchRow>(
    `${PRIOR_SEARCH_SELECT}
      WHERE sr.company_id = $1 AND sr.project_id = $2 AND sr.employee_id = $3 AND sr.session_id = $4
        AND sr.input_sequence_no < $5 AND sr.trigger = 'auto'
      ORDER BY sr.input_sequence_no DESC, sr.created_at DESC, sr.id DESC
      LIMIT 1`,
    [target.companyId, target.projectId, target.employeeId, target.sessionId, target.sequenceNo],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toPriorSearch(row);
}

// reuse保存TXで受付と元入力をロックし、検証後の改訂・受付更新をcommitまで待たせる。
// scope内・対象sequenceより前に限定し、revision・status・期限・根拠の適格性はreuse側で判定する。
export async function loadPriorSearchById(client: PoolClient, target: JobTarget, requestId: string): Promise<PriorSearch | undefined> {
  const result = await client.query<PriorSearchRow>(
    `${PRIOR_SEARCH_SELECT}
      WHERE sr.id = $1 AND sr.company_id = $2 AND sr.project_id = $3 AND sr.employee_id = $4 AND sr.session_id = $5
        AND sr.input_sequence_no < $6
      LIMIT 1
      FOR SHARE OF sr, m`,
    [requestId, target.companyId, target.projectId, target.employeeId, target.sessionId, target.sequenceNo],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toPriorSearch(row);
}

function sha256Json(value: unknown): Buffer {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest();
}

function toStateMessage(prior: PriorMessage): JevStateMessage {
  return {
    message_id: prior.messageId,
    revision: prior.revision,
    role: prior.role,
    occurred_at: prior.occurredAt,
    text: prior.text,
  };
}

function toPriorSearchState(prior: PriorSearch): JevPriorSearch {
  return {
    request_id: prior.requestId,
    input_id: prior.inputId,
    input_revision: prior.inputRevision,
    input_sequence_no: prior.inputSequenceNo,
    input_text: prior.inputText ?? '',
  };
}

function makeState(
  target: JobTarget,
  part: JevStatePart,
  priorMessages: readonly PriorMessage[],
  priorSearch: JevPriorSearch | null,
  omissions: { priorMessages: number; splitCurrent: boolean; priorSearch: boolean },
): JevState {
  return {
    policy_version: WORKER_POLICY_VERSION,
    current: {
      message_id: target.messageId,
      revision: target.targetRevision,
      role: target.role,
      occurred_at: target.occurredAt,
      parts: [part],
    },
    prior_messages: priorMessages.map(toStateMessage),
    prior_search: priorSearch,
    truncation: {
      omitted_prior_messages: omissions.priorMessages,
      split_current: omissions.splitCurrent,
      prior_search_omitted: omissions.priorSearch,
    },
  };
}

interface FitResult {
  plan: Omit<PlannedEvaluation, 'stateHash'>;
  size: number;
}

// 1つのpartを、直前完全発言→直近先行検索の順に予算へ入れて評価計画を作る。
// part単体でも予算を超える場合はnullを返し、呼出側が分割する。
function fitPart(
  target: JobTarget,
  part: JevStatePart,
  priorMessages: readonly PriorMessage[],
  priorSearch: PriorSearch | undefined,
  config: WorkerConfig,
  splitCurrent: boolean,
): FitResult | null {
  const included: PriorMessage[] = [];
  let priorSearchState: JevPriorSearch | null = null;
  let priorSearchOmitted = priorSearch !== undefined;
  const build = (): FitResult => {
    const candidates = included.map((prior) => ({ messageId: prior.messageId, revision: prior.revision }));
    const questions = buildQuestions(part, included.map((prior) => prior.messageId), priorSearchState !== null);
    const state = makeState(target, part, included, priorSearchState, {
      priorMessages: priorMessages.length - included.length,
      splitCurrent,
      priorSearch: priorSearchOmitted,
    });
    const request = buildRequest(config.model, state, questions);
    const bodyText = serializeRequest(request);
    return {
      plan: { request, bodyText, part, candidates, priorSearchIncluded: priorSearchState !== null },
      size: Buffer.byteLength(bodyText, 'utf8'),
    };
  };
  if (build().size > config.inputBudgetBytes) {
    return null;
  }
  let current = build();
  for (const prior of priorMessages) {
    included.push(prior);
    const next = build();
    if (next.size > config.inputBudgetBytes) {
      included.pop();
      break;
    }
    current = next;
  }
  if (priorSearch?.inputText !== null && priorSearch?.inputText !== undefined) {
    priorSearchState = toPriorSearchState(priorSearch);
    priorSearchOmitted = false;
    const next = build();
    if (next.size > config.inputBudgetBytes) {
      priorSearchState = null;
      priorSearchOmitted = true;
      current = build();
    } else {
      current = next;
    }
  }
  return current;
}

// 予算内で現在発言を連続UTF-16範囲へ分割し、各requestは1 partで送る。
function splitCurrentText(target: JobTarget, config: WorkerConfig): JevStatePart[] {
  const text = target.text;
  const chunks: JevStatePart[] = [];
  let offset = 0;
  while (offset < text.length) {
    const end = maxFittingEnd(target, text, offset, config);
    if (end <= offset) {
      throw new InputBudgetError();
    }
    const chunkText = text.slice(offset, end);
    chunks.push({ offset, length: chunkText.length, text: chunkText });
    offset = end;
  }
  return chunks;
}

// questions・JSONメタデータ込みでpartが収まる最大の終端を二分探索し、サロゲートペアを割らない。
function maxFittingEnd(target: JobTarget, text: string, offset: number, config: WorkerConfig): number {
  const fits = (end: number): boolean => {
    const part: JevStatePart = { offset, length: end - offset, text: text.slice(offset, end) };
    const questions = buildQuestions(part, [], false);
    const state = makeState(target, part, [], null, { priorMessages: 0, splitCurrent: true, priorSearch: false });
    return Buffer.byteLength(serializeRequest(buildRequest(config.model, state, questions)), 'utf8') <= config.inputBudgetBytes;
  };
  let low = offset + 1;
  let high = text.length;
  let best = offset;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best > offset && best < text.length) {
    const previous = text.charCodeAt(best - 1);
    const next = text.charCodeAt(best);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      best -= 1;
    }
  }
  return best;
}

// 対象messageのstate/questions/予算を組み立てる。routeとclassifyで同じ計画を使う。
export function planEvaluations(
  target: JobTarget,
  priorMessages: readonly PriorMessage[],
  priorSearch: PriorSearch | undefined,
  config: WorkerConfig,
): EvaluationPlan {
  const wholePart: JevStatePart = { offset: 0, length: target.text.length, text: target.text };
  const whole = fitPart(target, wholePart, priorMessages, priorSearch, config, false);
  let planned: FitResult[];
  if (whole !== null) {
    planned = [whole];
  } else {
    planned = splitCurrentText(target, config).map((part) => {
      const fitted = fitPart(target, part, priorMessages, priorSearch, config, true);
      if (fitted === null) {
        throw new InputBudgetError();
      }
      return fitted;
    });
  }
  const evaluations = planned.map((item) => ({
    ...item.plan,
    stateHash: sha256Json(item.plan.request.state),
  }));
  return {
    evaluations,
    stateHash: sha256Json(evaluations.map((evaluation) => evaluation.request.state)),
    priorSearch,
  };
}
