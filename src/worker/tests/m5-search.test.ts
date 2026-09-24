import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import {
  addProjectMember,
  insertCompany,
  insertEmployee,
  countRows,
  insertProject,
  insertSession,
  resetDatabase,
  seedWorkspace,
  sha256Bytes,
  type WorkspaceFixture,
} from '../../db/tests/fixtures.js';
import { BUILD_DOCUMENTS_PRIORITY, EXECUTE_SEARCH_PRIORITY, claimJobs, enqueueJob, type ClaimedJob } from '../../jobs/queue.js';
import { loadWorkerConfig, type WorkerConfig } from '../config.js';
import {
  JEV_API_PATH,
  VOYAGE_API_PATH,
  VOYAGE_DIMENSIONS,
  VOYAGE_DOCUMENT_INPUT_TYPE,
  VOYAGE_METRIC,
  VOYAGE_MODEL,
  VOYAGE_NORMALIZATION,
  VOYAGE_PROVIDER,
  VOYAGE_QUERY_INPUT_TYPE,
  VOYAGE_TOKENIZER_VERSION,
  WORKER_POLICY_VERSION,
  type JevRequest,
} from '../contract.js';
import { ensureActiveGeneration } from '../embedding.js';
import { processJob, retryJob } from '../process.js';
import { runWorker } from '../runner.js';
import { loadVoyageTokenizer } from '../tokenizer.js';
import {
  advanceRevision,
  countJobsByKind,
  jevReply,
  readJob,
  readSearchRequest,
  seedApproval,
  seedMessage,
  seedSearchRequest,
  seedSession,
  sleep,
  startFakeJev,
  type FakeJevReply,
  type FakeJevServer,
  type JevChoiceSelector,
} from './support.js';

// M5の結合test。production code・migrationを変更せず、既存のprocessJob / runWorker / claimJobs /
// PostgreSQL / loopback HTTP fixtureだけを通して、未実装のexecute_search・document_entities・
// 厳密検索・識別子検索・RRF・Jev候補判定・原文結果保存を検出する。
//
// 前提にするM5契約（実装計画5.2〜5.3、8.2〜8.3、9.0〜9.3、10.3、12節M5、A01/A02/A11/A13/A17/A19/
// A22〜A24/A27〜A33/A39/A40）:
// - document_entities(document_id, revision, company_id, project_id, entity_type, entity_key)と
//   (company_id, project_id, entity_type, entity_key)の検索index、search_document_revisionsへの複合FK、
//   (document_id, revision, entity_type, entity_key)の冪等キー
// - 検索開始時にproject.active_generation_idを固定し、同じ世代のquery埋め込みとdocument埋め込みだけで比較する
// - 会社・案件で厳密に絞り、現在input自身・現在input以降の同session発言・別案件・別会社を候補とevidenceから除外する
// - vector上位20とentity完全一致上位20をRRF 1/(60+rank)で統合し、同文書revisionを1件にまとめ、最大10件をJevへ渡す
// - Jev候補判定は既存 /v1/systemone のchoice契約で行い、無関係/周辺的/有用/直接答えるの4段階を扱う
// - 合計8,000 tokenizer token超は安定順の末尾から除外し、result.warningsへ記録する
// - 完了はsearch_requests.status=completed/outcome=matched|no_match、resultは10.3の必須フィールドを持つ
// - Voyage/Jev未承認はblocked_policy、retryableはpending、恒久障害はfailedとし、no_matchにしない
// - 候補判定後に原文revision/publication/leaseが変わったevidenceは保存前に再検証し、無効なら保存しない
// - runWorkerはexecute_searchをclaimし、再実行でjob/result/entity索引を増殖させない

const JEV_ACCOUNT = 'acct-a';
const VOYAGE_ACCOUNT = 'voyage-acct-a';
const VOYAGE_KEY = 'test-voyage-key';
const EXTERNAL_WAIT_TIMEOUT_MS = 4_000;

const pool = createPool(requireDatabaseUrl());
let workspace: WorkspaceFixture;
const openServers: { close(): Promise<void> }[] = [];

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

// ---- M5 schema reader（未実装tableはassertで理由を明示する） ----

const M5_TABLES = ['document_entities'] as const;

async function requireM5Tables(pool: Pool): Promise<void> {
  const result = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  const names = new Set(result.rows.map((row) => row.table_name));
  for (const table of M5_TABLES) {
    assert.ok(names.has(table), `M5の必須テーブル ${table} がない（M5 migration未適用）`);
  }
}

async function tableIndexDefs(pool: Pool, table: string): Promise<string[]> {
  const result = await pool.query<{ indexdef: string }>(
    'SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2',
    ['public', table],
  );
  return result.rows.map((row) => row.indexdef);
}

async function tableConstraints(pool: Pool, table: string): Promise<{ contype: string; def: string }[]> {
  const result = await pool.query<{ contype: string; def: string }>(
    `SELECT c.contype, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1`,
    [table],
  );
  return result.rows;
}

// ---- loopback Voyage fixture（実Voyage・実会話を送らない） ----

interface FakeVoyageRequest {
  model?: string;
  input?: string[];
  input_type?: string;
  output_dimension?: number;
  output_dtype?: string;
  truncation?: boolean;
}

interface FakeVoyageReply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
}

interface FakeVoyageServer {
  baseUrl: string;
  requests: { url: string; body: FakeVoyageRequest; rawBody: string }[];
  close(): Promise<void>;
}

async function startFakeVoyage(responder: (request: FakeVoyageRequest) => FakeVoyageReply | Promise<FakeVoyageReply>): Promise<FakeVoyageServer> {
  const requests: FakeVoyageServer['requests'] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: FakeVoyageRequest;
      try {
        body = JSON.parse(rawBody) as FakeVoyageRequest;
      } catch {
        body = {};
      }
      requests.push({ url: req.url ?? '', body, rawBody });
      const reply = await responder(body);
      if (reply.delayMs !== undefined) {
        await sleep(reply.delayMs);
      }
      res.statusCode = reply.status ?? 200;
      res.setHeader('content-type', 'application/json');
      for (const [name, value] of Object.entries(reply.headers ?? {})) {
        res.setHeader(name, value);
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
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

// 1024次元の単位基底vector。cosine距離の順位をfixture側で決める。
function basisVector(index: number, value = 1): number[] {
  const vector = new Array<number>(VOYAGE_DIMENSIONS).fill(0);
  vector[index] = value;
  return vector;
}

// 第1軸との類似度がrankに従って下がるvector。rankが小さいほど距離が近い。
function similarityVector(rank: number): number[] {
  const vector = basisVector(0, 1);
  vector[1] = rank * 0.01;
  return vector;
}

// index順に対応する非ゼロvector。document埋め込みの既定値に使う。
function defaultVector(index: number): number[] {
  const vector = new Array<number>(VOYAGE_DIMENSIONS).fill(0);
  vector[0] = 0.1 + index * 0.1;
  vector[1] = 0.2 + index * 0.05;
  return vector;
}

function voyageBody(inputs: readonly string[], vectorFor: (text: string, index: number) => number[]): unknown {
  return {
    object: 'list',
    model: VOYAGE_MODEL,
    data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: vectorFor(text, index) })),
    usage: { total_tokens: inputs.length * 10 },
  };
}

function defaultVoyageResponder(request: FakeVoyageRequest): FakeVoyageReply {
  return {
    body: voyageBody(request.input ?? [], (_text, index) => (request.input_type === 'query' ? basisVector(0) : defaultVector(index))),
  };
}

// query埋め込みだけを固定vectorへ差し替え、document埋め込みは既定値のままにする。
function vectorQueryResponder(queryVector: readonly number[]): (request: FakeVoyageRequest) => FakeVoyageReply {
  return (request) => ({
    body: voyageBody(request.input ?? [], (_text, index) => (request.input_type === 'query' ? [...queryVector] : defaultVector(index))),
  });
}

// ---- Jev候補判定fixture（既存choice契約の合成response） ----

type M5JevMode = 'direct' | 'useful' | 'no_match';

// 候補評価の質問文・IDはproduction側の設計に委ね、criteriaの選択肢名だけから4段階を選ぶ。
function m5ChoiceSelector(mode: M5JevMode): JevChoiceSelector {
  return (question) => {
    const keys = Object.keys(question.criteria);
    const pick = (patterns: RegExp): string | undefined => keys.find((key) => patterns.test(key));
    if (mode === 'no_match') {
      const negative = pick(/unrelated|irrelevant|peripheral|no_match|無関係|周辺/i) ?? pick(/^no$|^unknown$|^none$/i);
      return negative ?? keys[0];
    }
    const positive =
      mode === 'direct' ? pick(/direct|直接/i) ?? pick(/useful|有用/i) : pick(/useful|有用/i) ?? pick(/direct|直接/i);
    if (positive !== undefined) {
      return positive;
    }
    const reported = pick(/reported_completed|completed/i);
    if (reported !== undefined) {
      return reported;
    }
    return pick(/^yes$/i) ?? keys.find((key) => !/verified|unknown/i.test(key)) ?? keys[0];
  };
}

// ---- 外部待ちgate。候補取得後の状態変更をJev応答タイミングで起こす。 ----

interface ExternalGate {
  armed: boolean;
  enter(): void;
  waitForEntry(timeoutMs: number): Promise<boolean>;
  release(): void;
  waitRelease(): Promise<void>;
}

// 外部待ちgateか処理完了の早い方まで待つ。未実装時のRed確認をtimeout待ちにしない。
async function waitForGateOrProcessing(gate: ExternalGate, processing: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([gate.waitForEntry(timeoutMs), processing.then(() => false, () => false)]);
}

// 検索の共有lock中にmessages更新が待たされるかをlock_timeoutで検出する。
async function probeMessageRevisionUpdate(pool: Pool, messageId: string, timeoutMs: number): Promise<'blocked' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL lock_timeout = 150');
      try {
        await client.query('UPDATE messages SET updated_at = now() WHERE id = $1', [messageId]);
        await client.query('ROLLBACK');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if ((error as { code?: string }).code === '55P03') {
          return 'blocked';
        }
        throw error;
      }
    } finally {
      client.release();
    }
    await sleep(25);
  }
  return 'timeout';
}

function createExternalGate(): ExternalGate {
  let entered = false;
  let resolveEntered: (() => void) | undefined;
  const enteredPromise = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  let resolveRelease: (() => void) | undefined;
  const releasePromise = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  return {
    armed: false,
    enter() {
      entered = true;
      resolveEntered?.();
    },
    async waitForEntry(timeoutMs: number): Promise<boolean> {
      if (entered) {
        return true;
      }
      await Promise.race([enteredPromise, sleep(timeoutMs)]);
      return entered;
    },
    release() {
      resolveRelease?.();
    },
    waitRelease() {
      return releasePromise;
    },
  };
}

// ---- 設定・承認・provider起動 ----

interface SearchProviders {
  jev: FakeJevServer;
  voyage: FakeVoyageServer;
  config: WorkerConfig;
}

interface ProviderOptions {
  jevMode?: M5JevMode;
  jevResponder?: (request: JevRequest, rawBody: string) => FakeJevReply | Promise<FakeJevReply>;
  voyageResponder?: (request: FakeVoyageRequest) => FakeVoyageReply | Promise<FakeVoyageReply>;
  gate?: ExternalGate;
  approveJev?: boolean;
  approveVoyage?: boolean;
  jevRequestTimeoutMs?: number;
  voyageRequestTimeoutMs?: number;
}

function loadM5Config(input: {
  jevEndpoint: string;
  voyageEndpoint: string;
  jevRequestTimeoutMs?: number;
  voyageRequestTimeoutMs?: number;
}): WorkerConfig {
  return loadWorkerConfig({
    DATABASE_URL: requireDatabaseUrl(),
    JEV_API_KEY: 'test-key',
    JEV_ACCOUNT_REF: JEV_ACCOUNT,
    JEV_API_URL: input.jevEndpoint,
    JEV_REQUEST_TIMEOUT_MS: String(input.jevRequestTimeoutMs ?? 2_000),
    VOYAGE_API_KEY: VOYAGE_KEY,
    VOYAGE_ACCOUNT_REF: VOYAGE_ACCOUNT,
    VOYAGE_API_URL: input.voyageEndpoint,
    VOYAGE_REQUEST_TIMEOUT_MS: String(input.voyageRequestTimeoutMs ?? 2_000),
  }).config;
}

// Jev/Voyageのloopback fixtureを起動し、指定に応じて承認を保存してconfigを返す。
async function startProviders(pool: Pool, companyId: string, options: ProviderOptions = {}): Promise<SearchProviders> {
  const jevResponder =
    options.jevResponder ?? ((request: JevRequest) => ({ body: jevReply(request, m5ChoiceSelector(options.jevMode ?? 'direct')) }));
  const jev = await startFakeJev(async (request, rawBody) => {
    if (options.gate !== undefined && options.gate.armed) {
      options.gate.armed = false;
      options.gate.enter();
      await options.gate.waitRelease();
    }
    return jevResponder(request, rawBody);
  });
  openServers.push(jev);
  if (options.approveJev ?? true) {
    await seedApproval(pool, { companyId, endpoint: `${jev.baseUrl}${JEV_API_PATH}`, accountRef: JEV_ACCOUNT });
  }
  const voyage = await startFakeVoyage(options.voyageResponder ?? defaultVoyageResponder);
  openServers.push(voyage);
  if (options.approveVoyage ?? true) {
    await seedApproval(pool, { companyId, provider: VOYAGE_PROVIDER, endpoint: `${voyage.baseUrl}${VOYAGE_API_PATH}`, accountRef: VOYAGE_ACCOUNT });
  }
  const config = loadM5Config({
    jevEndpoint: `${jev.baseUrl}${JEV_API_PATH}`,
    voyageEndpoint: `${voyage.baseUrl}${VOYAGE_API_PATH}`,
    jevRequestTimeoutMs: options.jevRequestTimeoutMs,
    voyageRequestTimeoutMs: options.voyageRequestTimeoutMs,
  });
  return { jev, voyage, config };
}

// ---- DB fixture ----

async function insertGeneration(
  pool: Pool,
  input: { companyId: string; endpoint: string; model?: string; status?: string },
): Promise<string> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO embedding_generations
       (id, company_id, provider, account_ref, endpoint, model, model_revision, dimensions, metric,
        tokenizer_version, document_input_type, query_input_type, normalization, status)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      input.companyId,
      VOYAGE_PROVIDER,
      VOYAGE_ACCOUNT,
      input.endpoint,
      input.model ?? VOYAGE_MODEL,
      VOYAGE_DIMENSIONS,
      VOYAGE_METRIC,
      VOYAGE_TOKENIZER_VERSION,
      VOYAGE_DOCUMENT_INPUT_TYPE,
      VOYAGE_QUERY_INPUT_TYPE,
      VOYAGE_NORMALIZATION,
      input.status ?? 'active',
    ],
  );
  return id;
}

interface SeedDocSource {
  messageId: string;
  messageRevision: number;
  startOffset: number;
  endOffset: number;
}

interface SeedDocumentInput {
  id?: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  documentKey: string;
  content: string;
  revision?: number;
  isSearchable?: boolean;
  generationId?: string;
  embedding?: readonly number[];
  publication?: boolean;
  stale?: boolean;
  createdAt?: Date;
  sources: SeedDocSource[];
}

// M4 schemaへready文書を作る。generation/embedding指定時は同世代のembeddingとpublicationも張る。
async function seedReadyDocument(pool: Pool, input: SeedDocumentInput): Promise<string> {
  const id = input.id ?? uuidv7();
  const revision = input.revision ?? 1;
  const createdAt = input.createdAt ?? new Date();
  await pool.query(
    `INSERT INTO search_documents
       (id, company_id, project_id, session_id, document_key, desired_revision, is_searchable, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [id, input.companyId, input.projectId, input.sessionId, input.documentKey, revision, input.isSearchable ?? true, createdAt],
  );
  await pool.query(
    `INSERT INTO search_document_revisions
       (document_id, revision, content, content_hash, chunker_version, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'm5-test', 'ready', $5, $5)`,
    [id, revision, input.content, sha256Bytes(input.content), createdAt],
  );
  for (const [index, source] of input.sources.entries()) {
    await pool.query(
      `INSERT INTO search_document_sources
         (id, document_id, revision, message_id, message_revision, start_offset, end_offset, display_order, source_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'original')`,
      [uuidv7(), id, revision, source.messageId, source.messageRevision, source.startOffset, source.endOffset, index],
    );
  }
  if (input.generationId !== undefined && input.embedding !== undefined) {
    await pool.query(
      `INSERT INTO document_embeddings (document_id, revision, generation_id, embedding, input_hash)
       VALUES ($1, $2, $3, $4::vector, $5)`,
      [id, revision, input.generationId, toVectorLiteral(input.embedding), sha256Bytes(input.content)],
    );
  }
  if (input.publication ?? (input.generationId !== undefined && input.embedding !== undefined)) {
    assert.ok(input.generationId !== undefined, 'publicationにはgenerationIdが必要');
    await pool.query(
      `INSERT INTO document_publications (document_id, generation_id, revision, stale)
       VALUES ($1, $2, $3, $4)`,
      [id, input.generationId, revision, input.stale ?? false],
    );
  }
  return id;
}

async function updateDocumentEmbedding(pool: Pool, documentId: string, vector: readonly number[]): Promise<void> {
  await pool.query('UPDATE document_embeddings SET embedding = $2::vector WHERE document_id = $1', [documentId, toVectorLiteral(vector)]);
}

interface StoredReadyDocument {
  id: string;
  revision: number;
  content: string;
}

async function findReadyDocuments(pool: Pool, projectId: string, marker: string): Promise<StoredReadyDocument[]> {
  const result = await pool.query<StoredReadyDocument>(
    `SELECT d.id, r.revision, r.content
       FROM search_documents d
       JOIN search_document_revisions r ON r.document_id = d.id AND r.revision = d.desired_revision
      WHERE d.project_id = $1 AND r.content LIKE '%' || $2 || '%'
      ORDER BY d.created_at, d.id`,
    [projectId, marker],
  );
  return result.rows;
}

async function findReadyDocumentByMessage(pool: Pool, projectId: string, messageId: string): Promise<StoredReadyDocument | undefined> {
  const result = await pool.query<StoredReadyDocument>(
    `SELECT d.id, r.revision, r.content
       FROM search_documents d
       JOIN search_document_revisions r ON r.document_id = d.id AND r.revision = d.desired_revision
       JOIN search_document_sources s ON s.document_id = d.id AND s.revision = r.revision
      WHERE d.project_id = $1 AND s.message_id = $2
      ORDER BY d.created_at, d.id
      LIMIT 1`,
    [projectId, messageId],
  );
  return result.rows[0];
}

// 候補本文だけにmarkerを持たせ、原文側のmarker重複と混同せずJev投入件数を数えられるようにする。
async function appendRevisionContent(pool: Pool, documentId: string, revision: number, suffix: string): Promise<void> {
  await pool.query('UPDATE search_document_revisions SET content = content || $3::text, updated_at = now() WHERE document_id = $1 AND revision = $2', [
    documentId,
    revision,
    suffix,
  ]);
}

// 検索対象sessionのuser発言と自動検索受付・execute_search jobを、route_searchの保存形に近づけて作る。
async function seedExecuteSearch(
  pool: Pool,
  input: { workspace: WorkspaceFixture; sessionId: string; sequenceNo: number; text: string; occurredAt?: Date },
): Promise<{ requestId: string; jobId: string; messageId: string; revision: number }> {
  const message = await seedMessage(pool, {
    sessionId: input.sessionId,
    sequenceNo: input.sequenceNo,
    role: 'user',
    text: input.text,
    occurredAt: input.occurredAt,
  });
  const requestId = await seedSearchRequest(pool, {
    workspace: input.workspace,
    sessionId: input.sessionId,
    inputId: message.messageId,
    inputRevision: message.revision,
    sequenceNo: input.sequenceNo,
    searchAction: 'new_search',
  });
  await pool.query('UPDATE search_requests SET stage = $2, condition_hash = $3 WHERE id = $1', [
    requestId,
    'awaiting_search',
    sha256Bytes(`${requestId}:${message.messageId}:${message.revision}`),
  ]);
  const jobId = await enqueueJob(pool, {
    kind: 'execute_search',
    idempotencyKey: `execute_search:${requestId}:${WORKER_POLICY_VERSION}`,
    priority: EXECUTE_SEARCH_PRIORITY,
    sessionId: input.sessionId,
    messageId: message.messageId,
    targetRevision: message.revision,
    payload: { search_request_id: requestId },
  });
  await pool.query('UPDATE jobs SET next_run_at = LEAST(next_run_at, now()) WHERE id = $1', [jobId]);
  return { requestId, jobId, messageId: message.messageId, revision: message.revision };
}

async function claimExecuteJob(pool: Pool, jobId: string): Promise<ClaimedJob> {
  const [job] = await claimJobs(pool, { kinds: ['execute_search'], limit: 1, leaseMs: 60_000 });
  if (job === undefined) {
    assert.fail(`execute_search jobをclaimできない: ${jobId}`);
  }
  assert.equal(job.id, jobId, '別のexecute_search jobをclaimした');
  return job;
}

async function runExecuteSearch(pool: Pool, input: { jobId: string; config: WorkerConfig }): Promise<void> {
  const job = await claimExecuteJob(pool, input.jobId);
  await processJob(pool, job, input.config);
}

async function reopenJob(pool: Pool, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE jobs
        SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, error_code = NULL, next_run_at = now(), updated_at = now()
      WHERE id = $1`,
    [jobId],
  );
}

// ---- M5結果reader ----

interface M5Evidence {
  message_id: string;
  revision: number;
  employee_id: string;
  role: string;
  occurred_at: string;
  text: string;
}

interface M5Match {
  case_or_document_id?: string;
  relevance?: string;
  relevance_kind?: string[];
  statement_status?: string;
  claim_status?: string;
  evidence?: M5Evidence[];
  related_evidence_ids?: unknown[];
  truncated?: boolean;
}

interface M5SearchResult {
  request_id?: string;
  input_id?: string;
  input_revision?: number;
  trigger?: string;
  search_action?: string;
  reused_from_request_id?: string | null;
  status?: string;
  outcome?: string;
  project_id?: string;
  index_status?: {
    pending_documents?: number;
    failed_documents?: number;
    embedding_generation_id?: string;
    search_mode?: string;
  };
  matches?: M5Match[];
  candidate_evaluations?: unknown[];
  warnings?: unknown[];
}

async function readStoredResult(pool: Pool, requestId: string): Promise<M5SearchResult> {
  const request = await readSearchRequest(pool, requestId);
  assert.ok(request.result !== null && typeof request.result === 'object', 'search_request.resultが保存されていない');
  return request.result as M5SearchResult;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function allJevRawBody(server: FakeJevServer): string {
  return server.requests.map((request) => request.rawBody).join('\n');
}

function evidenceFor(result: M5SearchResult, messageId: string): M5Evidence | undefined {
  for (const match of result.matches ?? []) {
    const found = (match.evidence ?? []).find((evidence) => evidence.message_id === messageId);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

async function seedSearchableMessage(
  pool: Pool,
  input: { sessionId: string; sequenceNo: number; text: string },
): Promise<{ messageId: string; revision: number; buildJobId: string }> {
  const message = await seedMessage(pool, { sessionId: input.sessionId, sequenceNo: input.sequenceNo, role: 'user', text: input.text });
  await pool.query(
    `INSERT INTO message_analysis
       (id, message_id, revision, policy_version, retention, primary_intent, technical_labels, decision_action,
        continuity, statement_status, is_searchable, model_version, state_hash, parts)
     VALUES ($1, $2, $3, $4, 'substantive', 'implementation', '[]'::jsonb, 'none', 'same_topic', 'request', true, 'test-model', $5, '[]'::jsonb)
     ON CONFLICT (message_id, revision, policy_version) DO NOTHING`,
    [uuidv7(), message.messageId, message.revision, WORKER_POLICY_VERSION, sha256Bytes(`${message.messageId}:${message.revision}`)],
  );
  const buildJobId = await enqueueJob(pool, {
    kind: 'build_documents',
    idempotencyKey: `build_documents:${message.messageId}:${message.revision}:${WORKER_POLICY_VERSION}`,
    priority: BUILD_DOCUMENTS_PRIORITY,
    sessionId: input.sessionId,
    messageId: message.messageId,
    targetRevision: message.revision,
    payload: { retention: 'substantive', is_searchable: true },
  });
  await pool.query('UPDATE jobs SET next_run_at = LEAST(next_run_at, now()) WHERE id = $1', [buildJobId]);
  return { messageId: message.messageId, revision: message.revision, buildJobId };
}

async function runBuildJob(pool: Pool, jobId: string, config: WorkerConfig): Promise<void> {
  const [job] = await claimJobs(pool, { kinds: ['build_documents'], limit: 1, leaseMs: 60_000 });
  if (job === undefined) {
    assert.fail(`build_documents jobをclaimできない: ${jobId}`);
  }
  assert.equal(job.id, jobId, '別のbuild_documents jobをclaimした');
  await processJob(pool, job, config);
  assert.equal((await readJob(pool, jobId)).status, 'completed', 'build_documentsがcompletedでない');
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await sleep(20);
  }
  assert.fail('条件がtimeoutまでに成立しない');
}

describe('M5 schemaと識別子索引', () => {
  it('document_entitiesは検索用複合index・revisionへのFK・冪等キーを持つ', async () => {
    await requireM5Tables(pool);
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'document_entities'`,
    );
    const names = new Set(columns.rows.map((row) => row.column_name));
    for (const column of ['document_id', 'revision', 'company_id', 'project_id', 'entity_type', 'entity_key']) {
      assert.ok(names.has(column), `document_entitiesに${column}列がない`);
    }
    const indexes = await tableIndexDefs(pool, 'document_entities');
    assert.ok(
      indexes.some((def) => ['company_id', 'project_id', 'entity_type', 'entity_key'].every((column) => def.includes(column))),
      'document_entitiesに(company_id, project_id, entity_type, entity_key)の検索indexがない',
    );
    const constraints = await tableConstraints(pool, 'document_entities');
    assert.ok(
      constraints.some((constraint) =>
        /FOREIGN KEY \(document_id, revision\) REFERENCES search_document_revisions/.test(constraint.def.replace(/\s+/g, ' ')),
      ),
      'document_entities(document_id, revision)のsearch_document_revisionsへの複合FKがない',
    );
    const uniqueDefs = [
      ...indexes.filter((def) => def.startsWith('CREATE UNIQUE INDEX')),
      ...constraints.filter((constraint) => constraint.contype === 'u' || constraint.contype === 'p').map((constraint) => constraint.def),
    ];
    assert.ok(
      uniqueDefs.some((def) => ['document_id', 'revision', 'entity_type', 'entity_key'].every((column) => def.includes(column))),
      'document_entitiesに(document_id, revision, entity_type, entity_key)の冪等キーがない',
    );
  });

  it('build_documentsは明示識別子を文字大小そのままdocument_entitiesへ決定的に索引し、再実行で増殖しない', async () => {
    await requireM5Tables(pool);
    const { config } = await startProviders(pool, workspace.companyId, { approveJev: false });
    const sessionId = await seedSession(pool, workspace);
    const text =
      'src/worker/process.ts、./src/worker/process.ts、../src/worker/process.ts、/repo/src/worker/process.ts を確認し、' +
      'buildRequest() を直し、Issue #123 と PR #456、CaseSensitive.ts、https://example.com/src/worker/process.ts を参照した';
    const message = await seedSearchableMessage(pool, { sessionId, sequenceNo: 1, text });
    await runBuildJob(pool, message.buildJobId, config);

    const documents = await findReadyDocuments(pool, workspace.projectId, 'buildRequest');
    assert.equal(documents.length, 1, '識別子を含むready文書がない');
    const documentId = documents[0].id;
    const entities = await pool.query<{ entity_type: string; entity_key: string; company_id: string; project_id: string }>(
      'SELECT entity_type, entity_key, company_id, project_id FROM document_entities WHERE document_id = $1 ORDER BY entity_type, entity_key',
      [documentId],
    );
    const keys = entities.rows.map((row) => row.entity_key);
    assert.ok(keys.includes('src/worker/process.ts'), `相対pathのentityがない: ${JSON.stringify(keys)}`);
    assert.ok(keys.includes('./src/worker/process.ts'), `./付きpathのentityがない: ${JSON.stringify(keys)}`);
    assert.ok(keys.includes('../src/worker/process.ts'), `../付きpathのentityがない: ${JSON.stringify(keys)}`);
    assert.ok(keys.includes('/repo/src/worker/process.ts'), `絶対pathのentityがない: ${JSON.stringify(keys)}`);
    assert.equal(
      keys.filter((key) => key.endsWith('/src/worker/process.ts')).length,
      3,
      `URLや過剰な表記からpathを抽出した: ${JSON.stringify(keys)}`,
    );
    assert.ok(!keys.some((key) => key.includes('example.com') || key.startsWith('https')), `URL全体を抽出した: ${JSON.stringify(keys)}`);
    assert.ok(keys.some((key) => key.includes('buildRequest')), `関数のentityがない: ${JSON.stringify(keys)}`);
    assert.ok(keys.some((key) => key.includes('#123')), `Issueのentityがない: ${JSON.stringify(keys)}`);
    assert.ok(keys.some((key) => key.includes('#456')), `PRのentityがない: ${JSON.stringify(keys)}`);
    assert.ok(keys.includes('CaseSensitive.ts'), `文字大小を保持したentity_keyがない: ${JSON.stringify(keys)}`);
    assert.ok(!keys.includes('casesensitive.ts'), '文字大小を変えたentity_keyを索引している');
    assert.ok(
      entities.rows.every((row) => row.company_id === workspace.companyId && row.project_id === workspace.projectId),
      'document_entitiesのcompany/projectが文書と一致しない',
    );

    const before = entities.rows.length;
    await reopenJob(pool, message.buildJobId);
    await runBuildJob(pool, message.buildJobId, config);
    const after = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM document_entities WHERE document_id = $1', [
      documentId,
    ]);
    assert.equal(Number(after.rows[0]?.count ?? '0'), before, '再実行でdocument_entitiesが増殖した');
  });

  it('leading path 4形態はvector上位20外でもentity完全一致routeで候補になる', async () => {
    await requireM5Tables(pool);
    const queryVector = basisVector(0, 1);
    const { jev, config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const forms = [
      { marker: 'LEAD-ONE', text: './src/worker/process.ts の修正' },
      { marker: 'LEAD-TWO', text: '../src/worker/process.ts の修正' },
      { marker: 'LEAD-THREE', text: '/repo/src/worker/process.ts の修正' },
      { marker: 'LEAD-FOUR', text: 'src/worker/process.ts の修正' },
    ];
    const entityMessageIds: string[] = [];
    for (const [index, form] of forms.entries()) {
      const seededMessage = await seedSearchableMessage(pool, {
        sessionId: sessionA,
        sequenceNo: index + 1,
        text: `${form.marker} ${form.text}`,
      });
      await runBuildJob(pool, seededMessage.buildJobId, config);
      entityMessageIds.push(seededMessage.messageId);
    }
    // 近傍vector候補を21件積み、leading path文書をvector上位20から外す。
    for (let index = 0; index < 21; index += 1) {
      const text = `LEAD-VEC-${String(index + 1).padStart(2, '0')} 近傍候補`;
      const message = await seedMessage(pool, {
        sessionId: sessionA,
        sequenceNo: forms.length + index + 1,
        role: 'assistant',
        text: `近傍発言-${index + 1}`,
      });
      await seedReadyDocument(pool, {
        companyId: workspace.companyId,
        projectId: workspace.projectId,
        sessionId: sessionA,
        documentKey: `leading-vector-${index + 1}`,
        content: text,
        generationId: generation.id,
        embedding: similarityVector(1),
        sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
      });
    }
    const sessionB = await seedSession(pool, workspace);
    const queryText =
      './src/worker/process.ts ../src/worker/process.ts /repo/src/worker/process.ts src/worker/process.ts LEAD-QUERY';
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: queryText });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const result = await readStoredResult(pool, seeded.requestId);
    const topEvidence = result.matches?.[0]?.evidence ?? [];
    assert.ok(
      topEvidence.some((evidence) => entityMessageIds.includes(evidence.message_id)),
      'leading pathのentity route候補が代表evidenceになっていない',
    );
    const jevBody = allJevRawBody(jev);
    for (const form of forms) {
      assert.ok(jevBody.includes(form.marker), `leading path ${form.text} がentity routeでJev候補に入っていない`);
    }
  });
});

describe('M5 案件内厳密検索', () => {
  it('社員Bは別sessionから社員Aのready文書を検索し、Aの原文identityとVoyage query契約を返す', async () => {
    const queryVector = basisVector(0, 1);
    const { jev, voyage, config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const employeeA = await insertEmployee(pool, workspace.companyId, 'employee-a');
    await addProjectMember(pool, workspace.projectId, employeeA);
    const sessionA = await insertSession(pool, { projectId: workspace.projectId, employeeId: employeeA });
    const answerText = '保存後にキャッシュを無効化する修正を行いました。MARK-A';
    const occurredAt = new Date('2026-09-21T01:00:00.000Z');
    const answer = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text: answerText, occurredAt });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'doc-a',
      content: answerText,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: answer.messageId, messageRevision: 1, startOffset: 0, endOffset: answerText.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, {
      workspace,
      sessionId: sessionB,
      sequenceNo: 1,
      text: 'MARK-B キャッシュ更新の過去対応を探して',
    });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const job = await readJob(pool, seeded.jobId);
    assert.equal(job.status, 'completed');
    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const result = await readStoredResult(pool, seeded.requestId);
    assert.equal(result.request_id, seeded.requestId);
    assert.equal(result.input_id, seeded.messageId);
    assert.equal(result.input_revision, seeded.revision);
    assert.equal(result.trigger, 'auto');
    assert.equal(result.search_action, 'new_search');
    assert.equal(result.status, 'completed');
    assert.equal(result.outcome, 'matched');
    assert.equal(result.project_id, workspace.projectId);
    assert.equal(result.index_status?.embedding_generation_id, generation.id);
    assert.equal(result.index_status?.search_mode, 'exact_vector_and_entity');
    assert.equal(result.index_status?.pending_documents, 0);
    assert.equal(result.index_status?.failed_documents, 0);
    const matches = result.matches ?? [];
    assert.ok(matches.length >= 1, 'matchedなのにmatchesがない');
    const evidence = evidenceFor(result, answer.messageId);
    assert.ok(evidence, 'Aの原文evidenceがresultにない');
    assert.equal(evidence.revision, 1);
    assert.equal(evidence.employee_id, employeeA);
    assert.equal(evidence.role, 'assistant');
    assert.equal(new Date(evidence.occurred_at).getTime(), occurredAt.getTime());
    assert.equal(evidence.text, answerText);
    assert.equal(matches[0]?.claim_status, 'agent_reported');

    const queryRequests = voyage.requests.filter((item) => item.body.input_type === 'query');
    assert.equal(queryRequests.length, 1, 'Voyage query埋め込みが1回でない');
    const queryRequest = queryRequests[0].body;
    assert.equal(queryRequest.model, VOYAGE_MODEL);
    assert.equal(queryRequest.output_dimension, VOYAGE_DIMENSIONS);
    assert.equal(queryRequest.output_dtype, 'float');
    assert.equal(queryRequest.truncation, false);
    assert.ok((queryRequest.input ?? []).join('\n').includes('MARK-B'), 'query inputへ現在の質問を入れていない');
    assert.ok(allJevRawBody(jev).includes('MARK-A'), 'JevへAの候補本文が渡っていない');
  });

  it('別案件・別会社・現在input自身・現在input以降の同session発言を候補とevidenceから除外する', async () => {
    const queryVector = basisVector(0, 1);
    const { jev, config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);

    const employeeA = await insertEmployee(pool, workspace.companyId, 'employee-a');
    await addProjectMember(pool, workspace.projectId, employeeA);
    const sessionA = await insertSession(pool, { projectId: workspace.projectId, employeeId: employeeA });
    const validText = 'VALID-A-SCOPE 過去の確定対応';
    const validMessage = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text: validText });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'scope-valid',
      content: validText,
      generationId: generation.id,
      embedding: similarityVector(5),
      sources: [{ messageId: validMessage.messageId, messageRevision: 1, startOffset: 0, endOffset: validText.length }],
    });

    const sessionB = await seedSession(pool, workspace);
    const currentText = 'CURRENT-INPUT-SCOPE 現在の質問';
    const seeded = await seedExecuteSearch(pool, {
      workspace,
      sessionId: sessionB,
      sequenceNo: 5,
      text: currentText,
    });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionB,
      documentKey: 'scope-current',
      content: currentText,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: seeded.messageId, messageRevision: seeded.revision, startOffset: 0, endOffset: currentText.length }],
    });
    const futureText = 'FUTURE-SCOPE 現在inputより後の同session発言';
    const futureMessage = await seedMessage(pool, { sessionId: sessionB, sequenceNo: 6, role: 'assistant', text: futureText });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionB,
      documentKey: 'scope-future',
      content: futureText,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: futureMessage.messageId, messageRevision: 1, startOffset: 0, endOffset: futureText.length }],
    });

    const otherProjectId = await insertProject(pool, workspace.companyId, 'repo-other');
    await addProjectMember(pool, otherProjectId, workspace.employeeId);
    const otherProjectSession = await insertSession(pool, { projectId: otherProjectId, employeeId: workspace.employeeId });
    const otherProjectText = 'OTHERPROJ-SCOPE 別案件の文書';
    const otherProjectMessage = await seedMessage(pool, { sessionId: otherProjectSession, sequenceNo: 1, role: 'assistant', text: otherProjectText });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: otherProjectId,
      sessionId: otherProjectSession,
      documentKey: 'scope-other-project',
      content: otherProjectText,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: otherProjectMessage.messageId, messageRevision: 1, startOffset: 0, endOffset: otherProjectText.length }],
    });

    const otherCompanyId = await insertCompany(pool, 'company-other');
    const otherEmployeeId = await insertEmployee(pool, otherCompanyId, 'employee-other');
    const otherCompanyProjectId = await insertProject(pool, otherCompanyId, 'repo-other-company');
    await addProjectMember(pool, otherCompanyProjectId, otherEmployeeId);
    const otherCompanySession = await insertSession(pool, { projectId: otherCompanyProjectId, employeeId: otherEmployeeId });
    const otherCompanyText = 'OTHERCO-SCOPE 別会社の文書';
    const otherCompanyMessage = await seedMessage(pool, { sessionId: otherCompanySession, sequenceNo: 1, role: 'assistant', text: otherCompanyText });
    await seedReadyDocument(pool, {
      companyId: otherCompanyId,
      projectId: otherCompanyProjectId,
      sessionId: otherCompanySession,
      documentKey: 'scope-other-company',
      content: otherCompanyText,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: otherCompanyMessage.messageId, messageRevision: 1, startOffset: 0, endOffset: otherCompanyText.length }],
    });

    await runExecuteSearch(pool, { jobId: seeded.jobId, config });
    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const result = await readStoredResult(pool, seeded.requestId);
    assert.ok(evidenceFor(result, validMessage.messageId), '同一案件の有効なA文書が結果にない');
    assert.equal(evidenceFor(result, seeded.messageId), undefined, '現在input自身をevidenceにした');
    assert.equal(evidenceFor(result, futureMessage.messageId), undefined, '現在input以降の同session発言をevidenceにした');
    assert.equal(evidenceFor(result, otherProjectMessage.messageId), undefined, '別案件の文書をevidenceにした');
    assert.equal(evidenceFor(result, otherCompanyMessage.messageId), undefined, '別会社の文書をevidenceにした');
    const resultJson = JSON.stringify(result);
    for (const marker of ['FUTURE-SCOPE', 'OTHERPROJ-SCOPE', 'OTHERCO-SCOPE']) {
      assert.ok(!resultJson.includes(marker), `${marker}がresultへ混入した`);
    }
    const jevBody = allJevRawBody(jev);
    for (const marker of ['FUTURE-SCOPE', 'OTHERPROJ-SCOPE', 'OTHERCO-SCOPE']) {
      assert.ok(!jevBody.includes(marker), `${marker}をJev候補へ渡した`);
    }
    assert.ok(jevBody.includes('VALID-A-SCOPE'), '有効なA候補をJevへ渡していない');
  });
});

describe('M5 順位統合とJev投入量', () => {
  it('vector経路と識別子経路をRRFで統合し、同一documentをJevへ重複投入しない', async () => {
    await requireM5Tables(pool);
    const queryVector = basisVector(0, 1);
    const { jev, config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      voyageResponder: vectorQueryResponder(queryVector),
    });
    await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const combo = await seedSearchableMessage(pool, {
      sessionId: sessionA,
      sequenceNo: 1,
      text: 'src/worker/process.ts の修正',
    });
    const vectorDoc = await seedSearchableMessage(pool, { sessionId: sessionA, sequenceNo: 2, text: '別経路の設計メモ' });
    await runBuildJob(pool, combo.buildJobId, config);
    await runBuildJob(pool, vectorDoc.buildJobId, config);
    const comboDocument = await findReadyDocumentByMessage(pool, workspace.projectId, combo.messageId);
    const vectorDocument = await findReadyDocumentByMessage(pool, workspace.projectId, vectorDoc.messageId);
    assert.ok(comboDocument, '識別子付きdocumentがない');
    assert.ok(vectorDocument, 'vector経路用documentがない');
    await appendRevisionContent(pool, comboDocument.id, comboDocument.revision, ' RRF-COMBO');
    await appendRevisionContent(pool, vectorDocument.id, vectorDocument.revision, ' RRF-VECTOR');
    const comboEntities = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM document_entities WHERE document_id = $1',
      [comboDocument.id],
    );
    assert.ok(Number(comboEntities.rows[0]?.count ?? '0') > 0, '識別子付きdocumentのdocument_entitiesがない');

    // vector順位はvectorDocumentが1位、comboDocumentが2位。識別子経路はcomboDocumentが1位。
    // RRFはcomboDocumentが1/61+1/62、vectorDocumentが1/61となり、comboDocumentが上位になる。
    await updateDocumentEmbedding(pool, vectorDocument.id, similarityVector(1));
    await updateDocumentEmbedding(pool, comboDocument.id, similarityVector(2));
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, {
      workspace,
      sessionId: sessionB,
      sequenceNo: 1,
      text: 'src/worker/process.ts の経緯 RRF-QUERY',
    });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const result = await readStoredResult(pool, seeded.requestId);
    const matches = result.matches ?? [];
    assert.ok(matches.length >= 1, 'matchedなのにmatchesがない');
    const topEvidence = matches[0]?.evidence ?? [];
    assert.ok(
      topEvidence.some((evidence) => evidence.message_id === combo.messageId),
      'RRF統合で複数経路の候補が単一経路の1位より上位になっていない',
    );
    const jevBody = allJevRawBody(jev);
    assert.equal(countOccurrences(jevBody, 'RRF-COMBO'), 1, '同一documentをvector/識別子両経路からJevへ重複投入した');
    assert.equal(countOccurrences(jevBody, 'RRF-VECTOR'), 1, '同一documentをJevへ重複投入した');
    assert.ok(jevBody.includes('src/worker/process.ts'), '識別子がJev候補本文にない');
  });

  it('Jevへ渡す候補は最大10件で、ベクトル順の上位を安定して残す', async () => {
    const queryVector = basisVector(0, 1);
    const { jev, config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const markers = Array.from({ length: 12 }, (_, index) => `M5MAX-${String(index + 1).padStart(2, '0')}`);
    const messageIds: string[] = [];
    for (const [index, marker] of markers.entries()) {
      const text = `${marker} 候補本文`;
      const message = await seedMessage(pool, {
        sessionId: sessionA,
        sequenceNo: index + 1,
        role: 'assistant',
        text: `候補発言-${index + 1}`,
      });
      messageIds.push(message.messageId);
      await seedReadyDocument(pool, {
        companyId: workspace.companyId,
        projectId: workspace.projectId,
        sessionId: sessionA,
        documentKey: `max10-${index + 1}`,
        content: text,
        generationId: generation.id,
        embedding: similarityVector(index + 1),
        sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
      });
    }
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'M5MAX-QUERY 上位10件の確認' });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const jevBody = allJevRawBody(jev);
    const present = markers.filter((marker) => jevBody.includes(marker));
    assert.deepEqual(present, markers.slice(0, 10), `Jevへ渡す候補が最大10件の上位順でない: ${JSON.stringify(present)}`);
    const result = await readStoredResult(pool, seeded.requestId);
    assert.ok(
      (result.matches?.[0]?.evidence ?? []).some((evidence) => evidence.message_id === messageIds[0]),
      'RRF 1位の候補が代表evidenceになっていない',
    );
    const warnings = (result.warnings ?? []) as { code?: string; excluded_count?: number }[];
    assert.ok(
      warnings.some((warning) => warning.code === 'candidate_limit_exceeded' && warning.excluded_count === 2),
      `10件上限の除外warningがない: ${JSON.stringify(result.warnings)}`,
    );
  });

  it('合計8,000トークン超の候補は安定順の末尾から除外しwarningへ記録する', async () => {
    const queryVector = basisVector(0, 1);
    const { jev, config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const tokenizer = await loadVoyageTokenizer();
    const tokenText = exactTokenText(tokenizer, 1_100);
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const markers = Array.from({ length: 8 }, (_, index) => `BUDGET-${index + 1}`);
    for (const [index, marker] of markers.entries()) {
      const text = `${marker} ${tokenText}`;
      const message = await seedMessage(pool, {
        sessionId: sessionA,
        sequenceNo: index + 1,
        role: 'assistant',
        text: `予算候補-${index + 1}`,
      });
      await seedReadyDocument(pool, {
        companyId: workspace.companyId,
        projectId: workspace.projectId,
        sessionId: sessionA,
        documentKey: `budget-${index + 1}`,
        content: text,
        generationId: generation.id,
        embedding: similarityVector(index + 1),
        sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
      });
    }
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'BUDGET-QUERY 予算超過の確認' });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const result = await readStoredResult(pool, seeded.requestId);
    assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0, '予算除外のwarningがresult.warningsにない');
    assert.ok(
      (result.warnings as { code?: string }[]).some((warning) => warning.code === 'candidate_token_budget_exceeded'),
      `token予算超過のwarning codeがない: ${JSON.stringify(result.warnings)}`,
    );
    const jevBody = allJevRawBody(jev);
    assert.ok(jevBody.includes(markers[0]), '安定順の先頭候補を予算内に残していない');
    assert.ok(!jevBody.includes(markers[7]), '8,000トークン超でも末尾候補をJevへ送っている');
  });

  it('Jev本文予算は現在質問と候補の合計で数え、質問分を超える末尾候補をwarningで除外する', async () => {
    const queryVector = basisVector(0, 1);
    const { jev, config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const tokenizer = await loadVoyageTokenizer();
    const questionText = `${exactTokenText(tokenizer, 4_000)} QBUDGET`;
    const candidateText = exactTokenText(tokenizer, 3_000);
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const markers = ['QBUDGET-A', 'QBUDGET-B'];
    for (const [index, marker] of markers.entries()) {
      const text = `${marker} ${candidateText}`;
      const message = await seedMessage(pool, {
        sessionId: sessionA,
        sequenceNo: index + 1,
        role: 'assistant',
        text: `質問予算候補-${index + 1}`,
      });
      await seedReadyDocument(pool, {
        companyId: workspace.companyId,
        projectId: workspace.projectId,
        sessionId: sessionA,
        documentKey: `question-budget-${index + 1}`,
        content: text,
        generationId: generation.id,
        embedding: similarityVector(index + 1),
        sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
      });
    }
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: questionText });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const jevBody = allJevRawBody(jev);
    assert.ok(jevBody.includes(markers[0]), '質問分を引いた予算内の先頭候補をJevへ送っていない');
    assert.ok(!jevBody.includes(markers[1]), '現在質問を含めた予算を超えても末尾候補をJevへ送っている');
    const result = await readStoredResult(pool, seeded.requestId);
    const warnings = (result.warnings ?? []) as { code?: string; excluded_count?: number }[];
    assert.ok(
      warnings.some((warning) => warning.code === 'candidate_token_budget_exceeded' && (warning.excluded_count ?? 0) >= 1),
      `質問分を含むtoken予算の除外warningがない: ${JSON.stringify(result.warnings)}`,
    );
  });

  it('現在質問だけで8,000 tokenを使い切る場合はinput_budget_exceededの恒久failedにし、no_matchにしない', async () => {
    const queryVector = basisVector(0, 1);
    const { jev, config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const tokenizer = await loadVoyageTokenizer();
    // 既存fixtureの語列長では8,000 tokenを1回で作れないため、予算を使い切る長さへ連結する。
    const questionText = `${exactTokenText(tokenizer, 4_000)} ${exactTokenText(tokenizer, 4_000)} ${exactTokenText(tokenizer, 100)}`;
    assert.ok(tokenizer.encode(questionText).ids.length >= 8_000, '8,000 token以上の質問fixtureを作れない');
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const text = 'INPUT-BUDGET-CANDIDATE 候補本文';
    const message = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'input-budget-candidate',
      content: text,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: questionText });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const job = await readJob(pool, seeded.jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'input_budget_exceeded');
    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'failed');
    assert.equal(request.error_code, 'input_budget_exceeded');
    assert.notEqual(request.outcome, 'no_match');
    assert.equal(request.result, null);
    assert.equal(jev.requests.length, 0, '質問だけで予算超過なのにJevへ送信した');
  });

  it('同じ原文範囲の重複候補はJevへ1件にまとめ、結果evidenceにも重複させない', async () => {
    const queryVector = basisVector(0, 1);
    const { jev, config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const text = 'DUP-RANGE 同じ原文窓の候補本文';
    const message = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text: '重複範囲の元発言本文' });
    for (const suffix of ['a', 'b']) {
      await seedReadyDocument(pool, {
        companyId: workspace.companyId,
        projectId: workspace.projectId,
        sessionId: sessionA,
        documentKey: `dup-range-${suffix}`,
        content: text,
        generationId: generation.id,
        embedding: queryVector,
        sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
      });
    }
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'DUP-QUERY 重複範囲の確認' });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const jevBody = allJevRawBody(jev);
    assert.equal(countOccurrences(jevBody, 'DUP-RANGE'), 1, '同じ原文範囲の重複候補をJevへ複数投入した');
    const result = await readStoredResult(pool, seeded.requestId);
    const evidenceCount = (result.matches ?? [])
      .flatMap((match) => match.evidence ?? [])
      .filter((evidence) => evidence.message_id === message.messageId).length;
    assert.equal(evidenceCount, 1, '同じ原文範囲のevidenceを結果へ重複保存した');
    const warnings = (result.warnings ?? []) as { code?: string; excluded_count?: number }[];
    assert.ok(
      warnings.some((warning) => warning.code === 'duplicate_source_range_excluded' && warning.excluded_count === 1),
      `同じ原文範囲の重複除外warningがない: ${JSON.stringify(result.warnings)}`,
    );
  });
});

describe('M5 独立候補判定', () => {
  it('overall relevanceと6つの独立Choiceを候補ごとに評価し、positiveをreason code・statement_statusを別fieldで残す', async () => {
    const queryVector = basisVector(0, 1);
    const selectByQuestion: JevChoiceSelector = (question) => {
      const field = question.id.split(':')[0] ?? question.id;
      switch (field) {
        case 'candidate_relevance':
          return 'useful';
        case 'candidate_target_match':
          return 'yes';
        case 'candidate_similar_symptom_or_request':
          return 'no';
        case 'candidate_similar_constraints':
          return 'yes';
        case 'candidate_implementation_rationale':
          return 'no';
        case 'candidate_reusable_procedure':
          return 'yes';
        case 'candidate_statement_status':
          return 'reported_verified';
        default:
          return undefined;
      }
    };
    const { config } = await startProviders(pool, workspace.companyId, {
      jevResponder: (request) => ({ body: jevReply(request, selectByQuestion) }),
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const text = 'INDEPENDENT-CANDIDATE 独立判定の候補';
    const message = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'independent-candidate',
      content: text,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'INDEPENDENT-QUERY' });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const result = await readStoredResult(pool, seeded.requestId);
    const evaluations = (result.candidate_evaluations ?? []) as Array<{
      document_id?: string;
      revision?: number;
      relevance?: string;
      relevance_kind?: string[];
      statement_status?: string;
      adopted?: boolean;
      answers?: Record<string, { choice?: string; probabilities?: Record<string, number>; confidence?: number }>;
    }>;
    assert.equal(evaluations.length, 1, 'candidate_evaluationがない');
    const evaluation = evaluations[0];
    assert.equal(evaluation.document_id !== undefined, true);
    assert.equal(evaluation.relevance, 'useful');
    assert.deepEqual(evaluation.relevance_kind, ['target_match', 'similar_constraints', 'reusable_procedure']);
    assert.equal(evaluation.statement_status, 'reported_verified');
    assert.equal(evaluation.adopted, true);
    const answers = evaluation.answers ?? {};
    assert.equal(answers.overall?.choice, 'useful');
    assert.equal(answers.statement_status?.choice, 'reported_verified');
    for (const kind of [
      'overall',
      'target_match',
      'similar_symptom_or_request',
      'similar_constraints',
      'implementation_rationale',
      'reusable_procedure',
      'statement_status',
    ]) {
      const answer = answers[kind];
      assert.ok(answer, `${kind}のraw answerがない`);
      const probabilities = answer.probabilities ?? {};
      assert.ok(Object.keys(probabilities).length >= 2, `${kind}のprobabilitiesがない`);
      const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
      assert.ok(Math.abs(total - 1) < 0.01, `${kind}のprobabilities合計が1でない`);
      assert.ok(typeof answer.confidence === 'number' && answer.confidence >= 0 && answer.confidence <= 1);
    }
    const match = result.matches?.[0];
    assert.equal(match?.relevance, 'useful');
    assert.deepEqual(match?.relevance_kind, ['target_match', 'similar_constraints', 'reusable_procedure']);
    assert.equal(match?.statement_status, 'reported_verified');
    assert.equal(match?.claim_status, 'agent_reported', 'reported_verifiedをエージェント報告のclaim_statusへ格上げした');
  });
});

describe('M5 no_match', () => {
  it('検索可能な公開文書がなければcompleted/no_matchにする', async () => {
    const { config } = await startProviders(pool, workspace.companyId, { jevMode: 'direct' });
    await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: '文書なしの検索' });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'no_match');
    const result = await readStoredResult(pool, seeded.requestId);
    assert.equal(result.outcome, 'no_match');
    assert.equal(result.matches?.length ?? 0, 0, 'no_matchなのにmatchesがある');
  });

  it('active generationがなければ外部送信なしでcompleted/no_matchにする', async () => {
    const { jev, voyage, config } = await startProviders(pool, workspace.companyId, { jevMode: 'direct' });
    assert.equal(
      (await pool.query<{ active_generation_id: string | null }>('SELECT active_generation_id FROM projects WHERE id = $1', [
        workspace.projectId,
      ])).rows[0]?.active_generation_id,
      null,
    );
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: '世代なしの検索' });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'no_match');
    const result = await readStoredResult(pool, seeded.requestId);
    assert.equal(result.outcome, 'no_match');
    assert.equal(result.matches?.length ?? 0, 0);
    assert.equal(voyage.requests.length, 0, '世代なしでVoyageへ送信した');
    assert.equal(jev.requests.length, 0, '世代なしでJevへ送信した');
  });

  it('Jevが全候補をunrelated/peripheralと判定したらcompleted/no_matchにする', async () => {
    const queryVector = basisVector(0, 1);
    const { jev, voyage, config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'no_match',
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const text = 'UNRELATED-CANDIDATE 周辺的な候補本文';
    const message = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'unrelated-candidate',
      content: text,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'UNRELATED-QUERY 判定の確認' });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'no_match');
    const result = await readStoredResult(pool, seeded.requestId);
    assert.equal(result.outcome, 'no_match');
    assert.equal(result.matches?.length ?? 0, 0, 'unrelated判定なのにmatchesがある');
    const evaluations = (result.candidate_evaluations ?? []) as Array<{
      relevance?: string;
      statement_status?: string;
      adopted?: boolean;
      answers?: Record<string, { choice?: string; probabilities?: Record<string, number>; confidence?: number }>;
    }>;
    assert.equal(evaluations.length, 1, 'no_matchでも判定済み候補のraw evaluationを残していない');
    assert.equal(evaluations[0]?.relevance, 'unrelated');
    assert.equal(evaluations[0]?.statement_status, 'unknown');
    assert.equal(evaluations[0]?.adopted, false, 'no_match候補をadoptedにした');
    const overall = evaluations[0]?.answers?.overall;
    assert.ok(overall, 'no_match候補のoverall raw answerがない');
    assert.ok(Object.keys(overall.probabilities ?? {}).length >= 2, 'no_match候補のprobabilitiesがない');
    assert.ok(typeof overall.confidence === 'number', 'no_match候補のconfidenceがない');
    assert.equal(voyage.requests.filter((item) => item.body.input_type === 'query').length, 1, '候補取得のquery埋め込みをしていない');
    assert.ok(jev.requests.length >= 1, '候補ありなのにJev判定していない');
  });
});

describe('M5 承認と障害', () => {
  for (const approvalCase of [
    { name: 'Voyage/Jev両方未承認', approveJev: false, approveVoyage: false, voyageCalls: 0 },
    { name: 'Voyageだけ未承認', approveJev: true, approveVoyage: false, voyageCalls: 0 },
  ]) {
    it(`${approvalCase.name}ならblocked_policyにし、検索をfailed/provider_policy_unverifiedへ反映する`, async () => {
      const { jev, voyage, config } = await startProviders(pool, workspace.companyId, {
        approveJev: approvalCase.approveJev,
        approveVoyage: approvalCase.approveVoyage,
      });
      const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
      const sessionA = await seedSession(pool, workspace);
      const text = 'POLICY-CANDIDATE 承認確認の候補';
      const message = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text });
      await seedReadyDocument(pool, {
        companyId: workspace.companyId,
        projectId: workspace.projectId,
        sessionId: sessionA,
        documentKey: 'policy-candidate',
        content: text,
        generationId: generation.id,
        embedding: basisVector(0, 1),
        sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
      });
      const sessionB = await seedSession(pool, workspace);
      const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'POLICY-QUERY 承認確認' });
      await runExecuteSearch(pool, { jobId: seeded.jobId, config });

      const job = await readJob(pool, seeded.jobId);
      assert.equal(job.status, 'blocked_policy', '未承認をblocked_policyにしていない');
      assert.equal(job.error_code, 'provider_policy_unverified');
      const request = await readSearchRequest(pool, seeded.requestId);
      assert.equal(request.status, 'failed', '未承認をfailedへ反映していない');
      assert.equal(request.error_code, 'provider_policy_unverified');
      assert.notEqual(request.outcome, 'no_match');
      assert.equal(request.result, null);
      assert.equal(voyage.requests.length, approvalCase.voyageCalls, '未承認なのにVoyageへ送信した');
      assert.equal(jev.requests.length, 0, '未承認なのにJevへ送信した');
    });
  }

  it('Jevだけ未承認ならVoyage query後にblocked_policyにし、no_matchにしない', async () => {
    const queryVector = basisVector(0, 1);
    const { jev, voyage, config } = await startProviders(pool, workspace.companyId, {
      approveJev: false,
      approveVoyage: true,
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const text = 'POLICY-JEV-CANDIDATE 承認確認の候補';
    const message = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'policy-jev-candidate',
      content: text,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'POLICY-JEV-QUERY' });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const job = await readJob(pool, seeded.jobId);
    assert.equal(job.status, 'blocked_policy');
    assert.equal(job.error_code, 'provider_policy_unverified');
    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'failed');
    assert.equal(request.error_code, 'provider_policy_unverified');
    assert.notEqual(request.outcome, 'no_match');
    assert.equal(jev.requests.length, 0, 'Jev未承認なのに送信した');
    assert.equal(voyage.requests.filter((item) => item.body.input_type === 'query').length, 1, 'Voyage queryを実行していない');
  });

  it('retryJobはexecute_searchにVoyageとJev両方の承認を要求する', async () => {
    const { config } = await startProviders(pool, workspace.companyId, { approveJev: false, approveVoyage: false });
    await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'RETRY-QUERY' });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });
    assert.equal((await readJob(pool, seeded.jobId)).status, 'blocked_policy');

    await seedApproval(pool, { companyId: workspace.companyId, endpoint: config.apiUrl, accountRef: JEV_ACCOUNT });
    assert.equal(await retryJob(pool, seeded.jobId, config), false, 'Jev承認だけでexecute_searchを再開した');
    assert.equal((await readJob(pool, seeded.jobId)).status, 'blocked_policy');
    assert.equal((await readSearchRequest(pool, seeded.requestId)).status, 'failed');

    await seedApproval(pool, {
      companyId: workspace.companyId,
      provider: VOYAGE_PROVIDER,
      endpoint: config.voyageApiUrl,
      accountRef: VOYAGE_ACCOUNT,
    });
    assert.equal(await retryJob(pool, seeded.jobId, config), true, '両承認があっても再開できない');
    assert.equal((await readJob(pool, seeded.jobId)).status, 'pending');
    assert.equal((await readSearchRequest(pool, seeded.requestId)).status, 'pending');
  });
});

describe('M5 provider障害の分類', () => {
  interface ErrorCase {
    name: string;
    voyageResponder?: (request: FakeVoyageRequest) => FakeVoyageReply;
    jevResponder?: (request: JevRequest) => FakeJevReply;
    voyageRequestTimeoutMs?: number;
    expectedJobStatus: string;
    expectedCode: string;
    expectedVoyageCalls: number;
    expectedJevCalls: number;
  }

  const errorCases: ErrorCase[] = [
    {
      name: 'Voyage 429はretryableとしてpendingへ戻しsearch failedへ記録する',
      voyageResponder: () => ({ status: 429, headers: { 'retry-after': '1' }, body: {} }),
      expectedJobStatus: 'pending',
      expectedCode: 'provider_rate_limited',
      expectedVoyageCalls: 1,
      expectedJevCalls: 0,
    },
    {
      name: 'Voyage 5xxはretryableとしてpendingへ戻しsearch failedへ記録する',
      voyageResponder: () => ({ status: 500, body: {} }),
      expectedJobStatus: 'pending',
      expectedCode: 'provider_unavailable',
      expectedVoyageCalls: 1,
      expectedJevCalls: 0,
    },
    {
      name: 'Voyage timeoutはretryableとしてpendingへ戻しsearch failedへ記録する',
      voyageResponder: (request) => ({ delayMs: 1_000, body: voyageBody(request.input ?? [], () => basisVector(0)) }),
      voyageRequestTimeoutMs: 200,
      expectedJobStatus: 'pending',
      expectedCode: 'provider_timeout',
      expectedVoyageCalls: 1,
      expectedJevCalls: 0,
    },
    {
      name: 'Voyage応答契約不正はfailedとして保持しno_matchにしない',
      voyageResponder: (request) => ({ body: voyageBody(request.input ?? [], () => new Array<number>(VOYAGE_DIMENSIONS).fill(0)) }),
      expectedJobStatus: 'failed',
      expectedCode: 'provider_contract_invalid',
      expectedVoyageCalls: 1,
      expectedJevCalls: 0,
    },
    {
      name: 'Jev 5xxはretryableとしてpendingへ戻しsearch failedへ記録する',
      jevResponder: () => ({ status: 503, body: {} }),
      expectedJobStatus: 'pending',
      expectedCode: 'provider_unavailable',
      expectedVoyageCalls: 1,
      expectedJevCalls: 1,
    },
    {
      name: 'Jev応答契約不正はfailedとして保持しno_matchにしない',
      jevResponder: () => ({ body: {} }),
      expectedJobStatus: 'failed',
      expectedCode: 'provider_contract_invalid',
      expectedVoyageCalls: 1,
      expectedJevCalls: 1,
    },
  ];

  for (const errorCase of errorCases) {
    it(errorCase.name, async () => {
      const queryVector = basisVector(0, 1);
      const { jev, voyage, config } = await startProviders(pool, workspace.companyId, {
        jevMode: 'direct',
        jevResponder: errorCase.jevResponder,
        voyageResponder: errorCase.voyageResponder ?? vectorQueryResponder(queryVector),
        voyageRequestTimeoutMs: errorCase.voyageRequestTimeoutMs,
      });
      const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
      const sessionA = await seedSession(pool, workspace);
      const text = 'ERROR-CASE 候補本文';
      const message = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text });
      await seedReadyDocument(pool, {
        companyId: workspace.companyId,
        projectId: workspace.projectId,
        sessionId: sessionA,
        documentKey: `error-${errorCase.expectedCode}-${errorCase.expectedJobStatus}`,
        content: text,
        generationId: generation.id,
        embedding: queryVector,
        sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
      });
      const sessionB = await seedSession(pool, workspace);
      const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'ERROR-QUERY' });
      await runExecuteSearch(pool, { jobId: seeded.jobId, config });

      const job = await readJob(pool, seeded.jobId);
      assert.equal(job.status, errorCase.expectedJobStatus, `job statusが違う: ${errorCase.name}`);
      assert.equal(job.error_code, errorCase.expectedCode);
      const request = await readSearchRequest(pool, seeded.requestId);
      assert.equal(request.status, 'failed', 'provider障害をfailedへ反映していない');
      assert.equal(request.error_code, errorCase.expectedCode);
      assert.notEqual(request.outcome, 'no_match');
      assert.equal(request.result, null);
      assert.equal(voyage.requests.length, errorCase.expectedVoyageCalls);
      assert.equal(jev.requests.length, errorCase.expectedJevCalls);
    });
  }
});

describe('M5 実行状態と障害対象', () => {
  it('execute_searchは外部HTTPの前にrequestをrunningにし、完了後にcompletedへする', async () => {
    const queryVector = basisVector(0, 1);
    const gate = createExternalGate();
    gate.armed = true;
    const { config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      voyageResponder: async (request) => {
        if (gate.armed) {
          gate.armed = false;
          gate.enter();
          await gate.waitRelease();
        }
        return vectorQueryResponder(queryVector)(request);
      },
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const text = 'RUNNING-CANDIDATE 実行状態の候補';
    const message = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'running-status',
      content: text,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'RUNNING-QUERY' });
    const job = await claimExecuteJob(pool, seeded.jobId);
    const processing = processJob(pool, job, config);
    const entered = await waitForGateOrProcessing(gate, processing, EXTERNAL_WAIT_TIMEOUT_MS);
    if (entered) {
      const running = await readSearchRequest(pool, seeded.requestId);
      assert.equal(running.status, 'running', '外部HTTP前にsearch_requestがrunningでない');
      assert.equal(running.error_code, null);
      assert.equal(running.outcome, null);
      gate.release();
    }
    await processing;
    assert.ok(entered, 'Voyage query埋め込みまで到達しなかった（runningを観測できない）');

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    assert.equal(request.error_code, null);
    assert.equal((await readJob(pool, seeded.jobId)).status, 'completed');
  });

  it('execute_search障害はpayloadのrequestだけをfailedにし、別auto/manual requestを巻き込まない', async () => {
    const { config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      voyageResponder: (request) => ({ body: voyageBody(request.input ?? [], () => new Array<number>(VOYAGE_DIMENSIONS).fill(0)) }),
    });
    await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionB = await seedSession(pool, workspace);
    const targetMessage = await seedMessage(pool, { sessionId: sessionB, sequenceNo: 1, role: 'user', text: 'SCOPE-ERROR-QUERY' });
    const unrelatedRequestId = await seedSearchRequest(pool, {
      workspace,
      sessionId: sessionB,
      inputId: targetMessage.messageId,
      inputRevision: targetMessage.revision,
      sequenceNo: 1,
      searchAction: 'new_search',
    });
    await pool.query("UPDATE search_requests SET status = 'failed', error_code = 'seed-unrelated' WHERE id = $1", [unrelatedRequestId]);
    const manualRequestId = await seedSearchRequest(pool, {
      workspace,
      sessionId: sessionB,
      inputId: targetMessage.messageId,
      inputRevision: targetMessage.revision,
      sequenceNo: 1,
      trigger: 'manual',
      searchAction: 'new_search',
    });
    const targetRequestId = await seedSearchRequest(pool, {
      workspace,
      sessionId: sessionB,
      inputId: targetMessage.messageId,
      inputRevision: targetMessage.revision,
      sequenceNo: 1,
      policyVersion: 'm5-other-policy',
      searchAction: 'new_search',
    });
    const jobId = await enqueueJob(pool, {
      kind: 'execute_search',
      idempotencyKey: `execute_search:payload-scope:${targetRequestId}`,
      priority: EXECUTE_SEARCH_PRIORITY,
      sessionId: sessionB,
      messageId: targetMessage.messageId,
      targetRevision: targetMessage.revision,
      payload: { search_request_id: targetRequestId },
    });
    await pool.query('UPDATE jobs SET next_run_at = LEAST(next_run_at, now()) WHERE id = $1', [jobId]);
    await runExecuteSearch(pool, { jobId, config });

    const target = await readSearchRequest(pool, targetRequestId);
    assert.equal(target.status, 'failed');
    assert.equal(target.error_code, 'provider_contract_invalid');
    const unrelated = await readSearchRequest(pool, unrelatedRequestId);
    assert.equal(unrelated.status, 'failed');
    assert.equal(unrelated.error_code, 'seed-unrelated', 'payload外のauto requestを障害更新した');
    assert.equal((await readSearchRequest(pool, manualRequestId)).status, 'pending');

    assert.equal(await retryJob(pool, jobId, config), true);
    assert.equal((await readSearchRequest(pool, targetRequestId)).status, 'pending');
    const unrelatedAfterRetry = await readSearchRequest(pool, unrelatedRequestId);
    assert.equal(unrelatedAfterRetry.status, 'failed');
    assert.equal(unrelatedAfterRetry.error_code, 'seed-unrelated', 'retryJobがpayload外のauto requestを再開した');
    assert.equal((await readSearchRequest(pool, manualRequestId)).status, 'pending');
  });

  it('payloadが不正なexecute_searchは無関係requestをfailedにしない', async () => {
    const { config } = await startProviders(pool, workspace.companyId, { jevMode: 'direct' });
    await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionB = await seedSession(pool, workspace);
    const message = await seedMessage(pool, { sessionId: sessionB, sequenceNo: 1, role: 'user', text: 'INVALID-PAYLOAD-QUERY' });
    const requestId = await seedSearchRequest(pool, {
      workspace,
      sessionId: sessionB,
      inputId: message.messageId,
      inputRevision: message.revision,
      sequenceNo: 1,
      searchAction: 'new_search',
    });
    const jobId = await enqueueJob(pool, {
      kind: 'execute_search',
      idempotencyKey: `execute_search:invalid-payload:${uuidv7()}`,
      priority: EXECUTE_SEARCH_PRIORITY,
      sessionId: sessionB,
      messageId: message.messageId,
      targetRevision: message.revision,
      payload: {},
    });
    await pool.query('UPDATE jobs SET next_run_at = LEAST(next_run_at, now()) WHERE id = $1', [jobId]);
    await runExecuteSearch(pool, { jobId, config });

    const job = await readJob(pool, jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'target_missing');
    const request = await readSearchRequest(pool, requestId);
    assert.equal(request.status, 'pending', 'payload不正なexecute_searchが無関係requestをfailedにした');
    assert.equal(request.error_code, null);

    assert.equal(await retryJob(pool, jobId, config), false, 'payload空でretryJobが再開した');
    const jobAfter = await readJob(pool, jobId);
    assert.equal(jobAfter.status, 'failed');
    assert.equal(jobAfter.error_code, 'target_missing');
    assert.equal((await readSearchRequest(pool, requestId)).status, 'pending');
  });

  it('payloadが同案件の別inputを指す場合は無関係requestをfailedへせず、retryJobもfalseにする', async () => {
    const { config } = await startProviders(pool, workspace.companyId, { jevMode: 'direct' });
    const sessionB = await seedSession(pool, workspace);
    const targetMessage = await seedMessage(pool, { sessionId: sessionB, sequenceNo: 1, role: 'user', text: 'SCOPE-B-TARGET' });
    const otherMessage = await seedMessage(pool, { sessionId: sessionB, sequenceNo: 2, role: 'user', text: 'SCOPE-B-OTHER' });
    const otherRequestId = await seedSearchRequest(pool, {
      workspace,
      sessionId: sessionB,
      inputId: otherMessage.messageId,
      inputRevision: otherMessage.revision,
      sequenceNo: 2,
      searchAction: 'new_search',
    });
    await pool.query("UPDATE search_requests SET status = 'failed', error_code = 'seed-other', result = $2::jsonb WHERE id = $1", [
      otherRequestId,
      JSON.stringify({ marker: 'keep' }),
    ]);
    const jobId = await enqueueJob(pool, {
      kind: 'execute_search',
      idempotencyKey: `execute_search:scope-other-input:${otherRequestId}`,
      priority: EXECUTE_SEARCH_PRIORITY,
      sessionId: sessionB,
      messageId: targetMessage.messageId,
      targetRevision: targetMessage.revision,
      payload: { search_request_id: otherRequestId },
    });
    await pool.query('UPDATE jobs SET next_run_at = LEAST(next_run_at, now()) WHERE id = $1', [jobId]);
    await runExecuteSearch(pool, { jobId, config });

    const job = await readJob(pool, jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'target_missing');
    const otherBefore = await readSearchRequest(pool, otherRequestId);
    assert.equal(otherBefore.status, 'failed');
    assert.equal(otherBefore.error_code, 'seed-other');

    assert.equal(await retryJob(pool, jobId, config), false, 'scope不一致のpayloadでretryJobが再開した');
    const jobAfter = await readJob(pool, jobId);
    assert.equal(jobAfter.status, 'failed');
    assert.equal(jobAfter.error_code, 'target_missing');
    const otherAfter = await readSearchRequest(pool, otherRequestId);
    assert.equal(otherAfter.status, 'failed');
    assert.equal(otherAfter.error_code, 'seed-other', 'scope不一致のpayloadで無関係requestを更新した');
    assert.deepEqual(otherAfter.result, { marker: 'keep' }, 'scope不一致のpayloadで無関係requestのresultを変えた');
  });

  it('payloadが別案件requestを指す場合も無関係requestを更新しない', async () => {
    const { config } = await startProviders(pool, workspace.companyId, { jevMode: 'direct' });
    const targetSession = await seedSession(pool, workspace);
    const targetMessage = await seedMessage(pool, { sessionId: targetSession, sequenceNo: 1, role: 'user', text: 'SCOPE-C-TARGET' });
    const otherProjectId = await insertProject(pool, workspace.companyId, 'repo-scope-other');
    const otherSessionId = await insertSession(pool, { projectId: otherProjectId, employeeId: workspace.employeeId });
    const otherMessage = await seedMessage(pool, { sessionId: otherSessionId, sequenceNo: 1, role: 'user', text: 'SCOPE-C-OTHER' });
    const otherRequestId = await seedSearchRequest(pool, {
      workspace: { ...workspace, projectId: otherProjectId },
      sessionId: otherSessionId,
      inputId: otherMessage.messageId,
      inputRevision: otherMessage.revision,
      sequenceNo: 1,
      searchAction: 'new_search',
    });
    const jobId = await enqueueJob(pool, {
      kind: 'execute_search',
      idempotencyKey: `execute_search:scope-other-project:${otherRequestId}`,
      priority: EXECUTE_SEARCH_PRIORITY,
      sessionId: targetSession,
      messageId: targetMessage.messageId,
      targetRevision: targetMessage.revision,
      payload: { search_request_id: otherRequestId },
    });
    await pool.query('UPDATE jobs SET next_run_at = LEAST(next_run_at, now()) WHERE id = $1', [jobId]);
    await runExecuteSearch(pool, { jobId, config });

    const job = await readJob(pool, jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'target_missing');
    const otherBefore = await readSearchRequest(pool, otherRequestId);
    assert.equal(otherBefore.status, 'pending');
    assert.equal(otherBefore.error_code, null);

    assert.equal(await retryJob(pool, jobId, config), false, '別案件payloadでretryJobが再開した');
    const jobAfter = await readJob(pool, jobId);
    assert.equal(jobAfter.status, 'failed');
    assert.equal(jobAfter.error_code, 'target_missing');
    const otherAfter = await readSearchRequest(pool, otherRequestId);
    assert.equal(otherAfter.status, 'pending', '別案件payloadで無関係requestを更新した');
    assert.equal(otherAfter.error_code, null);
    assert.equal(otherAfter.result, null);
  });
});

describe('M5 stale inputの終端', () => {
  it('process開始時にinputが改訂済みなら外部送信なしでexpiredにし、jobを完了する', async () => {
    const { jev, voyage, config } = await startProviders(pool, workspace.companyId, { jevMode: 'direct' });
    await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'STALE-START 旧input' });
    await advanceRevision(pool, seeded.messageId, 'STALE-START 改訂後input');
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const job = await readJob(pool, seeded.jobId);
    assert.equal(job.status, 'completed', 'stale inputのjobを完了せず再回収対象に残した');
    assert.equal(job.error_code, null);
    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'expired');
    assert.equal(request.error_code, 'input_revision_stale');
    assert.equal(request.outcome, null);
    assert.equal(request.result, null, 'old input revisionの結果を保存した');
    assert.equal(voyage.requests.length, 0, 'stale inputなのにVoyageへ送信した');
    assert.equal(jev.requests.length, 0, 'stale inputなのにJevへ送信した');
    const message = await pool.query<{ current_revision: number }>('SELECT current_revision FROM messages WHERE id = $1', [
      seeded.messageId,
    ]);
    assert.equal(message.rows[0]?.current_revision, 2, '改訂後の新revisionを失った');
    const stored = await pool.query<{ input_revision: number; result: unknown }>(
      'SELECT input_revision, result FROM search_requests WHERE id = $1',
      [seeded.requestId],
    );
    assert.equal(stored.rows[0]?.input_revision, 1, 'old input revisionの受付を新revisionへ流用した');
    assert.equal(stored.rows[0]?.result, null);
  });

  it('候補判定後にinputが改訂されたらold inputの結果を保存せずexpiredにし、jobを完了する', async () => {
    const queryVector = basisVector(0, 1);
    const gate = createExternalGate();
    gate.armed = true;
    const { config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      gate,
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const candidateText = 'STALE-SAVE-CANDIDATE 候補本文';
    const candidate = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text: candidateText });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'stale-save-candidate',
      content: candidateText,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: candidate.messageId, messageRevision: 1, startOffset: 0, endOffset: candidateText.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'STALE-SAVE 旧input' });
    const job = await claimExecuteJob(pool, seeded.jobId);
    const processing = processJob(pool, job, config);
    const entered = await waitForGateOrProcessing(gate, processing, EXTERNAL_WAIT_TIMEOUT_MS);
    if (entered) {
      await advanceRevision(pool, seeded.messageId, 'STALE-SAVE 改訂後input');
      gate.release();
    }
    await processing;
    assert.ok(entered, 'Jev候補判定まで到達しなかった（stale保存経路を検証できない）');

    const jobAfter = await readJob(pool, seeded.jobId);
    assert.equal(jobAfter.status, 'completed', 'stale inputのjobを完了せず再回収対象に残した');
    assert.equal(jobAfter.error_code, null);
    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'expired');
    assert.equal(request.error_code, 'input_revision_stale');
    assert.equal(request.outcome, null);
    assert.equal(request.result, null, 'old input revisionの候補evidenceを保存した');
    const stored = await pool.query<{ input_revision: number; result: unknown }>(
      'SELECT input_revision, result FROM search_requests WHERE id = $1',
      [seeded.requestId],
    );
    assert.equal(stored.rows[0]?.input_revision, 1, 'old input revisionの受付を新revisionへ流用した');
    assert.equal(stored.rows[0]?.result, null);
  });
});

describe('M5 原文revisionの保存TX競合', () => {
  it('改訂が先にcommitした場合は旧evidenceを保存せずno_matchにする', async () => {
    const queryVector = basisVector(0, 1);
    const gate = createExternalGate();
    gate.armed = true;
    const { config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      gate,
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const candidateText = 'TOCTOU-CANDIDATE 改訂競合の候補';
    const candidate = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text: candidateText });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'toctou-update-first',
      content: candidateText,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: candidate.messageId, messageRevision: 1, startOffset: 0, endOffset: candidateText.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'TOCTOU-UPDATE-QUERY' });
    const job = await claimExecuteJob(pool, seeded.jobId);
    const processing = processJob(pool, job, config);
    const entered = await waitForGateOrProcessing(gate, processing, EXTERNAL_WAIT_TIMEOUT_MS);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      // 検索のsave TXをrequest rowで止め、その間に原文revisionの改訂を先にcommitさせる。
      await holder.query('SELECT id FROM search_requests WHERE id = $1 FOR UPDATE', [seeded.requestId]);
      if (entered) {
        await advanceRevision(pool, candidate.messageId, '改訂後 TOCTOU-CANDIDATE-NEW');
        gate.release();
      }
      await sleep(100);
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    await processing;
    assert.ok(entered, 'Jev候補判定まで到達しなかった（競合順序を検証できない）');

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'no_match', '改訂先行なのに旧evidenceをmatched保存した');
    const result = await readStoredResult(pool, seeded.requestId);
    assert.equal(result.matches?.length ?? 0, 0);
    const evaluations = (result.candidate_evaluations ?? []) as Array<{ adopted?: boolean; answers?: unknown }>;
    assert.equal(evaluations.length, 1, '競合時に判定記録を失った');
    assert.equal(evaluations[0]?.adopted, false, '改訂済み候補をadoptedにした');
  });

  it('検索が先に共有lockを取った場合は改訂が検索commitまで待つ', async () => {
    const queryVector = basisVector(0, 1);
    const gate = createExternalGate();
    gate.armed = true;
    const { config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      gate,
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const candidateText = 'TOCTOU-CANDIDATE 共有lockの候補';
    const candidate = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text: candidateText });
    const documentId = await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'toctou-search-first',
      content: candidateText,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: candidate.messageId, messageRevision: 1, startOffset: 0, endOffset: candidateText.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'TOCTOU-SEARCH-QUERY' });
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      // publication rowを止め、検索をsource messageの共有lock取得後・commit前に待たせる。
      await holder.query('SELECT document_id FROM document_publications WHERE document_id = $1 AND generation_id = $2 FOR UPDATE', [
        documentId,
        generation.id,
      ]);
      const job = await claimExecuteJob(pool, seeded.jobId);
      const processing = processJob(pool, job, config);
      const entered = await waitForGateOrProcessing(gate, processing, EXTERNAL_WAIT_TIMEOUT_MS);
      assert.ok(entered, 'Jev候補判定まで到達しなかった（競合順序を検証できない）');
      gate.release();

      const probe = await probeMessageRevisionUpdate(pool, candidate.messageId, 4_000);
      assert.equal(probe, 'blocked', '検索の共有lock中に原文revision更新が待たなかった');
      await holder.query('COMMIT');
      await processing;

      const request = await readSearchRequest(pool, seeded.requestId);
      assert.equal(request.status, 'completed');
      assert.equal(request.outcome, 'matched', '検索先行なのにmatched保存できていない');
      const result = await readStoredResult(pool, seeded.requestId);
      const evidence = (result.matches?.[0]?.evidence ?? []).find((item) => item.message_id === candidate.messageId);
      assert.ok(evidence, '検索先行の旧revision evidenceがない');
      assert.equal(evidence.revision, 1);

      await advanceRevision(pool, candidate.messageId, '検索commit後の改訂');
      const message = await pool.query<{ current_revision: number }>('SELECT current_revision FROM messages WHERE id = $1', [
        candidate.messageId,
      ]);
      assert.equal(message.rows[0]?.current_revision, 2, '検索commit後に改訂できない');
    } finally {
      holder.release();
    }
  });
});

describe('M5 世代固定と再検証', () => {
  it('active generationがprovider specと不一致ならfailed/embedding_generation_mismatchにし、no_matchにしない', async () => {
    const { jev, voyage, config } = await startProviders(pool, workspace.companyId, { jevMode: 'direct' });
    const mismatchGenerationId = await insertGeneration(pool, {
      companyId: workspace.companyId,
      endpoint: config.voyageApiUrl,
      model: 'voyage-other-model',
    });
    await pool.query('UPDATE projects SET active_generation_id = $2, updated_at = now() WHERE id = $1', [
      workspace.projectId,
      mismatchGenerationId,
    ]);
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'MISMATCH-QUERY' });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });

    const job = await readJob(pool, seeded.jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'embedding_generation_mismatch');
    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'failed');
    assert.equal(request.error_code, 'embedding_generation_mismatch');
    assert.notEqual(request.outcome, 'no_match');
    assert.equal(request.result, null);
    assert.equal(voyage.requests.length, 0, '世代不一致なのにVoyageへ送信した');
    assert.equal(jev.requests.length, 0, '世代不一致なのにJevへ送信した');
  });

  it('検索開始時の世代を固定し、外部待ち中のactive generation切替でも旧世代の文書だけを比較する', async () => {
    const queryVector = basisVector(0, 1);
    const gate = createExternalGate();
    gate.armed = true;
    const { jev, config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      voyageResponder: async (request) => {
        if (gate.armed) {
          gate.armed = false;
          gate.enter();
          await gate.waitRelease();
        }
        return vectorQueryResponder(queryVector)(request);
      },
    });
    const generationOne = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const generationTwo = await insertGeneration(pool, { companyId: workspace.companyId, endpoint: config.voyageApiUrl });
    const sessionA = await seedSession(pool, workspace);
    const textOne = 'GEN-ONE 旧世代の文書';
    const messageOne = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text: textOne });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'gen-one',
      content: textOne,
      generationId: generationOne.id,
      embedding: queryVector,
      sources: [{ messageId: messageOne.messageId, messageRevision: 1, startOffset: 0, endOffset: textOne.length }],
    });
    const textTwo = 'GEN-TWO 新世代の文書';
    const messageTwo = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 2, role: 'assistant', text: textTwo });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'gen-two',
      content: textTwo,
      generationId: generationTwo,
      embedding: queryVector,
      sources: [{ messageId: messageTwo.messageId, messageRevision: 1, startOffset: 0, endOffset: textTwo.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'GEN-QUERY 世代固定の確認' });
    const job = await claimExecuteJob(pool, seeded.jobId);
    const processing = processJob(pool, job, config);
    const entered = await waitForGateOrProcessing(gate, processing, EXTERNAL_WAIT_TIMEOUT_MS);
    if (entered) {
      await pool.query('UPDATE projects SET active_generation_id = $2, updated_at = now() WHERE id = $1', [
        workspace.projectId,
        generationTwo,
      ]);
      gate.release();
    }
    await processing;
    assert.ok(entered, 'Voyage query埋め込みまで到達しなかった（M5未実行）');

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const result = await readStoredResult(pool, seeded.requestId);
    assert.ok(evidenceFor(result, messageOne.messageId), '検索開始時に固定した旧世代の文書evidenceがない');
    assert.ok(!JSON.stringify(result).includes('GEN-TWO'), '切替後の新世代文書を結果へ混ぜた');
    assert.ok(!allJevRawBody(jev).includes('GEN-TWO'), '切替後の新世代文書をJev候補へ渡した');
  });

  it('候補判定後に原文revisionが変わったevidenceは保存せずno_matchにする', async () => {
    const queryVector = basisVector(0, 1);
    const gate = createExternalGate();
    gate.armed = true;
    const { config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      gate,
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const text = 'STALE-REV 候補判定後の改訂';
    const message = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'stale-rev',
      content: text,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'STALE-REV-QUERY' });
    const job = await claimExecuteJob(pool, seeded.jobId);
    const processing = processJob(pool, job, config);
    const entered = await waitForGateOrProcessing(gate, processing, EXTERNAL_WAIT_TIMEOUT_MS);
    if (entered) {
      await advanceRevision(pool, message.messageId, '改訂後の本文');
      gate.release();
    }
    await processing;
    assert.ok(entered, 'Jev候補判定まで到達しなかった（M5未実行）');

    const jobAfter = await readJob(pool, seeded.jobId);
    assert.equal(jobAfter.status, 'completed');
    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'no_match');
    const result = await readStoredResult(pool, seeded.requestId);
    assert.equal(result.matches?.length ?? 0, 0, '改訂後に無効evidenceを保存した');
    assert.ok(!JSON.stringify(result).includes('STALE-REV'), '改訂前の原文textを保存した');
    const evaluations = (result.candidate_evaluations ?? []) as Array<{
      relevance?: string;
      adopted?: boolean;
      answers?: Record<string, { choice?: string; probabilities?: Record<string, number>; confidence?: number }>;
    }>;
    assert.equal(evaluations.length, 1, 'invalid候補の判定記録がない');
    assert.equal(evaluations[0]?.adopted, false, 'invalid候補をadoptedとして保存した');
    assert.ok(evaluations[0]?.answers?.overall, 'invalid候補のraw answersがない');
  });

  it('候補判定後にpublicationが消えたevidenceは保存しない', async () => {
    const queryVector = basisVector(0, 1);
    const gate = createExternalGate();
    gate.armed = true;
    const { config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      gate,
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const text = 'STALE-PUB 候補判定後の非公開化';
    const message = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text });
    const documentId = await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'stale-pub',
      content: text,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'STALE-PUB-QUERY' });
    const job = await claimExecuteJob(pool, seeded.jobId);
    const processing = processJob(pool, job, config);
    const entered = await waitForGateOrProcessing(gate, processing, EXTERNAL_WAIT_TIMEOUT_MS);
    if (entered) {
      await pool.query('UPDATE search_documents SET is_searchable = false, updated_at = now() WHERE id = $1', [documentId]);
      await pool.query('DELETE FROM document_publications WHERE document_id = $1', [documentId]);
      gate.release();
    }
    await processing;
    assert.ok(entered, 'Jev候補判定まで到達しなかった（M5未実行）');

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'no_match');
    const result = await readStoredResult(pool, seeded.requestId);
    assert.equal(result.matches?.length ?? 0, 0, '非公開化後に無効evidenceを保存した');
    assert.ok(!JSON.stringify(result).includes('STALE-PUB'), '非公開化した文書を結果へ保存した');
  });

  it('候補判定中にleaseを失った場合はsearch_requestを更新せずrunningのまま残す', async () => {
    const queryVector = basisVector(0, 1);
    const gate = createExternalGate();
    gate.armed = true;
    const { config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      gate,
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const text = 'LEASE-LOST 候補判定中の所有喪失';
    const message = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'lease-lost',
      content: text,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'LEASE-QUERY' });
    const job = await claimExecuteJob(pool, seeded.jobId);
    const processing = processJob(pool, job, config);
    const entered = await waitForGateOrProcessing(gate, processing, EXTERNAL_WAIT_TIMEOUT_MS);
    if (entered) {
      await pool.query('UPDATE jobs SET lease_token = $2, updated_at = now() WHERE id = $1', [job.id, uuidv7()]);
      gate.release();
    }
    await processing;
    assert.ok(entered, 'Jev候補判定まで到達しなかった（M5未実行）');

    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.status, 'running', 'lease喪失時にsearch_requestを完了・失敗・pending化した');
    assert.equal(request.error_code, null);
    assert.equal(request.outcome, null);
    assert.equal(request.result, null);
    const storedJob = await readJob(pool, seeded.jobId);
    assert.equal(storedJob.status, 'running', 'lease喪失後に旧ownerがjobを完了/失敗させた');
    assert.equal(storedJob.error_code, null);
  });
});

describe('M5 冪等とrunner', () => {
  it('execute_searchの再実行・再送でjob/resultを増殖させない', async () => {
    const queryVector = basisVector(0, 1);
    const { config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const text = 'IDEMPOTENT-CANDIDATE 再実行の候補';
    const message = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'idempotent',
      content: text,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'IDEMPOTENT-QUERY' });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });
    const firstResult = await readStoredResult(pool, seeded.requestId);
    assert.equal(firstResult.outcome, 'matched');

    const sameJobId = await enqueueJob(pool, {
      kind: 'execute_search',
      idempotencyKey: `execute_search:${seeded.requestId}:${WORKER_POLICY_VERSION}`,
      priority: EXECUTE_SEARCH_PRIORITY,
      sessionId: sessionB,
      messageId: seeded.messageId,
      targetRevision: seeded.revision,
      payload: { search_request_id: seeded.requestId },
    });
    assert.equal(sameJobId, seeded.jobId, '同じ冪等キーでjobが増殖した');

    await reopenJob(pool, seeded.jobId);
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });
    const secondResult = await readStoredResult(pool, seeded.requestId);
    assert.equal(secondResult.request_id, seeded.requestId);
    assert.equal(secondResult.outcome, firstResult.outcome);
    assert.equal(secondResult.matches?.length ?? 0, firstResult.matches?.length ?? 0);
    assert.equal(await countRows(pool, 'search_requests'), 1, '再実行でsearch_requestが増殖した');
    assert.equal(await countJobsByKind(pool, 'execute_search'), 1, '再実行でexecute_search jobが増殖した');
  });

  it('runWorkerはexecute_searchをclaimして検索を完了する', async () => {
    const queryVector = basisVector(0, 1);
    const { jev, voyage, config } = await startProviders(pool, workspace.companyId, {
      jevMode: 'direct',
      voyageResponder: vectorQueryResponder(queryVector),
    });
    const generation = await ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: workspace.projectId }, config);
    const sessionA = await seedSession(pool, workspace);
    const text = 'RUNNER-CANDIDATE runnerの候補';
    const message = await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'assistant', text });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: sessionA,
      documentKey: 'runner',
      content: text,
      generationId: generation.id,
      embedding: queryVector,
      sources: [{ messageId: message.messageId, messageRevision: 1, startOffset: 0, endOffset: text.length }],
    });
    const sessionB = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: sessionB, sequenceNo: 1, text: 'RUNNER-QUERY' });

    const controller = new AbortController();
    const running = runWorker({ pool, config, pollIntervalMs: 10, signal: controller.signal });
    try {
      await waitFor(async () => (await readSearchRequest(pool, seeded.requestId)).status === 'completed', 3_000);
    } finally {
      controller.abort();
      await running;
    }
    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.outcome, 'matched');
    assert.equal((await readJob(pool, seeded.jobId)).status, 'completed');
    assert.equal(voyage.requests.filter((item) => item.body.input_type === 'query').length, 1);
    assert.ok(jev.requests.length >= 1);
  });
});

describe('M5 entity backfill', () => {
  it('0005適用前のready文書は本文不変のbuild_documents再処理でentityを補充し、Voyage再送・新revision・publication切替を起こさない', async () => {
    await requireM5Tables(pool);
    const { voyage, config } = await startProviders(pool, workspace.companyId, { approveJev: false });
    const sessionId = await seedSession(pool, workspace);
    const message = await seedSearchableMessage(pool, {
      sessionId,
      sequenceNo: 1,
      text: 'BACKFILL src/worker/process.ts の修正',
    });
    await runBuildJob(pool, message.buildJobId, config);

    const documents = await findReadyDocuments(pool, workspace.projectId, 'BACKFILL');
    assert.equal(documents.length, 1, 'backfill対象のready文書がない');
    const documentId = documents[0].id;
    const entityKeys = async (): Promise<string[]> =>
      (
        await pool.query<{ entity_key: string }>('SELECT entity_key FROM document_entities WHERE document_id = $1 ORDER BY entity_key', [
          documentId,
        ])
      ).rows.map((row) => row.entity_key);
    const beforeEntities = await entityKeys();
    assert.ok(beforeEntities.includes('src/worker/process.ts'), `backfill前のentityがない: ${JSON.stringify(beforeEntities)}`);
    const beforeRevisions = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM search_document_revisions WHERE document_id = $1',
      [documentId],
    );
    const beforePublications = await pool.query<{ revision: number; generation_id: string }>(
      'SELECT revision, generation_id FROM document_publications WHERE document_id = $1 ORDER BY generation_id',
      [documentId],
    );
    const beforeEmbeddings = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM document_embeddings WHERE document_id = $1',
      [documentId],
    );
    const voyageCalls = voyage.requests.length;

    // 0005適用前にreadyだった状態を模してentityだけ消す。
    await pool.query('DELETE FROM document_entities WHERE document_id = $1', [documentId]);
    await reopenJob(pool, message.buildJobId);
    await runBuildJob(pool, message.buildJobId, config);

    assert.deepEqual(await entityKeys(), beforeEntities, '本文不変の再処理でentityが補充されていない');
    assert.equal(voyage.requests.length, voyageCalls, 'backfillでVoyageを再送した');
    const afterRevisions = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM search_document_revisions WHERE document_id = $1',
      [documentId],
    );
    assert.equal(afterRevisions.rows[0]?.count, beforeRevisions.rows[0]?.count, 'backfillでrevisionが増えた');
    const afterPublications = await pool.query<{ revision: number; generation_id: string }>(
      'SELECT revision, generation_id FROM document_publications WHERE document_id = $1 ORDER BY generation_id',
      [documentId],
    );
    assert.deepEqual(afterPublications.rows, beforePublications.rows, 'backfillでpublicationが切り替わった');
    const afterEmbeddings = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM document_embeddings WHERE document_id = $1',
      [documentId],
    );
    assert.equal(afterEmbeddings.rows[0]?.count, beforeEmbeddings.rows[0]?.count, 'backfillでembeddingを作り直した');

    // もう一度再処理しても増殖しない。
    await reopenJob(pool, message.buildJobId);
    await runBuildJob(pool, message.buildJobId, config);
    assert.deepEqual(await entityKeys(), beforeEntities, '再実行でentityが増殖した');
  });
});

// ---- tokenizer fixture ----

// 1文字追加ごとにtoken数が増える単純な語列。8,000 token予算の超過fixtureに使う。
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
