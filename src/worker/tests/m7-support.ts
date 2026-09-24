import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { requireDatabaseUrl } from '../../db/pool.js';
import { sha256Bytes, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { EXECUTE_SEARCH_PRIORITY, claimJobs, enqueueJob } from '../../jobs/queue.js';
import { loadWorkerConfig, type WorkerConfig } from '../config.js';
import {
  JEV_API_PATH,
  VOYAGE_API_PATH,
  VOYAGE_DIMENSIONS,
  VOYAGE_MODEL,
  VOYAGE_PROVIDER,
  WORKER_POLICY_VERSION,
  type JevRequest,
} from '../contract.js';
import { processJob } from '../process.js';
import {
  jevReply,
  seedApproval,
  seedMessage,
  seedSearchRequest,
  sleep,
  startFakeJev,
  type FakeJevServer,
  type FakeJevReply,
  type JevChoiceSelector,
} from './support.js';

// M7探索のRedテスト専用support。production exportへ依存せず、loopback provider fixtureと
// 既存migrationの業務tableへready文書・検索受付を作るhelperだけを置く。

export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

// 1024次元の単位基底vector。cosine距離の順位をfixture側で決める。
export function basisVector(index: number, value = 1): number[] {
  const vector = new Array<number>(VOYAGE_DIMENSIONS).fill(0);
  vector[index] = value;
  return vector;
}

// 第1軸との類似度がrankに従って下がるvector。rankが小さいほど距離が近い。
export function similarityVector(rank: number): number[] {
  const vector = basisVector(0, 1);
  vector[1] = rank * 0.01;
  return vector;
}

// ---- loopback Voyage fixture（実Voyage・実会話を送らない） ----

export interface FakeVoyageRequest {
  model?: string;
  input?: string[];
  input_type?: string;
  output_dimension?: number;
  output_dtype?: string;
  truncation?: boolean;
}

export interface FakeVoyageReply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
}

export interface FakeVoyageServer {
  baseUrl: string;
  requests: { url: string; body: FakeVoyageRequest; rawBody: string }[];
  close(): Promise<void>;
}

export async function startFakeVoyage(
  responder: (request: FakeVoyageRequest) => FakeVoyageReply | Promise<FakeVoyageReply>,
): Promise<FakeVoyageServer> {
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

function voyageBody(inputs: readonly string[], vectorFor: (text: string, index: number) => number[]): unknown {
  return {
    object: 'list',
    model: VOYAGE_MODEL,
    data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: vectorFor(text, index) })),
    usage: { total_tokens: inputs.length * 10 },
  };
}

// document埋め込みはindexごとに異なる非ゼロvector、query埋め込みは指定vectorを返す。
export function vectorQueryResponder(queryVector: readonly number[]): (request: FakeVoyageRequest) => FakeVoyageReply {
  return (request) => ({
    body: voyageBody(request.input ?? [], (_text, index) => {
      if (request.input_type === 'query') {
        return [...queryVector];
      }
      const vector = new Array<number>(VOYAGE_DIMENSIONS).fill(0);
      vector[0] = 0.1 + index * 0.1;
      vector[1] = 0.2 + index * 0.05;
      return vector;
    }),
  });
}

// ---- Jev fixture ----

export type M7JevMode = 'positive' | 'primary-only';

// criteriaの選択肢名だけからchoiceを選ぶ。positiveはdirect/useful/yes、primary-onlyは
// primary documentの質問だけpositiveにし、推定探索の質問をnegativeへ倒す。
export function m7ChoiceSelector(mode: M7JevMode, primaryDocumentId?: string): JevChoiceSelector {
  return (question) => {
    const keys = Object.keys(question.criteria);
    const pick = (patterns: RegExp): string | undefined => keys.find((key) => patterns.test(key));
    const isPrimaryQuestion = primaryDocumentId !== undefined && question.id.includes(primaryDocumentId);
    if (mode === 'primary-only' && !isPrimaryQuestion) {
      const negative =
        pick(/unrelated|irrelevant|peripheral|no_match|not_|discontinu|reject|^none$/i) ??
        pick(/^no$/i) ??
        pick(/unknown/i);
      return negative ?? keys[0];
    }
    const positive = pick(/direct|直接/i) ?? pick(/useful|有用/i);
    if (positive !== undefined) {
      return positive;
    }
    const reported = pick(/reported_completed|completed/i);
    if (reported !== undefined) {
      return reported;
    }
    return pick(/^yes$/i) ?? keys.find((key) => !/verified|unknown|no_match|unrelated/i.test(key)) ?? keys[0];
  };
}

export function allJevRawBody(server: FakeJevServer): string {
  return server.requests.map((request) => request.rawBody).join('\n');
}

// ---- 設定・承認・provider起動 ----

export interface M7ProviderOptions {
  jevMode?: M7JevMode;
  primaryDocumentId?: string;
  jevResponder?: (request: JevRequest, rawBody: string) => FakeJevReply | Promise<FakeJevReply>;
  voyageResponder?: (request: FakeVoyageRequest) => FakeVoyageReply | Promise<FakeVoyageReply>;
  approveJev?: boolean;
  approveVoyage?: boolean;
  jevRequestTimeoutMs?: number;
  voyageRequestTimeoutMs?: number;
}

export interface M7Providers {
  jev: FakeJevServer;
  voyage: FakeVoyageServer;
  config: WorkerConfig;
}

const JEV_ACCOUNT = 'acct-a';
const VOYAGE_ACCOUNT = 'voyage-acct-a';

function loadM7Config(input: {
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
    VOYAGE_API_KEY: 'test-voyage-key',
    VOYAGE_ACCOUNT_REF: VOYAGE_ACCOUNT,
    VOYAGE_API_URL: input.voyageEndpoint,
    VOYAGE_REQUEST_TIMEOUT_MS: String(input.voyageRequestTimeoutMs ?? 2_000),
  }).config;
}

// Jev/Voyageのloopback fixtureを起動し、指定に応じて承認を保存してconfigを返す。
export async function startM7Providers(pool: Pool, companyId: string, options: M7ProviderOptions = {}): Promise<M7Providers> {
  const selector = m7ChoiceSelector(options.jevMode ?? 'positive', options.primaryDocumentId);
  const jevResponder = options.jevResponder ?? ((request: JevRequest) => ({ body: jevReply(request, selector) }));
  const jev = await startFakeJev(jevResponder);
  let voyage: FakeVoyageServer | undefined;
  try {
    if (options.approveJev ?? true) {
      await seedApproval(pool, { companyId, endpoint: `${jev.baseUrl}${JEV_API_PATH}`, accountRef: JEV_ACCOUNT });
    }
    voyage = await startFakeVoyage(options.voyageResponder ?? vectorQueryResponder(basisVector(0, 1)));
    if (options.approveVoyage ?? true) {
      await seedApproval(pool, {
        companyId,
        provider: VOYAGE_PROVIDER,
        endpoint: `${voyage.baseUrl}${VOYAGE_API_PATH}`,
        accountRef: VOYAGE_ACCOUNT,
      });
    }
    const config = loadM7Config({
      jevEndpoint: `${jev.baseUrl}${JEV_API_PATH}`,
      voyageEndpoint: `${voyage.baseUrl}${VOYAGE_API_PATH}`,
      jevRequestTimeoutMs: options.jevRequestTimeoutMs,
      voyageRequestTimeoutMs: options.voyageRequestTimeoutMs,
    });
    return { jev, voyage, config };
  } catch (error) {
    // 起動途中のHTTP fixtureを残すとRed確認のtest processが終了しない。
    await voyage?.close();
    await jev.close();
    throw error;
  }
}

// ---- DB fixture ----

export interface M7SeedDocSource {
  messageId: string;
  messageRevision: number;
  startOffset: number;
  endOffset: number;
}

export interface M7SeedDocumentInput {
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
  sources: M7SeedDocSource[];
}

// M4 schemaへready文書を作る。generation/embedding指定時は同世代のembeddingとpublicationも張る。
export async function seedReadyDocument(pool: Pool, input: M7SeedDocumentInput): Promise<string> {
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
     VALUES ($1, $2, $3, $4, 'm7-test', 'ready', $5, $5)`,
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

// 検索対象sessionのuser発言と自動検索受付・execute_search jobを、route_searchの保存形に近づけて作る。
export async function seedExecuteSearch(
  pool: Pool,
  input: {
    workspace: WorkspaceFixture;
    sessionId: string;
    sequenceNo: number;
    text: string;
    occurredAt?: Date;
    trigger?: 'auto' | 'manual';
    question?: string;
  },
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
    trigger: input.trigger,
    question: input.question,
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

// claimしたexecute_search jobを1件だけ処理する。
export async function runExecuteSearch(pool: Pool, input: { jobId: string; config: WorkerConfig }): Promise<void> {
  const [job] = await claimJobs(pool, { kinds: ['execute_search'], limit: 1, leaseMs: 60_000 });
  assert.ok(job, `execute_search jobをclaimできない: ${input.jobId}`);
  assert.equal(job.id, input.jobId, '別のexecute_search jobをclaimした');
  await processJob(pool, job, input.config);
}
