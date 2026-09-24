import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { AUTO_SEARCH_POLICY_VERSION, EVENT_WRITE_LOCK_NAMESPACE } from './contract.js';
import type { AuthContext } from './events.js';
import type { ParsedSearchByInputQuery, ParsedSearchRequest } from './schema.js';
import { EXECUTE_SEARCH_PRIORITY, enqueueJob } from '../jobs/queue.js';
import { WORKER_POLICY_VERSION } from '../worker/contract.js';

// M6の明示検索受付・結果取得・入力照合・原文取得。認証はroute側で行い、
// ここでは会社・案件membershipを含むscope照合と固定codeへ写せる失敗だけを返す。

export class SearchNotFoundError extends Error {}
export class SearchConflictError extends Error {}
export class SearchTargetError extends Error {}

export interface CreatedSearch {
  requestId: string;
  reused: boolean;
}

interface InputTargetRow {
  id: string;
  role: string;
  current_revision: number;
  sequence_no: number;
  session_id: string;
  employee_id: string;
  project_id: string;
  company_id: string;
  text: string;
}

interface SearchRequestRow {
  id: string;
  company_id: string;
  project_id: string;
  employee_id: string;
  session_id: string;
  input_id: string;
  input_revision: number;
  input_sequence_no: number;
  trigger: string;
  status: string;
  outcome: string | null;
  search_action: string | null;
  reused_from_request_id: string | null;
  original_request_id: string | null;
  result: unknown;
  error_code: string | null;
}

export interface SearchView {
  request_id: string;
  input_id: string;
  input_revision: number;
  trigger: string;
  search_action: string | null;
  reused_from_request_id: string | null;
  status: string;
  outcome: string | null;
  error_code: string | null;
  project_id: string;
  matches: unknown[];
  warnings: unknown[];
  index_status?: unknown;
}

export interface NotReceivedView {
  lookup_status: 'not_received';
  request_id: null;
  input_id: null;
  input_revision: null;
  trigger: null;
  status: null;
  outcome: null;
}

export type SearchLookupView = NotReceivedView | ({ lookup_status: 'found' } & SearchView);

export interface EvidenceView {
  message_id: string;
  revision: number;
  employee_id: string;
  role: string;
  occurred_at: string;
  text: string;
}

// 明示受付の条件hash。同じ冪等キーで質問・入力・force_refreshが変わった再送をconflictにする。
function manualConditionHash(input: ParsedSearchRequest): Buffer {
  const canonical = {
    question: input.query,
    input_id: input.input_id,
    input_revision: input.input_revision,
    project_id: input.project_id,
    force_refresh: input.force_refresh,
    policy_version: AUTO_SEARCH_POLICY_VERSION,
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest();
}

// 明示検索を受付ける。同条件の自動受付は処理状態にかかわらず再利用し、
// それ以外は冪等キー単位でmanual受付とexecute_search jobを同一TXで作る。
export async function createSearch(pool: Pool, auth: AuthContext, request: ParsedSearchRequest): Promise<CreatedSearch> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // イベント受付と同じ社員単位ロックを取り、入力revisionの判定と受付作成を直列化する。
    await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [
      EVENT_WRITE_LOCK_NAMESPACE,
      `${auth.companyId}:${auth.employeeId}`,
    ]);
    const targetResult = await client.query<InputTargetRow>(
      `SELECT m.id, m.role, m.current_revision, m.sequence_no, m.session_id,
              s.employee_id, s.project_id, p.company_id, r.text
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         JOIN projects p ON p.id = s.project_id
         JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
        WHERE m.id = $1`,
      [request.input_id],
    );
    const target = targetResult.rows[0];
    if (
      target === undefined ||
      target.company_id !== auth.companyId ||
      target.project_id !== request.project_id ||
      target.employee_id !== auth.employeeId
    ) {
      // 他社員・他案件のmessageは存在を開示せず404へ写す。
      throw new SearchNotFoundError();
    }
    if (target.role !== 'user') {
      throw new SearchTargetError();
    }
    if (target.current_revision !== request.input_revision) {
      throw new SearchConflictError();
    }
    // 冪等キーの既存manual照合は自動受付再利用より先に行う。input原文と同条件のrequestでも、
    // 同じkeyの内容違いをauto再利用で迂回して成功させない。
    const conditionHash = manualConditionHash(request);
    const existing = await client.query<{ id: string; condition_hash: Buffer }>(
      `SELECT id, condition_hash
         FROM search_requests
        WHERE company_id = $1 AND employee_id = $2 AND trigger = 'manual' AND idempotency_key = $3
        FOR UPDATE`,
      [auth.companyId, auth.employeeId, request.idempotency_key],
    );
    const duplicate = existing.rows[0];
    if (duplicate !== undefined) {
      if (!duplicate.condition_hash.equals(conditionHash)) {
        throw new SearchConflictError();
      }
      await client.query('COMMIT');
      return { requestId: duplicate.id, reused: true };
    }
    // 初回でkey未使用かつquestionが現在入力の原文と同じなら、既存の自動受付を再利用する。
    if (!request.force_refresh && request.query === target.text) {
      const auto = await client.query<{ id: string }>(
        `SELECT id
           FROM search_requests
          WHERE input_id = $1 AND input_revision = $2 AND policy_version = $3 AND trigger = 'auto' AND employee_id = $4`,
        [target.id, target.current_revision, AUTO_SEARCH_POLICY_VERSION, auth.employeeId],
      );
      const reused = auto.rows[0];
      if (reused !== undefined) {
        await client.query('COMMIT');
        return { requestId: reused.id, reused: true };
      }
    }
    const requestId = uuidv7();
    await client.query(
      `INSERT INTO search_requests
         (id, company_id, project_id, employee_id, session_id, input_id, input_revision, input_sequence_no,
          trigger, status, outcome, search_action, stage, policy_version, question, idempotency_key, condition_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', 'pending', NULL, 'new_search', 'awaiting_search', $9, $10, $11, $12)`,
      [
        requestId,
        auth.companyId,
        request.project_id,
        auth.employeeId,
        target.session_id,
        target.id,
        target.current_revision,
        target.sequence_no,
        AUTO_SEARCH_POLICY_VERSION,
        request.query,
        request.idempotency_key,
        conditionHash,
      ],
    );
    await enqueueJob(client, {
      kind: 'execute_search',
      idempotencyKey: `execute_search:${requestId}:${AUTO_SEARCH_POLICY_VERSION}`,
      priority: EXECUTE_SEARCH_PRIORITY,
      sessionId: target.session_id,
      messageId: target.id,
      targetRevision: target.current_revision,
      payload: { search_request_id: requestId },
    });
    await client.query('COMMIT');
    return { requestId, reused: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const SEARCH_REQUEST_COLUMNS = `sr.id, sr.company_id, sr.project_id, sr.employee_id, sr.session_id, sr.input_id, sr.input_revision,
       sr.input_sequence_no, sr.trigger, sr.status, sr.outcome, sr.search_action, sr.reused_from_request_id,
       sr.original_request_id, sr.result, sr.error_code`;

async function loadSearchRow(pool: Pool, auth: AuthContext, requestId: string): Promise<SearchRequestRow> {
  const result = await pool.query<SearchRequestRow>(
    `SELECT ${SEARCH_REQUEST_COLUMNS}
       FROM search_requests sr
       JOIN projects p ON p.id = sr.project_id AND p.company_id = $2
       JOIN sessions s ON s.id = sr.session_id AND s.project_id = sr.project_id
      WHERE sr.id = $1 AND sr.company_id = $2
        AND EXISTS (
          SELECT 1 FROM project_members pm
           WHERE pm.project_id = sr.project_id AND pm.employee_id = $3
        )`,
    [requestId, auth.companyId, auth.employeeId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SearchNotFoundError();
  }
  return row;
}

// reuse元は現在受付と同じ会社・案件・社員・sessionの範囲だけで解決する。
async function loadOriginRow(pool: Pool, current: SearchRequestRow, originId: string): Promise<SearchRequestRow | null> {
  const result = await pool.query<SearchRequestRow>(
    `SELECT ${SEARCH_REQUEST_COLUMNS}
       FROM search_requests sr
      WHERE sr.id = $1 AND sr.company_id = $2 AND sr.project_id = $3 AND sr.employee_id = $4 AND sr.session_id = $5`,
    [originId, current.company_id, current.project_id, current.employee_id, current.session_id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return row;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function resultMatches(result: unknown): unknown[] {
  const object = asObject(result);
  return object !== null && Array.isArray(object.matches) ? object.matches : [];
}

function resultWarnings(result: unknown): unknown[] {
  const object = asObject(result);
  return object !== null && Array.isArray(object.warnings) ? object.warnings : [];
}

// completed結果がobjectならoutcomeにかかわらずindex_status/warningsを返し、matchesはmatchedだけ返す。
function completedResultParts(row: SearchRequestRow): { matches: unknown[]; warnings: unknown[]; index_status?: unknown } {
  if (row.status !== 'completed') {
    return { matches: [], warnings: [] };
  }
  const object = asObject(row.result);
  if (object === null) {
    return { matches: [], warnings: [] };
  }
  return {
    matches: row.outcome === 'matched' ? resultMatches(row.result) : [],
    warnings: resultWarnings(row.result),
    index_status: object.index_status,
  };
}

// 結果取得時に現在入力のrevision・sequence・scopeが変わっていないか再検証する。
async function currentInputValid(pool: Pool, current: SearchRequestRow): Promise<boolean> {
  const result = await pool.query<{
    current_revision: number;
    sequence_no: number;
    session_id: string;
    employee_id: string;
    project_id: string;
    company_id: string;
  }>(
    `SELECT m.current_revision, m.sequence_no, m.session_id, s.employee_id, s.project_id, p.company_id
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN projects p ON p.id = s.project_id
      WHERE m.id = $1`,
    [current.input_id],
  );
  const input = result.rows[0];
  return (
    input !== undefined &&
    input.current_revision === current.input_revision &&
    input.sequence_no === current.input_sequence_no &&
    input.session_id === current.session_id &&
    input.employee_id === current.employee_id &&
    input.project_id === current.project_id &&
    input.company_id === current.company_id
  );
}

// 保存済みmatchの再検証。primary evidenceはcurrent revision・案件所属・現在policyの分類・
// 撤回/変更を確認し、M7 related_evidenceはcurrent revision・案件・input境界・relation/link状態を確認する。
// 無効なrelated itemだけを落とし、primaryが無効なmatchは全体を落とす。

// 内部検証metadata（_link_id等）はAPI応答へ出さない。
function publicRelatedItem(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !key.startsWith('_')));
}

interface MatchValidationContext {
  projectId: string;
  companyId: string;
  sessionId: string;
  inputSequenceNo: number;
}

// current revision・案件所属を検証する。境界はrelated itemだけに適用し、primary evidenceは
// 現在inputと同じsessionでも許可する（代表根拠は保存時に検証済み）。
async function revalidateMessage(
  pool: Pool,
  context: MatchValidationContext,
  messageId: string,
  revision: number,
  enforceInputBoundary: boolean,
): Promise<boolean> {
  const result = await pool.query<{
    current_revision: number;
    sequence_no: number;
    session_id: string;
    project_id: string;
    company_id: string;
  }>(
    `SELECT m.current_revision, m.sequence_no, m.session_id, s.project_id, p.company_id
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN projects p ON p.id = s.project_id
      WHERE m.id = $1`,
    [messageId],
  );
  const row = result.rows[0];
  if (row === undefined || row.current_revision !== revision) {
    return false;
  }
  if (row.project_id !== context.projectId || row.company_id !== context.companyId) {
    return false;
  }
  if (enforceInputBoundary && row.session_id === context.sessionId && row.sequence_no >= context.inputSequenceNo) {
    return false;
  }
  return true;
}

// M7 related item 1件を検証し、有効なら内部metadataだけを除いた公開形を返す。
async function revalidateRelatedItem(
  pool: Pool,
  context: MatchValidationContext,
  item: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const messageId = item.message_id;
  const revision = item.revision;
  const sourceKind = item.source_kind;
  if (typeof messageId !== 'string' || typeof revision !== 'number' || typeof sourceKind !== 'string') {
    return null;
  }
  if (!(await revalidateMessage(pool, context, messageId, revision, true))) {
    return null;
  }
  if (sourceKind === 'correction') {
    const relation = item.relation;
    const relatedToMessageId = item.related_to_message_id;
    const relatedToRevision = item.related_to_revision;
    if (
      typeof relation !== 'string' ||
      typeof relatedToMessageId !== 'string' ||
      typeof relatedToRevision !== 'number'
    ) {
      return null;
    }
    const row = await pool.query(
      `SELECT 1
         FROM message_relations
        WHERE source_message_id = $1 AND source_revision = $2
          AND target_message_id = $3 AND target_revision = $4 AND relation = $5`,
      [messageId, revision, relatedToMessageId, relatedToRevision, relation],
    );
    if (row.rows.length === 0) {
      return null;
    }
  } else if (sourceKind === 'explicit_session_link') {
    const linkId = item._link_id;
    if (typeof linkId !== 'string') {
      return null;
    }
    const link = await pool.query(
      `SELECT 1
         FROM session_links l
         JOIN messages em ON em.id = l.evidence_message_id
         JOIN sessions es ON es.id = em.session_id
         JOIN projects ep ON ep.id = es.project_id
        WHERE l.id = $1 AND l.status = 'active' AND l.company_id = $2 AND l.project_id = $3
          AND (em.session_id = l.from_session_id OR em.session_id = l.to_session_id)
          AND em.current_revision = l.evidence_revision
          AND es.project_id = l.project_id AND ep.company_id = l.company_id`,
      [linkId, context.companyId, context.projectId],
    );
    if (link.rows.length === 0) {
      return null;
    }
  } else if (sourceKind !== 'neighbor' && sourceKind !== 'inferred_session_link') {
    return null;
  }
  return publicRelatedItem(item);
}

async function revalidateMatches(pool: Pool, request: SearchRequestRow, result: unknown): Promise<unknown[]> {
  const context: MatchValidationContext = {
    projectId: request.project_id,
    companyId: request.company_id,
    sessionId: request.session_id,
    inputSequenceNo: request.input_sequence_no,
  };
  const kept: unknown[] = [];
  for (const match of resultMatches(result)) {
    const matchObject = asObject(match);
    if (matchObject === null) {
      continue;
    }
    const evidence = Array.isArray(matchObject.evidence) ? matchObject.evidence : [];
    if (evidence.length === 0) {
      continue;
    }
    const relatedRaw = Array.isArray(matchObject.related_evidence) ? matchObject.related_evidence : undefined;
    const relatedValid: Record<string, unknown>[] = [];
    if (relatedRaw !== undefined) {
      for (const item of relatedRaw) {
        const itemObject = asObject(item);
        if (itemObject === null) {
          continue;
        }
        const validItem = await revalidateRelatedItem(pool, context, itemObject);
        if (validItem !== null) {
          relatedValid.push(validItem);
        }
      }
    }
    let valid = true;
    for (const item of evidence) {
      const evidenceObject = asObject(item);
      const messageId = evidenceObject?.message_id;
      const revision = evidenceObject?.revision;
      if (typeof messageId !== 'string' || typeof revision !== 'number') {
        valid = false;
        break;
      }
      if (!(await revalidateMessage(pool, context, messageId, revision, false))) {
        valid = false;
        break;
      }
      // 現在policyの分類がprogress_only・非searchableへ再分類された根拠はmatchedとして返さない。
      const analysis = await pool.query<{ retention: string; is_searchable: boolean }>(
        `SELECT retention, is_searchable
           FROM message_analysis
          WHERE message_id = $1 AND revision = $2 AND policy_version = $3`,
        [messageId, revision, WORKER_POLICY_VERSION],
      );
      const classification = analysis.rows[0];
      if (classification !== undefined && (classification.retention === 'progress_only' || !classification.is_searchable)) {
        valid = false;
        break;
      }
      // 明示的なrevoke/changeは、currentなM7 correction related_evidenceが同時に残る場合だけ許容する。
      const invalidated = await pool.query(
        `SELECT 1
           FROM message_relations
          WHERE target_message_id = $1 AND target_revision = $2 AND relation IN ('revoke', 'change')
          LIMIT 1`,
        [messageId, revision],
      );
      if (invalidated.rows.length > 0) {
        const covered = relatedValid.some(
          (related) =>
            related.source_kind === 'correction' &&
            related.related_to_message_id === messageId &&
            related.related_to_revision === revision,
        );
        if (!covered) {
          valid = false;
          break;
        }
      }
    }
    if (!valid) {
      continue;
    }
    const output: Record<string, unknown> = { ...matchObject };
    if (relatedRaw !== undefined) {
      output.related_evidence = relatedValid;
      output.related_evidence_ids = [
        ...new Set(
          relatedValid
            .map((item) => item.message_id)
            .filter((messageId): messageId is string => typeof messageId === 'string'),
        ),
      ];
    }
    kept.push(output);
  }
  return kept;
}

function baseView(row: SearchRequestRow): SearchView {
  return {
    request_id: row.id,
    input_id: row.input_id,
    input_revision: row.input_revision,
    trigger: row.trigger,
    search_action: row.search_action,
    reused_from_request_id: row.reused_from_request_id,
    status: row.status,
    outcome: row.outcome,
    error_code: row.error_code,
    project_id: row.project_id,
    matches: [],
    warnings: [],
  };
}

async function buildView(pool: Pool, row: SearchRequestRow): Promise<SearchView> {
  const originId = row.original_request_id ?? row.reused_from_request_id;
  if (originId === null) {
    const view: SearchView = { ...baseView(row), ...completedResultParts(row) };
    if (row.status !== 'completed') {
      return view;
    }
    // direct requestでも保存済みmatchedを現在入力・原文・relation/link状態で再検証する。
    if (!(await currentInputValid(pool, row))) {
      return { ...view, status: 'expired', outcome: null, error_code: 'input_revision_stale', matches: [] };
    }
    if (row.outcome === 'matched') {
      const matches = await revalidateMatches(pool, row, row.result);
      if (matches.length === 0) {
        return { ...view, outcome: 'no_match', matches: [] };
      }
      return { ...view, matches };
    }
    return view;
  }
  const origin = await loadOriginRow(pool, row, originId);
  if (origin === null) {
    return baseView(row);
  }
  const tracking: SearchView = {
    ...baseView(row),
    reused_from_request_id: origin.id,
    status: origin.status,
    outcome: origin.outcome,
    error_code: origin.error_code,
  };
  const parts = completedResultParts(origin);
  // 入力失効は元検索の状態より優先する。originがpending/running等でも旧revision受付への待機を続けない。
  if (!(await currentInputValid(pool, row))) {
    return {
      ...tracking,
      status: 'expired',
      outcome: null,
      error_code: 'input_revision_stale',
      matches: [],
      warnings: parts.warnings,
      index_status: parts.index_status,
    };
  }
  if (origin.status === 'completed' && origin.outcome === 'matched') {
    const matches = await revalidateMatches(pool, origin, origin.result);
    if (matches.length === 0) {
      return { ...tracking, outcome: 'no_match', matches: [], warnings: parts.warnings, index_status: parts.index_status };
    }
    return { ...tracking, matches, warnings: parts.warnings, index_status: parts.index_status };
  }
  return { ...tracking, matches: [], warnings: parts.warnings, index_status: parts.index_status };
}

function isPendingStatus(status: string): boolean {
  return status === 'pending' || status === 'running';
}

// request IDで受付を取得する。pending/runningは期限まで短い間隔で再読込し、状態を変更しない。
export async function readSearch(pool: Pool, auth: AuthContext, requestId: string, waitMs: number): Promise<SearchView> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const row = await loadSearchRow(pool, auth, requestId);
    const view = await buildView(pool, row);
    if (!isPendingStatus(view.status) || Date.now() >= deadline) {
      return view;
    }
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

function notReceived(): NotReceivedView {
  return { lookup_status: 'not_received', request_id: null, input_id: null, input_revision: null, trigger: null, status: null, outcome: null };
}

interface LookupRow {
  id: string;
  status: string;
  outcome: string | null;
  input_id: string;
  input_revision: number;
}

// 内部input_idまたは外部取り込み元identityで自動受付を照合する。
// 内部IDも「現在入力」なので、受付とsessionの社員が認証employeeと一致する場合だけ返す。
// not_receivedはそのまま返し、foundはreadSearchと同じlong-poll後の完全なSearchViewへlookup_statusを付けて返す。
export async function lookupSearchByInput(
  pool: Pool,
  auth: AuthContext,
  query: ParsedSearchByInputQuery,
  waitMs: number,
): Promise<SearchLookupView> {
  let result;
  if ('input_id' in query) {
    result = await pool.query<LookupRow>(
      `SELECT sr.id, sr.status, sr.outcome, sr.input_id, sr.input_revision
         FROM search_requests sr
         JOIN messages m ON m.id = sr.input_id
         JOIN sessions s ON s.id = m.session_id
        WHERE sr.trigger = 'auto'
          AND sr.company_id = $1 AND sr.project_id = $2 AND sr.employee_id = $3
          AND s.employee_id = $3 AND s.project_id = $2
          AND m.id = $4 AND sr.input_revision = $5`,
      [auth.companyId, query.project_id, auth.employeeId, query.input_id, query.input_revision],
    );
  } else {
    // 外部IDはイベント受付と同じ会社・社員namespaceへ変換し、接続全体の最新受付を推測しない。
    const sourceScope = `v1|${auth.companyId}|${auth.employeeId}|${query.source_scope}`;
    result = await pool.query<LookupRow>(
      `SELECT sr.id, sr.status, sr.outcome, sr.input_id, sr.input_revision
         FROM sessions s
         JOIN messages m ON m.session_id = s.id AND m.source_message_id = $5
         JOIN search_requests sr ON sr.input_id = m.id AND sr.input_revision = $6 AND sr.trigger = 'auto'
        WHERE s.source = $1 AND s.source_scope = $2 AND s.source_session_id = $3
          AND s.project_id = $4 AND s.employee_id = $7
          AND sr.company_id = $8 AND sr.project_id = $4 AND sr.employee_id = $7`,
      [query.source, sourceScope, query.source_session_id, query.project_id, query.source_message_id, query.revision, auth.employeeId, auth.companyId],
    );
  }
  const row = result.rows[0];
  if (row === undefined) {
    return notReceived();
  }
  const view = await readSearch(pool, auth, row.id, waitMs);
  return { lookup_status: 'found', ...view };
}

interface EvidenceRow {
  message_id: string;
  role: string;
  occurred_at: Date;
  employee_id: string;
  text: string;
}

// 保存済みrevisionの原文を同一会社・案件membershipで取得する。別案件・別会社・未保存revisionはnullにする。
export async function loadEvidence(
  pool: Pool,
  auth: AuthContext,
  messageId: string,
  projectId: string,
  revision: number,
): Promise<EvidenceView | null> {
  const result = await pool.query<EvidenceRow>(
    `SELECT m.id AS message_id, m.role, m.occurred_at, s.employee_id, r.text
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN projects p ON p.id = s.project_id
       JOIN message_revisions r ON r.message_id = m.id AND r.revision = $4
      WHERE m.id = $1 AND p.company_id = $2 AND s.project_id = $3
        AND EXISTS (
          SELECT 1 FROM project_members pm
           WHERE pm.project_id = $3 AND pm.employee_id = $5
        )`,
    [messageId, auth.companyId, projectId, revision, auth.employeeId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    message_id: row.message_id,
    revision,
    employee_id: row.employee_id,
    role: row.role,
    occurred_at: row.occurred_at.toISOString(),
    text: row.text,
  };
}
