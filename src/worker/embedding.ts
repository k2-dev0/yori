import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import {
  VOYAGE_DIMENSIONS,
  VOYAGE_DOCUMENT_INPUT_TYPE,
  VOYAGE_METRIC,
  VOYAGE_MODEL,
  VOYAGE_NORMALIZATION,
  VOYAGE_PROVIDER,
  VOYAGE_QUERY_INPUT_TYPE,
  VOYAGE_TOKENIZER_VERSION,
} from './contract.js';
import { GenerationMismatchError, PolicyBlockedError } from './errors.js';
import { hasActiveProviderApproval } from './approvals.js';
import type { WorkerConfig } from './config.js';
import {
  callVoyage,
  extractVoyageInputTokens,
  extractVoyageResponseModel,
  validateVoyageResponse,
  VoyageCallError,
  type VoyageOperation,
} from './voyage.js';

// DBに登録済みの埋め込み世代。specの比較・cache・provider呼出しに必要な値を保持する。
export interface EmbeddingGeneration {
  id: string;
  companyId: string;
  provider: string;
  accountRef: string;
  endpoint: string;
  model: string;
  modelRevision: string | null;
  dimensions: number;
  metric: string;
  tokenizerVersion: string;
  documentInputType: string;
  queryInputType: string;
  normalization: string;
  status: string;
}

// 文書/質問を埋め込みvectorへ変換するproduction interface。テスト専用のclient injectionは持たない。
export interface EmbeddingProvider {
  embedDocuments(texts: readonly string[], generation: EmbeddingGeneration): Promise<number[][]>;
  embedQuery(text: string, generation: EmbeddingGeneration): Promise<number[]>;
}

interface GenerationRow {
  id: string;
  company_id: string;
  provider: string;
  account_ref: string;
  endpoint: string;
  model: string;
  model_revision: string | null;
  dimensions: number;
  metric: string;
  tokenizer_version: string;
  document_input_type: string;
  query_input_type: string;
  normalization: string;
  status: string;
}

function toGeneration(row: GenerationRow): EmbeddingGeneration {
  return {
    id: row.id,
    companyId: row.company_id,
    provider: row.provider,
    accountRef: row.account_ref,
    endpoint: row.endpoint,
    model: row.model,
    modelRevision: row.model_revision,
    dimensions: row.dimensions,
    metric: row.metric,
    tokenizerVersion: row.tokenizer_version,
    documentInputType: row.document_input_type,
    queryInputType: row.query_input_type,
    normalization: row.normalization,
    status: row.status,
  };
}

// 現在のprovider spec。世代の同一性はこの全項目で判定する。
function specOf(config: WorkerConfig): Omit<EmbeddingGeneration, 'id' | 'companyId' | 'modelRevision' | 'status'> {
  return {
    provider: VOYAGE_PROVIDER,
    accountRef: config.voyageAccountRef,
    endpoint: config.voyageApiUrl,
    model: VOYAGE_MODEL,
    dimensions: VOYAGE_DIMENSIONS,
    metric: VOYAGE_METRIC,
    tokenizerVersion: VOYAGE_TOKENIZER_VERSION,
    documentInputType: VOYAGE_DOCUMENT_INPUT_TYPE,
    queryInputType: VOYAGE_QUERY_INPUT_TYPE,
    normalization: VOYAGE_NORMALIZATION,
  };
}

function specMatches(generation: EmbeddingGeneration, config: WorkerConfig): boolean {
  const spec = specOf(config);
  return (
    generation.provider === spec.provider &&
    generation.accountRef === spec.accountRef &&
    generation.endpoint === spec.endpoint &&
    generation.model === spec.model &&
    generation.dimensions === spec.dimensions &&
    generation.metric === spec.metric &&
    generation.tokenizerVersion === spec.tokenizerVersion &&
    generation.documentInputType === spec.documentInputType &&
    generation.queryInputType === spec.queryInputType &&
    generation.normalization === spec.normalization
  );
}

async function loadGeneration(client: Pool | PoolClient, generationId: string): Promise<EmbeddingGeneration | null> {
  const result = await client.query<GenerationRow>(
    `SELECT id, company_id, provider, account_ref, endpoint, model, model_revision, dimensions, metric,
            tokenizer_version, document_input_type, query_input_type, normalization, status
       FROM embedding_generations WHERE id = $1`,
    [generationId],
  );
  return result.rows[0] ? toGeneration(result.rows[0]) : null;
}

const COMPANY_GENERATION_LOCK_NAMESPACE = 20260927;

// company単位のgeneration整合（初回紐付け・cutoverのretire判定）を直列化する。
// project行を触る前に必ず取得し、lock順序を company generation lock → project row に統一してdeadlockを避ける。
export async function acquireCompanyGenerationLock(client: PoolClient, companyId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [COMPANY_GENERATION_LOCK_NAMESPACE, companyId]);
}

// projectの初回だけ、会社+完全なprovider specのactive generationを再利用/作成して原子的に紐付ける。
// 既存active generationがconfigと一致しなければ自動切替せず恒久エラーにする（世代切替はM8）。
export async function ensureActiveGeneration(
  pool: Pool,
  input: { companyId: string; projectId: string },
  config: WorkerConfig,
): Promise<EmbeddingGeneration> {
  const spec = specOf(config);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireCompanyGenerationLock(client, input.companyId);
    const project = await client.query<{ active_generation_id: string | null }>(
      'SELECT active_generation_id FROM projects WHERE id = $1 FOR UPDATE',
      [input.projectId],
    );
    if (project.rows.length === 0) {
      throw new GenerationMismatchError('projectがありません');
    }
    const activeId = project.rows[0].active_generation_id;
    if (activeId !== null) {
      const generation = await loadGeneration(client, activeId);
      if (
        generation === null ||
        generation.companyId !== input.companyId ||
        generation.status !== 'active' ||
        !specMatches(generation, config)
      ) {
        // 別会社・retired/failed・spec不一致は自動切替せず恒久エラーにする。
        throw new GenerationMismatchError('active generationが現在のprovider specと一致しません');
      }
      await client.query('COMMIT');
      return generation;
    }

    const existing = await client.query<GenerationRow>(
      `SELECT id, company_id, provider, account_ref, endpoint, model, model_revision, dimensions, metric,
              tokenizer_version, document_input_type, query_input_type, normalization, status
         FROM embedding_generations
        WHERE company_id = $1 AND provider = $2 AND account_ref = $3 AND endpoint = $4 AND model = $5
          AND dimensions = $6 AND metric = $7 AND tokenizer_version = $8 AND document_input_type = $9
          AND query_input_type = $10 AND normalization = $11 AND status = 'active'
        ORDER BY created_at, id
        LIMIT 1`,
      [
        input.companyId,
        spec.provider,
        spec.accountRef,
        spec.endpoint,
        spec.model,
        spec.dimensions,
        spec.metric,
        spec.tokenizerVersion,
        spec.documentInputType,
        spec.queryInputType,
        spec.normalization,
      ],
    );
    let generation = existing.rows[0] ? toGeneration(existing.rows[0]) : null;
    if (generation === null) {
      const inserted = await client.query<GenerationRow>(
        `INSERT INTO embedding_generations
           (id, company_id, provider, account_ref, endpoint, model, model_revision, dimensions, metric,
            tokenizer_version, document_input_type, query_input_type, normalization, status)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11, $12, 'active')
         RETURNING id, company_id, provider, account_ref, endpoint, model, model_revision, dimensions, metric,
                   tokenizer_version, document_input_type, query_input_type, normalization, status`,
        [
          uuidv7(),
          input.companyId,
          spec.provider,
          spec.accountRef,
          spec.endpoint,
          spec.model,
          spec.dimensions,
          spec.metric,
          spec.tokenizerVersion,
          spec.documentInputType,
          spec.queryInputType,
          spec.normalization,
        ],
      );
      generation = toGeneration(inserted.rows[0]);
    }
    await client.query('UPDATE projects SET active_generation_id = $2, updated_at = now() WHERE id = $1 AND active_generation_id IS NULL', [
      input.projectId,
      generation.id,
    ]);
    await client.query('COMMIT');
    return generation;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// 現在のconfigと完全なprovider specが一致するか。再索引のresume・cutover検証で使う。
export function generationSpecMatches(generation: EmbeddingGeneration, config: WorkerConfig): boolean {
  return specMatches(generation, config);
}

// 世代IDを会社境界つきで読む。statusを問わず返し、利用可否は呼出元が決める。
export async function loadGenerationById(
  client: Pool | PoolClient,
  input: { companyId: string; generationId: string },
): Promise<EmbeddingGeneration | null> {
  const generation = await loadGeneration(client, input.generationId);
  if (generation === null || generation.companyId !== input.companyId) {
    return null;
  }
  return generation;
}

// current specの再索引target候補を新規作成する。project pointerはcutoverでだけ変更する。
export async function createCandidateGeneration(
  client: Pool | PoolClient,
  companyId: string,
  config: WorkerConfig,
): Promise<EmbeddingGeneration> {
  const spec = specOf(config);
  const inserted = await client.query<GenerationRow>(
    `INSERT INTO embedding_generations
       (id, company_id, provider, account_ref, endpoint, model, model_revision, dimensions, metric,
        tokenizer_version, document_input_type, query_input_type, normalization, status)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11, $12, 'candidate')
     RETURNING id, company_id, provider, account_ref, endpoint, model, model_revision, dimensions, metric,
               tokenizer_version, document_input_type, query_input_type, normalization, status`,
    [
      uuidv7(),
      companyId,
      spec.provider,
      spec.accountRef,
      spec.endpoint,
      spec.model,
      spec.dimensions,
      spec.metric,
      spec.tokenizerVersion,
      spec.documentInputType,
      spec.queryInputType,
      spec.normalization,
    ],
  );
  return toGeneration(inserted.rows[0]);
}

// 検索要求が固定した世代を読む。同company・完全spec一致ならretiredでも利用でき、failed/candidateは拒否する。
export async function loadPinnedGeneration(
  pool: Pool,
  input: { companyId: string; generationId: string },
  config: WorkerConfig,
): Promise<EmbeddingGeneration> {
  const generation = await loadGeneration(pool, input.generationId);
  if (
    generation === null ||
    generation.companyId !== input.companyId ||
    generation.status === 'failed' ||
    generation.status === 'candidate' ||
    !specMatches(generation, config)
  ) {
    throw new GenerationMismatchError('固定したgenerationが利用できません');
  }
  return generation;
}

function inputHash(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

function parseVector(value: string): number[] | null {
  if (!value.startsWith('[') || !value.endsWith(']')) {
    return null;
  }
  const vector = value
    .slice(1, -1)
    .split(',')
    .map((item) => Number(item));
  return vector.every((item) => Number.isFinite(item)) ? vector : null;
}

function validVector(vector: number[] | null, dimensions: number): vector is number[] {
  return vector !== null && vector.length === dimensions && vector.some((value) => value !== 0);
}

interface CachedRow {
  input_hash: string;
  embedding: string;
  dimensions: number;
}

// 各HTTP送信の直前に承認を確認する。cache hitでも未確認policyの結果を公開へ使わせない。
async function hasActiveVoyageApproval(pool: Pool, generation: EmbeddingGeneration): Promise<boolean> {
  return hasActiveProviderApproval(pool, {
    companyId: generation.companyId,
    provider: generation.provider,
    accountRef: generation.accountRef,
    endpoint: generation.endpoint,
  });
}

// VoyageEmbeddingProviderは承認確認→cache→HTTP→usage/cache保存の順で扱う。vector以外は再利用しない。
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly pool: Pool,
    private readonly config: WorkerConfig,
  ) {}

  async embedDocuments(texts: readonly string[], generation: EmbeddingGeneration): Promise<number[][]> {
    return this.embed(texts, generation, 'document');
  }

  async embedQuery(text: string, generation: EmbeddingGeneration): Promise<number[]> {
    const [vector] = await this.embed([text], generation, 'query');
    return vector;
  }

  private assertGeneration(generation: EmbeddingGeneration): void {
    if (generation.provider !== VOYAGE_PROVIDER || generation.model !== VOYAGE_MODEL || generation.dimensions !== VOYAGE_DIMENSIONS) {
      throw new GenerationMismatchError('生成世代がVoyageの固定specと一致しません');
    }
    if (!specMatches(generation, this.config)) {
      throw new GenerationMismatchError('生成世代が現在のprovider specと一致しません');
    }
  }

  private async embed(
    texts: readonly string[],
    generation: EmbeddingGeneration,
    operation: VoyageOperation,
  ): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    this.assertGeneration(generation);
    if (!(await hasActiveVoyageApproval(this.pool, generation))) {
      throw new PolicyBlockedError('Voyageの送信承認がありません');
    }

    const hashes = texts.map((text) => inputHash(text));
    const vectors: (number[] | undefined)[] = new Array<number[] | undefined>(texts.length);
    const missing: number[] = [];
    const cachedRows = await this.loadCache(generation, operation, hashes);
    for (let index = 0; index < texts.length; index += 1) {
      const cached = cachedRows.get(hashes[index].toString('hex'));
      if (cached !== undefined) {
        vectors[index] = cached;
      } else {
        missing.push(index);
      }
    }

    if (missing.length > 0) {
      // lease更新等のDB待機の後、HTTP送信の直前にもう一度承認を確認する。
      if (!(await hasActiveVoyageApproval(this.pool, generation))) {
        throw new PolicyBlockedError('Voyageの送信承認がありません');
      }
      const inputTexts = missing.map((index) => texts[index]);
      const started = Date.now();
      let call;
      try {
        call = await callVoyage(this.config, operation, inputTexts);
      } catch (error) {
        const voyageError = error instanceof VoyageCallError ? error : new VoyageCallError('provider_unavailable', true);
        await this.recordUsage(generation, operation, false, Date.now() - started, voyageError.code, null, null);
        throw voyageError;
      }
      let validated;
      try {
        validated = validateVoyageResponse(call.json, inputTexts.length);
      } catch (error) {
        const voyageError = error instanceof VoyageCallError ? error : new VoyageCallError('provider_contract_invalid', false);
        await this.recordUsage(
          generation,
          operation,
          false,
          call.durationMs,
          voyageError.code,
          extractVoyageInputTokens(call.json),
          extractVoyageResponseModel(call.json),
        );
        throw voyageError;
      }
      await this.recordUsage(generation, operation, true, call.durationMs, null, validated.inputTokens, validated.model);
      await this.saveCache(generation, operation, missing, hashes, validated.vectors, validated.inputTokens);
      for (let position = 0; position < missing.length; position += 1) {
        vectors[missing[position]] = validated.vectors[position];
      }
    }

    return vectors.map((vector) => {
      if (vector === undefined) {
        throw new VoyageCallError('provider_contract_invalid', false);
      }
      return vector;
    });
  }

  private async loadCache(
    generation: EmbeddingGeneration,
    operation: VoyageOperation,
    hashes: readonly Buffer[],
  ): Promise<Map<string, number[]>> {
    const keys = hashes.map((hash) => hash.toString('hex'));
    const result = await this.pool.query<CachedRow>(
      `SELECT encode(input_hash, 'hex') AS input_hash, embedding::text AS embedding, dimensions
         FROM embedding_cache
        WHERE company_id = $1 AND generation_id = $2 AND operation = $3 AND encode(input_hash, 'hex') = ANY($4::text[])`,
      [generation.companyId, generation.id, operation, keys],
    );
    const cached = new Map<string, number[]>();
    for (const row of result.rows) {
      const vector = parseVector(row.embedding);
      if (row.dimensions === generation.dimensions && validVector(vector, generation.dimensions)) {
        cached.set(row.input_hash, vector);
      }
    }
    return cached;
  }

  private async saveCache(
    generation: EmbeddingGeneration,
    operation: VoyageOperation,
    indexes: readonly number[],
    hashes: readonly Buffer[],
    vectors: readonly number[][],
    inputTokens: number | null,
  ): Promise<void> {
    for (let position = 0; position < indexes.length; position += 1) {
      const index = indexes[position];
      await this.pool.query(
        `INSERT INTO embedding_cache
           (id, company_id, generation_id, operation, input_hash, embedding, model, dimensions, input_tokens)
         VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9)
         ON CONFLICT (company_id, generation_id, operation, input_hash) DO NOTHING`,
        [
          uuidv7(),
          generation.companyId,
          generation.id,
          operation,
          hashes[index],
          `[${vectors[position].join(',')}]`,
          generation.model,
          generation.dimensions,
          indexes.length === 1 ? inputTokens : null,
        ],
      );
    }
  }

  // 試行ごとにusageを記録する。原文・key・外部error bodyは保存しない。
  private async recordUsage(
    generation: EmbeddingGeneration,
    operation: VoyageOperation,
    success: boolean,
    durationMs: number,
    errorCode: string | null,
    inputTokens: number | null,
    responseModel: string | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage_events
         (id, company_id, provider, account_ref, endpoint, operation, model, response_model, input_tokens, output_tokens, duration_ms, success, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12)`,
      [
        uuidv7(),
        generation.companyId,
        generation.provider,
        generation.accountRef,
        generation.endpoint,
        operation,
        generation.model,
        responseModel,
        inputTokens,
        Math.max(0, Math.round(durationMs)),
        success,
        errorCode,
      ],
    );
  }
}
