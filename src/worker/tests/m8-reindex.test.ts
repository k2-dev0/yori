import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import {
  addProjectMember,
  insertProject,
  insertSession,
  resetDatabase,
  seedWorkspace,
  sha256Bytes,
  type WorkspaceFixture,
} from '../../db/tests/fixtures.js';
import { BUILD_DOCUMENTS_PRIORITY, claimJobs, enqueueJob } from '../../jobs/queue.js';
import { runCli } from '../cli.js';
import { loadWorkerConfig, type WorkerConfig } from '../config.js';
import { WORKER_POLICY_VERSION } from '../contract.js';
import {
  VOYAGE_DIMENSIONS,
  VOYAGE_DOCUMENT_INPUT_TYPE,
  VOYAGE_METRIC,
  VOYAGE_MODEL,
  VOYAGE_NORMALIZATION,
  VOYAGE_PROVIDER,
  VOYAGE_QUERY_INPUT_TYPE,
  VOYAGE_TOKENIZER_VERSION,
} from '../contract.js';
import { acquireCompanyGenerationLock, ensureActiveGeneration } from '../embedding.js';
import { processJob, retryJob } from '../process.js';
import { deleteGeneration } from '../reindex.js';
import { advanceRevision, readJob, seedApproval, seedMessage, seedSession, readSearchRequest, sleep, type FakeJevServer } from './support.js';
import {
  allJevRawBody,
  basisVector,
  runExecuteSearch,
  seedExecuteSearch,
  seedReadyDocument,
  startM7Providers,
  toVectorLiteral,
  vectorQueryResponder,
  type FakeVoyageReply,
  type FakeVoyageRequest,
  type FakeVoyageServer,
} from './m7-support.js';

// M8のRed契約。実PostgreSQLとloopback Voyage fixtureだけを使い、実Voyage・実会話へ送信しない。
// reindexはproject pointerを選ぶまで旧世代を変えず、完了後にだけ原子的に切り替える。

const VOYAGE_ACCOUNT = 'voyage-acct-a';

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
  for (const server of openServers.splice(0)) {
    await server.close();
  }
});

after(async () => {
  await pool.end();
});

// M8のmigrationが入る前は、後続のassertより先にschema不足を明示してRed理由を固定する。
async function assertM8Structures(pool: Pool): Promise<void> {
  const table = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'reindex_runs'`,
  );
  assert.equal(table.rows.length, 1, '0008_m8.sqlのreindex_runsがない');
  const column = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'search_requests' AND column_name = 'embedding_generation_id'`,
  );
  assert.equal(column.rows.length, 1, 'search_requests.embedding_generation_idがない');
}

function workerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: requireDatabaseUrl(),
    JEV_API_KEY: 'test-key',
    JEV_ACCOUNT_REF: 'acct-a',
    VOYAGE_API_KEY: 'test-voyage-key',
    VOYAGE_ACCOUNT_REF: VOYAGE_ACCOUNT,
    ...overrides,
  };
}

interface ReindexProviders {
  jev: FakeJevServer;
  voyage: FakeVoyageServer;
  config: WorkerConfig;
  env: NodeJS.ProcessEnv;
}

// Jev/Voyageのloopback fixtureと承認を用意し、M8 CLIが使うenvまで返す。
async function startReindexProviders(
  pool: Pool,
  companyId: string,
  responder: (request: FakeVoyageRequest) => FakeVoyageReply | Promise<FakeVoyageReply>,
  options: { approveVoyage?: boolean } = {},
): Promise<ReindexProviders> {
  const providers = await startM7Providers(pool, companyId, {
    jevMode: 'positive',
    voyageResponder: responder,
    approveVoyage: options.approveVoyage ?? true,
  });
  openServers.push(providers.jev, providers.voyage);
  return { ...providers, env: workerEnv({ VOYAGE_API_URL: providers.config.voyageApiUrl }) };
}

async function insertGeneration(
  pool: Pool,
  input: { companyId: string; endpoint: string; status?: string; model?: string },
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

interface SeededDocument {
  documentId: string;
  messageId: string;
  text: string;
}

async function seedDocument(
  pool: Pool,
  input: {
    workspace: WorkspaceFixture;
    sessionId: string;
    sequenceNo: number;
    key: string;
    text: string;
    generationId?: string;
    embedding?: number[];
    searchable?: boolean;
  },
): Promise<SeededDocument> {
  const message = await seedMessage(pool, {
    sessionId: input.sessionId,
    sequenceNo: input.sequenceNo,
    role: 'assistant',
    text: input.text,
  });
  const documentId = await seedReadyDocument(pool, {
    companyId: input.workspace.companyId,
    projectId: input.workspace.projectId,
    sessionId: input.sessionId,
    documentKey: input.key,
    content: input.text,
    isSearchable: input.searchable ?? true,
    generationId: input.generationId,
    embedding: input.embedding,
    sources: [
      {
        messageId: message.messageId,
        messageRevision: message.revision,
        startOffset: 0,
        endOffset: input.text.length,
      },
    ],
  });
  return { documentId, messageId: message.messageId, text: input.text };
}

// 同じdocumentへ次のdesired_revisionをpendingで追加する（再索引中の改訂を模す）。
async function appendDesiredRevision(
  pool: Pool,
  input: { documentId: string; messageId: string; nextRevision: number; content: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO search_document_revisions (document_id, revision, content, content_hash, chunker_version, status)
     VALUES ($1, $2, $3, $4, 'm8-test', 'pending')`,
    [input.documentId, input.nextRevision, input.content, sha256Bytes(input.content)],
  );
  await pool.query(
    `INSERT INTO search_document_sources
       (id, document_id, revision, message_id, message_revision, start_offset, end_offset, display_order, source_kind)
     VALUES ($1, $2, $3, $4, 1, 0, $5, 0, 'original')`,
    [uuidv7(), input.documentId, input.nextRevision, input.messageId, input.content.length],
  );
  await pool.query('UPDATE search_documents SET desired_revision = $2, updated_at = now() WHERE id = $1', [
    input.documentId,
    input.nextRevision,
  ]);
}

async function readActiveGeneration(pool: Pool, projectId: string): Promise<string | null> {
  const result = await pool.query<{ active_generation_id: string | null }>(
    'SELECT active_generation_id FROM projects WHERE id = $1',
    [projectId],
  );
  return result.rows[0]?.active_generation_id ?? null;
}

interface PublishedDocument {
  document_id: string;
  desired_revision: number;
  content: string;
  input_hash: Buffer | null;
  published_revision: number | null;
}

// 現在searchableな文書について、target世代のembedding/publication適用状況を読む。
async function readTargetPublications(pool: Pool, projectId: string, generationId: string): Promise<PublishedDocument[]> {
  const result = await pool.query<PublishedDocument>(
    `SELECT d.id AS document_id, d.desired_revision, r.content, e.input_hash, p.revision AS published_revision
       FROM search_documents d
       JOIN search_document_revisions r ON r.document_id = d.id AND r.revision = d.desired_revision
       LEFT JOIN document_embeddings e ON e.document_id = d.id AND e.revision = d.desired_revision AND e.generation_id = $2
       LEFT JOIN document_publications p ON p.document_id = d.id AND p.generation_id = $2
      WHERE d.project_id = $1 AND d.is_searchable
      ORDER BY d.created_at, d.id`,
    [projectId, generationId],
  );
  return result.rows;
}

interface ReindexRunRow {
  id: string;
  status: string;
  error_code: string | null;
  source_generation_id: string | null;
  target_generation_id: string | null;
}

async function latestReindexRun(pool: Pool, projectId: string): Promise<ReindexRunRow | undefined> {
  const result = await pool.query<ReindexRunRow>(
    `SELECT id, status, error_code, source_generation_id, target_generation_id
       FROM reindex_runs WHERE project_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [projectId],
  );
  return result.rows[0];
}

interface CliProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// metricsのJSON stdoutを検証するためだけにCLIを子processで起動する。
function runCliProcess(argv: string[], env: NodeJS.ProcessEnv): Promise<CliProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker/cli.ts', ...argv], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// test専用gate。pg_locksのgranted=falseを確認して、sleep依存ではなくlock待ちでraceを同期する。
async function waitForLockWaiter(pool: Pool, classId: number, objId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_locks
        WHERE locktype = 'advisory' AND classid::bigint = $1::bigint AND objid::bigint = $2::bigint AND granted = false`,
      [classId, objId],
    );
    if (Number(result.rows[0]?.count ?? '0') > 0) {
      return true;
    }
    await sleep(10);
  }
  return false;
}

// 別projectの初回generation設定が完了したかをDB状態で確認する。
async function waitForProjectGeneration(pool: Pool, projectId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ active_generation_id: string | null }>(
      'SELECT active_generation_id FROM projects WHERE id = $1',
      [projectId],
    );
    if (result.rows[0]?.active_generation_id != null) {
      return true;
    }
    await sleep(10);
  }
  return false;
}

async function waitForNewTargetPublication(
  pool: Pool,
  projectId: string,
  sourceGenerationId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM document_publications p
         JOIN search_documents d ON d.id = p.document_id
        WHERE d.project_id = $1 AND p.generation_id <> $2`,
      [projectId, sourceGenerationId],
    );
    if (Number(result.rows[0]?.count ?? '0') > 0) {
      return true;
    }
    await sleep(10);
  }
  return false;
}

async function waitForReindexRun(pool: Pool, projectId: string, sourceGenerationId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reindex_runs
        WHERE project_id = $1 AND source_generation_id = $2 AND status IN ('pending', 'running', 'blocked_policy')`,
      [projectId, sourceGenerationId],
    );
    if (Number(result.rows[0]?.count ?? '0') > 0) {
      return true;
    }
    await sleep(10);
  }
  return false;
}

// lock待ちのbackendをpg_stat_activityで確認し、sleep依存ではなくDB待ち状態でraceを同期する。
async function waitForBackendWaiting(pool: Pool, queryFragment: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'
          AND query LIKE '%' || $1 || '%'`,
      [queryFragment],
    );
    if (Number(result.rows[0]?.count ?? '0') > 0) {
      return true;
    }
    await sleep(10);
  }
  return false;
}

// build_documents再試行用の検索可能なanalysisとjobを作る。
async function upsertAnalysis(pool: Pool, input: { messageId: string; revision: number }): Promise<void> {
  await pool.query(
    `INSERT INTO message_analysis
       (id, message_id, revision, policy_version, retention, primary_intent, technical_labels, decision_action,
        continuity, statement_status, is_searchable, model_version, state_hash, parts)
     VALUES ($1, $2, $3, $4, 'substantive', 'implementation', '[]'::jsonb, 'none', 'same_topic', 'request', true,
             'test-model', $5, '[]'::jsonb)
     ON CONFLICT (message_id, revision, policy_version) DO UPDATE
       SET retention = EXCLUDED.retention, is_searchable = EXCLUDED.is_searchable, updated_at = now()`,
    [uuidv7(), input.messageId, input.revision, WORKER_POLICY_VERSION, sha256Bytes(`${input.messageId}:${input.revision}`)],
  );
}

async function enqueueBuildJob(pool: Pool, input: { sessionId: string; messageId: string; revision: number }): Promise<string> {
  const jobId = await enqueueJob(pool, {
    kind: 'build_documents',
    idempotencyKey: `build_documents:${input.messageId}:${input.revision}:${WORKER_POLICY_VERSION}`,
    priority: BUILD_DOCUMENTS_PRIORITY,
    sessionId: input.sessionId,
    messageId: input.messageId,
    targetRevision: input.revision,
    payload: { retention: 'substantive', is_searchable: true },
  });
  // host時計とDB時計のskewで直後のclaimが未到来扱いになるのを避け、DB時刻へ揃える。
  await pool.query('UPDATE jobs SET next_run_at = LEAST(next_run_at, now()) WHERE id = $1', [jobId]);
  return jobId;
}

interface MetricsJson {
  project_id: string;
  generations: {
    generation_id: string;
    dimensions: number;
    documents: number;
    vectors: number;
    estimated_vector_bytes: number;
  }[];
  reindex: { pending_documents: number };
  search_duration_ms: { samples: number; p50: number; p95: number };
  jobs: { pending: number; running: number; completed: number; failed: number; blocked_policy: number };
}

describe('M8 CLI契約', () => {
  it('worker:reindex / worker:generation-delete / worker:metrics scriptを提供する', async () => {
    const raw = await readFile(path.join(process.cwd(), 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    assert.ok(pkg.scripts?.['worker:reindex']?.includes('src/worker/cli.ts reindex'), 'worker:reindex scriptがない');
    assert.ok(
      pkg.scripts?.['worker:generation-delete']?.includes('src/worker/cli.ts generation:delete'),
      'worker:generation-delete scriptがない',
    );
    assert.ok(pkg.scripts?.['worker:metrics']?.includes('src/worker/cli.ts metrics'), 'worker:metrics scriptがない');
  });
});

describe('M8 再索引と世代切替', () => {
  it('再索引中は旧generationをactiveに保ち、全searchable文書の完了後だけ切り替える', { timeout: 30_000 }, async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let enterGate!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterGate = resolve;
    });
    let gated = false;
    const { config, env, voyage } = await startReindexProviders(pool, workspace.companyId, async (request) => {
      if (request.input_type === 'document' && !gated) {
        gated = true;
        enterGate();
        await gate;
      }
      return vectorQueryResponder(basisVector(0, 1))(request);
    });
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const sessionId = await seedSession(pool, workspace);
    const first = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 1,
      key: 'm8-a',
      text: 'M8-REINDEX-A',
      generationId: source.id,
      embedding: basisVector(0, 1),
    });
    const second = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 2,
      key: 'm8-b',
      text: 'M8-REINDEX-B',
      generationId: source.id,
      embedding: basisVector(1, 1),
    });
    const revised = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 3,
      key: 'm8-c',
      text: 'M8-REINDEX-C-REV1',
      generationId: source.id,
      embedding: basisVector(2, 1),
    });
    const revisedText = 'M8-REINDEX-C-REV2';
    await appendDesiredRevision(pool, {
      documentId: revised.documentId,
      messageId: revised.messageId,
      nextRevision: 2,
      content: revisedText,
    });
    const excluded = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 4,
      key: 'm8-excluded',
      text: 'M8-REINDEX-EXCLUDED',
      searchable: false,
    });

    const reindexing = runCli(['reindex', workspace.projectId], env);
    const observed = await Promise.race([
      entered.then(() => 'entered' as const),
      sleep(5_000).then(() => 'timeout' as const),
    ]);
    assert.equal(observed, 'entered', 'reindexがdocument埋め込みを開始しなかった（M8未実装または対象文書を読んでいない）');
    assert.equal(
      await readActiveGeneration(pool, workspace.projectId),
      source.id,
      '再索引中にactive_generation_idを切り替えた',
    );
    releaseGate();
    assert.equal(await reindexing, 0, 'reindexが成功終了しなかった');

    const targetId = await readActiveGeneration(pool, workspace.projectId);
    assert.ok(targetId !== null && targetId !== source.id, 'active_generation_idが新世代へ切り替わっていない');
    const target = await pool.query<{ status: string; dimensions: number; model: string }>(
      'SELECT status, dimensions, model FROM embedding_generations WHERE id = $1',
      [targetId],
    );
    assert.equal(target.rows[0]?.status, 'active', '新世代がactiveでない');
    assert.equal(target.rows[0]?.dimensions, VOYAGE_DIMENSIONS, '新世代の次元が現在specと違う');
    assert.equal(target.rows[0]?.model, VOYAGE_MODEL, '新世代のmodelが現在specと違う');

    const run = await latestReindexRun(pool, workspace.projectId);
    assert.ok(run, 'reindex_runsにrunが残っていない');
    assert.equal(run.status, 'completed', '完了runがcompletedでない');
    assert.equal(run.source_generation_id, source.id);
    assert.equal(run.target_generation_id, targetId);

    const published = await readTargetPublications(pool, workspace.projectId, targetId);
    assert.equal(published.length, 3, '現在searchableな文書だけを再索引していない');
    for (const row of published) {
      assert.ok(row.input_hash !== null, `${row.document_id}: target embeddingがない`);
      assert.equal(
        row.published_revision,
        row.desired_revision,
        `${row.document_id}: target publicationが最新desired_revisionと違う`,
      );
      assert.deepEqual(row.input_hash, sha256Bytes(row.content), `${row.document_id}: input_hashが本文と一致しない`);
    }
    const revisedRow = published.find((row) => row.document_id === revised.documentId);
    assert.equal(revisedRow?.content, revisedText, '最新desired_revisionの本文を再索引していない');
    const excludedPublication = await pool.query(
      'SELECT 1 FROM document_publications WHERE document_id = $1 AND generation_id = $2',
      [excluded.documentId, targetId],
    );
    assert.equal(excludedPublication.rows.length, 0, '非searchable文書を新世代へ公開した');
    const oldPublications = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM document_publications WHERE generation_id = $1',
      [source.id],
    );
    assert.equal(Number(oldPublications.rows[0]?.count), 3, '旧世代の公開revisionを削除した');
    const oldStatus = await pool.query<{ status: string }>('SELECT status FROM embedding_generations WHERE id = $1', [source.id]);
    assert.equal(oldStatus.rows[0]?.status, 'retired', '他project参照がない旧世代をretiredにしていない');

    const sent = voyage.requests.flatMap((request) => request.body.input ?? []);
    assert.deepEqual(
      [...sent].sort(),
      [first.text, second.text, revisedText].sort(),
      '再索引の送信本文が現在searchableなdesired revisionと一致しない',
    );
    assert.ok(
      voyage.requests.every((request) => request.body.input_type === 'document'),
      '再索引がdocument以外のinput_typeを送信した',
    );
  });

  it('再索引中の追加・除外を追従し、最新desired_revisionのまま切替える', { timeout: 30_000 }, async () => {
    const concurrent: { mutated: boolean; added?: SeededDocument; excluded?: SeededDocument } = { mutated: false };
    const { config, env } = await startReindexProviders(pool, workspace.companyId, async (request) => {
      if (request.input_type === 'document' && !concurrent.mutated) {
        concurrent.mutated = true;
        // 走査後の追加と除外を作り、cutover前に最新状態を確認させる。
        const addedSession = await seedSession(pool, workspace);
        concurrent.added = await seedDocument(pool, {
          workspace,
          sessionId: addedSession,
          sequenceNo: 1,
          key: 'm8-concurrent-added',
          text: 'M8-CONCURRENT-ADDED',
        });
        assert.ok(concurrent.excluded, '除外対象の文書がない');
        await pool.query('UPDATE search_documents SET is_searchable = false, updated_at = now() WHERE id = $1', [
          concurrent.excluded.documentId,
        ]);
      }
      return vectorQueryResponder(basisVector(0, 1))(request);
    });
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const sessionId = await seedSession(pool, workspace);
    await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 1,
      key: 'm8-concurrent-base',
      text: 'M8-CONCURRENT-BASE',
      generationId: source.id,
      embedding: basisVector(0, 1),
    });
    const excludedDocument = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 2,
      key: 'm8-concurrent-excluded',
      text: 'M8-CONCURRENT-EXCLUDED',
      generationId: source.id,
      embedding: basisVector(1, 1),
    });
    concurrent.excluded = excludedDocument;

    const code = await runCli(['reindex', workspace.projectId], env);
    assert.ok(concurrent.mutated, 'reindexがdocument埋め込みを開始しなかった');
    const addedDocument = concurrent.added;
    assert.ok(addedDocument, '再索引中に追加した文書がない');

    let active = await readActiveGeneration(pool, workspace.projectId);
    if (active === source.id) {
      const refusedRun = await latestReindexRun(pool, workspace.projectId);
      assert.ok(refusedRun, '切替を拒否したrunが残っていない');
      assert.notEqual(refusedRun.status, 'completed', '最新desired_revisionを確認せず再索引を完了扱いにした');
      assert.equal(await runCli(['reindex', workspace.projectId], env), 0, '切替を拒否した後の再実行が成功しない');
      active = await readActiveGeneration(pool, workspace.projectId);
    } else {
      assert.equal(code, 0, '切替したのにreindexが成功終了していない');
    }
    assert.ok(active !== null && active !== source.id, '再索引後に新世代へ切り替わっていない');

    const addedPublication = await pool.query<{ revision: number }>(
      'SELECT revision FROM document_publications WHERE document_id = $1 AND generation_id = $2',
      [addedDocument.documentId, active],
    );
    assert.equal(addedPublication.rows[0]?.revision, 1, '再索引中に追加された文書を切替前に公開していない');
    const addedEmbedding = await pool.query<{ input_hash: Buffer }>(
      'SELECT input_hash FROM document_embeddings WHERE document_id = $1 AND generation_id = $2',
      [addedDocument.documentId, active],
    );
    assert.deepEqual(
      addedEmbedding.rows[0]?.input_hash,
      sha256Bytes(addedDocument.text),
      '追加文書のinput_hashが本文と一致しない',
    );
    const excludedPublication = await pool.query(
      'SELECT 1 FROM document_publications WHERE document_id = $1 AND generation_id = $2',
      [excludedDocument.documentId, active],
    );
    assert.equal(excludedPublication.rows.length, 0, '除外された文書を新世代で公開したまま切り替えた');
  });

  it('再索引はproject・company境界を越えない', { timeout: 30_000 }, async () => {
    const { config, env, voyage } = await startReindexProviders(pool, workspace.companyId, vectorQueryResponder(basisVector(0, 1)));
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    // 同一会社の別project。source generationを共有してactive参照する。
    const projectB = await insertProject(pool, workspace.companyId, `repo-b-${uuidv7()}`);
    await addProjectMember(pool, projectB, workspace.employeeId);
    await pool.query('UPDATE projects SET active_generation_id = $2, updated_at = now() WHERE id = $1', [projectB, source.id]);
    const sessionB = await insertSession(pool, { projectId: projectB, employeeId: workspace.employeeId });
    const boundaryB = 'M8-BOUNDARY-B';
    const messageB = await seedMessage(pool, { sessionId: sessionB, sequenceNo: 1, role: 'assistant', text: boundaryB });
    const documentB = await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: projectB,
      sessionId: sessionB,
      documentKey: 'm8-boundary-b',
      content: boundaryB,
      generationId: source.id,
      embedding: basisVector(3, 1),
      sources: [{ messageId: messageB.messageId, messageRevision: 1, startOffset: 0, endOffset: boundaryB.length }],
    });
    // 別会社のproject・generation・文書。
    const other = await seedWorkspace(pool, { name: `company-${uuidv7()}`, repositoryIdentifier: `repo-c-${uuidv7()}` });
    const otherGeneration = await insertGeneration(pool, {
      companyId: other.companyId,
      endpoint: config.voyageApiUrl,
    });
    await pool.query('UPDATE projects SET active_generation_id = $2, updated_at = now() WHERE id = $1', [
      other.projectId,
      otherGeneration,
    ]);
    const otherSession = await insertSession(pool, { projectId: other.projectId, employeeId: other.employeeId });
    const boundaryC = 'M8-BOUNDARY-C';
    const messageC = await seedMessage(pool, { sessionId: otherSession, sequenceNo: 1, role: 'assistant', text: boundaryC });
    await seedReadyDocument(pool, {
      companyId: other.companyId,
      projectId: other.projectId,
      sessionId: otherSession,
      documentKey: 'm8-boundary-c',
      content: boundaryC,
      generationId: otherGeneration,
      embedding: basisVector(4, 1),
      sources: [{ messageId: messageC.messageId, messageRevision: 1, startOffset: 0, endOffset: boundaryC.length }],
    });

    const sessionA = await seedSession(pool, workspace);
    await seedDocument(pool, {
      workspace,
      sessionId: sessionA,
      sequenceNo: 1,
      key: 'm8-boundary-a',
      text: 'M8-BOUNDARY-A',
      generationId: source.id,
      embedding: basisVector(0, 1),
    });

    assert.equal(await runCli(['reindex', workspace.projectId], env), 0, 'reindexが成功終了しなかった');
    const targetId = await readActiveGeneration(pool, workspace.projectId);
    assert.ok(targetId !== null && targetId !== source.id, 'active_generation_idが切り替わっていない');

    assert.equal(await readActiveGeneration(pool, projectB), source.id, '別projectのactive世代を変更した');
    const projectBTargetPublications = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM document_publications WHERE document_id = $1 AND generation_id = $2',
      [documentB, targetId],
    );
    assert.equal(Number(projectBTargetPublications.rows[0]?.count), 0, '別projectの文書を新世代へ公開した');
    const sourceStatus = await pool.query<{ status: string }>('SELECT status FROM embedding_generations WHERE id = $1', [source.id]);
    assert.equal(sourceStatus.rows[0]?.status, 'active', '他projectがactive参照するsource generationをretireした');
    const bEmbeddings = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM document_embeddings WHERE document_id = $1 AND generation_id = $2',
      [documentB, targetId],
    );
    assert.equal(Number(bEmbeddings.rows[0]?.count), 0, '別projectの文書をtarget世代へ埋め込んだ');

    assert.equal(await readActiveGeneration(pool, other.projectId), otherGeneration, '他社projectのactive世代を変更した');
    const otherGenerationCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM embedding_generations WHERE company_id = $1',
      [other.companyId],
    );
    assert.equal(Number(otherGenerationCount.rows[0]?.count), 1, '他社へ世代を追加した');
    const sent = voyage.requests.flatMap((request) => request.body.input ?? []);
    assert.ok(!sent.includes(boundaryB), '別projectの本文を外部送信した');
    assert.ok(!sent.includes(boundaryC), '他社の本文を外部送信した');
  });

  it('未完了の同じspecのrunを再開し、完了済みembedding/publicationを重複作成しない', { timeout: 30_000 }, async () => {
    await assertM8Structures(pool);
    const { config, env, voyage } = await startReindexProviders(pool, workspace.companyId, vectorQueryResponder(basisVector(0, 1)));
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const sessionId = await seedSession(pool, workspace);
    const docA = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 1,
      key: 'm8-resume-a',
      text: 'M8-RESUME-A',
      generationId: source.id,
      embedding: basisVector(0, 1),
    });
    const docB = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 2,
      key: 'm8-resume-b',
      text: 'M8-RESUME-B',
      generationId: source.id,
      embedding: basisVector(1, 1),
    });
    const target = await insertGeneration(pool, { companyId: workspace.companyId, endpoint: config.voyageApiUrl });
    // docAだけtarget世代の再索引が完了している途中状態。
    await pool.query(
      `INSERT INTO document_embeddings (document_id, revision, generation_id, embedding, input_hash)
       VALUES ($1, 1, $2, $3::vector, $4)`,
      [docA.documentId, target, toVectorLiteral(basisVector(0, 1)), sha256Bytes(docA.text)],
    );
    await pool.query('INSERT INTO document_publications (document_id, generation_id, revision, stale) VALUES ($1, $2, 1, false)', [
      docA.documentId,
      target,
    ]);
    await pool.query(
      `INSERT INTO reindex_runs (id, company_id, project_id, source_generation_id, target_generation_id, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [uuidv7(), workspace.companyId, workspace.projectId, source.id, target],
    );

    assert.equal(await runCli(['reindex', workspace.projectId], env), 0, '未完了runの再開が失敗した');
    assert.equal(await readActiveGeneration(pool, workspace.projectId), target, '未完了runのtargetへ切り替えていない');
    const embeddings = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM document_embeddings WHERE generation_id = $1',
      [target],
    );
    assert.equal(Number(embeddings.rows[0]?.count), 2, '完了済みtarget embeddingを重複作成した');
    const publications = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM document_publications WHERE generation_id = $1',
      [target],
    );
    assert.equal(Number(publications.rows[0]?.count), 2, '完了済みtarget publicationを重複作成した');
    const run = await latestReindexRun(pool, workspace.projectId);
    assert.equal(run?.status, 'completed', '再開したrunがcompletedでない');
    assert.equal(run?.target_generation_id, target, '再開時に別のtarget generationを作成した');
    const sent = voyage.requests.flatMap((request) => request.body.input ?? []);
    assert.deepEqual(sent, [docB.text], '完了済み文書を再送信した');
  });

  it('provider障害では旧activeを維持し、再開可能なrunを残して失敗をno_matchにしない', { timeout: 30_000 }, async () => {
    await assertM8Structures(pool);
    let failDocuments = true;
    const { config, env } = await startReindexProviders(pool, workspace.companyId, (request) => {
      if (failDocuments && request.input_type === 'document') {
        return { status: 503, body: {} };
      }
      return vectorQueryResponder(basisVector(0, 1))(request);
    });
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const sessionId = await seedSession(pool, workspace);
    const document = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 1,
      key: 'm8-retry-a',
      text: 'M8-RETRY-A',
      generationId: source.id,
      embedding: basisVector(0, 1),
    });

    assert.notEqual(await runCli(['reindex', workspace.projectId], env), 0, 'provider障害のreindexが成功扱いになった');
    assert.equal(await readActiveGeneration(pool, workspace.projectId), source.id, 'provider障害でactive世代を切り替えた');
    const failedRun = await latestReindexRun(pool, workspace.projectId);
    assert.ok(failedRun, '再開可能なrunが残っていない');
    assert.notEqual(failedRun.status, 'completed', '障害runをcompletedにした');
    assert.notEqual(failedRun.status, 'failed', 'retry可能な障害runをfailedにした');
    assert.ok(failedRun.target_generation_id, 'runのtarget generationがない');
    const targetStatus = await pool.query<{ status: string }>('SELECT status FROM embedding_generations WHERE id = $1', [
      failedRun.target_generation_id,
    ]);
    assert.notEqual(targetStatus.rows[0]?.status, 'failed', 'retry可能な障害でtarget generationをfailedにした');
    const targetPublications = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM document_publications WHERE generation_id = $1',
      [failedRun.target_generation_id],
    );
    assert.equal(Number(targetPublications.rows[0]?.count), 0, '全件完了前にpublicationを作成した');

    // 旧世代の検索は継続でき、再索引失敗をno_matchへ変換しない。
    const searchSession = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, {
      workspace,
      sessionId: searchSession,
      sequenceNo: 1,
      text: 'M8-RETRY-QUERY',
    });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config });
    const request = await readSearchRequest(pool, seeded.requestId);
    assert.equal(request.outcome, 'matched', '再索引失敗後の検索をno_matchやfailedにした');
    const result = request.result as { matches?: { evidence?: { message_id?: string }[] }[] } | null;
    assert.ok(
      result?.matches?.[0]?.evidence?.some((item) => item.message_id === document.messageId),
      '旧世代の文書根拠がない',
    );

    failDocuments = false;
    assert.equal(await runCli(['reindex', workspace.projectId], env), 0, '障害復旧後の再開が失敗した');
    const active = await readActiveGeneration(pool, workspace.projectId);
    assert.equal(active, failedRun.target_generation_id, '再開時に別のtarget generationを作成した');
    const published = await readTargetPublications(pool, workspace.projectId, active ?? '');
    assert.equal(published.length, 1, '障害復旧後に対象文書を公開していない');
    assert.equal(published[0]?.published_revision, 1);
    assert.deepEqual(published[0]?.input_hash, sha256Bytes(document.text));
  });

  it('承認がないreindexはblocked_policyで旧activeを維持し、承認後に再開できる', { timeout: 30_000 }, async () => {
    await assertM8Structures(pool);
    const { config, env, voyage } = await startReindexProviders(pool, workspace.companyId, vectorQueryResponder(basisVector(0, 1)), {
      approveVoyage: false,
    });
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const sessionId = await seedSession(pool, workspace);
    await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 1,
      key: 'm8-blocked-a',
      text: 'M8-BLOCKED-A',
      generationId: source.id,
      embedding: basisVector(0, 1),
    });

    assert.notEqual(await runCli(['reindex', workspace.projectId], env), 0, '未承認のreindexが成功扱いになった');
    assert.equal(voyage.requests.length, 0, '承認なしでVoyageへ送信した');
    assert.equal(await readActiveGeneration(pool, workspace.projectId), source.id, '未承認でactive世代を切り替えた');
    const blockedRun = await latestReindexRun(pool, workspace.projectId);
    assert.ok(blockedRun, 'blocked_policyのrunが残っていない');
    assert.equal(blockedRun.status, 'blocked_policy', '未承認runをblocked_policyにしていない');
    assert.ok(blockedRun.target_generation_id, 'runのtarget generationがない');
    const targetStatus = await pool.query<{ status: string }>('SELECT status FROM embedding_generations WHERE id = $1', [
      blockedRun.target_generation_id,
    ]);
    assert.notEqual(targetStatus.rows[0]?.status, 'failed', 'blocked_policyでtarget generationをfailedにした');

    await seedApproval(pool, {
      companyId: workspace.companyId,
      provider: VOYAGE_PROVIDER,
      endpoint: config.voyageApiUrl,
      accountRef: config.voyageAccountRef,
    });
    assert.equal(await runCli(['reindex', workspace.projectId], env), 0, '承認後の再開が失敗した');
    assert.equal(
      await readActiveGeneration(pool, workspace.projectId),
      blockedRun.target_generation_id,
      '再開時に別のtarget generationを作成した',
    );
    const published = await readTargetPublications(pool, workspace.projectId, blockedRun.target_generation_id ?? '');
    assert.equal(published.length, 1, '承認後の再開で公開していない');
    assert.ok(published[0]?.input_hash !== null);
  });

  it('恒久provider契約違反はrunとtarget generationをfailedにする', { timeout: 30_000 }, async () => {
    await assertM8Structures(pool);
    const { config, env } = await startReindexProviders(pool, workspace.companyId, (request) => {
      if (request.input_type === 'document') {
        return {
          body: {
            object: 'list',
            model: VOYAGE_MODEL,
            data: [{ object: 'embedding', index: 0, embedding: [1, 2, 3] }],
            usage: { total_tokens: 1 },
          },
        };
      }
      return vectorQueryResponder(basisVector(0, 1))(request);
    });
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const sessionId = await seedSession(pool, workspace);
    await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 1,
      key: 'm8-invalid-a',
      text: 'M8-INVALID-A',
      generationId: source.id,
      embedding: basisVector(0, 1),
    });

    assert.notEqual(await runCli(['reindex', workspace.projectId], env), 0, '不正vectorのreindexが成功扱いになった');
    assert.equal(await readActiveGeneration(pool, workspace.projectId), source.id, '不正vectorでactive世代を切り替えた');
    const run = await latestReindexRun(pool, workspace.projectId);
    assert.ok(run, 'failed runが残っていない');
    assert.equal(run.status, 'failed', '恒久契約違反のrunをfailedにしていない');
    assert.ok(run.target_generation_id, 'runのtarget generationがない');
    const target = await pool.query<{ status: string }>('SELECT status FROM embedding_generations WHERE id = $1', [
      run.target_generation_id,
    ]);
    assert.equal(target.rows[0]?.status, 'failed', '恒久契約違反でtarget generationをfailedにしていない');
    const publications = await pool.query(
      'SELECT 1 FROM document_publications WHERE generation_id = $1',
      [run.target_generation_id],
    );
    assert.equal(publications.rows.length, 0, '不正vectorを公開した');
  });

  it('検索要求は開始時のgenerationを永続固定し、切替後も同じ世代で比較する', { timeout: 30_000 }, async () => {
    await assertM8Structures(pool);
    const { config, jev } = await startReindexProviders(pool, workspace.companyId, vectorQueryResponder(basisVector(0, 1)));
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const target = await insertGeneration(pool, { companyId: workspace.companyId, endpoint: config.voyageApiUrl });
    const sessionA = await seedSession(pool, workspace);
    const oldDocText = 'M8-PIN-OLD';
    const oldDocument = await seedDocument(pool, {
      workspace,
      sessionId: sessionA,
      sequenceNo: 1,
      key: 'm8-pin-old',
      text: oldDocText,
      generationId: source.id,
      embedding: basisVector(0, 1),
    });
    const newDocText = 'M8-PIN-NEW';
    const newDocument = await seedDocument(pool, {
      workspace,
      sessionId: sessionA,
      sequenceNo: 2,
      key: 'm8-pin-new',
      text: newDocText,
      generationId: target,
      embedding: basisVector(1, 1),
    });

    // 切替前に開始したrequestはsource世代を固定したまま切替をまたぐ。
    const oldSearchSession = await seedSession(pool, workspace);
    const pinned = await seedExecuteSearch(pool, {
      workspace,
      sessionId: oldSearchSession,
      sequenceNo: 1,
      text: 'M8-PIN-QUERY-OLD',
    });
    await pool.query('UPDATE search_requests SET embedding_generation_id = $2, updated_at = now() WHERE id = $1', [
      pinned.requestId,
      source.id,
    ]);
    await pool.query('UPDATE projects SET active_generation_id = $2, updated_at = now() WHERE id = $1', [
      workspace.projectId,
      target,
    ]);
    await runExecuteSearch(pool, { jobId: pinned.jobId, config });
    const pinnedRequest = await readSearchRequest(pool, pinned.requestId);
    assert.equal(pinnedRequest.status, 'completed');
    assert.equal(pinnedRequest.outcome, 'matched');
    const pinnedResult = pinnedRequest.result as
      | { index_status?: { embedding_generation_id?: string }; matches?: { evidence?: { message_id?: string }[] }[] }
      | null;
    assert.equal(
      pinnedResult?.index_status?.embedding_generation_id,
      source.id,
      '開始時に固定したgenerationを検索結果・候補比較へ使っていない',
    );
    assert.ok(
      pinnedResult?.matches?.[0]?.evidence?.some((item) => item.message_id === oldDocument.messageId),
      '固定世代の旧文書を根拠にしていない',
    );
    assert.ok(!allJevRawBody(jev).includes(newDocText), '固定世代以外の新文書をJev候補へ渡した');
    const storedPin = await pool.query<{ embedding_generation_id: string | null }>(
      'SELECT embedding_generation_id FROM search_requests WHERE id = $1',
      [pinned.requestId],
    );
    assert.equal(storedPin.rows[0]?.embedding_generation_id, source.id, '検索要求の固定世代を永続化していない');

    // 切替後の新規requestは新しいactive世代を開始時に固定する。
    const newSearchSession = await seedSession(pool, workspace);
    const fresh = await seedExecuteSearch(pool, {
      workspace,
      sessionId: newSearchSession,
      sequenceNo: 1,
      text: 'M8-PIN-QUERY-NEW',
    });
    await runExecuteSearch(pool, { jobId: fresh.jobId, config });
    const freshRequest = await readSearchRequest(pool, fresh.requestId);
    assert.equal(freshRequest.outcome, 'matched');
    const freshResult = freshRequest.result as
      | { index_status?: { embedding_generation_id?: string }; matches?: { evidence?: { message_id?: string }[] }[] }
      | null;
    assert.equal(
      freshResult?.index_status?.embedding_generation_id,
      target,
      '新規検索が開始時のactive世代を固定していない',
    );
    assert.ok(
      freshResult?.matches?.[0]?.evidence?.some((item) => item.message_id === newDocument.messageId),
      '新世代の文書を根拠にしていない',
    );
  });

  it('generation:deleteは参照がない世代だけを削除する', { timeout: 30_000 }, async () => {
    const { config, env } = await startReindexProviders(pool, workspace.companyId, vectorQueryResponder(basisVector(0, 1)));
    const unreferenced = await insertGeneration(pool, {
      companyId: workspace.companyId,
      endpoint: config.voyageApiUrl,
      status: 'retired',
    });
    assert.equal(await runCli(['generation:delete', unreferenced], env), 0, '参照がない世代を削除できない');
    const deleted = await pool.query('SELECT 1 FROM embedding_generations WHERE id = $1', [unreferenced]);
    assert.equal(deleted.rows.length, 0, '参照がない世代が残っている');

    const active = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    assert.notEqual(await runCli(['generation:delete', active.id], env), 0, 'active projectが参照する世代を削除した');
    assert.equal(
      (await pool.query('SELECT 1 FROM embedding_generations WHERE id = $1', [active.id])).rows.length,
      1,
      '拒否すべきactive世代が消えた',
    );
    assert.equal(await readActiveGeneration(pool, workspace.projectId), active.id, 'active_generation_idが変わった');

    await assertM8Structures(pool);
    // 実行中search requestが参照する世代。
    const searchGeneration = await insertGeneration(pool, {
      companyId: workspace.companyId,
      endpoint: config.voyageApiUrl,
      status: 'retired',
    });
    const searchSession = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, {
      workspace,
      sessionId: searchSession,
      sequenceNo: 1,
      text: 'M8-DELETE-SEARCH',
    });
    await pool.query("UPDATE search_requests SET embedding_generation_id = $2, status = 'running', updated_at = now() WHERE id = $1", [
      seeded.requestId,
      searchGeneration,
    ]);
    assert.notEqual(
      await runCli(['generation:delete', searchGeneration], env),
      0,
      '実行中search requestが参照する世代を削除した',
    );
    assert.equal(
      (await pool.query('SELECT 1 FROM embedding_generations WHERE id = $1', [searchGeneration])).rows.length,
      1,
      '拒否すべきsearch参照世代が消えた',
    );

    // 進行中reindex runが参照する世代。
    const runGeneration = await insertGeneration(pool, {
      companyId: workspace.companyId,
      endpoint: config.voyageApiUrl,
    });
    await pool.query(
      `INSERT INTO reindex_runs (id, company_id, project_id, source_generation_id, target_generation_id, status)
       VALUES ($1, $2, $3, $4, $5, 'running')`,
      [uuidv7(), workspace.companyId, workspace.projectId, active.id, runGeneration],
    );
    assert.notEqual(
      await runCli(['generation:delete', runGeneration], env),
      0,
      '進行中reindex runが参照する世代を削除した',
    );
    assert.equal(
      (await pool.query('SELECT 1 FROM embedding_generations WHERE id = $1', [runGeneration])).rows.length,
      1,
      '拒否すべきreindex参照世代が消えた',
    );
  });
  it('cutoverのretireと別projectの初回generation設定が競合してもretired generationをactive参照しない', { timeout: 30_000 }, async () => {
    const { config, env } = await startReindexProviders(pool, workspace.companyId, vectorQueryResponder(basisVector(0, 1)));
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const projectB = await insertProject(pool, workspace.companyId, `repo-race-${uuidv7()}`);
    await addProjectMember(pool, projectB, workspace.employeeId);

    // cutoverのsource retireだけをtest用triggerで停止し、company lock待ちを固定する。
    const gate = await pool.connect();
    let gateLocked = false;
    try {
      await pool.query(
        `CREATE OR REPLACE FUNCTION m8_test_pause_retire() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           PERFORM pg_advisory_xact_lock(20261002, 770001);
           RETURN NEW;
         END $$`,
      );
      await pool.query('DROP TRIGGER IF EXISTS m8_test_pause_retire_trigger ON embedding_generations');
      await pool.query(
        `CREATE TRIGGER m8_test_pause_retire_trigger
           AFTER UPDATE OF status ON embedding_generations
           FOR EACH ROW WHEN (NEW.status = 'retired')
           EXECUTE FUNCTION m8_test_pause_retire()`,
      );
      await gate.query('SELECT pg_advisory_lock(20261002, 770001)');
      gateLocked = true;

      const reindexing = runCli(['reindex', workspace.projectId], env);
      assert.ok(await waitForLockWaiter(pool, 20261002, 770001, 5_000), 'cutoverのretireがtest gateで停止しなかった');
      const ensureB = ensureActiveGeneration(pool, { companyId: workspace.companyId, projectId: projectB }, config);
      // fix前はretire commit前に別project pointerがsource世代へ進む。fix後はcompany lockで待つ。
      await waitForProjectGeneration(pool, projectB, 1_000);
      await gate.query('SELECT pg_advisory_unlock(20261002, 770001)');
      gateLocked = false;
      const [code] = await Promise.all([reindexing, ensureB]);
      assert.equal(code, 0, `reindexが成功終了しなかった: ${code}`);

      const activeB = await pool.query<{ active_generation_id: string | null; status: string }>(
        `SELECT p.active_generation_id, g.status
           FROM projects p
           JOIN embedding_generations g ON g.id = p.active_generation_id
          WHERE p.id = $1`,
        [projectB],
      );
      assert.ok(activeB.rows[0]?.active_generation_id, '別projectのactive generationが設定されていない');
      assert.equal(activeB.rows[0]?.status, 'active', '別projectがretired generationをactive参照した');
      assert.notEqual(activeB.rows[0]?.active_generation_id, source.id, '別projectがretire対象sourceを参照した');
      const retiredSource = await pool.query<{ status: string }>('SELECT status FROM embedding_generations WHERE id = $1', [
        source.id,
      ]);
      assert.equal(retiredSource.rows[0]?.status, 'retired', 'source generationがretireされていない');
    } finally {
      if (gateLocked) {
        await gate.query('SELECT pg_advisory_unlock(20261002, 770001)').catch(() => undefined);
      }
      await pool.query('DROP TRIGGER IF EXISTS m8_test_pause_retire_trigger ON embedding_generations').catch(() => undefined);
      await pool.query('DROP FUNCTION IF EXISTS m8_test_pause_retire()').catch(() => undefined);
      gate.release();
    }
  });

  it('desired revisionのsourceが現行revisionでなくなった文書はtargetへ公開しない', { timeout: 30_000 }, async () => {
    await assertM8Structures(pool);
    const { config, env } = await startReindexProviders(pool, workspace.companyId, vectorQueryResponder(basisVector(0, 1)));
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const sessionId = await seedSession(pool, workspace);
    const document = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 1,
      key: 'm8-stale-source',
      text: 'M8-STALE-SOURCE',
      generationId: source.id,
      embedding: basisVector(0, 1),
    });
    // source messageだけを改訂し、document desired revisionのsourceを現行でなくする。
    await advanceRevision(pool, document.messageId, 'M8-STALE-SOURCE-REVISED');

    assert.notEqual(await runCli(['reindex', workspace.projectId], env), 0, '現行でないsourceのreindexが成功扱いになった');
    assert.equal(await readActiveGeneration(pool, workspace.projectId), source.id, 'source不整合でactive世代を切り替えた');
    const run = await latestReindexRun(pool, workspace.projectId);
    assert.ok(run, 'reindex runが残っていない');
    assert.notEqual(run.status, 'completed', 'source不整合のrunをcompletedにした');
    assert.ok(run.target_generation_id);
    const publications = await pool.query('SELECT 1 FROM document_publications WHERE generation_id = $1', [
      run.target_generation_id,
    ]);
    assert.equal(publications.rows.length, 0, '現行でないsourceのtarget publicationを作成した');
    const embeddings = await pool.query('SELECT 1 FROM document_embeddings WHERE generation_id = $1', [
      run.target_generation_id,
    ]);
    assert.equal(embeddings.rows.length, 0, '現行でないsourceのtarget embeddingを作成した');
  });

  it('cutover時にproject pointerがrun開始時sourceと違えばpointerを上書きしない', { timeout: 30_000 }, async () => {
    await assertM8Structures(pool);
    const { config, env } = await startReindexProviders(pool, workspace.companyId, vectorQueryResponder(basisVector(0, 1)));
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const other = await insertGeneration(pool, { companyId: workspace.companyId, endpoint: config.voyageApiUrl, status: 'active' });

    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      // cutoverと同じcompany generation lockをtest側で先に保持し、cutoverだけをrun作成後に停止する。
      await acquireCompanyGenerationLock(lock, workspace.companyId);
      const reindexing = runCli(['reindex', workspace.projectId], env);
      assert.ok(await waitForReindexRun(pool, workspace.projectId, source.id, 5_000), 'reindex runが作成されなかった');
      await lock.query('UPDATE projects SET active_generation_id = $2, updated_at = now() WHERE id = $1', [
        workspace.projectId,
        other,
      ]);
      await lock.query('COMMIT');
      assert.notEqual(await reindexing, 0, 'source mismatchのcutoverが成功扱いになった');
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined);
      lock.release();
    }

    assert.equal(await readActiveGeneration(pool, workspace.projectId), other, 'run開始時sourceと違うpointerを上書きした');
    const run = await latestReindexRun(pool, workspace.projectId);
    assert.ok(run, 'reindex runが残っていない');
    assert.equal(run.status, 'pending', 'source mismatchのrunをresume可能な状態にしていない');
    assert.equal(run.error_code, 'source_changed');
    assert.ok(run.target_generation_id !== null && run.target_generation_id !== other, 'source mismatchでtargetを別世代にした');
    const target = await pool.query<{ status: string }>('SELECT status FROM embedding_generations WHERE id = $1', [
      run.target_generation_id,
    ]);
    assert.notEqual(target.rows[0]?.status, 'active', 'source mismatchでtarget generationをactiveにした');
  });
  it('target publication作成後・cutover直前にsourceが改訂されたら旧sourceのまま切り替えない', { timeout: 30_000 }, async () => {
    await assertM8Structures(pool);
    const { config, env } = await startReindexProviders(pool, workspace.companyId, vectorQueryResponder(basisVector(0, 1)));
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const sessionId = await seedSession(pool, workspace);
    const document = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 1,
      key: 'm8-cutover-race',
      text: 'M8-CUTOVER-RACE',
      generationId: source.id,
      embedding: basisVector(0, 1),
    });

    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      // cutoverと同じcompany lockを先に保持し、applyEmbeddings完了後・完全性確認前に停止する。
      await acquireCompanyGenerationLock(lock, workspace.companyId);
      const reindexing = runCli(['reindex', workspace.projectId], env);
      assert.ok(
        await waitForNewTargetPublication(pool, workspace.projectId, source.id, 5_000),
        'target publicationがgate前に作成されなかった',
      );
      // publication作成後にsource messageだけを改訂し、cutover直前のsource検証と競合させる。
      await advanceRevision(pool, document.messageId, 'M8-CUTOVER-RACE-REVISED');
      await lock.query('COMMIT');
      assert.notEqual(await reindexing, 0, '旧sourceのままcutoverが成功扱いになった');
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined);
      lock.release();
    }

    assert.equal(await readActiveGeneration(pool, workspace.projectId), source.id, '旧sourceのままactive世代を切り替えた');
    const run = await latestReindexRun(pool, workspace.projectId);
    assert.ok(run, 'reindex runが残っていない');
    assert.notEqual(run.status, 'completed', '旧sourceのrunをcompletedにした');
  });
  it('ミリ秒未満のcreated_atでもkeyset cursorが進み、再索引が有限時間で完了する', { timeout: 15_000 }, async () => {
    const { config, env, voyage } = await startReindexProviders(pool, workspace.companyId, vectorQueryResponder(basisVector(0, 1)));
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const sessionId = await seedSession(pool, workspace);
    const first = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 1,
      key: 'm8-micro-a',
      text: 'M8-MICRO-A',
      generationId: source.id,
      embedding: basisVector(0, 1),
    });
    const second = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 2,
      key: 'm8-micro-b',
      text: 'M8-MICRO-B',
      generationId: source.id,
      embedding: basisVector(1, 1),
    });
    // DBのtimestamptz精度（マイクロ秒）を持つ同値created_atを作り、cursorがidで一度ずつ進むことも確認する。
    await pool.query(
      `UPDATE search_documents
          SET created_at = '2026-01-01 00:00:00.123456+00'::timestamptz,
              updated_at = '2026-01-01 00:00:00.123456+00'::timestamptz
        WHERE id = ANY($1::uuid[])`,
      [[first.documentId, second.documentId]],
    );

    assert.equal(await runCli(['reindex', workspace.projectId], env), 0, 'reindexが成功終了しなかった');
    const targetId = await readActiveGeneration(pool, workspace.projectId);
    assert.ok(targetId !== null && targetId !== source.id, 'active generationが切り替わっていない');
    const published = await readTargetPublications(pool, workspace.projectId, targetId);
    assert.equal(published.length, 2, 'searchable文書がすべてtargetへ公開されていない');
    const sent = voyage.requests.flatMap((request) => request.body.input ?? []);
    assert.deepEqual([...sent].sort(), [first.text, second.text].sort(), '同じ文書を重複送信した');
  });
  it('pending desired revisionはcandidate公開だけではreadyにならず、通常build_documentsが旧activeへ公開できる', { timeout: 30_000 }, async () => {
    let documentCallCount = 0;
    let phase: 'partial' | 'ok' = 'partial';
    const { config, env } = await startReindexProviders(pool, workspace.companyId, (request) => {
      if (request.input_type !== 'document') {
        return vectorQueryResponder(basisVector(0, 1))(request);
      }
      documentCallCount += 1;
      if (phase === 'partial' && documentCallCount >= 2) {
        return { status: 503, body: {} };
      }
      return vectorQueryResponder(basisVector(0, 1))(request);
    });
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );

    // 1件目をpending desired revisionとして先頭pageへ入れ、後続fillerで2回目のVoyage呼出しを作る。
    const sessionId = await seedSession(pool, workspace);
    const first = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 1,
      key: 'm8-partial-first',
      text: 'M8-PARTIAL-FIRST',
    });
    await pool.query(`UPDATE search_document_revisions SET status = 'pending' WHERE document_id = $1 AND revision = 1`, [
      first.documentId,
    ]);
    const fillerSession = await seedSession(pool, workspace);
    for (let index = 0; index < 64; index += 1) {
      await seedDocument(pool, {
        workspace,
        sessionId: fillerSession,
        sequenceNo: index + 1,
        key: `m8-partial-filler-${String(index).padStart(2, '0')}`,
        text: `M8-PARTIAL-FILLER-${String(index).padStart(2, '0')}`,
        generationId: source.id,
        embedding: basisVector(2, 1),
      });
    }

    assert.notEqual(await runCli(['reindex', workspace.projectId], env), 0, 'provider障害のreindexが成功扱いになった');
    assert.equal(await readActiveGeneration(pool, workspace.projectId), source.id, 'provider障害でactive世代を切り替えた');
    const run = await latestReindexRun(pool, workspace.projectId);
    assert.ok(run, 'reindex runが残っていない');
    assert.notEqual(run.status, 'completed', 'provider障害のrunをcompletedにした');
    assert.ok(run.target_generation_id, 'runのtarget generationがない');
    assert.ok(documentCallCount >= 2, '後続batchのprovider障害を作れていない');

    // 1回目のbatchはcandidateへ公開済みでも、revision statusはpendingのまま。
    const candidatePublication = await pool.query<{ revision: number }>(
      'SELECT revision FROM document_publications WHERE document_id = $1 AND generation_id = $2',
      [first.documentId, run.target_generation_id],
    );
    assert.equal(candidatePublication.rows[0]?.revision, 1, 'candidate publicationが作成されていない');
    const revision = await pool.query<{ status: string }>(
      'SELECT status FROM search_document_revisions WHERE document_id = $1 AND revision = 1',
      [first.documentId],
    );
    assert.equal(revision.rows[0]?.status, 'pending', 'candidate公開だけで旧世代共通revision statusをreadyにした');

    // 通常のbuild_documents再試行が、旧active generationへ公開できる。
    await upsertAnalysis(pool, { messageId: first.messageId, revision: 1 });
    const buildJobId = await enqueueBuildJob(pool, { sessionId, messageId: first.messageId, revision: 1 });
    phase = 'ok';
    const [buildJob] = await claimJobs(pool, { kinds: ['build_documents'], limit: 1, leaseMs: 60_000 });
    assert.ok(buildJob, 'build_documents jobをclaimできない');
    assert.equal(buildJob.id, buildJobId);
    await processJob(pool, buildJob, config);
    assert.equal((await readJob(pool, buildJobId)).status, 'completed', 'build_documents再試行が完了しない');
    const oldActivePublication = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM document_publications p
         JOIN search_documents d ON d.id = p.document_id
         JOIN search_document_sources s ON s.document_id = d.id AND s.revision = p.revision
        WHERE d.project_id = $1 AND p.generation_id = $2 AND s.message_id = $3`,
      [workspace.projectId, source.id, first.messageId],
    );
    assert.ok(
      Number(oldActivePublication.rows[0]?.count) >= 1,
      '通常build_documentsが旧active generationへ公開できない',
    );
  });

  it('完了済みreindexの再実行はno-opで世代・run・provider送信を増やさない', { timeout: 30_000 }, async () => {
    const { config, env, voyage } = await startReindexProviders(pool, workspace.companyId, vectorQueryResponder(basisVector(0, 1)));
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const sessionId = await seedSession(pool, workspace);
    const document = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 1,
      key: 'm8-noop-a',
      text: 'M8-NOOP-A',
      generationId: source.id,
      embedding: basisVector(0, 1),
    });
    assert.equal(await runCli(['reindex', workspace.projectId], env), 0, '初回reindexが成功しなかった');
    const activeAfterFirst = await readActiveGeneration(pool, workspace.projectId);
    assert.ok(activeAfterFirst !== null && activeAfterFirst !== source.id, '初回reindexで切替していない');
    const readyRevision = await pool.query<{ status: string }>(
      'SELECT status FROM search_document_revisions WHERE document_id = $1 AND revision = 1',
      [document.documentId],
    );
    assert.equal(readyRevision.rows[0]?.status, 'ready', 'cutover後にdesired revisionがreadyでない');

    const runsBefore = Number(
      (await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM reindex_runs WHERE project_id = $1', [
        workspace.projectId,
      ])).rows[0]?.count,
    );
    const generationsBefore = Number(
      (await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM embedding_generations WHERE company_id = $1', [
        workspace.companyId,
      ])).rows[0]?.count,
    );
    const requestsBefore = voyage.requests.length;
    const runBefore = await latestReindexRun(pool, workspace.projectId);

    assert.equal(await runCli(['reindex', workspace.projectId], env), 0, 'no-op再実行が成功終了しなかった');
    assert.equal(await readActiveGeneration(pool, workspace.projectId), activeAfterFirst, 'no-opでactive世代を変更した');
    const runsAfter = Number(
      (await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM reindex_runs WHERE project_id = $1', [
        workspace.projectId,
      ])).rows[0]?.count,
    );
    const generationsAfter = Number(
      (await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM embedding_generations WHERE company_id = $1', [
        workspace.companyId,
      ])).rows[0]?.count,
    );
    assert.equal(runsAfter, runsBefore, 'no-opでrunを増やした');
    assert.equal(generationsAfter, generationsBefore, 'no-opでgenerationを増やした');
    assert.equal(voyage.requests.length, requestsBefore, 'no-opでVoyageへ送信した');
    const runAfter = await latestReindexRun(pool, workspace.projectId);
    assert.equal(runAfter?.id, runBefore?.id, 'no-opで別runを作成した');
    assert.equal(runAfter?.status, 'completed');
  });

  it('retryでpendingへ戻したrequestが参照するgenerationは削除できない', { timeout: 30_000 }, async () => {
    await assertM8Structures(pool);
    const { config } = await startReindexProviders(pool, workspace.companyId, vectorQueryResponder(basisVector(0, 1)));
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId, sequenceNo: 1, text: 'M8-RETRY-DELETE' });
    const pinned = await insertGeneration(pool, { companyId: workspace.companyId, endpoint: config.voyageApiUrl, status: 'retired' });
    await pool.query(
      `UPDATE search_requests
          SET embedding_generation_id = $2, status = 'failed', outcome = NULL,
              error_code = 'provider_unavailable', updated_at = now()
        WHERE id = $1`,
      [seeded.requestId, pinned],
    );
    await pool.query(
      `UPDATE jobs SET status = 'failed', error_code = 'provider_unavailable', updated_at = now() WHERE id = $1`,
      [seeded.jobId],
    );

    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT 1 FROM search_requests WHERE id = $1 FOR UPDATE', [seeded.requestId]);
      const retry = retryJob(pool, seeded.jobId, config);
      assert.ok(await waitForBackendWaiting(pool, 'FOR SHARE OF sr', 5_000), 'retryがrequest lock待ちにならなかった');
      const deletion = deleteGeneration(pool, pinned);
      assert.ok(
        await waitForBackendWaiting(pool, 'embedding_generations', 5_000),
        'deleteがgeneration lock待ちにならなかった',
      );
      await lock.query('COMMIT');
      assert.equal(await retry, true, 'retryが成功しなかった');
      assert.equal(await deletion, 'generation_referenced', 'pending requestが参照するgenerationを削除した');
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined);
      lock.release();
    }

    const request = await pool.query<{ status: string; embedding_generation_id: string | null }>(
      'SELECT status, embedding_generation_id FROM search_requests WHERE id = $1',
      [seeded.requestId],
    );
    assert.equal(request.rows[0]?.status, 'pending', 'retry後にrequestがpendingでない');
    assert.equal(request.rows[0]?.embedding_generation_id, pinned, 'retryがgenerationをpinし直した');
    assert.equal((await pool.query('SELECT 1 FROM embedding_generations WHERE id = $1', [pinned])).rows.length, 1);
  });

  it('failed requestが参照するgenerationを削除した後のretryは別世代へpinし直さない', { timeout: 30_000 }, async () => {
    await assertM8Structures(pool);
    const { config } = await startReindexProviders(pool, workspace.companyId, vectorQueryResponder(basisVector(0, 1)));
    const active = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId, sequenceNo: 1, text: 'M8-DELETE-THEN-RETRY' });
    const pinned = await insertGeneration(pool, { companyId: workspace.companyId, endpoint: config.voyageApiUrl, status: 'retired' });
    assert.notEqual(active.id, pinned, 'precondition: activeとpin対象が同じ');
    await pool.query(
      `UPDATE search_requests
          SET embedding_generation_id = $2, status = 'failed', outcome = NULL,
              error_code = 'provider_unavailable', updated_at = now()
        WHERE id = $1`,
      [seeded.requestId, pinned],
    );
    await pool.query(
      `UPDATE jobs SET status = 'failed', error_code = 'provider_unavailable', updated_at = now() WHERE id = $1`,
      [seeded.jobId],
    );

    assert.equal(await deleteGeneration(pool, pinned), 'deleted', 'failed requestが参照する世代を削除できない');
    assert.equal(await retryJob(pool, seeded.jobId, config), false, '削除済み世代を参照するrequestのretryが成功した');
    const request = await pool.query<{ status: string; embedding_generation_id: string | null; error_code: string | null }>(
      'SELECT status, embedding_generation_id, error_code FROM search_requests WHERE id = $1',
      [seeded.requestId],
    );
    assert.equal(request.rows[0]?.status, 'expired', '削除後にfailed requestがexpiredになっていない');
    assert.equal(request.rows[0]?.embedding_generation_id, null, '削除後にrequestが別世代へpinされている');
    assert.equal(request.rows[0]?.error_code, 'embedding_generation_deleted');
    const job = await readJob(pool, seeded.jobId);
    assert.equal(job.status, 'failed', '削除後のretryでjobがfailedのまま残っていない');
    assert.equal(await readActiveGeneration(pool, workspace.projectId), active.id, 'retryで別世代へpinし直した');
    const claimed = await claimJobs(pool, { kinds: ['execute_search'], limit: 1, leaseMs: 60_000 });
    assert.equal(claimed.length, 0, 'failedのままのexecute_search jobがclaimされた');
    assert.equal((await pool.query('SELECT 1 FROM embedding_generations WHERE id = $1', [pinned])).rows.length, 0);
  });
});

describe('M8 運用metrics', () => {
  it('project scopeのJSON metricsを生成し、本文・credentialを含めない', { timeout: 60_000 }, async () => {
    await assertM8Structures(pool);
    const durationTable = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'search_duration_samples'`,
    );
    assert.equal(durationTable.rows.length, 1, '0008_m8.sqlのsearch_duration_samplesがない');
    const env = workerEnv();
    const config = loadWorkerConfig(env).config;
    const sourceA = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const sessionA = await seedSession(pool, workspace);
    const bodyMarker = 'M8-METRICS-BODY-MARKER';
    await seedMessage(pool, { sessionId: sessionA, sequenceNo: 1, role: 'user', text: bodyMarker });
    const docOne = await seedDocument(pool, {
      workspace,
      sessionId: sessionA,
      sequenceNo: 2,
      key: 'm8-metrics-one',
      text: 'M8-METRICS-DOC-ONE',
      generationId: sourceA.id,
      embedding: basisVector(0, 1),
    });
    const docTwo = await seedDocument(pool, {
      workspace,
      sessionId: sessionA,
      sequenceNo: 3,
      key: 'm8-metrics-two',
      text: 'M8-METRICS-DOC-TWO',
      generationId: sourceA.id,
      embedding: basisVector(1, 1),
      searchable: true,
    });
    await seedDocument(pool, {
      workspace,
      sessionId: sessionA,
      sequenceNo: 4,
      key: 'm8-metrics-excluded',
      text: 'M8-METRICS-EXCLUDED',
      searchable: false,
    });
    // 進行中run: docOneだけtarget世代へ完了済み。
    const runTarget = await insertGeneration(pool, { companyId: workspace.companyId, endpoint: config.voyageApiUrl });
    await pool.query(
      `INSERT INTO document_embeddings (document_id, revision, generation_id, embedding, input_hash)
       VALUES ($1, 1, $2, $3::vector, $4)`,
      [docOne.documentId, runTarget, toVectorLiteral(basisVector(4, 1)), sha256Bytes(docOne.text)],
    );
    await pool.query('INSERT INTO document_publications (document_id, generation_id, revision, stale) VALUES ($1, $2, 1, false)', [
      docOne.documentId,
      runTarget,
    ]);
    await pool.query(
      `INSERT INTO reindex_runs (id, company_id, project_id, source_generation_id, target_generation_id, status)
       VALUES ($1, $2, $3, $4, $5, 'running')`,
      [uuidv7(), workspace.companyId, workspace.projectId, sourceA.id, runTarget],
    );
    const jobPending = await enqueueJob(pool, {
      kind: 'classify_message',
      idempotencyKey: `m8-metrics-pending:${uuidv7()}`,
      sessionId: sessionA,
    });
    assert.ok(jobPending);
    const jobCompleted = await enqueueJob(pool, {
      kind: 'classify_message',
      idempotencyKey: `m8-metrics-completed:${uuidv7()}`,
      sessionId: sessionA,
    });
    await pool.query("UPDATE jobs SET status = 'completed', updated_at = now() WHERE id = $1", [jobCompleted]);
    const jobFailed = await enqueueJob(pool, {
      kind: 'route_search',
      idempotencyKey: `m8-metrics-failed:${uuidv7()}`,
      sessionId: sessionA,
    });
    await pool.query("UPDATE jobs SET status = 'failed', error_code = 'provider_contract_invalid', updated_at = now() WHERE id = $1", [
      jobFailed,
    ]);
    for (const duration of [10, 20, 30]) {
      await pool.query(
        `INSERT INTO search_duration_samples (id, company_id, project_id, generation_id, duration_ms)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), workspace.companyId, workspace.projectId, sourceA.id, duration],
      );
    }

    // 同一会社の別project。metricsが混ざらないことを確認する。
    const projectB = await insertProject(pool, workspace.companyId, `repo-metrics-${uuidv7()}`);
    await addProjectMember(pool, projectB, workspace.employeeId);
    const generationB = await insertGeneration(pool, { companyId: workspace.companyId, endpoint: config.voyageApiUrl });
    await pool.query('UPDATE projects SET active_generation_id = $2, updated_at = now() WHERE id = $1', [projectB, generationB]);
    const sessionB = await insertSession(pool, { projectId: projectB, employeeId: workspace.employeeId });
    await seedMessage(pool, { sessionId: sessionB, sequenceNo: 1, role: 'user', text: 'M8-METRICS-B-BODY' });
    const boundaryB = 'M8-METRICS-B-DOC';
    const messageB = await seedMessage(pool, { sessionId: sessionB, sequenceNo: 2, role: 'assistant', text: boundaryB });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: projectB,
      sessionId: sessionB,
      documentKey: 'm8-metrics-b',
      content: boundaryB,
      generationId: generationB,
      embedding: basisVector(5, 1),
      sources: [{ messageId: messageB.messageId, messageRevision: 1, startOffset: 0, endOffset: boundaryB.length }],
    });
    await enqueueJob(pool, {
      kind: 'classify_message',
      idempotencyKey: `m8-metrics-b-pending:${uuidv7()}`,
      sessionId: sessionB,
    });
    for (const duration of [1000, 2000]) {
      await pool.query(
        `INSERT INTO search_duration_samples (id, company_id, project_id, generation_id, duration_ms)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), workspace.companyId, projectB, generationB, duration],
      );
    }

    const result = await runCliProcess(['metrics', workspace.projectId], env);
    assert.equal(result.code, 0, `metricsが失敗した: ${result.stderr}`);
    assert.ok(result.stdout.trim().startsWith('{'), `metricsのstdoutがJSONでない: ${result.stdout.slice(0, 200)}`);
    const metrics = JSON.parse(result.stdout) as MetricsJson;
    assert.equal(metrics.project_id, workspace.projectId, 'metricsが別projectのscopeを返した');
    const generationA = metrics.generations.find((generation) => generation.generation_id === sourceA.id);
    assert.ok(generationA, 'active generationのdocument/vector件数がない');
    assert.equal(generationA.documents, 2, 'generation別document件数がsearchable文書と違う');
    assert.equal(generationA.vectors, 2, 'generation別vector件数が違う');
    assert.equal(generationA.dimensions, VOYAGE_DIMENSIONS);
    assert.equal(
      generationA.estimated_vector_bytes,
      2 * (VOYAGE_DIMENSIONS * 4 + 8),
      '推定vector bytesが4×次元+8/行の目安と違う',
    );
    assert.equal(metrics.reindex.pending_documents, 1, 'target未公開のsearchable文書だけを再索引残件にしていない');
    assert.equal(metrics.jobs.pending, 1, 'project scopeのpending job件数が違う');
    assert.equal(metrics.jobs.completed, 1, 'project scopeのcompleted job件数が違う');
    assert.equal(metrics.jobs.failed, 1, 'project scopeのfailed job件数が違う');
    assert.equal(metrics.jobs.running, 0);
    assert.equal(metrics.jobs.blocked_policy, 0);
    assert.equal(metrics.search_duration_ms.samples, 3, 'DB検索durationがproject scopeでない');
    assert.ok(metrics.search_duration_ms.p50 >= 10 && metrics.search_duration_ms.p50 <= 30, 'p50がproject Aの範囲外');
    assert.ok(metrics.search_duration_ms.p95 >= metrics.search_duration_ms.p50, 'p95がp50未満');
    assert.ok(metrics.search_duration_ms.p95 <= 30, 'p95がproject Aの範囲外');
    const serialized = JSON.stringify(metrics);
    for (const secret of [bodyMarker, docOne.text, docTwo.text, 'M8-METRICS-EXCLUDED', 'test-voyage-key', 'test-key']) {
      assert.ok(!serialized.includes(secret), `metricsへ本文/credentialを含めた: ${secret}`);
    }
    assert.ok(!serialized.includes(boundaryB), 'metricsへ別projectの本文を含めた');

    const resultB = await runCliProcess(['metrics', projectB], env);
    assert.equal(resultB.code, 0, `project Bのmetricsが失敗した: ${resultB.stderr}`);
    const metricsB = JSON.parse(resultB.stdout) as MetricsJson;
    assert.equal(metricsB.project_id, projectB);
    const generationBEntry = metricsB.generations.find((generation) => generation.generation_id === generationB);
    assert.ok(generationBEntry, 'project Bのgeneration件数がない');
    assert.equal(generationBEntry.documents, 1, 'project Bのdocument件数が違う');
    assert.equal(metricsB.jobs.pending, 1, 'project Bのjob件数が違う');
    assert.ok(metricsB.search_duration_ms.p50 >= 1000, '他projectのdurationを混ぜた');
    assert.ok(!JSON.stringify(metricsB).includes(docOne.text), 'project Bのmetricsへproject Aの本文を含めた');
  });

  it('durationはsample行数に比例してNodeへ読まず、SQL集約のcount/p50/p95を返す', { timeout: 30_000 }, async () => {
    await assertM8Structures(pool);
    const env = workerEnv();
    const config = loadWorkerConfig(env).config;
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    await pool.query(
      `INSERT INTO search_duration_samples (id, company_id, project_id, generation_id, duration_ms)
       SELECT gen_random_uuid(), $1, $2, $3, value FROM generate_series(1, 101) AS value`,
      [workspace.companyId, workspace.projectId, source.id],
    );

    const result = await runCliProcess(['metrics', workspace.projectId], env);
    assert.equal(result.code, 0, `metricsが失敗した: ${result.stderr}`);
    const metrics = JSON.parse(result.stdout) as MetricsJson;
    assert.equal(metrics.search_duration_ms.samples, 101, 'sample件数の集約が違う');
    assert.equal(metrics.search_duration_ms.p50, 51, 'p50のSQL集約が違う');
    assert.equal(metrics.search_duration_ms.p95, 96, 'p95のSQL集約が違う');
  });

  it('target完成後にsource messageだけ改訂された残件をpending_documentsへ数える', { timeout: 30_000 }, async () => {
    await assertM8Structures(pool);
    const env = workerEnv();
    const config = loadWorkerConfig(env).config;
    const source = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const sessionId = await seedSession(pool, workspace);
    const document = await seedDocument(pool, {
      workspace,
      sessionId,
      sequenceNo: 1,
      key: 'm8-metrics-stale',
      text: 'M8-METRICS-STALE-SOURCE',
      generationId: source.id,
      embedding: basisVector(0, 1),
    });
    const target = await insertGeneration(pool, { companyId: workspace.companyId, endpoint: config.voyageApiUrl });
    await pool.query(
      `INSERT INTO document_embeddings (document_id, revision, generation_id, embedding, input_hash)
       VALUES ($1, 1, $2, $3::vector, $4)`,
      [document.documentId, target, toVectorLiteral(basisVector(4, 1)), sha256Bytes(document.text)],
    );
    await pool.query('INSERT INTO document_publications (document_id, generation_id, revision, stale) VALUES ($1, $2, 1, false)', [
      document.documentId,
      target,
    ]);
    await pool.query(
      `INSERT INTO reindex_runs (id, company_id, project_id, source_generation_id, target_generation_id, status)
       VALUES ($1, $2, $3, $4, $5, 'running')`,
      [uuidv7(), workspace.companyId, workspace.projectId, source.id, target],
    );
    // embedding/publication/hash/staleは完成している。
    const incompleteBefore = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM search_documents d
         JOIN search_document_revisions r ON r.document_id = d.id AND r.revision = d.desired_revision
         LEFT JOIN document_embeddings e
           ON e.document_id = d.id AND e.revision = d.desired_revision AND e.generation_id = $2
         LEFT JOIN document_publications p
           ON p.document_id = d.id AND p.generation_id = $2 AND p.revision = d.desired_revision
        WHERE d.project_id = $1 AND d.is_searchable AND r.status <> 'excluded'
          AND (e.input_hash IS NULL OR e.input_hash <> r.content_hash OR p.document_id IS NULL OR p.stale)`,
      [workspace.projectId, target],
    );
    assert.equal(Number(incompleteBefore.rows[0]?.count), 0, 'embedding/publication/hashが完成していない');

    await advanceRevision(pool, document.messageId, 'M8-METRICS-STALE-REVISED');
    const result = await runCliProcess(['metrics', workspace.projectId], env);
    assert.equal(result.code, 0, `metricsが失敗した: ${result.stderr}`);
    const metrics = JSON.parse(result.stdout) as MetricsJson;
    assert.equal(metrics.reindex.pending_documents, 1, 'source現行性をreindex残件へ含めていない');
    assert.ok(!result.stdout.includes('M8-METRICS-STALE'), 'metricsへ本文を出した');
    assert.ok(!result.stdout.includes('test-voyage-key'), 'metricsへcredentialを出した');
  });
});
