import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { resetDatabase, seedWorkspace, sha256Bytes, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { runCli } from '../cli.js';
import { loadWorkerConfig } from '../config.js';
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
import { ensureActiveGeneration } from '../embedding.js';
import { loadProjectMetrics } from '../metrics.js';
import { seedMessage, seedSearchRequest, seedSession } from './support.js';
import {
  basisVector,
  runExecuteSearch,
  seedExecuteSearch,
  seedReadyDocument,
  similarityVector,
  startM7Providers,
  toVectorLiteral,
  vectorQueryResponder,
} from './m7-support.js';

// 近似索引（HNSW）導入準備の契約。実PostgreSQL（pgvector 0.8系）とloopback fixtureだけを使い、
// 実Voyage・実会話へ送信しない。本番の検索経路が近似索引を使わないことは既存の検索テストが担う。

const VOYAGE_ACCOUNT = 'voyage-acct-a';
const ANN_INDEX_NAME_PATTERN = 'document\\_embeddings\\_hnsw\\_%';
const MIN_SAMPLES = 50;
const SAMPLE_WINDOW = 200;
const VECTOR_P95_THRESHOLD_MS = 100;
const DOCUMENT_THRESHOLD = 20_000;
const TOP_K = 20;

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
  // 索引はTRUNCATEで消えない。他のテストfileへ残さない。
  const indexes = await pool.query<{ indexname: string }>('SELECT indexname FROM pg_indexes WHERE indexname LIKE $1', [
    ANN_INDEX_NAME_PATTERN,
  ]);
  for (const row of indexes.rows) {
    await pool.query(`DROP INDEX IF EXISTS ${row.indexname}`);
  }
});

after(async () => {
  await pool.end();
});

function workerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: requireDatabaseUrl(),
    JEV_API_KEY: 'test-key',
    JEV_ACCOUNT_REF: 'acct-a',
    VOYAGE_API_KEY: 'test-voyage-key',
    VOYAGE_ACCOUNT_REF: VOYAGE_ACCOUNT,
  };
}

async function activeGenerationId(): Promise<string> {
  const generation = await ensureActiveGeneration(
    pool,
    { companyId: workspace.companyId, projectId: workspace.projectId },
    loadWorkerConfig(workerEnv()).config,
  );
  return generation.id;
}

// どのprojectからも参照されない世代。世代削除の対象にできる。
async function insertRetiredGeneration(): Promise<string> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO embedding_generations
       (id, company_id, provider, account_ref, endpoint, model, model_revision, dimensions, metric,
        tokenizer_version, document_input_type, query_input_type, normalization, status)
     VALUES ($1, $2, $3, $4, 'https://voyage.invalid/v1/embeddings', $5, NULL, $6, $7, $8, $9, $10, $11, 'retired')`,
    [
      id,
      workspace.companyId,
      VOYAGE_PROVIDER,
      VOYAGE_ACCOUNT,
      VOYAGE_MODEL,
      VOYAGE_DIMENSIONS,
      VOYAGE_METRIC,
      VOYAGE_TOKENIZER_VERSION,
      VOYAGE_DOCUMENT_INPUT_TYPE,
      VOYAGE_QUERY_INPUT_TYPE,
      VOYAGE_NORMALIZATION,
    ],
  );
  return id;
}

async function readAnnIndex(generationId: string): Promise<{ indexdef: string; indisvalid: boolean } | undefined> {
  const result = await pool.query<{ indexdef: string; indisvalid: boolean }>(
    `SELECT x.indexdef, i.indisvalid
       FROM pg_indexes x
       JOIN pg_class c ON c.relname = x.indexname
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE x.tablename = 'document_embeddings' AND x.indexname = $1`,
    [`document_embeddings_hnsw_${generationId.replaceAll('-', '')}`],
  );
  return result.rows[0];
}

async function insertVectorSamples(
  pool: Pool,
  input: { generationId: string; count: number; vectorDurationMs: number | null; ageMinutes?: number },
): Promise<void> {
  await pool.query(
    `INSERT INTO search_duration_samples (id, company_id, project_id, generation_id, duration_ms, vector_duration_ms, created_at)
     SELECT gen_random_uuid(), $1, $2, $3, 1000, $4, now() - make_interval(mins => $6::int)
       FROM generate_series(1, $5::int)`,
    [workspace.companyId, workspace.projectId, input.generationId, input.vectorDurationMs, input.count, input.ageMinutes ?? 0],
  );
}

async function annRecommendation() {
  const metrics = await loadProjectMetrics(pool, workspace.projectId);
  assert.ok(metrics, 'metricsを取得できない');
  return metrics.ann_recommendation;
}

interface CliProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// JSON stdoutと固定エラーコードを検証するため、CLIを子processで起動する。
function runCliProcess(argv: string[]): Promise<CliProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker/cli.ts', ...argv], {
      cwd: process.cwd(),
      env: workerEnv(),
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

describe('近似索引 CLI契約', () => {
  it('worker:ann-index / worker:ann-recall scriptを提供する', async () => {
    const raw = await readFile(path.join(process.cwd(), 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    assert.ok(pkg.scripts?.['worker:ann-index']?.includes('src/worker/cli.ts ann-index'), 'worker:ann-index scriptがない');
    assert.ok(pkg.scripts?.['worker:ann-recall']?.includes('src/worker/cli.ts ann-recall'), 'worker:ann-recall scriptがない');
  });
});

describe('vector経路の所要時間', () => {
  it('候補検索のsampleへvector経路だけの時間を合計と別に記録する', { timeout: 30_000 }, async () => {
    const providers = await startM7Providers(pool, workspace.companyId, {
      jevMode: 'positive',
      voyageResponder: vectorQueryResponder(basisVector(0, 1)),
    });
    openServers.push(providers.jev, providers.voyage);
    const generation = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      providers.config,
    );
    const documentSession = await seedSession(pool, workspace);
    const text = 'ANN-VECTOR-DURATION-DOC';
    const message = await seedMessage(pool, { sessionId: documentSession, sequenceNo: 1, role: 'assistant', text });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: documentSession,
      documentKey: 'ann-vector-duration',
      content: text,
      generationId: generation.id,
      embedding: basisVector(0, 1),
      sources: [{ messageId: message.messageId, messageRevision: message.revision, startOffset: 0, endOffset: text.length }],
    });
    const searchSession = await seedSession(pool, workspace);
    const seeded = await seedExecuteSearch(pool, { workspace, sessionId: searchSession, sequenceNo: 1, text: 'ANN-VECTOR-DURATION-QUERY' });
    await runExecuteSearch(pool, { jobId: seeded.jobId, config: providers.config });

    const samples = await pool.query<{ duration_ms: number; vector_duration_ms: number | null }>(
      'SELECT duration_ms, vector_duration_ms FROM search_duration_samples WHERE project_id = $1',
      [workspace.projectId],
    );
    assert.equal(samples.rows.length, 1, '候補検索のsampleが1件ではない');
    const sample = samples.rows[0];
    assert.notEqual(sample.vector_duration_ms, null, 'vector_duration_msが記録されていない');
    assert.ok((sample.vector_duration_ms ?? -1) >= 0, 'vector_duration_msが負値');
    assert.ok((sample.vector_duration_ms ?? Infinity) <= sample.duration_ms, 'vector経路の時間が3経路合計を超えた');
  });
});

describe('ann_recommendation', () => {
  it('sampleが不足する間は時間が遅くても推奨せず、insufficient_samplesを返す', { timeout: 30_000 }, async () => {
    const generationId = await activeGenerationId();
    await insertVectorSamples(pool, { generationId, count: MIN_SAMPLES - 1, vectorDurationMs: VECTOR_P95_THRESHOLD_MS * 10 });
    // 列追加前のNULL sampleは件数へ数えない。
    await insertVectorSamples(pool, { generationId, count: MIN_SAMPLES, vectorDurationMs: null });

    const recommendation = await annRecommendation();
    assert.equal(recommendation.recommended, false);
    assert.deepEqual(recommendation.reasons, ['insufficient_samples']);
    assert.equal(recommendation.observed.samples, MIN_SAMPLES - 1);
    assert.deepEqual(recommendation.thresholds, {
      min_samples: MIN_SAMPLES,
      sample_window: SAMPLE_WINDOW,
      vector_p95_ms: VECTOR_P95_THRESHOLD_MS,
      documents: DOCUMENT_THRESHOLD,
    });
  });

  it('sampleが揃いvector経路のp95がしきい値を超えたら推奨する', { timeout: 30_000 }, async () => {
    const generationId = await activeGenerationId();
    await insertVectorSamples(pool, { generationId, count: MIN_SAMPLES, vectorDurationMs: VECTOR_P95_THRESHOLD_MS });
    const atThreshold = await annRecommendation();
    assert.equal(atThreshold.recommended, false, 'しきい値ちょうどで推奨した');
    assert.deepEqual(atThreshold.reasons, []);
    assert.equal(atThreshold.observed.vector_p95_ms, VECTOR_P95_THRESHOLD_MS);

    await resetDatabase(pool);
    workspace = await seedWorkspace(pool);
    const slowGenerationId = await activeGenerationId();
    await insertVectorSamples(pool, { generationId: slowGenerationId, count: MIN_SAMPLES, vectorDurationMs: VECTOR_P95_THRESHOLD_MS + 1 });
    const exceeded = await annRecommendation();
    assert.equal(exceeded.recommended, true);
    assert.deepEqual(exceeded.reasons, ['vector_p95_exceeded']);
    assert.equal(exceeded.observed.samples, MIN_SAMPLES);
    assert.equal(exceeded.observed.vector_p95_ms, VECTOR_P95_THRESHOLD_MS + 1);
  });

  it('直近の範囲より古いsampleと別世代のsampleはp95へ含めない', { timeout: 30_000 }, async () => {
    const generationId = await activeGenerationId();
    const otherGenerationId = await insertRetiredGeneration();
    await insertVectorSamples(pool, { generationId, count: SAMPLE_WINDOW, vectorDurationMs: 1 });
    await insertVectorSamples(pool, { generationId, count: SAMPLE_WINDOW, vectorDurationMs: VECTOR_P95_THRESHOLD_MS * 10, ageMinutes: 60 });
    await insertVectorSamples(pool, { generationId: otherGenerationId, count: SAMPLE_WINDOW, vectorDurationMs: VECTOR_P95_THRESHOLD_MS * 10 });

    const recommendation = await annRecommendation();
    assert.equal(recommendation.recommended, false, '古いsampleまたは別世代のsampleで推奨した');
    assert.equal(recommendation.observed.samples, SAMPLE_WINDOW);
    assert.equal(recommendation.observed.vector_p95_ms, 1);
  });

  it('active世代の公開文書数がしきい値を超えたら、sampleがなくても推奨する', { timeout: 60_000 }, async () => {
    const generationId = await activeGenerationId();
    const sessionId = await seedSession(pool, workspace);
    const content = 'ANN-DOCUMENT-COUNT';
    await pool.query(
      `WITH docs AS (
         INSERT INTO search_documents (id, company_id, project_id, session_id, document_key, desired_revision, is_searchable)
         SELECT gen_random_uuid(), $1, $2, $3, 'ann-bulk-' || n, 1, true FROM generate_series(1, $6::int) AS n
         RETURNING id
       ), revisions AS (
         INSERT INTO search_document_revisions (document_id, revision, content, content_hash, chunker_version, status)
         SELECT id, 1, $4, $5, 'ann-test', 'ready' FROM docs
         RETURNING document_id
       )
       INSERT INTO document_publications (document_id, generation_id, revision, is_stale)
       SELECT document_id, $7, 1, false FROM revisions`,
      [workspace.companyId, workspace.projectId, sessionId, content, sha256Bytes(content), DOCUMENT_THRESHOLD + 1, generationId],
    );

    const exceeded = await annRecommendation();
    assert.equal(exceeded.recommended, true);
    assert.deepEqual(exceeded.reasons, ['insufficient_samples', 'document_count_exceeded']);
    assert.equal(exceeded.observed.documents, DOCUMENT_THRESHOLD + 1);
    assert.equal(exceeded.observed.vector_p95_ms, null);

    await pool.query('DELETE FROM search_documents WHERE id = (SELECT id FROM search_documents WHERE project_id = $1 LIMIT 1)', [
      workspace.projectId,
    ]);
    const atThreshold = await annRecommendation();
    assert.equal(atThreshold.recommended, false, 'しきい値ちょうどの文書数で推奨した');
    assert.deepEqual(atThreshold.reasons, ['insufficient_samples']);
  });
});

describe('worker:ann-index', () => {
  it('世代専用の部分HNSW索引を作成・削除する', { timeout: 60_000 }, async () => {
    const env = workerEnv();
    const generationId = await activeGenerationId();
    assert.equal(await readAnnIndex(generationId), undefined, '索引が自動で作られている');

    assert.equal(await runCli(['ann-index', 'create', '--generation', generationId], env), 0, '索引を作成できない');
    const created = await readAnnIndex(generationId);
    assert.ok(created, '索引が作られていない');
    assert.equal(created.indisvalid, true, '索引がINVALID');
    assert.match(created.indexdef, /USING hnsw/);
    assert.match(created.indexdef, /halfvec\(1024\)/);
    assert.match(created.indexdef, /halfvec_cosine_ops/);
    assert.ok(created.indexdef.includes(`generation_id = '${generationId}'`), `世代の部分索引ではない: ${created.indexdef}`);

    assert.equal(await runCli(['ann-index', 'create', '--generation', generationId], env), 0, '作成済みの再実行が失敗した');
    assert.equal(await runCli(['ann-index', 'drop', '--generation', generationId], env), 0, '索引を削除できない');
    assert.equal(await readAnnIndex(generationId), undefined, '索引が残っている');
    assert.notEqual(await runCli(['ann-index', 'drop', '--generation', generationId], env), 0, '存在しない索引の削除が成功した');
  });

  it('存在しない世代・不正な引数を拒否し、索引を作らない', { timeout: 30_000 }, async () => {
    const env = workerEnv();
    const missingGenerationId = uuidv7();
    assert.notEqual(await runCli(['ann-index', 'create', '--generation', missingGenerationId], env), 0);
    assert.equal(await readAnnIndex(missingGenerationId), undefined);
    assert.notEqual(await runCli(['ann-index', 'create', '--generation', 'not-a-uuid'], env), 0);
    assert.notEqual(await runCli(['ann-index', 'create'], env), 0);
    assert.notEqual(await runCli(['ann-index', 'rebuild', '--generation', missingGenerationId], env), 0);
  });

  it('世代削除で、その世代の索引も消す', { timeout: 60_000 }, async () => {
    const env = workerEnv();
    const generationId = await insertRetiredGeneration();
    const keptGenerationId = await activeGenerationId();
    assert.equal(await runCli(['ann-index', 'create', '--generation', generationId], env), 0);
    assert.equal(await runCli(['ann-index', 'create', '--generation', keptGenerationId], env), 0);

    assert.equal(await runCli(['generation:delete', generationId], env), 0, '世代を削除できない');
    assert.equal(await readAnnIndex(generationId), undefined, '削除した世代の索引が残っている');
    assert.ok(await readAnnIndex(keptGenerationId), '別世代の索引まで消した');

    // 参照があり削除を拒否された世代の索引は残す。
    assert.notEqual(await runCli(['generation:delete', keptGenerationId], env), 0);
    assert.ok(await readAnnIndex(keptGenerationId), '削除を拒否した世代の索引を消した');
  });
});

describe('worker:ann-recall', () => {
  const DOCUMENT_COUNT = 40;
  const CACHED_QUERY_COUNT = 5;
  const REQUESTED_SAMPLES = 3;
  const CONTENT_MARKER = 'ANN-RECALL-SECRET';
  const QUERY_MARKER = 'ANN-RECALL-QUESTION';

  async function seedRecallFixture(): Promise<string> {
    const generationId = await activeGenerationId();
    const sessionId = await seedSession(pool, workspace);
    for (let rank = 1; rank <= DOCUMENT_COUNT; rank += 1) {
      await seedReadyDocument(pool, {
        companyId: workspace.companyId,
        projectId: workspace.projectId,
        sessionId,
        documentKey: `ann-recall-${rank}`,
        content: `${CONTENT_MARKER}-${rank}`,
        generationId,
        embedding: similarityVector(rank),
        sources: [],
      });
    }
    return generationId;
  }

  async function insertQueryCache(generationId: string, text: string, vector: readonly number[]): Promise<void> {
    await pool.query(
      `INSERT INTO embedding_cache (id, company_id, generation_id, operation, input_hash, embedding, model, dimensions)
       VALUES ($1, $2, $3, 'query', $4, $5::vector, $6, $7)`,
      [uuidv7(), workspace.companyId, generationId, sha256Bytes(text), toVectorLiteral(vector), VOYAGE_MODEL, VOYAGE_DIMENSIONS],
    );
  }

  // 案件の過去の検索要求と、その質問のcache済みベクトルを作る。manualは受付の質問、autoは入力発言が質問になる。
  async function seedCachedSearch(
    generationId: string,
    input: { text: string; vector: readonly number[]; question?: string; sessionId?: string; sequenceNo?: number },
  ): Promise<void> {
    const sessionId = input.sessionId ?? (await seedSession(pool, workspace));
    const sequenceNo = input.sequenceNo ?? 1;
    const message = await seedMessage(pool, { sessionId, sequenceNo, role: 'user', text: input.text });
    const requestId = await seedSearchRequest(pool, {
      workspace,
      sessionId,
      inputId: message.messageId,
      inputRevision: message.revision,
      sequenceNo,
      trigger: input.question === undefined ? 'auto' : 'manual',
      question: input.question,
      searchAction: 'new_search',
      status: 'completed',
    });
    await pool.query('UPDATE search_requests SET embedding_generation_id = $2 WHERE id = $1', [requestId, generationId]);
    await insertQueryCache(generationId, input.question ?? input.text, input.vector);
  }

  async function seedCachedSearches(generationId: string): Promise<void> {
    for (let index = 1; index < CACHED_QUERY_COUNT; index += 1) {
      await seedCachedSearch(generationId, { text: `${QUERY_MARKER}-${index}`, vector: basisVector(0, index) });
    }
    await seedCachedSearch(generationId, {
      text: `${QUERY_MARKER}-INPUT`,
      question: `${QUERY_MARKER}-MANUAL`,
      vector: basisVector(0, CACHED_QUERY_COUNT),
    });
  }

  it('索引がない世代では固定のエラーコードで終了する', { timeout: 60_000 }, async () => {
    await seedCachedSearches(await seedRecallFixture());
    const result = await runCliProcess(['ann-recall', '--project', workspace.projectId]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), 'worker: ann_index_not_found');
    assert.equal(result.stdout, '', '失敗時にstdoutへ出力した');
  });

  it('同じデータで厳密と近似を実行し、本文を含まない指標をJSONで返す', { timeout: 60_000 }, async () => {
    const generationId = await seedRecallFixture();
    await seedCachedSearches(generationId);
    assert.equal(await runCli(['ann-index', 'create', '--generation', generationId], workerEnv()), 0);

    const result = await runCliProcess(['ann-recall', '--project', workspace.projectId, '--samples', String(REQUESTED_SAMPLES)]);
    assert.equal(result.code, 0, `ann-recallが失敗した: ${result.stderr}`);
    assert.ok(!result.stdout.includes(CONTENT_MARKER), 'stdoutへ本文を含めた');
    assert.ok(!result.stderr.includes(CONTENT_MARKER), 'stderrへ本文を含めた');
    assert.ok(!result.stdout.includes(QUERY_MARKER) && !result.stderr.includes(QUERY_MARKER), '質問を出力した');
    const report = JSON.parse(result.stdout) as {
      project_id: string;
      generation_id: string;
      samples: number;
      recall: { mean: number; min: number };
      exact_duration_ms: { p50: number; p95: number };
      approximate_duration_ms: { p50: number; p95: number };
      settings: { top_k: number; ef_search: number; iterative_scan: string; statement_timeout_ms: number; index_name: string };
    };
    assert.deepEqual(Object.keys(report).sort(), [
      'approximate_duration_ms',
      'exact_duration_ms',
      'generation_id',
      'project_id',
      'recall',
      'samples',
      'settings',
    ]);
    assert.equal(report.project_id, workspace.projectId);
    assert.equal(report.generation_id, generationId);
    assert.equal(report.samples, REQUESTED_SAMPLES);
    // 距離が全て異なる少数の文書では、近似検索は厳密検索の上位を取りこぼさない。
    assert.equal(report.recall.mean, 1);
    assert.equal(report.recall.min, 1);
    for (const duration of [report.exact_duration_ms, report.approximate_duration_ms]) {
      assert.ok(duration.p50 >= 0 && duration.p95 >= duration.p50, `所要時間のp50/p95が不正: ${JSON.stringify(duration)}`);
    }
    assert.equal(report.settings.top_k, TOP_K);
    assert.equal(report.settings.iterative_scan, 'relaxed_order');
    assert.ok(report.settings.ef_search >= TOP_K);
    assert.equal(report.settings.index_name, `document_embeddings_hnsw_${generationId.replaceAll('-', '')}`);
  });

  it('manual検索は受付の質問、autoは入力発言のcacheを質問ベクトルに使う', { timeout: 60_000 }, async () => {
    const generationId = await seedRecallFixture();
    await seedCachedSearches(generationId);
    assert.equal(await runCli(['ann-index', 'create', '--generation', generationId], workerEnv()), 0);
    const result = await runCliProcess(['ann-recall', '--project', workspace.projectId]);
    assert.equal(result.code, 0, `ann-recallが失敗した: ${result.stderr}`);
    assert.equal((JSON.parse(result.stdout) as { samples: number }).samples, CACHED_QUERY_COUNT);
  });

  it('この案件の検索要求に結び付かないcacheは使わず、固定のエラーコードで終了する', { timeout: 60_000 }, async () => {
    const generationId = await seedRecallFixture();
    // 同じ会社・世代の質問cacheだが、この案件の検索要求の質問ではない。
    await insertQueryCache(generationId, `${QUERY_MARKER}-OTHER-PROJECT`, basisVector(0, 1));
    assert.equal(await runCli(['ann-index', 'create', '--generation', generationId], workerEnv()), 0);
    const result = await runCliProcess(['ann-recall', '--project', workspace.projectId]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), 'worker: ann_recall_no_samples');
  });

  it('検索元sessionの質問以降の発言を含む文書を、本番の検索と同じく比較対象から除く', { timeout: 60_000 }, async () => {
    const generationId = await activeGenerationId();
    const sessionId = await seedSession(pool, workspace);
    const questionSequenceNo = 1;
    // 全ての文書が、検索元sessionの質問より後の発言をsourceに持つ。
    for (let rank = 1; rank <= DOCUMENT_COUNT; rank += 1) {
      const text = `${CONTENT_MARKER}-AFTER-QUESTION-${rank}`;
      const answer = await seedMessage(pool, { sessionId, sequenceNo: questionSequenceNo + rank, role: 'assistant', text });
      await seedReadyDocument(pool, {
        companyId: workspace.companyId,
        projectId: workspace.projectId,
        sessionId,
        documentKey: `ann-recall-after-question-${rank}`,
        content: text,
        generationId,
        embedding: similarityVector(rank),
        sources: [{ messageId: answer.messageId, messageRevision: answer.revision, startOffset: 0, endOffset: text.length }],
      });
    }
    await seedCachedSearch(generationId, { text: `${QUERY_MARKER}-SELF`, vector: basisVector(0, 1), sessionId, sequenceNo: questionSequenceNo });
    assert.equal(await runCli(['ann-index', 'create', '--generation', generationId], workerEnv()), 0);

    // 全ての文書が除外されるため、比較できるsampleが残らない。
    const result = await runCliProcess(['ann-recall', '--project', workspace.projectId]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), 'worker: ann_recall_no_documents');
  });

  it('不正な引数を拒否する', async () => {
    const env = workerEnv();
    assert.notEqual(await runCli(['ann-recall'], env), 0);
    assert.notEqual(await runCli(['ann-recall', '--project', 'not-a-uuid'], env), 0);
    assert.notEqual(await runCli(['ann-recall', '--project', workspace.projectId, '--samples', '0'], env), 0);
    assert.notEqual(await runCli(['ann-recall', '--project', workspace.projectId, '--unknown', '1'], env), 0);
  });
});
