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
import { BUILD_DOCUMENTS_PRIORITY, claimJobs, enqueueJob, type ClaimedJob } from '../../jobs/queue.js';
import { loadWorkerConfig, type WorkerConfig } from '../config.js';
import { WORKER_POLICY_VERSION } from '../contract.js';
import { processJob } from '../process.js';
import { runWorker } from '../runner.js';
import { advanceRevision, countJobsByKind, minutesFromNow, readJob, seedMessage, seedSession, sleep } from './support.js';

// M4の結合test。production codeを変更せず、既存のprocessJob / runWorker / PostgreSQLだけを通して
// 未実装のbuild_documents・Voyage送信・M4 schemaを検出する。
//
// ここで前提にするM4契約（予定schema）:
// - embedding_generations(id, provider, model, dimensions, status, tokenizer/前処理版, metric)
// - search_documents(id, company_id, project_id, session_id, document_key, desired_revision, is_searchable)
// - search_document_revisions(document_id, revision, 検索本文, content_hash, chunker_version, status)
// - search_document_sources(document_id, revision, message_id, message_revision, UTF-16 start/end, display_order)
// - document_embeddings(document_id, revision, generation_id, vector(1024), input_hash)
// - document_publications(document_id, generation_id, revision, stale)
// - embedding_cache(company_id, generation_id, operation, input_hash)
// - revision status: pending / embedding / ready / failed / superseded / excluded
// - Voyage接続設定はJEVと同じ方式でenv（VOYAGE_API_KEY / VOYAGE_ACCOUNT_REF / VOYAGE_API_URL）から読む。
//   実APIへは送らず、loopback HTTP fixtureだけを使う。

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
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
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
      if (reply.delayMs !== undefined) {
        await sleep(reply.delayMs);
      }
      res.statusCode = reply.status ?? 200;
      res.setHeader('content-type', 'application/json');
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
  accountRef?: string;
  active?: boolean;
  learningDisabled?: boolean;
  termsCheckedAt?: Date;
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
      VOYAGE_PROVIDER,
      input.accountRef ?? VOYAGE_ACCOUNT,
      input.endpoint,
      'https://www.voyageai.com/tos',
      input.termsCheckedAt ?? new Date(),
      input.learningDisabled ?? true,
      'retention-terms',
      input.confirmedAt ?? new Date(),
      input.active ?? true,
    ],
  );
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
  return enqueueJob(pool, {
    kind: 'build_documents',
    idempotencyKey: `build_documents:${input.messageId}:${input.revision}:${WORKER_POLICY_VERSION}`,
    priority: BUILD_DOCUMENTS_PRIORITY,
    sessionId: input.sessionId,
    messageId: input.messageId,
    targetRevision: input.revision,
    payload: { retention: input.retention, is_searchable: input.isSearchable },
  });
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
  assert.ok(job, `build_documents jobをclaimできない: ${buildJobId}`);
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

async function readVoyageUsageEvents(pool: Pool, companyId: string): Promise<{ provider: string | null; success: boolean | null }[]> {
  const result = await pool.query<{ row: DbRow }>('SELECT to_jsonb(u) AS row FROM usage_events u WHERE company_id = $1', [
    companyId,
  ]);
  return result.rows.map(({ row }) => ({
    provider: pickOptionalString(row, ['provider']),
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
        if (first.revision === second.revision) {
          continue;
        }
        const overlapLength = Math.min(first.end, second.end) - Math.max(first.start, second.start);
        if (overlapLength > 0) {
          hasOverlap = true;
          const shorterLength = Math.min(first.end - first.start, second.end - second.start);
          assert.ok(overlapLength < shorterLength, '分割時の重複windowが文書全体の複製になっている');
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
    timeoutOverride?: string;
  }

  const failureCases: FailureCase[] = [
    { name: '429', replyStatus: 429, expectedStatus: 'pending', expectedCode: 'provider_rate_limited' },
    { name: '503', replyStatus: 503, expectedStatus: 'pending', expectedCode: 'provider_unavailable' },
    {
      name: 'timeout',
      delayMs: 1_000,
      expectedStatus: 'pending',
      expectedCode: 'provider_timeout',
      timeoutOverride: '200',
    },
    { name: '400', replyStatus: 400, expectedStatus: 'failed', expectedCode: 'provider_rejected' },
    { name: '422', replyStatus: 422, expectedStatus: 'failed', expectedCode: 'provider_rejected' },
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

    gateArmed = true;
    const job = await claimBuildJob(pool, second.buildJobId);
    const processing = processJob(pool, job, config);
    const sent = await waitUntil(() => server.requests.length >= 1, EXTERNAL_WAIT_TIMEOUT_MS);
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

    gateArmed = true;
    const job = await claimBuildJob(pool, second.buildJobId);
    const processing = processJob(pool, job, config);
    const sent = await waitUntil(() => server.requests.length >= 1, EXTERNAL_WAIT_TIMEOUT_MS);
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

    gateArmed = true;
    const job = await claimBuildJob(pool, second.buildJobId);
    const processing = processJob(pool, job, config);
    const sent = await waitUntil(() => server.requests.length >= 1, EXTERNAL_WAIT_TIMEOUT_MS);
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
