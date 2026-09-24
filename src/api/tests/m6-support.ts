import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { sha256Bytes } from '../../db/tests/fixtures.js';

// M6 APIのRedテスト用support。production exportには依存せず、HTTP境界とDBの観測だけを行う。
// テストが要求するPOST /v1/searchesのbody最小契約:
//   project_id, input_id, input_revision, query, idempotency_key, force_refresh
// GET /v1/searches/by-inputのquery最小契約:
//   内部入力: project_id, input_id, input_revision
//   外部入力: project_id, source, source_scope, source_session_id, source_message_id, revision

export interface SearchResponseBody {
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
  matches?: Array<{
    case_or_document_id: string;
    evidence: Array<{
      message_id: string;
      revision: number;
      employee_id?: string;
      role?: string;
      occurred_at?: string;
      text?: string;
    }>;
  }>;
  warnings?: string[];
}

export interface SearchByInputResponseBody {
  lookup_status?: string;
  request_id?: string | null;
  status?: string;
  outcome?: string | null;
}

export interface ErrorResponseBody {
  error?: { code?: string; message?: string };
}

function authHeaders(token: string | null): Record<string, string> {
  return token === null ? {} : { authorization: `Bearer ${token}` };
}

export async function postSearch(app: FastifyInstance, options: { token: string | null; body: unknown }) {
  return app.inject({
    method: 'POST',
    url: '/v1/searches',
    headers: { 'content-type': 'application/json', ...authHeaders(options.token) },
    payload: JSON.stringify(options.body),
  });
}

export async function injectGet(app: FastifyInstance, options: { token: string | null; url: string }) {
  return app.inject({ method: 'GET', url: options.url, headers: authHeaders(options.token) });
}

export async function getSearchById(
  app: FastifyInstance,
  options: { token: string | null; id: string; waitMs?: number; rawWaitMs?: string },
) {
  let url = `/v1/searches/${options.id}`;
  if (options.rawWaitMs !== undefined) {
    url += `?wait_ms=${encodeURIComponent(options.rawWaitMs)}`;
  } else if (options.waitMs !== undefined) {
    url += `?wait_ms=${options.waitMs}`;
  }
  return injectGet(app, { token: options.token, url });
}

export async function getSearchByInput(
  app: FastifyInstance,
  options: { token: string | null; query: Record<string, string | number> },
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query)) {
    params.set(key, String(value));
  }
  return injectGet(app, { token: options.token, url: `/v1/searches/by-input?${params.toString()}` });
}

export interface SearchRequestRow {
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
  stage: string | null;
  policy_version: string;
  reused_from_request_id: string | null;
  original_request_id: string | null;
  result: unknown;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
}

export async function readSearchRequest(pool: Pool, requestId: string): Promise<SearchRequestRow> {
  const result = await pool.query<SearchRequestRow>('SELECT * FROM search_requests WHERE id = $1', [requestId]);
  const row = result.rows[0];
  assert.ok(row, `search_request ${requestId} がない`);
  return row;
}

// 新設される質問column等に依存せず、受付行のどこかへ質問が保存されたことを確認する。
export async function readSearchRequestFull(pool: Pool, requestId: string): Promise<Record<string, unknown>> {
  const result = await pool.query<Record<string, unknown>>('SELECT * FROM search_requests WHERE id = $1', [requestId]);
  const row = result.rows[0];
  assert.ok(row, `search_request ${requestId} がない`);
  return row;
}

export async function countManualSearchRequests(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM search_requests WHERE trigger = 'manual'",
  );
  return Number(result.rows[0].count);
}

export interface SearchRequestPatch {
  status?: string;
  outcome?: string | null;
  searchAction?: string | null;
  stage?: string | null;
  result?: unknown;
  errorCode?: string | null;
  reusedFromRequestId?: string | null;
  originalRequestId?: string | null;
  expiresAt?: Date | null;
}

const PATCH_COLUMNS = {
  status: 'status',
  outcome: 'outcome',
  searchAction: 'search_action',
  stage: 'stage',
  result: 'result',
  errorCode: 'error_code',
  reusedFromRequestId: 'reused_from_request_id',
  originalRequestId: 'original_request_id',
  expiresAt: 'expires_at',
} as const satisfies Record<keyof SearchRequestPatch, string>;

// テストで受付の状態・reuse参照を直接作る。指定したfieldだけを更新する。
export async function updateSearchRequest(pool: Pool, requestId: string, patch: SearchRequestPatch): Promise<void> {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as Array<[keyof SearchRequestPatch, unknown]>;
  assert.ok(entries.length > 0, '更新項目がない');
  const assignments = entries.map(([key], index) => {
    const column = PATCH_COLUMNS[key];
    return key === 'result' ? `${column} = $${index + 2}::jsonb` : `${column} = $${index + 2}`;
  });
  const values = entries.map(([key, value]) => (key === 'result' ? JSON.stringify(value) : value));
  await pool.query(`UPDATE search_requests SET ${assignments.join(', ')}, updated_at = now() WHERE id = $1`, [
    requestId,
    ...values,
  ]);
}

export interface JobRow {
  id: string;
  kind: string;
  status: string;
  session_id: string | null;
  message_id: string | null;
  target_revision: number | null;
  payload: { search_request_id?: string };
  idempotency_key: string;
  created_at: Date;
}

export async function readJobs(pool: Pool): Promise<JobRow[]> {
  const result = await pool.query<JobRow>('SELECT * FROM jobs ORDER BY created_at, id');
  return result.rows;
}

export async function countJobs(pool: Pool, kind: string): Promise<number> {
  const result = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM jobs WHERE kind = $1', [kind]);
  return Number(result.rows[0].count);
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  sequence_no: number;
  current_revision: number;
  source_message_id: string;
}

export async function readMessage(pool: Pool, messageId: string): Promise<MessageRow> {
  const result = await pool.query<MessageRow>(
    'SELECT id, session_id, role, sequence_no, current_revision, source_message_id FROM messages WHERE id = $1',
    [messageId],
  );
  const row = result.rows[0];
  assert.ok(row, `message ${messageId} がない`);
  return row;
}

// 原文のrevisionを進め、reuse時の根拠revision照合を試せる状態にする。
export async function advanceMessageRevision(pool: Pool, messageId: string, text: string): Promise<number> {
  const message = await readMessage(pool, messageId);
  const nextRevision = message.current_revision + 1;
  await pool.query('INSERT INTO message_revisions (message_id, revision, text, content_hash) VALUES ($1, $2, $3, $4)', [
    messageId,
    nextRevision,
    text,
    sha256Bytes(text),
  ]);
  await pool.query('UPDATE messages SET current_revision = $2, updated_at = now() WHERE id = $1', [messageId, nextRevision]);
  return nextRevision;
}

export interface EvidenceFixture {
  messageId: string;
  revision: number;
  employeeId: string;
  role: string;
  occurredAt: string;
  text: string;
}

// 10.3節のcompleted/matched結果を合成する。reuse検証がevidenceの現在性を見られる形にする。
export function buildMatchedResult(input: {
  requestId: string;
  inputId: string;
  inputRevision: number;
  projectId: string;
  evidence: EvidenceFixture[];
}): Record<string, unknown> {
  return {
    request_id: input.requestId,
    input_id: input.inputId,
    input_revision: input.inputRevision,
    trigger: 'auto',
    search_action: 'new_search',
    reused_from_request_id: null,
    status: 'completed',
    outcome: 'matched',
    project_id: input.projectId,
    index_status: {
      pending_documents: 0,
      failed_documents: 0,
      embedding_generation_id: uuidv7(),
      search_mode: 'exact_vector_and_entity',
    },
    matches: [
      {
        case_or_document_id: uuidv7(),
        relevance_kind: ['similar_symptom', 'reusable_procedure'],
        claim_status: 'agent_reported',
        evidence: input.evidence.map((item) => ({
          message_id: item.messageId,
          revision: item.revision,
          employee_id: item.employeeId,
          role: item.role,
          occurred_at: item.occurredAt,
          text: item.text,
        })),
        related_evidence_ids: [],
        truncated: false,
      },
    ],
    warnings: [],
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
