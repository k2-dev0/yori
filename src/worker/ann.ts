import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';
import { validate as validateUuid } from 'uuid';
import { SEARCH_STATEMENT_TIMEOUT_MS, SEARCH_VECTOR_LIMIT, VOYAGE_DIMENSIONS } from './contract.js';

// 近似索引（世代ごとの部分HNSW）導入の準備。管理者が明示実行する索引の作成・削除と、
// 厳密検索に対する近似検索の一致率（recall）の比較だけを行う。本番の検索経路は変更しない。
// 本文・質問・検索条件・credentialは読み出さず、出力もしない。

const ANN_INDEX_NAME_PREFIX = 'document_embeddings_hnsw_';
const ANN_ITERATIVE_SCAN = 'relaxed_order';
const ANN_EF_SEARCH = 100;
const ANN_DURATION_DECIMALS = 3;
const MEDIAN_FRACTION = 0.5;
const P95_FRACTION = 0.95;

// 索引名とDDLへ埋め込む世代IDはここでUUIDへ限定する。DDLはbind parameterを使えないため。
export function annIndexName(generationId: string): string {
  if (!validateUuid(generationId)) {
    throw new Error('generation idがUUIDではありません');
  }
  return `${ANN_INDEX_NAME_PREFIX}${generationId.toLowerCase().replaceAll('-', '')}`;
}

// CREATE INDEX CONCURRENTLYは失敗・中断でINVALIDな索引を残す。有効な索引だけを利用可能と扱う。
async function annIndexState(db: Pool | PoolClient, indexName: string): Promise<'valid' | 'invalid' | 'missing'> {
  const index = await db.query<{ indisvalid: boolean }>(
    `SELECT i.indisvalid
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1 AND pg_table_is_visible(c.oid)`,
    [indexName],
  );
  const row = index.rows[0];
  if (row === undefined) {
    return 'missing';
  }
  return row.indisvalid ? 'valid' : 'invalid';
}

export type AnnIndexCreateResult = 'created' | 'already_exists' | 'generation_not_found' | 'ann_index_busy';

// 指定世代専用の部分HNSW索引を作る。CONCURRENTLYはTX内で実行できないため、1 sessionで順に実行する。
export async function createAnnIndex(pool: Pool, generationId: string): Promise<AnnIndexCreateResult> {
  const indexName = annIndexName(generationId);
  const client = await pool.connect();
  let locked = false;
  try {
    const generationExists = async (): Promise<boolean> =>
      (await client.query('SELECT 1 FROM embedding_generations WHERE id = $1', [generationId])).rows.length > 0;
    if (!(await generationExists())) {
      return 'generation_not_found';
    }
    // 構築中の索引もINVALIDに見える。同じ索引の同時作成が互いの構築中索引を消さないよう直列化する。
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [indexName]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) {
      return 'ann_index_busy';
    }
    const state = await annIndexState(client, indexName);
    if (state === 'valid') {
      return 'already_exists';
    }
    // 索引構築は通常のstatement_timeoutを超えるため、このsessionだけ無効にする。
    await client.query('SET statement_timeout = 0');
    if (state === 'invalid') {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`);
    }
    await client.query(
      `CREATE INDEX CONCURRENTLY ${indexName} ON document_embeddings
         USING hnsw ((embedding::halfvec(${VOYAGE_DIMENSIONS})) halfvec_cosine_ops)
         WHERE generation_id = '${generationId.toLowerCase()}'`,
    );
    // 構築中に世代が削除された場合、何も指さない索引を残さない。
    if (!(await generationExists())) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`);
      return 'generation_not_found';
    }
    return 'created';
  } finally {
    await client.query('RESET statement_timeout').catch(() => undefined);
    if (locked) {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [indexName]).catch(() => undefined);
    }
    client.release();
  }
}

export type AnnIndexDropResult = 'dropped' | 'not_found';

export async function dropAnnIndex(pool: Pool, generationId: string): Promise<AnnIndexDropResult> {
  const indexName = annIndexName(generationId);
  if ((await annIndexState(pool, indexName)) === 'missing') {
    return 'not_found';
  }
  await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`);
  return 'dropped';
}

// 絞り込みはsearch.tsのVECTOR_CANDIDATES_SQLと同じ（会社・案件・世代・検索可能な公開revision）。
// 検索元sessionの発言を除く条件だけは持たない。embedding_cacheの質問ベクトルは元のsessionを
// 記録しておらず再現できないため、厳密・近似の両方から同じように外す。
const RECALL_SCOPE_SQL = `
    FROM document_embeddings e
    JOIN search_documents d ON d.id = e.document_id
    JOIN document_search_entries p
      ON p.document_id = e.document_id AND p.generation_id = e.generation_id AND p.revision = e.revision
    JOIN search_document_revisions r
      ON r.document_id = e.document_id AND r.revision = e.revision
        AND (r.status IN ('ready', 'superseded') OR p.correction_only)
   WHERE d.company_id = $1
     AND d.project_id = $2
`;

const EXACT_TOP_SQL = `
  SELECT e.document_id, e.revision
  ${RECALL_SCOPE_SQL}
     AND e.generation_id = $4
   ORDER BY e.embedding <=> $3::vector ASC, e.document_id ASC, e.revision ASC
   LIMIT $5
`;

// 部分索引の述語と式に一致させるため、世代IDはliteral、距離はhalfvecの式で書く。
// relaxed_orderは距離順を厳密に保証しないため、内側で上位を取り、外側で厳密側と同じ順へ並べ直す。
function approximateTopSql(generationId: string): string {
  return `
  SELECT x.document_id, x.revision
    FROM (
      SELECT e.document_id, e.revision,
             (e.embedding::halfvec(${VOYAGE_DIMENSIONS})) <=> $3::halfvec(${VOYAGE_DIMENSIONS}) AS distance
      ${RECALL_SCOPE_SQL}
         AND e.generation_id = '${generationId}'
       ORDER BY distance ASC
       LIMIT $4
    ) x
   ORDER BY x.distance ASC, x.document_id ASC, x.revision ASC
`;
}

export interface AnnRecallReport {
  project_id: string;
  generation_id: string;
  samples: number;
  recall: { mean: number; min: number };
  exact_duration_ms: { p50: number; p95: number };
  approximate_duration_ms: { p50: number; p95: number };
  settings: { top_k: number; ef_search: number; iterative_scan: string; statement_timeout_ms: number; index_name: string };
}

export type AnnRecallResult = { ok: true; report: AnnRecallReport } | { ok: false; code: string };

// 設定はSET LOCALでTX内に閉じ、pool上の他のqueryへ漏らさない。
async function inSettingsTransaction<T>(pool: Pool, settings: readonly string[], run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const setting of settings) {
      await client.query(setting);
    }
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function timedTopKeys(
  pool: Pool,
  settings: readonly string[],
  sql: string,
  params: readonly unknown[],
): Promise<{ keys: string[]; durationMs: number }> {
  return inSettingsTransaction(pool, settings, async (client) => {
    const startedAt = performance.now();
    const rows = await client.query<{ document_id: string; revision: number }>(sql, [...params]);
    const durationMs = performance.now() - startedAt;
    return { keys: rows.rows.map((row) => `${row.document_id}:${row.revision}`), durationMs };
  });
}

function percentiles(durations: readonly number[]): { p50: number; p95: number } {
  const sorted = [...durations].sort((left, right) => left - right);
  const at = (fraction: number): number =>
    Number((sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0).toFixed(ANN_DURATION_DECIMALS));
  return { p50: at(MEDIAN_FRACTION), p95: at(P95_FRACTION) };
}

// active世代の既存の質問ベクトル（embedding_cache）で、厳密検索と近似検索の上位を比べる。
// 外部providerは呼ばない。質問ベクトルは会社・世代単位のcacheであり、他案件の質問も含む。
export async function measureAnnRecall(pool: Pool, projectId: string, sampleLimit: number): Promise<AnnRecallResult> {
  const project = await pool.query<{ company_id: string; active_generation_id: string | null }>(
    'SELECT company_id, active_generation_id FROM projects WHERE id = $1',
    [projectId],
  );
  const projectRow = project.rows[0];
  if (projectRow === undefined) {
    return { ok: false, code: 'project_not_found' };
  }
  const generationId = projectRow.active_generation_id;
  if (generationId === null) {
    return { ok: false, code: 'active_generation_not_found' };
  }
  const indexName = annIndexName(generationId);
  if ((await annIndexState(pool, indexName)) !== 'valid') {
    return { ok: false, code: 'ann_index_not_found' };
  }
  const queries = await pool.query<{ embedding: string }>(
    `SELECT embedding::text AS embedding
       FROM embedding_cache
      WHERE company_id = $1 AND generation_id = $2 AND operation = 'query' AND dimensions = $3
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [projectRow.company_id, generationId, VOYAGE_DIMENSIONS, sampleLimit],
  );
  if (queries.rows.length === 0) {
    return { ok: false, code: 'ann_recall_no_samples' };
  }

  const timeout = `SET LOCAL statement_timeout = ${SEARCH_STATEMENT_TIMEOUT_MS}`;
  // 厳密側はvector型の距離で並べるため、halfvecの式索引を使えない。追加のplanner設定は不要で、
  // 通常のjoin索引まで無効にすると本番の厳密検索と違う時間を測ることになる。
  const exactSettings = [timeout];
  const approximateSettings = [
    timeout,
    `SET LOCAL hnsw.iterative_scan = ${ANN_ITERATIVE_SCAN}`,
    `SET LOCAL hnsw.ef_search = ${ANN_EF_SEARCH}`,
    'SET LOCAL enable_seqscan = off',
  ];
  const approximateSql = approximateTopSql(generationId);
  const scope = [projectRow.company_id, projectId];

  // 近似側が実際に索引を使う計画でなければ、測った値は近似検索のrecallではない。
  const plan = await inSettingsTransaction(pool, approximateSettings, (client) =>
    client.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${approximateSql}`, [
      ...scope,
      queries.rows[0].embedding,
      SEARCH_VECTOR_LIMIT,
    ]),
  );
  if (!JSON.stringify(plan.rows[0]?.['QUERY PLAN']).includes(indexName)) {
    return { ok: false, code: 'ann_index_not_used' };
  }

  const recalls: number[] = [];
  const exactDurations: number[] = [];
  const approximateDurations: number[] = [];
  let exactFirst = true;
  for (const query of queries.rows) {
    const runExact = () => timedTopKeys(pool, exactSettings, EXACT_TOP_SQL, [...scope, query.embedding, generationId, SEARCH_VECTOR_LIMIT]);
    const runApproximate = () => timedTopKeys(pool, approximateSettings, approximateSql, [...scope, query.embedding, SEARCH_VECTOR_LIMIT]);
    // 先に実行した側がbufferを温めて後の側を有利にするため、順序を交互に入れ替える。
    const first = exactFirst ? await runExact() : await runApproximate();
    const second = exactFirst ? await runApproximate() : await runExact();
    const exact = exactFirst ? first : second;
    const approximate = exactFirst ? second : first;
    exactFirst = !exactFirst;
    if (exact.keys.length === 0) {
      return { ok: false, code: 'ann_recall_no_documents' };
    }
    const approximateKeys = new Set(approximate.keys);
    recalls.push(exact.keys.filter((key) => approximateKeys.has(key)).length / exact.keys.length);
    exactDurations.push(exact.durationMs);
    approximateDurations.push(approximate.durationMs);
  }

  return {
    ok: true,
    report: {
      project_id: projectId,
      generation_id: generationId,
      samples: recalls.length,
      recall: {
        mean: recalls.reduce((sum, value) => sum + value, 0) / recalls.length,
        min: Math.min(...recalls),
      },
      exact_duration_ms: percentiles(exactDurations),
      approximate_duration_ms: percentiles(approximateDurations),
      settings: {
        top_k: SEARCH_VECTOR_LIMIT,
        ef_search: ANN_EF_SEARCH,
        iterative_scan: ANN_ITERATIVE_SCAN,
        statement_timeout_ms: SEARCH_STATEMENT_TIMEOUT_MS,
        index_name: indexName,
      },
    },
  };
}
