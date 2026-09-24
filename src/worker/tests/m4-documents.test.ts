import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import {
  addProjectMember,
  insertEmployee,
  insertProject,
  insertSession,
  resetDatabase,
  seedWorkspace,
  sha256Bytes,
  type WorkspaceFixture,
} from '../../db/tests/fixtures.js';
import { BUILD_DOCUMENTS_PRIORITY, claimJobs, enqueueJob, recoverExpiredJobs, type ClaimedJob } from '../../jobs/queue.js';
import { loadWorkerConfig, type WorkerConfig } from '../config.js';
import {
  CHUNK_MAX_TOKENS,
  CHUNK_TARGET_TOKENS,
  JEV_PROVIDER,
  VOYAGE_DOCUMENT_PREFIX_TOKEN_RESERVE,
  VOYAGE_TOKENIZER_VERSION,
  WORKER_POLICY_VERSION,
} from '../contract.js';
import { applyDocumentPlan, loadSessionMessages, planDocumentChunks } from '../documents.js';
import { ensureActiveGeneration, VoyageEmbeddingProvider } from '../embedding.js';
import { LeaseLostError, StaleApplyError } from '../errors.js';
import { processJob, retryJob } from '../process.js';
import { loadVoyageTokenizer } from '../tokenizer.js';
import { runWorker } from '../runner.js';
import { advanceRevision, countJobsByKind, minutesFromNow, readJob, seedMessage, seedSession, sleep } from './support.js';

// M4の結合test。production codeを変更せず、既存のprocessJob / runWorker / PostgreSQLだけを通して
// 未実装のbuild_documents・Voyage送信・M4 schemaを検出する。
//
// ここで前提にするM4契約（0004_m4.sqlで確定）:
// - embedding_generations(id, provider, model, dimensions, status, tokenizer/前処理版, metric)
// - search_documents(id, company_id, project_id, session_id, document_key, desired_revision, is_searchable)
// - search_document_revisions(document_id, revision, 検索本文, content_hash, chunker_version, status)
// - search_document_sources(document_id, revision, message_id, message_revision, UTF-16 start/end, display_order)
// - document_embeddings(document_id, revision, generation_id, vector(1024), input_hash)
// - document_publications(document_id, generation_id, revision, stale)
// - embedding_cache(company_id, generation_id, operation, input_hash)
// - revision status: pending / embedding / ready / failed / superseded / excluded
// - Voyage接続設定はJEVと同じ方式でenv（VOYAGE_API_KEY / VOYAGE_ACCOUNT_REF / VOYAGE_API_URL /
//   VOYAGE_REQUEST_TIMEOUT_MS）から読む。実APIへは送らず、loopback HTTP fixtureだけを使う。

const VOYAGE_PROVIDER = 'voyage_direct';
const VOYAGE_MODEL = 'voyage-4-lite';
const VOYAGE_PATH = '/v1/embeddings';
const VOYAGE_ACCOUNT = 'voyage-acct-a';
const VOYAGE_KEY = 'test-voyage-key';
const EMBEDDING_DIMENSIONS = 1024;
const BUILD_JOB_TIMEOUT_MS = 8_000;
const EXTERNAL_WAIT_TIMEOUT_MS = 5_000;

const pool = createPool(requireDatabaseUrl());
let workspace: WorkspaceFixture;
const openServers: FakeHttpServer[] = [];

before(async () => {
  await runMigrations(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
  workspace = await seedWorkspace(pool);
});

afterEach(async () => {
  const closing = openServers.splice(0);
  await Promise.all(closing.map((server) => server.close()));
});

after(async () => {
  await pool.end();
});

// ---- loopback HTTP fixture（実Voyage・実会話を送らない） ----

interface FakeHttpReply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
  // headersを先にflushし、bodyだけを遅延させる。
  bodyDelayMs?: number;
}

interface RecordedHttpRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  rawBody: string;
  body: unknown;
}

interface FakeHttpServer {
  baseUrl: string;
  requests: RecordedHttpRequest[];
  close(): Promise<void>;
}

type FakeHttpResponder = (body: unknown) => FakeHttpReply | Promise<FakeHttpReply>;

async function startFakeVoyage(responder: FakeHttpResponder): Promise<FakeHttpServer> {
  const requests: RecordedHttpRequest[] = [];
  let closed = false;
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = null;
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, rawBody, body });
      const reply = await responder(body);
      res.statusCode = reply.status ?? 200;
      res.setHeader('content-type', 'application/json');
      for (const [name, value] of Object.entries(reply.headers ?? {})) {
        res.setHeader(name, value);
      }
      if (reply.bodyDelayMs !== undefined) {
        res.flushHeaders();
        await sleep(reply.bodyDelayMs);
        res.end(reply.rawBody ?? JSON.stringify(reply.body ?? {}));
        return;
      }
      if (reply.delayMs !== undefined) {
        await sleep(reply.delayMs);
      }
      res.end(reply.rawBody ?? JSON.stringify(reply.body ?? {}));
    })().catch(() => {
      res.destroy();
    });
    req.on('error', () => undefined);
    res.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

interface VoyageEmbeddingRequest {
  model: string;
  input: string[];
  input_type?: string;
  output_dimension?: number;
  output_dtype?: string;
  truncation?: boolean;
}

interface VoyageEmbeddingResponse {
  object: string;
  model: string;
  data: { object: string; index: number; embedding: number[] }[];
  usage: { total_tokens: number };
}

function readVoyageRequest(body: unknown): VoyageEmbeddingRequest {
  assert.ok(typeof body === 'object' && body !== null, 'Voyage request bodyがJSON objectでない');
  return body as VoyageEmbeddingRequest;
}

function vectorFor(index: number, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[0] = 0.1 + index * 0.1;
  vector[1] = 0.2 + index * 0.05;
  return vector;
}

// index順の対応を検証できるよう、data配列は入力と逆順で返す。
function validVoyageReply(inputs: readonly string[], model = VOYAGE_MODEL): VoyageEmbeddingResponse {
  const data = inputs.map((_, index) => ({ object: 'embedding', index, embedding: vectorFor(index) }));
  data.reverse();
  return { object: 'list', model, data, usage: { total_tokens: inputs.length * 10 } };
}

const defaultVoyageResponder: FakeHttpResponder = (body) => ({ body: validVoyageReply(readVoyageRequest(body).input ?? []) });

// ---- 設定・承認・job fixture ----

function loadM4WorkerConfig(voyageEndpoint: string, overrides: Record<string, string> = {}): WorkerConfig {
  const loaded = loadWorkerConfig({
    DATABASE_URL: requireDatabaseUrl(),
    JEV_API_KEY: 'test-key',
    JEV_ACCOUNT_REF: 'acct-a',
    JEV_API_URL: 'https://api.typesafe.ai/v1/systemone',
    VOYAGE_API_KEY: VOYAGE_KEY,
    VOYAGE_ACCOUNT_REF: VOYAGE_ACCOUNT,
    VOYAGE_API_URL: voyageEndpoint,
    ...overrides,
  });
  return loaded.config;
}

interface VoyageApprovalSeed {
  companyId: string;
  endpoint: string;
  provider?: string;
  accountRef?: string;
  active?: boolean;
  learningDisabled?: boolean;
  termsCheckedAt?: Date | null;
  confirmedAt?: Date;
}

async function insertVoyageApproval(pool: Pool, input: VoyageApprovalSeed): Promise<void> {
  await pool.query(
    `INSERT INTO provider_policy_approvals
       (id, company_id, provider, account_ref, endpoint, terms_url, terms_checked_at, learning_disabled, retention_terms, confirmed_by, confirmed_at, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'admin-a', $10, $11)`,
    [
      uuidv7(),
      input.companyId,
      input.provider ?? VOYAGE_PROVIDER,
      input.accountRef ?? VOYAGE_ACCOUNT,
      input.endpoint,
      'https://www.voyageai.com/tos',
      input.termsCheckedAt === undefined ? new Date() : input.termsCheckedAt,
      input.learningDisabled ?? true,
      'retention-terms',
      input.confirmedAt ?? new Date(),
      input.active ?? true,
    ],
  );
}

interface GenerationSeed {
  companyId: string;
  overrides?: Partial<{
    provider: string;
    accountRef: string;
    endpoint: string;
    model: string;
    dimensions: number;
    metric: string;
    tokenizerVersion: string;
    documentInputType: string;
    queryInputType: string;
    normalization: string;
    status: string;
  }>;
}

// spec不一致test用に、configと一致しない世代を直接登録する。
async function insertGeneration(pool: Pool, input: GenerationSeed): Promise<string> {
  const id = uuidv7();
  const values = {
    provider: VOYAGE_PROVIDER,
    accountRef: VOYAGE_ACCOUNT,
    endpoint: `https://api.voyageai.com${VOYAGE_PATH}`,
    model: VOYAGE_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    metric: 'cosine',
    tokenizerVersion: 'test-tokenizer',
    documentInputType: 'document',
    queryInputType: 'query',
    normalization: 'provider_default',
    status: 'active',
    ...input.overrides,
  };
  await pool.query(
    `INSERT INTO embedding_generations
       (id, company_id, provider, account_ref, endpoint, model, model_revision, dimensions, metric,
        tokenizer_version, document_input_type, query_input_type, normalization, status)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      input.companyId,
      values.provider,
      values.accountRef,
      values.endpoint,
      values.model,
      values.dimensions,
      values.metric,
      values.tokenizerVersion,
      values.documentInputType,
      values.queryInputType,
      values.normalization,
      values.status,
    ],
  );
  return id;
}

async function startApprovedVoyage(
  pool: Pool,
  companyId: string,
  responder: FakeHttpResponder = defaultVoyageResponder,
): Promise<{ server: FakeHttpServer; config: WorkerConfig }> {
  const server = await startFakeVoyage(responder);
  openServers.push(server);
  const endpoint = `${server.baseUrl}${VOYAGE_PATH}`;
  await insertVoyageApproval(pool, { companyId, endpoint });
  return { server, config: loadM4WorkerConfig(endpoint) };
}

interface SeededMessage {
  messageId: string;
  revision: number;
  text: string;
  buildJobId: string;
}

async function enqueueBuildJob(
  pool: Pool,
  input: { sessionId: string; messageId: string; revision: number; retention: string; isSearchable: boolean },
): Promise<string> {
  const jobId = await enqueueJob(pool, {
    kind: 'build_documents',
    idempotencyKey: `build_documents:${input.messageId}:${input.revision}:${WORKER_POLICY_VERSION}`,
    priority: BUILD_DOCUMENTS_PRIORITY,
    sessionId: input.sessionId,
    messageId: input.messageId,
    targetRevision: input.revision,
    payload: { retention: input.retention, is_searchable: input.isSearchable },
  });
  // host時計とDB時計のskewで直後のclaimが未到来扱いになるのを避け、DB時刻へ揃える。
  await pool.query('UPDATE jobs SET next_run_at = LEAST(next_run_at, now()) WHERE id = $1', [jobId]);
  return jobId;
}

async function upsertAnalysis(
  pool: Pool,
  input: { messageId: string; revision: number; retention?: string; isSearchable?: boolean },
): Promise<void> {
  const retention = input.retention ?? 'substantive';
  const isSearchable = input.isSearchable ?? true;
  await pool.query(
    `INSERT INTO message_analysis
       (id, message_id, revision, policy_version, retention, primary_intent, technical_labels, decision_action,
        continuity, statement_status, is_searchable, model_version, state_hash, parts)
     VALUES ($1, $2, $3, $4, $5, 'implementation', '[]'::jsonb, 'none', 'same_topic', 'request', $6, 'test-model', $7, '[]'::jsonb)
     ON CONFLICT (message_id, revision, policy_version) DO UPDATE
       SET retention = EXCLUDED.retention, is_searchable = EXCLUDED.is_searchable, updated_at = now()`,
    [
      uuidv7(),
      input.messageId,
      input.revision,
      WORKER_POLICY_VERSION,
      retention,
      isSearchable,
      sha256Bytes(`${input.messageId}:${input.revision}:${retention}:${String(isSearchable)}`),
    ],
  );
}

async function insertMessageRelation(
  pool: Pool,
  input: {
    sourceMessageId: string;
    sourceRevision: number;
    targetMessageId: string;
    targetRevision: number;
    relation: string;
    policyVersion?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO message_relations
       (id, source_message_id, source_revision, target_message_id, target_revision, relation, is_explicit, policy_version, evidence_ranges)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7, '[]'::jsonb)`,
    [
      uuidv7(),
      input.sourceMessageId,
      input.sourceRevision,
      input.targetMessageId,
      input.targetRevision,
      input.relation,
      input.policyVersion ?? WORKER_POLICY_VERSION,
    ],
  );
}

async function seedSearchableMessage(
  pool: Pool,
  input: {
    sessionId: string;
    sequenceNo: number;
    text: string;
    role?: 'user' | 'assistant' | 'agent_report';
    retention?: string;
    isSearchable?: boolean;
  },
): Promise<SeededMessage> {
  const message = await seedMessage(pool, {
    sessionId: input.sessionId,
    sequenceNo: input.sequenceNo,
    role: input.role ?? 'user',
    text: input.text,
  });
  const retention = input.retention ?? 'substantive';
  const isSearchable = input.isSearchable ?? true;
  await upsertAnalysis(pool, { messageId: message.messageId, revision: message.revision, retention, isSearchable });
  const buildJobId = await enqueueBuildJob(pool, {
    sessionId: input.sessionId,
    messageId: message.messageId,
    revision: message.revision,
    retention,
    isSearchable,
  });
  return { messageId: message.messageId, revision: message.revision, text: input.text, buildJobId };
}

async function claimBuildJob(pool: Pool, buildJobId: string): Promise<ClaimedJob> {
  const [job] = await claimJobs(pool, { kinds: ['build_documents'], limit: 1, leaseMs: 60_000 });
  if (job === undefined) {
    // host時計とDB時計のskewで未到来扱いになった場合に原因が分かるよう、job行を診断へ含める。
    const diagnostics = await pool.query(
      'SELECT status, next_run_at, now() AS db_now, next_run_at > now() AS is_future FROM jobs WHERE id = $1',
      [buildJobId],
    );
    const activity = await pool.query(
      `SELECT pid, state, xact_start, wait_event_type, left(query, 80) AS query
         FROM pg_stat_activity
        WHERE datname = current_database() AND state <> 'idle'`,
    );
    assert.fail(
      `build_documents jobをclaimできない: ${buildJobId} ${JSON.stringify(diagnostics.rows[0] ?? null)} activity=${JSON.stringify(activity.rows)}`,
    );
  }
  assert.equal(job.id, buildJobId, '別のbuild_documents jobをclaimした');
  return job;
}

interface JobOutcome {
  status: string;
  errorCode: string | null;
  attempts: number;
}

async function runBuildJob(pool: Pool, input: { buildJobId: string; config: WorkerConfig }): Promise<JobOutcome> {
  const job = await claimBuildJob(pool, input.buildJobId);
  await processJob(pool, job, input.config);
  const stored = await readJob(pool, input.buildJobId);
  return { status: stored.status, errorCode: stored.error_code, attempts: stored.attempts };
}

async function reopenJob(pool: Pool, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, error_code = NULL, next_run_at = now(), updated_at = now() WHERE id = $1`,
    [jobId],
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await sleep(20);
  }
  return false;
}

// 最大prefixがtargetトークンちょうどになる固定fixture。1文字追加ごとにトークン数が1増える単純な語列を使う。
const TOKEN_FIXTURE_BASE = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu '.repeat(500);

function exactTokenText(tokenizer: { encode: (text: string) => { ids: number[] } }, target: number): string {
  let low = 1;
  let high = TOKEN_FIXTURE_BASE.length;
  let best = 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (tokenizer.encode(TOKEN_FIXTURE_BASE.slice(0, middle)).ids.length <= target) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const text = TOKEN_FIXTURE_BASE.slice(0, best);
  assert.equal(tokenizer.encode(text).ids.length, target, `token数${target}のfixture文字列を作れない`);
  return text;
}

// ---- M4 schema reader（未実装tableはassertで理由を明示する） ----

const M4_TABLES = [
  'embedding_generations',
  'search_documents',
  'search_document_revisions',
  'search_document_sources',
  'document_embeddings',
  'document_publications',
  'embedding_cache',
] as const;

async function requireM4Tables(pool: Pool): Promise<void> {
  const result = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  const names = new Set(result.rows.map((row) => row.table_name));
  for (const table of M4_TABLES) {
    assert.ok(names.has(table), `M4の必須テーブル ${table} がない（M4 migration未適用）`);
  }
}

type DbRow = Record<string, unknown>;

function pickValue(row: DbRow, candidates: readonly string[]): unknown {
  for (const key of candidates) {
    const value = row[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function pickString(row: DbRow, candidates: readonly string[], label: string): string {
  const value = pickValue(row, candidates);
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  assert.fail(`${label}: 期待する列(${candidates.join('/')})がない。実際の列: ${Object.keys(row).join(', ')}`);
}

function pickOptionalString(row: DbRow, candidates: readonly string[]): string | null {
  const value = pickValue(row, candidates);
  return typeof value === 'string' ? value : null;
}

function pickNumber(row: DbRow, candidates: readonly string[], label: string): number {
  const value = pickValue(row, candidates);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) {
    return Number(value);
  }
  assert.fail(`${label}: 期待する数値列(${candidates.join('/')})がない。実際の値: ${JSON.stringify(value)}`);
}

function pickOptionalBoolean(row: DbRow, candidates: readonly string[]): boolean | null {
  const value = pickValue(row, candidates);
  return typeof value === 'boolean' ? value : null;
}

function parseVector(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const vector = value.map((item) => Number(item));
    return vector.every((item) => Number.isFinite(item)) ? vector : null;
  }
  if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
    const vector = value
      .slice(1, -1)
      .split(',')
      .map((item) => Number(item));
    return vector.length > 0 && vector.every((item) => Number.isFinite(item)) ? vector : null;
  }
  return null;
}

interface DocumentRow {
  id: string;
  documentKey: string;
  desiredRevision: number;
  isSearchable: boolean;
}

async function readDocuments(pool: Pool, projectId: string): Promise<DocumentRow[]> {
  await requireM4Tables(pool);
  const result = await pool.query<{ id: string; document_key: string; desired_revision: number; is_searchable: boolean }>(
    'SELECT id, document_key, desired_revision, is_searchable FROM search_documents WHERE project_id = $1 ORDER BY document_key, id',
    [projectId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    documentKey: row.document_key,
    desiredRevision: row.desired_revision,
    isSearchable: row.is_searchable,
  }));
}

interface RevisionRow {
  documentId: string;
  revision: number;
  text: string;
  status: string;
  chunkerVersion: string;
}

async function readRevisions(pool: Pool): Promise<RevisionRow[]> {
  await requireM4Tables(pool);
  const result = await pool.query<{ row: DbRow }>('SELECT to_jsonb(r) AS row FROM search_document_revisions r');
  return result.rows
    .map(({ row }) => ({
      documentId: pickString(row, ['document_id'], 'search_document_revisions.document_id'),
      revision: pickNumber(row, ['revision'], 'search_document_revisions.revision'),
      text: pickString(row, ['text', 'search_text', 'body', 'content'], 'search_document_revisionsの検索本文'),
      status: pickString(row, ['status', 'index_status'], 'search_document_revisions.status'),
      chunkerVersion: pickString(row, ['chunker_version', 'chunk_version'], 'search_document_revisions.chunker_version'),
    }))
    .sort((a, b) => a.documentId.localeCompare(b.documentId) || a.revision - b.revision);
}

interface SourceSpan {
  documentId: string;
  revision: number;
  messageId: string;
  messageRevision: number;
  start: number;
  end: number;
  displayOrder: number;
  sourceKind: string;
}

async function readSources(pool: Pool): Promise<SourceSpan[]> {
  await requireM4Tables(pool);
  const result = await pool.query<{ row: DbRow }>('SELECT to_jsonb(s) AS row FROM search_document_sources s');
  return result.rows
    .map(({ row }) => ({
      documentId: pickString(row, ['document_id'], 'search_document_sources.document_id'),
      revision: pickNumber(row, ['revision', 'document_revision'], 'search_document_sourcesの文書revision'),
      messageId: pickString(row, ['message_id', 'source_message_id'], 'search_document_sources.message_id'),
      messageRevision: pickNumber(row, ['message_revision', 'source_revision'], 'search_document_sources.message_revision'),
      start: pickNumber(row, ['start_offset', 'start_utf16', 'start'], 'search_document_sourcesのstart'),
      end: pickNumber(row, ['end_offset', 'end_utf16', 'end', 'stop'], 'search_document_sourcesのend'),
      displayOrder: pickNumber(row, ['display_order', 'source_order', 'ordinal', 'order_index'], 'search_document_sources.display_order'),
      sourceKind: pickString(row, ['source_kind', 'kind'], 'search_document_sources.source_kind'),
    }))
    .sort(
      (a, b) =>
        a.documentId.localeCompare(b.documentId) || a.revision - b.revision || a.displayOrder - b.displayOrder,
    );
}

interface EmbeddingRow {
  documentId: string;
  revision: number;
  generationId: string;
  inputHash: string | null;
  vector: number[];
}

async function readEmbeddings(pool: Pool): Promise<EmbeddingRow[]> {
  await requireM4Tables(pool);
  const result = await pool.query<{ row: DbRow }>('SELECT to_jsonb(e) AS row FROM document_embeddings e');
  return result.rows.map(({ row }) => {
    const vector = ['embedding', 'vector', 'embedding_vector']
      .map((key) => parseVector(row[key]))
      .find((value): value is number[] => value !== null);
    assert.ok(vector, `document_embeddingsのvector列がない。実際の列: ${Object.keys(row).join(', ')}`);
    return {
      documentId: pickString(row, ['document_id'], 'document_embeddings.document_id'),
      revision: pickNumber(row, ['revision'], 'document_embeddings.revision'),
      generationId: pickString(row, ['generation_id', 'embedding_generation_id'], 'document_embeddings.generation_id'),
      inputHash: pickOptionalString(row, ['input_hash', 'content_hash']),
      vector,
    };
  });
}

interface PublicationRow {
  documentId: string;
  generationId: string;
  revision: number;
  stale: boolean;
}

async function readPublications(pool: Pool, projectId: string): Promise<PublicationRow[]> {
  await requireM4Tables(pool);
  const result = await pool.query<{ row: DbRow }>(
    `SELECT to_jsonb(p) AS row
       FROM document_publications p
       JOIN search_documents d ON d.id = p.document_id
      WHERE d.project_id = $1
      ORDER BY p.document_id, p.generation_id`,
    [projectId],
  );
  return result.rows.map(({ row }) => ({
    documentId: pickString(row, ['document_id'], 'document_publications.document_id'),
    generationId: pickString(row, ['generation_id', 'embedding_generation_id'], 'document_publications.generation_id'),
    revision: pickNumber(row, ['revision', 'published_revision'], 'document_publications.revision'),
    stale: pickOptionalBoolean(row, ['stale', 'is_stale']) ?? false,
  }));
}

interface GenerationRow {
  id: string;
  provider: string;
  model: string;
  dimensions: number;
  status: string | null;
  tokenizerVersion: string;
}

async function readActiveGeneration(pool: Pool, projectId: string): Promise<GenerationRow> {
  await requireM4Tables(pool);
  const result = await pool.query<{ active_generation_id: string | null; row: DbRow | null }>(
    `SELECT p.active_generation_id, to_jsonb(g) AS row
       FROM projects p
       LEFT JOIN embedding_generations g ON g.id = p.active_generation_id
      WHERE p.id = $1`,
    [projectId],
  );
  const record = result.rows[0];
  assert.ok(record, `project ${projectId} がない`);
  assert.ok(record.active_generation_id, 'projects.active_generation_idが未設定（M4の世代作成が未実装）');
  assert.ok(record.row, 'active_generation_idがembedding_generationsを参照していない');
  return {
    id: record.active_generation_id,
    provider: pickString(record.row, ['provider'], 'embedding_generations.provider'),
    model: pickString(record.row, ['model'], 'embedding_generations.model'),
    dimensions: pickNumber(record.row, ['dimensions'], 'embedding_generations.dimensions'),
    status: pickOptionalString(record.row, ['status']),
    tokenizerVersion: pickString(record.row, ['tokenizer_version'], 'embedding_generations.tokenizer_version'),
  };
}

async function readEmbeddingCacheRows(pool: Pool): Promise<{ companyId: string | null; operation: string | null }[]> {
  await requireM4Tables(pool);
  const result = await pool.query<{ row: DbRow }>('SELECT to_jsonb(c) AS row FROM embedding_cache c');
  return result.rows.map(({ row }) => ({
    companyId: pickOptionalString(row, ['company_id']),
    operation: pickOptionalString(row, ['operation']),
  }));
}

async function readVoyageUsageEvents(
  pool: Pool,
  companyId: string,
): Promise<{ provider: string | null; operation: string | null; success: boolean | null }[]> {
  const result = await pool.query<{ row: DbRow }>('SELECT to_jsonb(u) AS row FROM usage_events u WHERE company_id = $1', [
    companyId,
  ]);
  return result.rows.map(({ row }) => ({
    provider: pickOptionalString(row, ['provider']),
    operation: pickOptionalString(row, ['operation']),
    success: pickOptionalBoolean(row, ['success']),
  }));
}

async function messageRevisionText(pool: Pool, messageId: string, revision: number): Promise<string> {
  const result = await pool.query<{ text: string }>(
    'SELECT text FROM message_revisions WHERE message_id = $1 AND revision = $2',
    [messageId, revision],
  );
  assert.ok(result.rows[0], `message_revision ${messageId}@${revision} がない`);
  return result.rows[0].text;
}

async function currentMessageRevision(pool: Pool, messageId: string): Promise<number> {
  const result = await pool.query<{ current_revision: number }>('SELECT current_revision FROM messages WHERE id = $1', [
    messageId,
  ]);
  assert.ok(result.rows[0], `message ${messageId} がない`);
  return result.rows[0].current_revision;
}

// 公開中のrevisionが出典messageの現行revisionだけを指すことを確認する。
async function assertPublishedSourcesCurrent(pool: Pool, projectId: string): Promise<void> {
  const publications = await readPublications(pool, projectId);
  const sources = await readSources(pool);
  for (const publication of publications.filter((item) => !item.stale)) {
    const revisionSources = sources.filter(
      (source) => source.documentId === publication.documentId && source.revision === publication.revision,
    );
    for (const source of revisionSources) {
      const current = await currentMessageRevision(pool, source.messageId);
      assert.equal(
        source.messageRevision,
        current,
        `公開revision ${publication.documentId}@${publication.revision} が出典message ${source.messageId} の旧revision ${source.messageRevision} を指す（現行 ${current}）`,
      );
    }
  }
}

async function publishedRevisionTexts(pool: Pool, projectId: string): Promise<string[]> {
  const publications = await readPublications(pool, projectId);
  const revisions = await readRevisions(pool);
  const texts: string[] = [];
  for (const publication of publications.filter((item) => !item.stale)) {
    const revision = revisions.find(
      (item) => item.documentId === publication.documentId && item.revision === publication.revision,
    );
    if (revision !== undefined) {
      texts.push(revision.text);
    }
  }
  return texts;
}

async function snapshotSearchState(pool: Pool, projectId: string): Promise<{
  documents: DocumentRow[];
  revisions: RevisionRow[];
  sources: SourceSpan[];
  publications: PublicationRow[];
  embeddings: { documentId: string; revision: number; generationId: string; vector: number[] }[];
}> {
  const documents = await readDocuments(pool, projectId);
  const documentIds = new Set(documents.map((document) => document.id));
  const revisions = (await readRevisions(pool)).filter((revision) => documentIds.has(revision.documentId));
  const sources = (await readSources(pool)).filter((source) => documentIds.has(source.documentId));
  const publications = await readPublications(pool, projectId);
  const embeddings = (await readEmbeddings(pool))
    .filter((embedding) => documentIds.has(embedding.documentId))
    .map((embedding) => ({
      documentId: embedding.documentId,
      revision: embedding.revision,
      generationId: embedding.generationId,
      vector: embedding.vector,
    }));
  return { documents, revisions, sources, publications, embeddings };
}

function compact(value: string): string {
  return value.replace(/\s+/gu, '');
}

function matchesInput(revisionText: string, input: string): boolean {
  if (revisionText === input) {
    return true;
  }
  const left = compact(revisionText);
  const right = compact(input);
  return left === right || left.includes(right) || right.includes(left);
}

function isSurrogatePairSplit(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return false;
  }
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

// 出典rangeの和集合が原文全体を欠落なく覆うことを確認する（重複窓は許容）。
function assertCoverage(spans: readonly SourceSpan[], textLength: number, label: string): void {
  const ranges = spans.map((span) => [span.start, span.end]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let covered = 0;
  for (const range of ranges) {
    assert.ok(range[0] <= covered, `${label}: 原文範囲に欠落がある (${covered}..${range[0]})`);
    covered = Math.max(covered, range[1]);
  }
  assert.equal(covered, textLength, `${label}: 原文末尾まで範囲が覆っていない (${covered}/${textLength})`);
}

function revisionKey(documentId: string, revision: number): string {
  return `${documentId}:${revision}`;
}

function totalSpanLength(spans: readonly SourceSpan[]): number {
  return spans.reduce((sum, span) => sum + (span.end - span.start), 0);
}

function revisionContainsRange(spans: readonly SourceSpan[], range: { start: number; end: number }): boolean {
  const ranges = spans.map((span) => [span.start, span.end]).sort((a, b) => a[0] - b[0]);
  let covered = range.start;
  for (const span of ranges) {
    if (span[0] > covered) {
      return false;
    }
    covered = Math.max(covered, span[1]);
    if (covered >= range.end) {
      return true;
    }
  }
  return covered >= range.end;
}

// ---- 結合test ----

describe('M4 build_documents: 世代作成・原文対応・公開', () => {
  it('初回build_documentsでVoyage世代を作成し、原文範囲付きのready文書を公開する', async () => {
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const first = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 1,
      text: '設計方針として抽出条件を確認する 🧪',
    });
    const second = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 2,
      role: 'assistant',
      text: '実装方針として決定的な文書分割を先に作る',
    });

    const firstRun = await runBuildJob(pool, { buildJobId: first.buildJobId, config });
    assert.equal(firstRun.status, 'completed', `最初のbuild_documentsがcompletedでない: ${firstRun.status}/${firstRun.errorCode ?? ''}`);
    const secondRun = await runBuildJob(pool, { buildJobId: second.buildJobId, config });
    assert.equal(secondRun.status, 'completed', `後続のbuild_documentsがcompletedでない: ${secondRun.status}/${secondRun.errorCode ?? ''}`);

    const generation = await readActiveGeneration(pool, workspace.projectId);
    assert.equal(generation.provider, VOYAGE_PROVIDER, 'generationのproviderがvoyage_directでない');
    assert.equal(generation.model, VOYAGE_MODEL, 'generationのmodelがvoyage-4-liteでない');
    assert.equal(generation.dimensions, EMBEDDING_DIMENSIONS, 'generationのdimensionsが1024でない');
    assert.equal(generation.tokenizerVersion, VOYAGE_TOKENIZER_VERSION, 'tokenizer_versionにasset revisionと実行library版が入っていない');
    assert.ok(
      generation.tokenizerVersion.includes('0335ddf7698395712e3220733b4079006951cfef') &&
        generation.tokenizerVersion.includes('@huggingface/tokenizers@0.2.0'),
      `tokenizer_versionの固定内容が不足: ${generation.tokenizerVersion}`,
    );

    const documents = await readDocuments(pool, workspace.projectId);
    assert.ok(documents.length >= 1, '検索文書がない');
    const revisions = await readRevisions(pool);
    const ready = revisions.filter((revision) => revision.status === 'ready');
    assert.ok(ready.length >= 1, 'readyの文書revisionがない');
    assert.ok(
      ready.some(
        (revision) => compact(revision.text).includes(compact(first.text)) && compact(revision.text).includes(compact(second.text)),
      ),
      '同一sessionの選別原文が同じ検索文書へまとまっていない',
    );

    const sources = await readSources(pool);
    assert.ok(sources.length >= 2, '原文対応（search_document_sources）が保存されていない');
    for (const source of sources) {
      const original = await messageRevisionText(pool, source.messageId, source.messageRevision);
      assert.ok(
        source.start >= 0 && source.end <= original.length && source.start < source.end,
        `原文範囲が不正: ${source.messageId}@${source.messageRevision} ${source.start}..${source.end}`,
      );
    }

    const publications = await readPublications(pool, workspace.projectId);
    assert.ok(publications.some((publication) => !publication.stale), '公開状態（document_publications）がない');
    const embeddings = await readEmbeddings(pool);
    for (const publication of publications.filter((item) => !item.stale)) {
      const revision = revisions.find(
        (item) => item.documentId === publication.documentId && item.revision === publication.revision,
      );
      assert.ok(revision, '公開revisionがsearch_document_revisionsにない');
      assert.equal(revision.status, 'ready', '公開revisionのstatusがreadyでない');
      const embedding = embeddings.find(
        (item) =>
          item.documentId === publication.documentId &&
          item.revision === publication.revision &&
          item.generationId === generation.id,
      );
      assert.ok(embedding, '公開revisionのembeddingがない');
      assert.equal(embedding.vector.length, EMBEDDING_DIMENSIONS, 'embeddingの次元が1024でない');
      assert.ok(embedding.vector.every((value) => Number.isFinite(value)), 'embeddingに有限でない値がある');
      assert.ok(embedding.vector.some((value) => value !== 0), '全ゼロvectorが保存されている');
    }
    await assertPublishedSourcesCurrent(pool, workspace.projectId);
    assert.equal(await messageRevisionText(pool, first.messageId, 1), first.text, '原文が変更されている');
    assert.ok(server.requests.length >= 1, 'Voyageへ送信していない');
  });

  it('同一session/raw revision/chunker版の再実行で検索本文・document_key・原文範囲が同一で、文書/revision/jobが増殖しない', async () => {
    const { config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const first = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '冪等性を確認する設計メモ' });
    const second = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 2,
      role: 'assistant',
      text: '再実行しても本文と原文範囲を変えない',
    });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: first.buildJobId, config })).status,
      'completed',
      '最初のbuild_documentsがcompletedでない',
    );
    assert.equal(
      (await runBuildJob(pool, { buildJobId: second.buildJobId, config })).status,
      'completed',
      '後続のbuild_documentsがcompletedでない',
    );

    const before = await snapshotSearchState(pool, workspace.projectId);
    const jobCount = await countJobsByKind(pool, 'build_documents');
    await reopenJob(pool, second.buildJobId);
    const rerun = await runBuildJob(pool, { buildJobId: second.buildJobId, config });
    assert.equal(rerun.status, 'completed', `再実行のbuild_documentsがcompletedでない: ${rerun.status}/${rerun.errorCode ?? ''}`);

    assert.deepEqual(
      await snapshotSearchState(pool, workspace.projectId),
      before,
      '再実行で検索本文・document_key・原文範囲が変化、または文書/revisionが増殖した',
    );
    assert.equal(await countJobsByKind(pool, 'build_documents'), jobCount, 'build_documents jobが増殖した');
  });

  it('長文は複数文書へ分割し、message→paragraph→code block境界を優先して単一超過blockも原文rangeで欠落なく覆う', async () => {
    const { config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const paragraph1 = `第1段落: ${'設計方針を確認する。'.repeat(12)} 🧪`;
    const codeLines = Array.from(
      { length: 1500 },
      (_, index) => `const value_${String(index).padStart(4, '0')} = compute(${index}); // コード行 ${index}`,
    );
    const codeBlock = ['```ts', ...codeLines, '```'].join('\n');
    const paragraph2 = `第2段落: ${'確認項目を並べる。'.repeat(12)} ✅`;
    const text = `${paragraph1}\n\n${codeBlock}\n\n${paragraph2}`;
    const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text });
    const run = await runBuildJob(pool, { buildJobId: message.buildJobId, config });
    assert.equal(run.status, 'completed', `長文のbuild_documentsがcompletedでない: ${run.status}/${run.errorCode ?? ''}`);

    const documents = await readDocuments(pool, workspace.projectId);
    assert.ok(documents.length >= 2, '上限超過の長文が複数文書へ分割されていない');
    const revisions = await readRevisions(pool);
    assert.ok(revisions.length >= 2, '上限超過の長文が複数revisionへ分割されていない');
    assert.ok(
      revisions.every((revision) => revision.text.length > 0 && revision.chunkerVersion.length > 0),
      '空の検索本文またはchunker_version欠落がある',
    );

    const spans = (await readSources(pool)).filter(
      (source) => source.messageId === message.messageId && source.messageRevision === message.revision,
    );
    assert.ok(spans.length >= 2, '長文の原文対応が1件しかない');
    assertCoverage(spans, text.length, '長文の原文');
    for (const span of spans) {
      assert.ok(!isSurrogatePairSplit(text, span.start), `原文範囲のstartがサロゲートペアを分割している: ${span.start}`);
      assert.ok(!isSurrogatePairSplit(text, span.end), `原文範囲のendがサロゲートペアを分割している: ${span.end}`);
      assert.ok(text.slice(span.start, span.end).length > 0, `原文範囲のsliceが空: ${span.start}..${span.end}`);
    }

    const spansByRevision = new Map<string, SourceSpan[]>();
    for (const span of spans) {
      const key = revisionKey(span.documentId, span.revision);
      spansByRevision.set(key, [...(spansByRevision.get(key) ?? []), span]);
    }
    const paragraph1Range = { start: 0, end: paragraph1.length };
    const paragraph2Range = { start: text.length - paragraph2.length, end: text.length };
    assert.ok(
      [...spansByRevision.values()].some((revisionSpans) => revisionContainsRange(revisionSpans, paragraph1Range)),
      '短い第1段落が段落境界で単一revisionに収まっていない',
    );
    assert.ok(
      [...spansByRevision.values()].some((revisionSpans) => revisionContainsRange(revisionSpans, paragraph2Range)),
      '短い第2段落が段落境界で単一revisionに収まっていない',
    );

    const codeRange = { start: paragraph1.length + 2, end: text.length - paragraph2.length - 2 };
    const coveringRevisions = [...spansByRevision.entries()].filter(([, revisionSpans]) =>
      revisionSpans.some((span) => span.start < codeRange.end && span.end > codeRange.start),
    );
    assert.ok(coveringRevisions.length >= 2, '上限を超える単一コードブロックが分割されていない');

    // 分割時は境界の取出しを失わない重複windowを持つ。文書全体の複製にはしない。
    const codeSpans = spans.filter((span) => span.start < codeRange.end && span.end > codeRange.start);
    let hasOverlap = false;
    for (let left = 0; left < codeSpans.length; left += 1) {
      for (let right = left + 1; right < codeSpans.length; right += 1) {
        const first = codeSpans[left];
        const second = codeSpans[right];
        if (first.documentId === second.documentId && first.revision === second.revision) {
          continue;
        }
        const overlapLength = Math.min(first.end, second.end) - Math.max(first.start, second.start);
        if (overlapLength > 0) {
          hasOverlap = true;
          // 重複windowは前chunkの末尾rangeの複製なので、span単体では包含関係になる。
          // revision全体を複製していないことを、revisionごとの原文range合計で確認する。
          const firstTotal = totalSpanLength(spansByRevision.get(revisionKey(first.documentId, first.revision)) ?? []);
          const secondTotal = totalSpanLength(spansByRevision.get(revisionKey(second.documentId, second.revision)) ?? []);
          assert.ok(
            overlapLength < Math.min(firstTotal, secondTotal),
            '分割時の重複windowがrevision全体の複製になっている',
          );
        }
      }
    }
    assert.ok(hasOverlap, '分割された長文の隣接revisionに重複window（100トークン相当）がない');
  });

  it('後続発言の追加は確定済み文書revisionを維持し、末尾だけ新revisionにする', async () => {
    const { config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const first = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '先に確定する設計方針' });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: first.buildJobId, config })).status,
      'completed',
      '最初のbuild_documentsがcompletedでない',
    );
    const beforeDocuments = await readDocuments(pool, workspace.projectId);
    const beforeRevisions = await readRevisions(pool);
    assert.ok(beforeRevisions.length >= 1, '確定済みrevisionがない');

    const second = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 2,
      role: 'assistant',
      text: '追加する末尾の実装メモ',
    });
    const run = await runBuildJob(pool, { buildJobId: second.buildJobId, config });
    assert.equal(run.status, 'completed', `後続発言のbuild_documentsがcompletedでない: ${run.status}/${run.errorCode ?? ''}`);

    const afterDocuments = await readDocuments(pool, workspace.projectId);
    const afterRevisions = await readRevisions(pool);
    assert.equal(afterDocuments.length, beforeDocuments.length, '後続発言の追加で文書が増殖した');
    for (const revision of beforeRevisions) {
      const same = afterRevisions.find(
        (item) => item.documentId === revision.documentId && item.revision === revision.revision,
      );
      assert.ok(same, `確定済みrevisionが消えた: ${revision.documentId}@${revision.revision}`);
      assert.equal(same.text, revision.text, '確定済みrevisionの検索本文が書き換わった');
    }
    const newRevisions = afterRevisions.filter(
      (revision) =>
        !beforeRevisions.some((item) => item.documentId === revision.documentId && item.revision === revision.revision),
    );
    assert.equal(newRevisions.length, 1, `末尾の新revisionが1件でない: ${newRevisions.length}`);
    const newRevision = newRevisions[0];
    assert.ok(compact(newRevision.text).includes(compact(second.text)), '新revisionに後続発言の原文が含まれていない');

    const tailDocument = afterDocuments.find((document) => document.id === newRevision.documentId);
    assert.ok(tailDocument, '新revisionの文書がない');
    assert.equal(tailDocument.desiredRevision, newRevision.revision, 'desired_revisionが新revisionを指していない');
    const publications = await readPublications(pool, workspace.projectId);
    assert.ok(
      publications.some(
        (publication) =>
          publication.documentId === newRevision.documentId &&
          publication.revision === newRevision.revision &&
          !publication.stale,
      ),
      '末尾の新revisionが公開されていない',
    );
  });

  it('原文編集後に古いrevisionのbuild_documentsが完了しても、新しい公開revisionを上書きしない', async () => {
    const { config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const first = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '編集前の設計方針 🧪' });
    const edited = '編集後の設計方針: 抽出条件を変更する';
    const revision2 = await advanceRevision(pool, first.messageId, edited);
    await upsertAnalysis(pool, { messageId: first.messageId, revision: revision2 });
    const currentJobId = await enqueueBuildJob(pool, {
      sessionId,
      messageId: first.messageId,
      revision: revision2,
      retention: 'substantive',
      isSearchable: true,
    });

    // 対象revisionが既に2の状態で、旧revision1のjobを先に完了させる。
    const staleFirst = await runBuildJob(pool, { buildJobId: first.buildJobId, config });
    assert.equal(
      staleFirst.status,
      'completed',
      `古いrevisionのbuild_documentsがcompletedでない: ${staleFirst.status}/${staleFirst.errorCode ?? ''}`,
    );
    const current = await runBuildJob(pool, { buildJobId: currentJobId, config });
    assert.equal(
      current.status,
      'completed',
      `現行revisionのbuild_documentsがcompletedでない: ${current.status}/${current.errorCode ?? ''}`,
    );

    const documents = await readDocuments(pool, workspace.projectId);
    const publications = await readPublications(pool, workspace.projectId);
    const revisions = await readRevisions(pool);
    for (const publication of publications.filter((item) => !item.stale)) {
      const document = documents.find((item) => item.id === publication.documentId);
      const revision = revisions.find(
        (item) => item.documentId === publication.documentId && item.revision === publication.revision,
      );
      assert.ok(document && revision, '公開revisionの文書またはrevisionがない');
      assert.equal(publication.revision, document.desiredRevision, '公開revisionがdesired_revisionと一致しない');
      assert.ok(compact(revision.text).includes(compact(edited)), '編集後の原文が公開revisionにない');
      assert.ok(!compact(revision.text).includes(compact(first.text)), '編集前の原文が公開revisionに残っている');
    }

    const beforeDelayedStale = await snapshotSearchState(pool, workspace.projectId);
    await reopenJob(pool, first.buildJobId);
    const delayedStale = await runBuildJob(pool, { buildJobId: first.buildJobId, config });
    assert.equal(
      delayedStale.status,
      'completed',
      `遅延した古いrevisionのbuild_documentsがcompletedでない: ${delayedStale.status}/${delayedStale.errorCode ?? ''}`,
    );
    assert.deepEqual(
      await snapshotSearchState(pool, workspace.projectId),
      beforeDelayedStale,
      '遅れて完了した古いrevisionが新しい公開状態を上書きした',
    );
  });
});

describe('M4 progress_onlyの索引除外', () => {
  it('progress_onlyの初回buildはVoyageへ送信せず、原文を保持して検索文書へ載せない', async () => {
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const message = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 1,
      text: 'progress_onlyの進行メモ',
      retention: 'progress_only',
      isSearchable: false,
    });
    const run = await runBuildJob(pool, { buildJobId: message.buildJobId, config });
    assert.equal(
      run.status,
      'completed',
      `progress_onlyのbuild_documentsがcompletedでない: ${run.status}/${run.errorCode ?? ''}`,
    );
    assert.equal(server.requests.length, 0, 'progress_onlyの原文をVoyageへ送信している');
    assert.equal(await messageRevisionText(pool, message.messageId, message.revision), message.text, 'progress_onlyの原文が消えた');

    for (const text of await publishedRevisionTexts(pool, workspace.projectId)) {
      assert.ok(!compact(text).includes(compact(message.text)), 'progress_onlyの原文が公開revisionに残っている');
    }
  });

  it('progress_onlyへ再分類すると、原文を残したまま旧公開文書を検索不能にする', async () => {
    const { config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const first = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '再分類の対象になる設計メモ' });
    const second = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 2,
      role: 'assistant',
      text: '残り続ける実装メモ',
    });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: first.buildJobId, config })).status,
      'completed',
      '最初のbuild_documentsがcompletedでない',
    );
    assert.equal(
      (await runBuildJob(pool, { buildJobId: second.buildJobId, config })).status,
      'completed',
      '後続のbuild_documentsがcompletedでない',
    );

    await upsertAnalysis(pool, {
      messageId: first.messageId,
      revision: first.revision,
      retention: 'progress_only',
      isSearchable: false,
    });
    await pool.query(`UPDATE jobs SET payload = $2::jsonb WHERE id = $1`, [
      first.buildJobId,
      JSON.stringify({ retention: 'progress_only', is_searchable: false }),
    ]);
    await reopenJob(pool, first.buildJobId);
    const reclassified = await runBuildJob(pool, { buildJobId: first.buildJobId, config });
    assert.equal(
      reclassified.status,
      'completed',
      `再分類後のbuild_documentsがcompletedでない: ${reclassified.status}/${reclassified.errorCode ?? ''}`,
    );
    assert.equal(await messageRevisionText(pool, first.messageId, first.revision), first.text, 'progress_only再分類で原文が消えた');

    const documents = await readDocuments(pool, workspace.projectId);
    const publications = await readPublications(pool, workspace.projectId);
    const revisions = await readRevisions(pool);
    for (const publication of publications.filter((item) => !item.stale)) {
      const document = documents.find((item) => item.id === publication.documentId);
      if (document !== undefined && !document.isSearchable) {
        continue;
      }
      const revision = revisions.find(
        (item) => item.documentId === publication.documentId && item.revision === publication.revision,
      );
      assert.ok(revision, '公開revisionがない');
      assert.ok(
        !compact(revision.text).includes(compact(first.text)),
        'progress_onlyへ再分類された原文を含む公開revisionが残っている',
      );
    }
  });

  it('非先頭sourceのprogress_only再分類はVoyage未承認でも旧publicationを残さず、成功時に再作成する', async () => {
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const first = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '先頭に残る設計メモ' });
    const second = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 2,
      role: 'assistant',
      text: '非先頭でprogress_onlyへ再分類される実装メモ',
    });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: first.buildJobId, config })).status,
      'completed',
      '最初のbuild_documentsがcompletedでない',
    );
    assert.equal(
      (await runBuildJob(pool, { buildJobId: second.buildJobId, config })).status,
      'completed',
      '後続のbuild_documentsがcompletedでない',
    );
    const document = (await readDocuments(pool, workspace.projectId))[0];
    assert.ok(document, 'A+Bの公開文書がない');
    assert.ok(
      (await readPublications(pool, workspace.projectId)).some(
        (publication) => publication.documentId === document.id && !publication.stale,
      ),
      'A+Bの公開publicationがない',
    );

    // 非先頭Bだけをprogress_onlyへ再分類し、Voyage未承認のまま再buildする。
    await upsertAnalysis(pool, {
      messageId: second.messageId,
      revision: second.revision,
      retention: 'progress_only',
      isSearchable: false,
    });
    await pool.query(
      `UPDATE provider_policy_approvals SET active = false, updated_at = now() WHERE company_id = $1 AND provider = $2`,
      [workspace.companyId, VOYAGE_PROVIDER],
    );
    const requestsBefore = server.requests.length;
    await reopenJob(pool, second.buildJobId);
    const blocked = await runBuildJob(pool, { buildJobId: second.buildJobId, config });
    assert.equal(blocked.status, 'blocked_policy', `未承認の再buildがblocked_policyでない: ${blocked.status}/${blocked.errorCode ?? ''}`);
    assert.equal(server.requests.length, requestsBefore, 'Voyage未承認なのに送信している');

    const blockedDocument = (await readDocuments(pool, workspace.projectId)).find((item) => item.id === document.id);
    assert.ok(blockedDocument, '再分類後もdocumentが消えた');
    assert.equal(blockedDocument.isSearchable, true, '新desired revision用のis_searchableがfalseになった');
    assert.ok(blockedDocument.desiredRevision > document.desiredRevision, 'desired_revisionが進んでいない');
    assert.equal(
      (await readPublications(pool, workspace.projectId)).filter((publication) => publication.documentId === document.id).length,
      0,
      'Bを含む旧publicationが即時検索不能になっていない',
    );

    // 承認を戻してretryすると、Bを含まない新revisionが公開される。
    await pool.query(
      `UPDATE provider_policy_approvals SET active = true, updated_at = now() WHERE company_id = $1 AND provider = $2`,
      [workspace.companyId, VOYAGE_PROVIDER],
    );
    assert.equal(await retryJob(pool, second.buildJobId, config), true, 'Voyage承認後にretryできない');
    const retried = await runBuildJob(pool, { buildJobId: second.buildJobId, config });
    assert.equal(retried.status, 'completed', `retry後のbuild_documentsがcompletedでない: ${retried.status}/${retried.errorCode ?? ''}`);
    const publication = (await readPublications(pool, workspace.projectId)).find(
      (item) => item.documentId === document.id && !item.stale,
    );
    assert.ok(publication, '成功後にpublicationが再作成されていない');
    assert.equal(publication.revision, blockedDocument.desiredRevision, '再作成された公開revisionがdesired_revisionと違う');
    const publishedTexts = (await readRevisions(pool))
      .filter((revision) => revision.documentId === document.id && revision.revision === publication.revision)
      .map((revision) => revision.text);
    assert.ok(
      publishedTexts.some((text) => compact(text).includes(compact(first.text))),
      '先頭Aの原文が公開revisionにない',
    );
    for (const text of publishedTexts) {
      assert.ok(
        !compact(text).includes(compact(second.text)),
        'progress_onlyへ再分類されたBが公開revisionに残っている',
      );
    }
  });
});

describe('M4 revoke/change relationの索引除外', () => {
  it('現行policyのrevokeで撤回された発言Aは、Voyage未承認でもpublicationごと即時除外される', async () => {
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const revoked = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '撤回対象として公開される発言A' });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: revoked.buildJobId, config })).status,
      'completed',
      '撤回対象Aのbuild_documentsがcompletedでない',
    );
    const document = (await readDocuments(pool, workspace.projectId))[0];
    assert.ok(document, 'Aの公開文書がない');
    assert.ok(
      (await readPublications(pool, workspace.projectId)).some(
        (publication) => publication.documentId === document.id && !publication.stale,
      ),
      'Aの公開publicationがない',
    );

    // 後続BからAの現行revisionへのrevoke relationを保存する。A自身のrevision/analysisは変更しない。
    const revoker = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 2,
      role: 'assistant',
      text: 'Aを撤回する後続発言B',
    });
    await insertMessageRelation(pool, {
      sourceMessageId: revoker.messageId,
      sourceRevision: revoker.revision,
      targetMessageId: revoked.messageId,
      targetRevision: revoked.revision,
      relation: 'revoke',
    });

    // Voyage未承認でも、外部HTTP前の文書plan TXで旧publicationを削除する。
    await pool.query(
      `UPDATE provider_policy_approvals SET active = false, updated_at = now() WHERE company_id = $1 AND provider = $2`,
      [workspace.companyId, VOYAGE_PROVIDER],
    );
    const requestsBefore = server.requests.length;
    const blocked = await runBuildJob(pool, { buildJobId: revoker.buildJobId, config });
    assert.equal(blocked.status, 'blocked_policy', `撤回後の再buildがblocked_policyでない: ${blocked.status}/${blocked.errorCode ?? ''}`);
    assert.equal(server.requests.length, requestsBefore, 'Voyage未承認なのに送信している');

    const afterDocument = (await readDocuments(pool, workspace.projectId)).find((item) => item.id === document.id);
    assert.ok(afterDocument, '撤回後もdocument行が消えた');
    assert.equal(afterDocument.isSearchable, false, '撤回済みAのdocumentがis_searchable=falseでない');
    assert.equal(
      (await readPublications(pool, workspace.projectId)).filter((publication) => publication.documentId === document.id).length,
      0,
      '撤回済みAを含むpublicationが残っている',
    );
    assert.equal(await currentMessageRevision(pool, revoked.messageId), revoked.revision, 'Aのcurrent revisionが変わった');
    assert.equal(await messageRevisionText(pool, revoked.messageId, revoked.revision), revoked.text, 'Aの原文が消えた');
    const relations = await pool.query<{ relation: string }>(
      'SELECT relation FROM message_relations WHERE target_message_id = $1',
      [revoked.messageId],
    );
    assert.equal(relations.rows.length, 1, 'relationが保持されていない');
    const analysis = await pool.query<{ is_searchable: boolean; retention: string }>(
      'SELECT is_searchable, retention FROM message_analysis WHERE message_id = $1 AND revision = $2',
      [revoked.messageId, revoked.revision],
    );
    assert.equal(analysis.rows[0]?.is_searchable, true, 'Aのanalysisが変更された');
    assert.equal(analysis.rows[0]?.retention, 'substantive', 'Aのretentionが変更された');
  });

  it('現行policyのchange relationも対象messageを索引対象から除外する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const target = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: 'changeの対象になる発言A' });
    const source = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 2,
      role: 'assistant',
      text: 'Aを変更する後続発言B',
    });
    await insertMessageRelation(pool, {
      sourceMessageId: source.messageId,
      sourceRevision: source.revision,
      targetMessageId: target.messageId,
      targetRevision: target.revision,
      relation: 'change',
    });

    const loaded = await loadSessionMessages(pool, sessionId);
    const ids = loaded.messages.map((message) => message.messageId);
    assert.ok(!ids.includes(target.messageId), 'change relationのtargetが索引対象に残っている');
    assert.ok(ids.includes(source.messageId), 'relation sourceの現行Bを誤除外した');
  });

  it('古いsource/target revision・別policy・revoke/change以外のrelationは現行messageを除外しない', async () => {
    const sessionId = await seedSession(pool, workspace);
    const target = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '誤除外されてはならない現行発言A' });
    const source = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 2,
      role: 'assistant',
      text: 'relation sourceになる発言B',
    });

    // 両messageのcurrent revisionを進め、relationの有効revisionと異なる古いrevisionを作る。
    const targetRevision2 = await advanceRevision(pool, target.messageId, '誤除外されてはならない現行発言Aの改訂版');
    await upsertAnalysis(pool, { messageId: target.messageId, revision: targetRevision2 });
    const sourceRevision2 = await advanceRevision(pool, source.messageId, 'relation sourceになる発言Bの改訂版');
    await upsertAnalysis(pool, { messageId: source.messageId, revision: sourceRevision2 });

    // 古いsource revisionからのrevoke。
    await insertMessageRelation(pool, {
      sourceMessageId: source.messageId,
      sourceRevision: source.revision,
      targetMessageId: target.messageId,
      targetRevision: targetRevision2,
      relation: 'revoke',
    });
    // 古いtarget revisionへのrevoke。
    await insertMessageRelation(pool, {
      sourceMessageId: source.messageId,
      sourceRevision: sourceRevision2,
      targetMessageId: target.messageId,
      targetRevision: target.revision,
      relation: 'revoke',
    });
    // 別policy版のrevoke。
    await insertMessageRelation(pool, {
      sourceMessageId: source.messageId,
      sourceRevision: sourceRevision2,
      targetMessageId: target.messageId,
      targetRevision: targetRevision2,
      relation: 'revoke',
      policyVersion: 'older-policy',
    });
    // revoke/change以外のrelation。
    await insertMessageRelation(pool, {
      sourceMessageId: source.messageId,
      sourceRevision: sourceRevision2,
      targetMessageId: target.messageId,
      targetRevision: targetRevision2,
      relation: 'accept',
    });
    // 別案件・別会社のsource messageからのrevoke。
    const otherWorkspace = await seedWorkspace(pool, {
      name: 'company-relation-boundary',
      repositoryIdentifier: 'repo-relation-boundary',
    });
    const otherSessionId = await seedSession(pool, otherWorkspace);
    const otherSource = await seedMessage(pool, { sessionId: otherSessionId, sequenceNo: 1, text: '別案件からの撤回元' });
    await insertMessageRelation(pool, {
      sourceMessageId: otherSource.messageId,
      sourceRevision: otherSource.revision,
      targetMessageId: target.messageId,
      targetRevision: targetRevision2,
      relation: 'revoke',
    });

    const loaded = await loadSessionMessages(pool, sessionId);
    const current = loaded.messages.find((message) => message.messageId === target.messageId);
    assert.ok(current, '古い/別policy/対象外relationで現行Aを誤除外した');
    assert.equal(current.revision, targetRevision2, 'Aの現行revisionでない');
    assert.ok(
      loaded.messages.some((message) => message.messageId === source.messageId),
      'relation sourceの現行Bまで除外した',
    );
  });

  it('snapshot後に有効revoke relationを追加したapplyDocumentPlanはStaleApplyErrorで文書状態を変えない', async () => {
    const { config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const target = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 1,
      text: 'snapshot後に撤回relationが追加される発言A',
    });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: target.buildJobId, config })).status,
      'completed',
      'snapshot対象Aのbuild_documentsがcompletedでない',
    );
    const source = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 2,
      role: 'assistant',
      text: '撤回relationを追加する発言B',
    });
    const job = await claimBuildJob(pool, source.buildJobId);
    const before = await loadSessionMessages(pool, sessionId);
    const chunks = await planDocumentChunks(sessionId, before.messages);

    await insertMessageRelation(pool, {
      sourceMessageId: source.messageId,
      sourceRevision: source.revision,
      targetMessageId: target.messageId,
      targetRevision: target.revision,
      relation: 'revoke',
    });
    const stateBefore = await snapshotSearchState(pool, workspace.projectId);
    await assert.rejects(
      applyDocumentPlan(
        pool,
        job,
        { companyId: workspace.companyId, projectId: workspace.projectId, sessionId },
        before.snapshot,
        chunks,
      ),
      (error: unknown) => error instanceof StaleApplyError,
      'relation追加後のplan適用がStaleApplyErrorで拒否されない',
    );
    assert.deepEqual(
      await snapshotSearchState(pool, workspace.projectId),
      stateBefore,
      'relation追加後の旧plan適用が文書状態を変えた',
    );
  });
});

describe('M4 VoyageEmbeddingProviderの送信契約と応答検証', () => {
  it('voyage-4-lite/document/1024/float/truncation=falseで送信し、index順に対応する1024次元vectorだけを保存する', async () => {
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const first = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: 'Voyage契約を確認する文書A' });
    const second = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 2,
      role: 'assistant',
      text: 'Voyage契約を確認する文書B',
    });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: first.buildJobId, config })).status,
      'completed',
      '最初のbuild_documentsがcompletedでない',
    );
    assert.equal(
      (await runBuildJob(pool, { buildJobId: second.buildJobId, config })).status,
      'completed',
      '後続のbuild_documentsがcompletedでない',
    );
    assert.ok(server.requests.length >= 1, 'Voyageへ送信していない');

    for (const recorded of server.requests) {
      assert.equal(recorded.method, 'POST', 'Voyageへの送信methodがPOSTでない');
      assert.equal(recorded.url, VOYAGE_PATH, 'Voyageのendpoint pathが違う');
      const body = readVoyageRequest(recorded.body);
      assert.equal(body.model, VOYAGE_MODEL, 'modelがvoyage-4-liteでない');
      assert.equal(body.input_type, 'document', 'input_typeがdocumentでない');
      assert.equal(body.output_dimension, EMBEDDING_DIMENSIONS, 'output_dimensionが1024でない');
      assert.equal(body.output_dtype, 'float', 'output_dtypeがfloatでない');
      assert.equal(body.truncation, false, 'truncationがfalseでない');
      assert.ok(
        Array.isArray(body.input) && body.input.length >= 1 && body.input.every((value) => typeof value === 'string' && value.length > 0),
        'inputが空でない文字列配列でない',
      );
      assert.equal(recorded.headers.authorization, `Bearer ${VOYAGE_KEY}`, 'Bearer credentialで送信していない');
    }

    const revisions = await readRevisions(pool);
    const embeddings = await readEmbeddings(pool);
    for (const recorded of server.requests) {
      const body = readVoyageRequest(recorded.body);
      for (const [index, input] of body.input.entries()) {
        const revision = revisions.find((item) => matchesInput(item.text, input));
        assert.ok(revision, `送信inputに対応する文書revisionがない: ${input.slice(0, 40)}`);
        const embedding = embeddings.find(
          (item) => item.documentId === revision.documentId && item.revision === revision.revision,
        );
        assert.ok(embedding, '送信した文書revisionのembeddingがない');
        assert.equal(embedding.vector.length, EMBEDDING_DIMENSIONS, '保存vectorの次元が1024でない');
        assert.ok(
          Math.abs(embedding.vector[0] - (0.1 + index * 0.1)) < 1e-9,
          `応答index ${index} と保存vectorの対応が違う: ${embedding.vector[0]}`,
        );
      }
    }

    const usage = await readVoyageUsageEvents(pool, workspace.companyId);
    assert.ok(
      usage.some((row) => row.provider === VOYAGE_PROVIDER && row.success === true),
      'Voyageのusage_eventsが記録されていない',
    );
  });

  interface InvalidVectorCase {
    name: string;
    mutate: (reply: VoyageEmbeddingResponse) => VoyageEmbeddingResponse;
  }

  const invalidVectorCases: InvalidVectorCase[] = [
    { name: '件数不足', mutate: (reply) => ({ ...reply, data: [] }) },
    {
      name: 'indexが入力範囲外',
      mutate: (reply) => ({ ...reply, data: reply.data.map((entry) => ({ ...entry, index: 99 })) }),
    },
    {
      name: '1024次元でない',
      mutate: (reply) => ({
        ...reply,
        data: reply.data.map((entry, index) => ({ ...entry, embedding: vectorFor(index, 1023) })),
      }),
    },
    {
      name: '非finite値',
      mutate: (reply) => ({
        ...reply,
        data: reply.data.map((entry, index) => ({
          ...entry,
          embedding: vectorFor(index).map((value, position) => (position === 0 ? Number.NaN : value)),
        })),
      }),
    },
    {
      name: '全ゼロvector',
      mutate: (reply) => ({
        ...reply,
        data: reply.data.map((entry) => ({ ...entry, embedding: new Array<number>(EMBEDDING_DIMENSIONS).fill(0) })),
      }),
    },
    { name: 'model不一致', mutate: (reply) => ({ ...reply, model: 'voyage-3' }) },
  ];

  for (const testCase of invalidVectorCases) {
    it(`Voyage応答の${testCase.name}はfailedとして扱い、vectorも文書も公開しない`, async () => {
      const { server, config } = await startApprovedVoyage(pool, workspace.companyId, (body) => ({
        body: testCase.mutate(validVoyageReply(readVoyageRequest(body).input ?? [])),
      }));
      const sessionId = await seedSession(pool, workspace);
      const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '不正応答の前に保存される原文' });
      const run = await runBuildJob(pool, { buildJobId: message.buildJobId, config });

      assert.ok(server.requests.length >= 1, '不正応答の検証前にVoyageへ送信していない');
      assert.equal(run.status, 'failed', `不正vectorがfailedにならない: ${run.status}`);
      assert.equal(run.errorCode, 'provider_contract_invalid', `契約不正のerror_codeが違う: ${run.errorCode ?? ''}`);
      assert.equal((await readPublications(pool, workspace.projectId)).length, 0, '不正vectorの文書が公開された');
      assert.equal((await readEmbeddings(pool)).length, 0, '不正vectorが保存された');
      const invalidRevisions = await readRevisions(pool);
      assert.ok(
        invalidRevisions.length >= 1 && invalidRevisions.every((revision) => revision.status === 'failed'),
        `恒久契約不正でrevisionがfailedにならない: ${invalidRevisions.map((revision) => revision.status).join(',')}`,
      );
      assert.equal(await messageRevisionText(pool, message.messageId, message.revision), message.text, '失敗時に原文が消えた');
    });
  }
});

describe('M4 学習利用条件の送信ゲート', () => {
  interface ApprovalCase {
    name: string;
    seed?: Partial<VoyageApprovalSeed>;
  }

  const approvalCases: ApprovalCase[] = [
    { name: '承認がない' },
    { name: '承認が失効している', seed: { active: false } },
    { name: '学習利用無効が確認されていない', seed: { learningDisabled: false } },
    { name: '別accountの承認しかない', seed: { accountRef: 'other-acct' } },
    { name: '別endpointの承認しかない', seed: { endpoint: 'https://api.voyageai.com/v1/embeddings' } },
    { name: '規約確認日が未来', seed: { termsCheckedAt: minutesFromNow(10) } },
    { name: '規約確認日が未設定', seed: { termsCheckedAt: null } },
    { name: '確認日が未来', seed: { confirmedAt: minutesFromNow(10) } },
  ];

  for (const testCase of approvalCases) {
    it(`${testCase.name}場合はVoyageへ送信せずblocked_policyにし、原文を保持して公開しない`, async () => {
      const server = await startFakeVoyage(defaultVoyageResponder);
      openServers.push(server);
      const endpoint = `${server.baseUrl}${VOYAGE_PATH}`;
      if (testCase.seed !== undefined) {
        await insertVoyageApproval(pool, { companyId: workspace.companyId, endpoint, ...testCase.seed });
      }
      const config = loadM4WorkerConfig(endpoint);

      const sessionId = await seedSession(pool, workspace);
      const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '承認ゲートの対象になる設計メモ' });
      const run = await runBuildJob(pool, { buildJobId: message.buildJobId, config });

      assert.equal(server.requests.length, 0, '承認条件を満たさないのにVoyageへ送信している');
      assert.equal(run.status, 'blocked_policy', `jobがblocked_policyでない: ${run.status}/${run.errorCode ?? ''}`);
      assert.equal(run.errorCode, 'provider_policy_unverified', `policy停止のerror_codeが違う: ${run.errorCode ?? ''}`);
      assert.equal(
        await messageRevisionText(pool, message.messageId, message.revision),
        message.text,
        '承認停止時に原文が消えた',
      );
      assert.equal((await readPublications(pool, workspace.projectId)).length, 0, '承認停止時に文書が公開された');
      const revisions = await readRevisions(pool);
      assert.ok(revisions.length >= 1, '承認停止時に文書revisionがない');
      assert.ok(
        revisions.every((revision) => revision.status === 'pending' || revision.status === 'embedding'),
        `policy停止でpending revisionがfailedになった: ${revisions.map((revision) => revision.status).join(',')}`,
      );
    });
  }
});

describe('M4 Voyage障害時の再試行と永続失敗', () => {
  interface FailureCase {
    name: string;
    replyStatus?: number;
    delayMs?: number;
    expectedStatus: string;
    expectedCode: string;
    expectedRevisionStatus: string;
    timeoutOverride?: string;
  }

  const failureCases: FailureCase[] = [
    {
      name: '429',
      replyStatus: 429,
      expectedStatus: 'pending',
      expectedCode: 'provider_rate_limited',
      expectedRevisionStatus: 'pending',
    },
    {
      name: '503',
      replyStatus: 503,
      expectedStatus: 'pending',
      expectedCode: 'provider_unavailable',
      expectedRevisionStatus: 'pending',
    },
    {
      name: 'timeout',
      delayMs: 1_000,
      expectedStatus: 'pending',
      expectedCode: 'provider_timeout',
      expectedRevisionStatus: 'pending',
      timeoutOverride: '200',
    },
    {
      name: '400',
      replyStatus: 400,
      expectedStatus: 'failed',
      expectedCode: 'provider_rejected',
      expectedRevisionStatus: 'failed',
    },
    {
      name: '422',
      replyStatus: 422,
      expectedStatus: 'failed',
      expectedCode: 'provider_rejected',
      expectedRevisionStatus: 'failed',
    },
  ];

  for (const testCase of failureCases) {
    it(`Voyageの${testCase.name}は${testCase.expectedStatus}になり、文書を公開しない`, async () => {
      const server = await startFakeVoyage(() => ({
        status: testCase.replyStatus ?? 200,
        body: { detail: `voyage-${testCase.name}` },
        delayMs: testCase.delayMs,
      }));
      openServers.push(server);
      const endpoint = `${server.baseUrl}${VOYAGE_PATH}`;
      await insertVoyageApproval(pool, { companyId: workspace.companyId, endpoint });
      const config = loadM4WorkerConfig(
        endpoint,
        testCase.timeoutOverride === undefined ? {} : { VOYAGE_REQUEST_TIMEOUT_MS: testCase.timeoutOverride },
      );

      const sessionId = await seedSession(pool, workspace);
      const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '障害時に保持される原文' });
      const run = await runBuildJob(pool, { buildJobId: message.buildJobId, config });

      assert.ok(server.requests.length >= 1, 'Voyageへ送信していない');
      assert.equal(run.status, testCase.expectedStatus, `job statusが違う: ${run.status}/${run.errorCode ?? ''}`);
      assert.equal(run.errorCode, testCase.expectedCode, `error_codeが違う: ${run.errorCode ?? ''}`);
      assert.equal((await readPublications(pool, workspace.projectId)).length, 0, '障害時に文書が公開された');
      assert.equal(
        await messageRevisionText(pool, message.messageId, message.revision),
        message.text,
        '障害時に原文が消えた',
      );
      const revisions = await readRevisions(pool);
      assert.ok(revisions.length >= 1, '障害時に文書revisionがない');
      assert.ok(
        revisions.every((revision) => revision.status === testCase.expectedRevisionStatus),
        `revision statusが${testCase.expectedRevisionStatus}でない: ${revisions.map((revision) => revision.status).join(',')}`,
      );
    });
  }
});

describe('M4 外部待ち中の状態変更', () => {
  it('外部待ちの間に原文revisionが変わった応答は保存・公開しない', async () => {
    const gate = deferred();
    let gateArmed = false;
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId, async (body) => {
      const reply = validVoyageReply(readVoyageRequest(body).input ?? []);
      if (gateArmed) {
        await gate.promise;
      }
      return { body: reply };
    });
    const sessionId = await seedSession(pool, workspace);
    const warm = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '先に公開される原文' });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: warm.buildJobId, config })).status,
      'completed',
      '最初のbuild_documentsがcompletedでない',
    );
    const second = await seedSearchableMessage(pool, { sessionId, sequenceNo: 2, text: '応答待ちの対象になる原文' });
    const beforePublications = await readPublications(pool, workspace.projectId);
    const warmRequests = server.requests.length;

    gateArmed = true;
    const job = await claimBuildJob(pool, second.buildJobId);
    const processing = processJob(pool, job, config);
    const sent = await waitUntil(() => server.requests.length > warmRequests, EXTERNAL_WAIT_TIMEOUT_MS);
    if (sent) {
      await advanceRevision(pool, warm.messageId, '外部待ちの間に編集された原文');
      gate.resolve();
    }
    await processing;
    assert.ok(sent, 'Voyage送信まで到達せずbuild_documentsが終了した（M4未実装）');

    const afterPublications = await readPublications(pool, workspace.projectId);
    for (const publication of afterPublications.filter((item) => !item.stale)) {
      assert.ok(
        beforePublications.some(
          (before) =>
            !before.stale &&
            before.documentId === publication.documentId &&
            before.generationId === publication.generationId &&
            before.revision === publication.revision,
        ),
        `外部待ち中の原文変更後に公開revisionが更新された: ${publication.documentId}@${publication.revision}`,
      );
    }
    assert.equal(await messageRevisionText(pool, warm.messageId, 2), '外部待ちの間に編集された原文', '外部待ち中の編集が消えた');
    assert.ok(
      (await readRevisions(pool)).every((revision) => revision.status !== 'failed'),
      'stale応答でrevisionがfailedになった',
    );
  });

  it('外部待ちの間にlease所有を失った応答は保存・公開しない', async () => {
    const gate = deferred();
    let gateArmed = false;
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId, async (body) => {
      const reply = validVoyageReply(readVoyageRequest(body).input ?? []);
      if (gateArmed) {
        await gate.promise;
      }
      return { body: reply };
    });
    const sessionId = await seedSession(pool, workspace);
    const warm = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: 'lease喪失の前に公開される原文' });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: warm.buildJobId, config })).status,
      'completed',
      '最初のbuild_documentsがcompletedでない',
    );
    const second = await seedSearchableMessage(pool, { sessionId, sequenceNo: 2, text: 'lease喪失中の応答対象' });
    const beforePublications = await readPublications(pool, workspace.projectId);
    const warmRequests = server.requests.length;

    gateArmed = true;
    const job = await claimBuildJob(pool, second.buildJobId);
    const processing = processJob(pool, job, config);
    const sent = await waitUntil(() => server.requests.length > warmRequests, EXTERNAL_WAIT_TIMEOUT_MS);
    if (sent) {
      await pool.query('UPDATE jobs SET lease_token = $2, updated_at = now() WHERE id = $1', [job.id, uuidv7()]);
      gate.resolve();
    }
    await processing;
    assert.ok(sent, 'Voyage送信まで到達せずbuild_documentsが終了した（M4未実装）');

    const afterPublications = await readPublications(pool, workspace.projectId);
    for (const publication of afterPublications.filter((item) => !item.stale)) {
      assert.ok(
        beforePublications.some(
          (before) =>
            !before.stale &&
            before.documentId === publication.documentId &&
            before.generationId === publication.generationId &&
            before.revision === publication.revision,
        ),
        `lease喪失後に公開revisionが更新された: ${publication.documentId}@${publication.revision}`,
      );
    }
    assert.notEqual((await readJob(pool, second.buildJobId)).status, 'completed', 'lease喪失後もjobがcompletedになった');
    assert.ok(
      (await readRevisions(pool)).every((revision) => revision.status !== 'failed'),
      'lease喪失でrevisionがfailedになった',
    );
  });

  it('外部待ちの間にdesired_revisionが変わった応答は公開revisionを更新しない', async () => {
    const gate = deferred();
    let gateArmed = false;
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId, async (body) => {
      const reply = validVoyageReply(readVoyageRequest(body).input ?? []);
      if (gateArmed) {
        await gate.promise;
      }
      return { body: reply };
    });
    const sessionId = await seedSession(pool, workspace);
    const warm = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: 'desired変更の前に公開される原文' });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: warm.buildJobId, config })).status,
      'completed',
      '最初のbuild_documentsがcompletedでない',
    );
    const second = await seedSearchableMessage(pool, { sessionId, sequenceNo: 2, text: 'desired変更中の応答対象' });
    const documentsBefore = await readDocuments(pool, workspace.projectId);
    const beforePublications = await readPublications(pool, workspace.projectId);
    const warmRequests = server.requests.length;

    gateArmed = true;
    const job = await claimBuildJob(pool, second.buildJobId);
    const processing = processJob(pool, job, config);
    const sent = await waitUntil(() => server.requests.length > warmRequests, EXTERNAL_WAIT_TIMEOUT_MS);
    let reverted: { id: string; desiredRevision: number } | undefined;
    if (sent) {
      const documentsDuring = await readDocuments(pool, workspace.projectId);
      const advanced = documentsDuring.find((document) => {
        const before = documentsBefore.find((item) => item.id === document.id);
        return before !== undefined && document.desiredRevision > before.desiredRevision;
      });
      assert.ok(advanced, '応答待ち中にdesired_revisionが進んだ文書がない');
      const before = documentsBefore.find((item) => item.id === advanced.id);
      assert.ok(before, 'desired_revisionの比較元がない');
      await pool.query('UPDATE search_documents SET desired_revision = $2 WHERE id = $1', [advanced.id, before.desiredRevision]);
      reverted = { id: advanced.id, desiredRevision: before.desiredRevision };
      gate.resolve();
    }
    await processing;
    assert.ok(sent, 'Voyage送信まで到達せずbuild_documentsが終了した（M4未実装）');
    assert.ok(reverted, 'desired_revisionを戻した文書がない');

    const afterDocuments = await readDocuments(pool, workspace.projectId);
    assert.equal(
      afterDocuments.find((document) => document.id === reverted.id)?.desiredRevision,
      reverted.desiredRevision,
      'desired_revisionが応答で上書きされた',
    );
    const afterPublications = await readPublications(pool, workspace.projectId);
    for (const publication of afterPublications.filter((item) => !item.stale)) {
      assert.ok(
        beforePublications.some(
          (before) =>
            !before.stale &&
            before.documentId === publication.documentId &&
            before.generationId === publication.generationId &&
            before.revision === publication.revision,
        ),
        `desired_revision変更後に公開revisionが更新された: ${publication.documentId}@${publication.revision}`,
      );
    }
  });
});

describe('M4 embedding_cacheと出典分離', () => {
  it('再処理ではembedding_cacheでHTTPを省略し、同文でも別社員・別案件・別会社のsourceとdocumentを統合しない', async () => {
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId);
    const text = '同じ本文でも出典を失わないための共有テスト 🧪';
    const sessionId = await seedSession(pool, workspace);
    const first = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: first.buildJobId, config })).status,
      'completed',
      '最初のbuild_documentsがcompletedでない',
    );
    const httpAfterFirst = server.requests.length;
    assert.equal(httpAfterFirst, 1, `初回のVoyage送信が1件でない: ${httpAfterFirst}`);
    const beforeRerun = await snapshotSearchState(pool, workspace.projectId);

    await reopenJob(pool, first.buildJobId);
    assert.equal(
      (await runBuildJob(pool, { buildJobId: first.buildJobId, config })).status,
      'completed',
      '再処理のbuild_documentsがcompletedでない',
    );
    assert.equal(server.requests.length, httpAfterFirst, '再処理でembedding_cacheのHTTP省略がない');
    assert.deepEqual(await snapshotSearchState(pool, workspace.projectId), beforeRerun, '再処理で文書・revision・原文範囲が変化した');

    const employeeB = await insertEmployee(pool, workspace.companyId, 'employee-b');
    const projectB = await insertProject(pool, workspace.companyId, 'repo-b');
    await addProjectMember(pool, projectB, employeeB);
    const sessionB = await insertSession(pool, { projectId: projectB, employeeId: employeeB });
    const second = await seedSearchableMessage(pool, { sessionId: sessionB, sequenceNo: 1, text });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: second.buildJobId, config })).status,
      'completed',
      '同会社別案件のbuild_documentsがcompletedでない',
    );

    const documentsA = await readDocuments(pool, workspace.projectId);
    const documentsB = await readDocuments(pool, projectB);
    assert.ok(documentsA.length >= 1 && documentsB.length >= 1, '別社員・別案件の文書がない');
    assert.ok(
      documentsA.every((documentA) => documentsB.every((documentB) => documentA.id !== documentB.id)),
      '別案件の文書が同一レコードへ統合された',
    );
    const sources = await readSources(pool);
    const documentIdsA = new Set(documentsA.map((document) => document.id));
    const documentIdsB = new Set(documentsB.map((document) => document.id));
    assert.ok(
      sources.filter((source) => documentIdsA.has(source.documentId)).every((source) => source.messageId === first.messageId),
      '案件Aの文書に別社員・別案件のsourceが混ざった',
    );
    assert.ok(
      sources.filter((source) => documentIdsB.has(source.documentId)).every((source) => source.messageId === second.messageId),
      '案件Bの文書に別社員・別案件のsourceが混ざった',
    );
    assert.deepEqual(await readDocuments(pool, workspace.projectId), documentsA, '別案件の処理で案件Aの文書が変化した');

    const other = await seedWorkspace(pool, { name: 'company-d', repositoryIdentifier: 'repo-d' });
    await insertVoyageApproval(pool, { companyId: other.companyId, endpoint: `${server.baseUrl}${VOYAGE_PATH}` });
    const sessionD = await insertSession(pool, { projectId: other.projectId, employeeId: other.employeeId });
    const third = await seedSearchableMessage(pool, { sessionId: sessionD, sequenceNo: 1, text });
    const httpBeforeOtherCompany = server.requests.length;
    assert.equal(
      (await runBuildJob(pool, { buildJobId: third.buildJobId, config })).status,
      'completed',
      '別会社のbuild_documentsがcompletedでない',
    );
    assert.ok(
      server.requests.length > httpBeforeOtherCompany,
      '別会社でembedding_cacheを流用しVoyage送信を省略した',
    );
    const documentsD = await readDocuments(pool, other.projectId);
    assert.ok(documentsD.length >= 1, '別会社の文書がない');
    assert.ok(
      documentsD.every((document) => document.id !== first.messageId && !documentsA.some((item) => item.id === document.id)),
      '別会社の文書が案件Aへ統合された',
    );

    const cache = await readEmbeddingCacheRows(pool);
    assert.ok(cache.some((row) => row.companyId === workspace.companyId), '会社Aのembedding_cache行がない');
    assert.ok(cache.some((row) => row.companyId === other.companyId), '会社Dのembedding_cache行がない');
    assert.ok(cache.some((row) => row.operation === 'document'), 'document操作のembedding_cache行がない');
  });
});

describe('M4 worker runner', () => {
  it('runWorkerはbuild_documents jobをclaimして世代・文書を作る', async () => {
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: 'runner経由のbuild_documents' });
    const controller = new AbortController();
    const running = runWorker({ pool, config, pollIntervalMs: 20, signal: controller.signal });
    try {
      const completed = await waitUntil(
        async () => (await readJob(pool, message.buildJobId)).status === 'completed',
        BUILD_JOB_TIMEOUT_MS,
      );
      assert.ok(completed, 'runWorkerがbuild_documents jobをclaim・処理していない（pendingのまま等）');
      assert.ok(server.requests.length >= 1, 'runner経由でVoyageへ送信していない');
      const documents = await readDocuments(pool, workspace.projectId);
      assert.ok(documents.length >= 1, 'runner経由で文書が作られていない');
    } finally {
      controller.abort();
      await running;
    }
  });
});

describe('M4 Green追加契約', () => {
  it('embedQueryはinput_type=queryで固定値送信し、同じ入力はcacheから再利用する', async () => {
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId);
    const generation = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const provider = new VoyageEmbeddingProvider(pool, config);
    const vector = await provider.embedQuery('検索質問の本文', generation);

    assert.equal(server.requests.length, 1, 'embedQueryが1回送信していない');
    const body = readVoyageRequest(server.requests[0].body);
    assert.equal(body.input_type, 'query', 'input_typeがqueryでない');
    assert.equal(body.model, VOYAGE_MODEL, 'modelがvoyage-4-liteでない');
    assert.equal(body.output_dimension, EMBEDDING_DIMENSIONS, 'output_dimensionが1024でない');
    assert.equal(body.output_dtype, 'float', 'output_dtypeがfloatでない');
    assert.equal(body.truncation, false, 'truncationがfalseでない');
    assert.deepEqual(body.input, ['検索質問の本文'], 'inputが質問本文と一致しない');
    assert.equal(server.requests[0].headers.authorization, `Bearer ${VOYAGE_KEY}`, 'Bearer credentialでない');
    assert.equal(vector.length, EMBEDDING_DIMENSIONS, 'query vectorの次元が1024でない');
    assert.ok(Math.abs(vector[0] - 0.1) < 1e-9, 'index順のvector対応が違う');

    const cacheRows = await readEmbeddingCacheRows(pool);
    assert.ok(cacheRows.some((row) => row.operation === 'query'), 'query操作のembedding_cache行がない');
    const usage = await readVoyageUsageEvents(pool, workspace.companyId);
    assert.ok(
      usage.some((row) => row.provider === VOYAGE_PROVIDER && row.operation === 'query' && row.success === true),
      'queryのusage_eventsがない',
    );

    const second = await provider.embedQuery('検索質問の本文', generation);
    assert.equal(server.requests.length, 1, '同じ質問でHTTPを省略していない');
    assert.deepEqual(second, vector, 'cache再利用のvectorが違う');
  });

  it('実tokenizerの計測で各revisionは上限内に収まり、隣接chunkが重複windowを持つ', async () => {
    const { config } = await startApprovedVoyage(pool, workspace.companyId);
    const tokenizer = await loadVoyageTokenizer();
    const words = Array.from({ length: 3_000 }, (_, index) => `word${String(index).padStart(4, '0')}`);
    const text = words
      .map((word, index) => (index > 0 && index % 200 === 0 ? `\n\n${word}` : ` ${word}`))
      .join('')
      .trim();
    const sessionId = await seedSession(pool, workspace);
    const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text });
    const run = await runBuildJob(pool, { buildJobId: message.buildJobId, config });
    assert.equal(run.status, 'completed', `boundary fixtureのbuild_documentsがcompletedでない: ${run.status}/${run.errorCode ?? ''}`);

    const revisions = await readRevisions(pool);
    assert.ok(revisions.length >= 2, `3000 tokenの文書が分割されていない: ${revisions.length}`);
    const tokenCounts = revisions.map((revision) => tokenizer.encode(revision.text).ids.length);
    for (const [index, count] of tokenCounts.entries()) {
      assert.ok(count > 0, `revision ${index} が空`);
      assert.ok(
        count + VOYAGE_DOCUMENT_PREFIX_TOKEN_RESERVE <= CHUNK_MAX_TOKENS,
        `revision ${index} が上限1200+prefix予約を超える: ${count}`,
      );
    }
    assert.ok(
      Math.max(...tokenCounts) > CHUNK_TARGET_TOKENS - VOYAGE_DOCUMENT_PREFIX_TOKEN_RESERVE - 50,
      `目標800 token近傍まで使っていない: max=${Math.max(...tokenCounts)}`,
    );

    const spans = await readSources(pool);
    const messageSpans = spans.filter((span) => span.messageId === message.messageId && span.messageRevision === message.revision);
    assertCoverage(messageSpans, text.length, 'tokenizer境界fixture');

    const groups = new Map<string, SourceSpan[]>();
    for (const span of messageSpans) {
      const key = revisionKey(span.documentId, span.revision);
      groups.set(key, [...(groups.get(key) ?? []), span]);
    }
    const ordered = [...groups.values()]
      .map((revisionSpans) => ({
        start: Math.min(...revisionSpans.map((span) => span.start)),
        end: Math.max(...revisionSpans.map((span) => span.end)),
      }))
      .sort((left, right) => left.start - right.start);
    for (let index = 1; index < ordered.length; index += 1) {
      assert.ok(ordered[index].start < ordered[index - 1].end, `隣接chunkに重複windowがない: ${ordered[index].start} >= ${ordered[index - 1].end}`);
    }
  });

  it('改行なしの長文も全chunkが上限内で正のoverlapを持ち、chunk全体を複製しない', async () => {
    const { config } = await startApprovedVoyage(pool, workspace.companyId);
    const tokenizer = await loadVoyageTokenizer();
    const words = Array.from({ length: 4_000 }, (_, index) => `token${String(index).padStart(4, '0')}`);
    const text = words.join(' ');
    assert.ok(!text.includes('\n'), 'fixtureに改行がある');
    const sessionId = await seedSession(pool, workspace);
    const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text });
    const run = await runBuildJob(pool, { buildJobId: message.buildJobId, config });
    assert.equal(run.status, 'completed', `改行なし長文のbuild_documentsがcompletedでない: ${run.status}/${run.errorCode ?? ''}`);

    const revisions = await readRevisions(pool);
    assert.ok(revisions.length >= 2, `改行なし長文が複数chunkへ分割されていない: ${revisions.length}`);
    for (const [index, revision] of revisions.entries()) {
      const count = tokenizer.encode(revision.text).ids.length;
      assert.ok(count > 0, `chunk ${index} が空`);
      assert.ok(
        count + VOYAGE_DOCUMENT_PREFIX_TOKEN_RESERVE <= CHUNK_MAX_TOKENS,
        `chunk ${index} が上限1200+prefix予約を超える: ${count}`,
      );
    }

    const spans = await readSources(pool);
    const messageSpans = spans.filter((span) => span.messageId === message.messageId && span.messageRevision === message.revision);
    assertCoverage(messageSpans, text.length, '改行なし長文');

    const groups = new Map<string, SourceSpan[]>();
    for (const span of messageSpans) {
      const key = revisionKey(span.documentId, span.revision);
      groups.set(key, [...(groups.get(key) ?? []), span]);
    }
    const ordered = [...groups.values()]
      .map((revisionSpans) => ({
        start: Math.min(...revisionSpans.map((span) => span.start)),
        end: Math.max(...revisionSpans.map((span) => span.end)),
        total: totalSpanLength(revisionSpans),
      }))
      .sort((left, right) => left.start - right.start);
    assert.ok(ordered.length >= 2, `source rangeから複数chunkを確認できない: ${ordered.length}`);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      const overlap = previous.end - current.start;
      assert.ok(overlap > 0, `隣接chunkに正のoverlapがない: ${current.start} >= ${previous.end}`);
      assert.ok(overlap < Math.min(previous.total, current.total), '隣接chunkがchunk全体を複製している');
    }
  });

  it('短い複数partのoverlapと上限近いatomの組合せでもwindowを破棄せず正のoverlapを保つ', async () => {
    const { config } = await startApprovedVoyage(pool, workspace.companyId);
    const tokenizer = await loadVoyageTokenizer();
    const paragraph = exactTokenText(tokenizer, 50);
    const longPiece = exactTokenText(tokenizer, 1067);
    const longLine = [longPiece, longPiece, longPiece].join(' ');
    const text = `${paragraph}\n\n${paragraph}\n\n${longLine}`;
    const sessionId = await seedSession(pool, workspace);
    const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text });
    const run = await runBuildJob(pool, { buildJobId: message.buildJobId, config });
    assert.equal(run.status, 'completed', `複数part overlap fixtureのbuild_documentsがcompletedでない: ${run.status}/${run.errorCode ?? ''}`);

    const revisions = await readRevisions(pool);
    assert.ok(revisions.length >= 3, `複数part overlap fixtureが複数chunkへ分割されていない: ${revisions.length}`);
    for (const [index, revision] of revisions.entries()) {
      const count = tokenizer.encode(revision.text).ids.length;
      assert.ok(count > 0, `chunk ${index} が空`);
      assert.ok(
        count + VOYAGE_DOCUMENT_PREFIX_TOKEN_RESERVE <= CHUNK_MAX_TOKENS,
        `chunk ${index} が上限1200+prefix予約を超える: ${count}`,
      );
    }

    const spans = await readSources(pool);
    const messageSpans = spans.filter((span) => span.messageId === message.messageId && span.messageRevision === message.revision);
    assertCoverage(messageSpans, text.length, '複数part overlap fixture');

    const groups = new Map<string, SourceSpan[]>();
    for (const span of messageSpans) {
      const key = revisionKey(span.documentId, span.revision);
      groups.set(key, [...(groups.get(key) ?? []), span]);
    }
    const ordered = [...groups.values()]
      .map((revisionSpans) => ({
        start: Math.min(...revisionSpans.map((span) => span.start)),
        end: Math.max(...revisionSpans.map((span) => span.end)),
        total: totalSpanLength(revisionSpans),
        overlapSources: revisionSpans.filter((span) => span.sourceKind === 'overlap').length,
      }))
      .sort((left, right) => left.start - right.start);
    assert.ok(ordered.length >= 3, `source rangeから複数chunkを確認できない: ${ordered.length}`);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      const overlap = previous.end - current.start;
      assert.ok(overlap > 0, `隣接chunkに正のoverlapがない: ${current.start} >= ${previous.end}`);
      assert.ok(overlap < Math.min(previous.total, current.total), '隣接chunkがchunk全体を複製している');
    }
    assert.ok(
      ordered.some((group) => group.overlapSources >= 2),
      '複数partからなるoverlap windowが保持されていない',
    );
  });

  it('短い先行chunk全体をoverlapせず、上限内なら次atomと1文書へ結合する', async () => {
    const { config } = await startApprovedVoyage(pool, workspace.companyId);
    const tokenizer = await loadVoyageTokenizer();
    const shortParagraph = exactTokenText(tokenizer, 50);
    const longParagraph = exactTokenText(tokenizer, 900);
    const text = `${shortParagraph}\n\n${longParagraph}`;
    const messageId = uuidv7();
    const chunks = await planDocumentChunks('short-overlap-session', [
      { messageId, revision: 1, text },
    ]);

    assert.equal(chunks.length, 1, `短い先行chunkが次atomと結合されていない: ${chunks.length}`);
    assert.ok(chunks[0].sources.every((source) => source.sourceKind === 'original'), '1文書内に不要なoverlap sourceがある');
    assert.ok(
      tokenizer.encode(chunks[0].content).ids.length + VOYAGE_DOCUMENT_PREFIX_TOKEN_RESERVE <= CHUNK_MAX_TOKENS,
      '結合後の文書がprovider prefix込み上限を超える',
    );

    const sessionId = await seedSession(pool, workspace);
    const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text });
    const run = await runBuildJob(pool, { buildJobId: message.buildJobId, config });
    assert.equal(run.status, 'completed', `短い先行chunkの結合後にbuild_documentsが完了しない: ${run.status}/${run.errorCode ?? ''}`);
    assert.equal((await readDocuments(pool, workspace.projectId)).length, 1, '結合後も複数の検索文書として保存されている');
  });

  it('active generationがconfigとspec不一致なら自動切替せず恒久エラーにする', async () => {
    const server = await startFakeVoyage(defaultVoyageResponder);
    openServers.push(server);
    const endpoint = `${server.baseUrl}${VOYAGE_PATH}`;
    const config = loadM4WorkerConfig(endpoint);
    const generationId = await insertGeneration(pool, {
      companyId: workspace.companyId,
      overrides: { endpoint: `https://api.voyageai.com${VOYAGE_PATH}`, dimensions: 768 },
    });
    await pool.query('UPDATE projects SET active_generation_id = $2 WHERE id = $1', [workspace.projectId, generationId]);

    const sessionId = await seedSession(pool, workspace);
    const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '世代不一致の対象になる設計メモ' });
    const run = await runBuildJob(pool, { buildJobId: message.buildJobId, config });

    assert.equal(run.status, 'failed', `spec不一致がfailedにならない: ${run.status}`);
    assert.equal(run.errorCode, 'embedding_generation_mismatch', `spec不一致のerror_codeが違う: ${run.errorCode ?? ''}`);
    assert.equal(server.requests.length, 0, 'spec不一致なのにVoyageへ送信している');
    assert.equal((await readPublications(pool, workspace.projectId)).length, 0, 'spec不一致で文書が公開された');
  });

  it('承認失効後はcache hit可能でもHTTPを送らずblocked_policyにし、cacheから公開しない', async () => {
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: 'cacheとpolicy再確認の対象' });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: message.buildJobId, config })).status,
      'completed',
      '最初のbuild_documentsがcompletedでない',
    );
    const cacheBefore = await readEmbeddingCacheRows(pool);
    assert.ok(cacheBefore.length >= 1, '再利用可能なcache行がない');

    await pool.query(
      `UPDATE provider_policy_approvals SET active = false, updated_at = now() WHERE company_id = $1 AND provider = $2`,
      [workspace.companyId, VOYAGE_PROVIDER],
    );
    // 同じcontentのrevisionをpendingへ戻し、cache-hitになり得る再処理を作る。
    await pool.query(
      `UPDATE search_document_revisions
          SET status = 'pending'
        WHERE document_id IN (SELECT id FROM search_documents WHERE project_id = $1)`,
      [workspace.projectId],
    );
    const requestsBefore = server.requests.length;
    await reopenJob(pool, message.buildJobId);
    const rerun = await runBuildJob(pool, { buildJobId: message.buildJobId, config });

    assert.equal(rerun.status, 'blocked_policy', `承認失効後のjobがblocked_policyでない: ${rerun.status}/${rerun.errorCode ?? ''}`);
    assert.equal(rerun.errorCode, 'provider_policy_unverified', `policy停止のerror_codeが違う: ${rerun.errorCode ?? ''}`);
    assert.equal(server.requests.length, requestsBefore, '承認失効後にVoyageへ送信している');
    assert.ok((await readEmbeddingCacheRows(pool)).length >= cacheBefore.length, 'cache行が消えた');
  });

  it('retryJobはbuild_documentsにVoyage承認だけを使い、Jev承認では再開しない', async () => {
    const server = await startFakeVoyage(defaultVoyageResponder);
    openServers.push(server);
    const endpoint = `${server.baseUrl}${VOYAGE_PATH}`;
    const config = loadM4WorkerConfig(endpoint);
    const sessionId = await seedSession(pool, workspace);
    const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: 'retry対象のbuild_documents' });
    const blocked = await runBuildJob(pool, { buildJobId: message.buildJobId, config });
    assert.equal(blocked.status, 'blocked_policy', `未承認のbuild_documentsがblocked_policyでない: ${blocked.status}`);

    // Jev承認だけではVoyage jobを再開しない。
    await insertVoyageApproval(pool, {
      companyId: workspace.companyId,
      endpoint: config.apiUrl,
      provider: JEV_PROVIDER,
      accountRef: config.accountRef,
    });
    assert.equal(await retryJob(pool, message.buildJobId, config), false, 'Jev承認でVoyage jobを再開した');

    await insertVoyageApproval(pool, { companyId: workspace.companyId, endpoint });
    assert.equal(await retryJob(pool, message.buildJobId, config), true, 'Voyage承認で再開できない');
    assert.equal((await readJob(pool, message.buildJobId)).status, 'pending', 'retry後にpendingでない');

    const retried = await runBuildJob(pool, { buildJobId: message.buildJobId, config });
    assert.equal(retried.status, 'completed', `retry後のbuild_documentsがcompletedでない: ${retried.status}/${retried.errorCode ?? ''}`);
    assert.ok(server.requests.length >= 1, 'retry後にVoyageへ送信していない');
    const publications = await readPublications(pool, workspace.projectId);
    assert.ok(publications.some((publication) => !publication.stale), 'retry後に文書が公開されていない');
  });
});

describe('M4 監査修正契約', () => {
  it('先頭message編集後もdocument_keyは不変で、同じdocumentの新revisionになる', async () => {
    const { config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const first = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '編集前の先頭になる短い設計メモ' });
    const second = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 2,
      role: 'assistant',
      text: '後続の短い実装メモ',
    });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: first.buildJobId, config })).status,
      'completed',
      '最初のbuild_documentsがcompletedでない',
    );
    assert.equal(
      (await runBuildJob(pool, { buildJobId: second.buildJobId, config })).status,
      'completed',
      '後続のbuild_documentsがcompletedでない',
    );
    const documentsBefore = await readDocuments(pool, workspace.projectId);
    const revisionsBefore = await readRevisions(pool);
    assert.equal(documentsBefore.length, 1, `短い2発言が同一文書へまとまっていない: ${documentsBefore.length}`);

    const edited = '編集後の先頭になる短い設計メモ';
    const revision2 = await advanceRevision(pool, first.messageId, edited);
    await upsertAnalysis(pool, { messageId: first.messageId, revision: revision2 });
    const editJobId = await enqueueBuildJob(pool, {
      sessionId,
      messageId: first.messageId,
      revision: revision2,
      retention: 'substantive',
      isSearchable: true,
    });
    const run = await runBuildJob(pool, { buildJobId: editJobId, config });
    assert.equal(run.status, 'completed', `編集後のbuild_documentsがcompletedでない: ${run.status}/${run.errorCode ?? ''}`);

    const documentsAfter = await readDocuments(pool, workspace.projectId);
    assert.equal(documentsAfter.length, documentsBefore.length, 'document_keyへrevision番号を含めたため別documentへ増殖した');
    assert.deepEqual(
      [...documentsAfter].map((document) => document.id).sort(),
      [...documentsBefore].map((document) => document.id).sort(),
      '同じsearch_documents.idが維持されていない',
    );
    assert.deepEqual(
      [...documentsAfter].map((document) => document.documentKey).sort(),
      [...documentsBefore].map((document) => document.documentKey).sort(),
      'document_keyが編集で変化した',
    );
    const newRevisions = (await readRevisions(pool)).filter(
      (revision) =>
        !revisionsBefore.some((before) => before.documentId === revision.documentId && before.revision === revision.revision),
    );
    assert.equal(newRevisions.length, 1, `同じdocumentの新revisionが1件でない: ${newRevisions.length}`);
    assert.equal(newRevisions[0].documentId, documentsBefore[0].id, '新revisionが別documentへ増殖した');
    assert.ok(compact(newRevisions[0].text).includes(compact(edited)), '編集後の本文が新revisionにない');
  });

  for (const status of ['retired', 'failed'] as const) {
    it(`active generationが${status}なら自動切替せずHTTP 0件で恒久失敗する`, async () => {
      const server = await startFakeVoyage(defaultVoyageResponder);
      openServers.push(server);
      const endpoint = `${server.baseUrl}${VOYAGE_PATH}`;
      const config = loadM4WorkerConfig(endpoint);
      const generationId = await insertGeneration(pool, {
        companyId: workspace.companyId,
        overrides: { endpoint, status },
      });
      await pool.query('UPDATE projects SET active_generation_id = $2 WHERE id = $1', [workspace.projectId, generationId]);

      const sessionId = await seedSession(pool, workspace);
      const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: `${status}世代の対象` });
      const run = await runBuildJob(pool, { buildJobId: message.buildJobId, config });

      assert.equal(run.status, 'failed', `${status}世代がfailedにならない: ${run.status}`);
      assert.equal(run.errorCode, 'embedding_generation_mismatch', `${status}世代のerror_codeが違う: ${run.errorCode ?? ''}`);
      assert.equal(server.requests.length, 0, `${status}世代なのにVoyageへ送信している`);
      assert.equal((await readPublications(pool, workspace.projectId)).length, 0, `${status}世代で文書が公開された`);
    });
  }

  it('headers受信後のbody read timeoutはprovider_timeoutとしてretryableにする', async () => {
    const server = await startFakeVoyage((body) => ({
      status: 200,
      body: validVoyageReply(readVoyageRequest(body).input ?? []),
      bodyDelayMs: 1_000,
    }));
    openServers.push(server);
    const endpoint = `${server.baseUrl}${VOYAGE_PATH}`;
    await insertVoyageApproval(pool, { companyId: workspace.companyId, endpoint });
    const config = loadM4WorkerConfig(endpoint, { VOYAGE_REQUEST_TIMEOUT_MS: '250' });

    const sessionId = await seedSession(pool, workspace);
    const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: 'body遅延のtimeout対象' });
    const run = await runBuildJob(pool, { buildJobId: message.buildJobId, config });

    assert.ok(server.requests.length >= 1, 'Voyageへ送信していない');
    assert.equal(run.status, 'pending', `body timeoutがretryableでない: ${run.status}/${run.errorCode ?? ''}`);
    assert.equal(run.errorCode, 'provider_timeout', `body timeoutのerror_codeが違う: ${run.errorCode ?? ''}`);
    const revisions = await readRevisions(pool);
    assert.ok(revisions.length >= 1 && revisions.every((revision) => revision.status === 'pending'), 'body timeoutでrevisionがfailedになった');
    assert.equal((await readPublications(pool, workspace.projectId)).length, 0, 'body timeoutで文書が公開された');
  });

  it('Retry-Afterはdelta-secondsとHTTP-dateの両方をbackoffへ反映する', async () => {
    const deltaServer = await startFakeVoyage(() => ({
      status: 429,
      headers: { 'retry-after': '2' },
      body: { detail: 'rate limited' },
    }));
    openServers.push(deltaServer);
    const deltaEndpoint = `${deltaServer.baseUrl}${VOYAGE_PATH}`;
    await insertVoyageApproval(pool, { companyId: workspace.companyId, endpoint: deltaEndpoint });
    const deltaConfig = loadM4WorkerConfig(deltaEndpoint);
    const deltaSessionId = await seedSession(pool, workspace);
    const deltaMessage = await seedSearchableMessage(pool, {
      sessionId: deltaSessionId,
      sequenceNo: 1,
      text: 'delta-secondsの再試行対象',
    });
    const deltaRun = await runBuildJob(pool, { buildJobId: deltaMessage.buildJobId, config: deltaConfig });
    assert.equal(deltaRun.status, 'pending', `delta-secondsの429がpendingでない: ${deltaRun.status}`);
    assert.equal(deltaRun.errorCode, 'provider_rate_limited');
    const deltaDelayMs = (await readJob(pool, deltaMessage.buildJobId)).next_run_at.getTime() - Date.now();
    assert.ok(deltaDelayMs >= 1_000 && deltaDelayMs <= 15_000, `Retry-After(秒)が反映されていない: ${deltaDelayMs}`);

    const dateServer = await startFakeVoyage(() => ({
      status: 429,
      headers: { 'retry-after': new Date(Date.now() + 60_000).toUTCString() },
      body: { detail: 'rate limited' },
    }));
    openServers.push(dateServer);
    const dateEndpoint = `${dateServer.baseUrl}${VOYAGE_PATH}`;
    // endpointごとにactive generationが固定されるため、HTTP-date側は別会社・別projectで検証する。
    const dateWorkspace = await seedWorkspace(pool, { name: 'company-retry-date', repositoryIdentifier: 'repo-retry-date' });
    await insertVoyageApproval(pool, { companyId: dateWorkspace.companyId, endpoint: dateEndpoint });
    const dateConfig = loadM4WorkerConfig(dateEndpoint);
    const dateSessionId = await seedSession(pool, dateWorkspace);
    const dateMessage = await seedSearchableMessage(pool, {
      sessionId: dateSessionId,
      sequenceNo: 1,
      text: 'HTTP-dateの再試行対象',
    });
    const dateRun = await runBuildJob(pool, { buildJobId: dateMessage.buildJobId, config: dateConfig });
    assert.equal(dateRun.status, 'pending', `HTTP-dateの429がpendingでない: ${dateRun.status}`);
    assert.equal(dateRun.errorCode, 'provider_rate_limited');
    const dateDelayMs = (await readJob(pool, dateMessage.buildJobId)).next_run_at.getTime() - Date.now();
    assert.ok(dateDelayMs >= 30_000 && dateDelayMs <= 90_000, `Retry-After(HTTP-date)が反映されていない: ${dateDelayMs}`);
  });

  it('新revisionのembedding待ち中は既存公開revisionをstaleにし、公開時にsupersededへする', async () => {
    const gate = deferred();
    let gateArmed = false;
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId, async (body) => {
      const reply = validVoyageReply(readVoyageRequest(body).input ?? []);
      if (gateArmed) {
        await gate.promise;
      }
      return { body: reply };
    });
    const sessionId = await seedSession(pool, workspace);
    const warm = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '先に公開されるstale対象' });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: warm.buildJobId, config })).status,
      'completed',
      '最初のbuild_documentsがcompletedでない',
    );
    const warmRevisions = await readRevisions(pool);
    const warmReady = warmRevisions.find((revision) => revision.status === 'ready');
    assert.ok(warmReady, '最初のready revisionがない');

    const second = await seedSearchableMessage(pool, { sessionId, sequenceNo: 2, text: 'stale中に追加される発言' });
    const warmRequests = server.requests.length;
    gateArmed = true;
    const job = await claimBuildJob(pool, second.buildJobId);
    const processing = processJob(pool, job, config);
    const sent = await waitUntil(() => server.requests.length > warmRequests, EXTERNAL_WAIT_TIMEOUT_MS);
    if (!sent) {
      await processing;
    }
    assert.ok(sent, 'Voyage送信まで到達せず、embedding待ち中のstaleを確認できない');

    const duringPublications = await readPublications(pool, workspace.projectId);
    const duringWarm = duringPublications.find(
      (publication) => publication.documentId === warmReady.documentId && publication.revision === warmReady.revision,
    );
    assert.ok(duringWarm, 'embedding待ち中に旧公開revisionがない');
    assert.equal(duringWarm.stale, true, 'embedding待ち中に旧公開revisionがstale=trueでない');

    gate.resolve();
    await processing;
    const afterRevisions = await readRevisions(pool);
    const superseded = afterRevisions.find(
      (revision) => revision.documentId === warmReady.documentId && revision.revision === warmReady.revision,
    );
    assert.equal(superseded?.status, 'superseded', '公開後に以前のready revisionがsupersededでない');
    const afterPublications = await readPublications(pool, workspace.projectId);
    const published = afterPublications.find((publication) => publication.documentId === warmReady.documentId && !publication.stale);
    assert.ok(published, '新revisionが公開されていない');
    assert.ok(published.revision > warmReady.revision, '公開revisionが進んでいない');
  });

  it('同じrevisionのcontent_hashが別jobで置換された後の恒久失敗は新hashをfailedにしない', async () => {
    const gate = deferred();
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId, async (body) => {
      const reply = validVoyageReply(readVoyageRequest(body).input ?? []);
      await gate.promise;
      return { body: { ...reply, model: 'voyage-3' } };
    });
    const sessionId = await seedSession(pool, workspace);
    const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '置換前の本文' });
    const job = await claimBuildJob(pool, message.buildJobId);
    const processing = processJob(pool, job, config);
    const sent = await waitUntil(() => server.requests.length >= 1, EXTERNAL_WAIT_TIMEOUT_MS);
    if (!sent) {
      gate.resolve();
      await processing;
    }
    assert.ok(sent, 'Voyage送信まで到達せず、content_hash置換競合を再現できない');

    const document = (await readDocuments(pool, workspace.projectId))[0];
    assert.ok(document, '対象文書がない');
    const revision = document.desiredRevision;

    // 別jobが同じdocument_id/revision/desired_revisionのcontent/sourceを新hashへ置換する。
    const edited = '別jobが置換した本文';
    const editedRevision = await advanceRevision(pool, message.messageId, edited);
    await upsertAnalysis(pool, { messageId: message.messageId, revision: editedRevision });
    const replacementJobId = await enqueueBuildJob(pool, {
      sessionId,
      messageId: message.messageId,
      revision: editedRevision,
      retention: 'substantive',
      isSearchable: true,
    });
    const replacementJob = await claimBuildJob(pool, replacementJobId);
    const plan = await loadSessionMessages(pool, sessionId);
    const chunks = await planDocumentChunks(sessionId, plan.messages);
    await applyDocumentPlan(
      pool,
      replacementJob,
      { companyId: workspace.companyId, projectId: workspace.projectId, sessionId },
      plan.snapshot,
      chunks,
    );

    gate.resolve();
    await processing;

    assert.equal((await readJob(pool, message.buildJobId)).status, 'failed', '恒久契約不正がfailedでない');
    const revisions = await readRevisions(pool);
    const replaced = revisions.find((item) => item.documentId === document.id && item.revision === revision);
    assert.ok(replaced, '置換されたrevisionがない');
    assert.equal(replaced.status, 'pending', '旧hashの恒久失敗が新hashのrevisionをfailedに巻き込んだ');
    assert.ok(compact(replaced.text).includes(compact(edited)), '新hashのcontentが保持されていない');
    assert.ok(
      revisions.every((item) => item.status !== 'failed'),
      `新hash revisionがfailedになった: ${revisions.map((item) => item.status).join(',')}`,
    );
  });

  it('恒久エラーのfailed更新はjobのpending revisionに限定し、desiredが変わったrevisionを巻き込まない', async () => {
    const gate = deferred();
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId, async (body) => {
      const reply = validVoyageReply(readVoyageRequest(body).input ?? []);
      await gate.promise;
      return { body: { ...reply, model: 'voyage-3' } };
    });
    const sessionId = await seedSession(pool, workspace);
    const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '限定更新の対象' });
    const job = await claimBuildJob(pool, message.buildJobId);
    const processing = processJob(pool, job, config);
    const sent = await waitUntil(() => server.requests.length >= 1, EXTERNAL_WAIT_TIMEOUT_MS);
    if (!sent) {
      await processing;
    }
    assert.ok(sent, 'Voyage送信まで到達せず、限定更新を確認できない');

    const document = (await readDocuments(pool, workspace.projectId))[0];
    const latest = (await readRevisions(pool)).find((revision) => revision.documentId === document.id);
    assert.ok(latest, '対象revisionがない');
    // 応答待ち中に別の新しいrevisionがdesiredになり、旧revisionはこのjobの対象でなくなる。
    await pool.query(
      `INSERT INTO search_document_revisions (document_id, revision, content, content_hash, chunker_version, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [document.id, latest.revision + 1, '別jobが作る内容', sha256Bytes('別jobが作る内容'), latest.chunkerVersion],
    );
    await pool.query('UPDATE search_documents SET desired_revision = $2, updated_at = now() WHERE id = $1', [
      document.id,
      latest.revision + 1,
    ]);
    gate.resolve();
    await processing;

    assert.equal((await readJob(pool, message.buildJobId)).status, 'failed', '恒久契約不正がfailedでない');
    const after = await readRevisions(pool);
    assert.equal(
      after.find((revision) => revision.documentId === document.id && revision.revision === latest.revision)?.status,
      'pending',
      'desiredが変わったrevisionをfailedに巻き込んだ',
    );
    assert.equal(
      after.find((revision) => revision.documentId === document.id && revision.revision === latest.revision + 1)?.status,
      'pending',
      'このjobのpending listにないrevisionをfailedにした',
    );
  });

  it('恒久契約不正のrevisionはfailedになり、明示retryで同じrevisionを再埋め込みしてjobを空完了しない', async () => {
    let invalid = true;
    const { server, config } = await startApprovedVoyage(pool, workspace.companyId, (body) => {
      const reply = validVoyageReply(readVoyageRequest(body).input ?? []);
      return invalid ? { body: { ...reply, model: 'voyage-3' } } : { body: reply };
    });
    const sessionId = await seedSession(pool, workspace);
    const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '再埋め込みretryの対象' });

    const first = await runBuildJob(pool, { buildJobId: message.buildJobId, config });
    assert.equal(first.status, 'failed', `契約不正がfailedにならない: ${first.status}`);
    assert.equal(first.errorCode, 'provider_contract_invalid');
    const failedRevisions = await readRevisions(pool);
    const failedRevision = failedRevisions.find((revision) => revision.status === 'failed');
    assert.ok(failedRevision, `恒久契約不正でrevisionがfailedにならない: ${failedRevisions.map((revision) => revision.status).join(',')}`);
    assert.equal((await readPublications(pool, workspace.projectId)).length, 0, '契約不正で文書が公開された');
    const requestsAfterFailure = server.requests.length;
    assert.ok(requestsAfterFailure >= 1, '契約不正のHTTP送信がない');

    invalid = false;
    assert.equal(await retryJob(pool, message.buildJobId, config), true, 'failed jobをretryできない');
    assert.equal((await readJob(pool, message.buildJobId)).status, 'pending', 'retry後にpendingでない');
    const retried = await runBuildJob(pool, { buildJobId: message.buildJobId, config });
    assert.equal(retried.status, 'completed', `retry後のbuild_documentsがcompletedでない: ${retried.status}/${retried.errorCode ?? ''}`);
    assert.ok(server.requests.length > requestsAfterFailure, 'retry後の再埋め込みHTTP送信がない');
    const retriedRevision = (await readRevisions(pool)).find(
      (revision) => revision.documentId === failedRevision.documentId && revision.revision === failedRevision.revision,
    );
    assert.equal(retriedRevision?.status, 'ready', '同じfailed revisionがreadyへ戻っていない');
    assert.ok(
      (await readPublications(pool, workspace.projectId)).some(
        (publication) => publication.documentId === failedRevision.documentId && !publication.stale,
      ),
      'retry後に文書が公開されていない',
    );
  });

  it('snapshot後に停止した旧workerのapplyDocumentPlanは、lease回収後の別workerの公開を上書きしない', async () => {
    const { config } = await startApprovedVoyage(pool, workspace.companyId);
    const sessionId = await seedSession(pool, workspace);
    const first = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text: '旧workerが見た先頭本文' });
    const second = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 2,
      role: 'assistant',
      text: '旧workerが見た後続本文',
    });
    assert.equal(
      (await runBuildJob(pool, { buildJobId: first.buildJobId, config })).status,
      'completed',
      '最初のbuild_documentsがcompletedでない',
    );
    assert.equal(
      (await runBuildJob(pool, { buildJobId: second.buildJobId, config })).status,
      'completed',
      '後続のbuild_documentsがcompletedでない',
    );

    // 旧workerがsnapshotを取得して停止する。
    await reopenJob(pool, second.buildJobId);
    const staleJob = await claimBuildJob(pool, second.buildJobId);
    const stale = await loadSessionMessages(pool, sessionId);
    const staleChunks = await planDocumentChunks(sessionId, stale.messages);

    // lease期限切れで回収し、回収後の同じjobを別workerが処理できる状態にする。
    await pool.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [staleJob.id]);
    assert.equal(await recoverExpiredJobs(pool), 1, 'lease期限切れjobを回収できない');

    // 別workerが編集後のsessionを構築・公開する。
    const edited = '別workerが公開する編集後の先頭本文';
    const revision2 = await advanceRevision(pool, first.messageId, edited);
    await upsertAnalysis(pool, { messageId: first.messageId, revision: revision2 });
    const takeover = await claimBuildJob(pool, second.buildJobId);
    await processJob(pool, takeover, config);
    assert.equal((await readJob(pool, second.buildJobId)).status, 'completed', '回収後の別workerがjobを完了していない');
    assert.ok(
      (await readRevisions(pool)).some((revision) => compact(revision.text).includes(compact(edited))),
      '別workerが編集後の本文を公開していない',
    );
    const afterTakeover = await snapshotSearchState(pool, workspace.projectId);

    // snapshot後に停止した旧workerが同じjobで計画適用へ進んでも、文書状態を変えない。
    await assert.rejects(
      applyDocumentPlan(
        pool,
        staleJob,
        { companyId: workspace.companyId, projectId: workspace.projectId, sessionId },
        stale.snapshot,
        staleChunks,
      ),
      (error: unknown) => error instanceof LeaseLostError,
      'leaseを失った旧workerの計画適用が拒否されない',
    );
    assert.deepEqual(
      await snapshotSearchState(pool, workspace.projectId),
      afterTakeover,
      'lease喪失後の旧workerが文書状態を上書きした',
    );

    // leaseが有効なままsession snapshotだけが変わった場合も、書込前に拒否して状態を変えない。
    const third = await seedSearchableMessage(pool, { sessionId, sequenceNo: 3, text: 'snapshot不一致を検出する追記' });
    const inconsistentJob = await claimBuildJob(pool, third.buildJobId);
    const beforeEdit = await loadSessionMessages(pool, sessionId);
    const beforeChunks = await planDocumentChunks(sessionId, beforeEdit.messages);
    const revision3 = await advanceRevision(pool, first.messageId, `${edited} さらに編集`);
    await upsertAnalysis(pool, { messageId: first.messageId, revision: revision3 });
    const beforeSnapshotMismatchApply = await snapshotSearchState(pool, workspace.projectId);
    await assert.rejects(
      applyDocumentPlan(
        pool,
        inconsistentJob,
        { companyId: workspace.companyId, projectId: workspace.projectId, sessionId },
        beforeEdit.snapshot,
        beforeChunks,
      ),
      (error: unknown) => error instanceof StaleApplyError,
      'session snapshot不一致の計画適用が拒否されない',
    );
    assert.deepEqual(
      await snapshotSearchState(pool, workspace.projectId),
      beforeSnapshotMismatchApply,
      'snapshot不一致の旧workerが文書状態を上書きした',
    );
  });
});
