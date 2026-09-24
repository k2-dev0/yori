import {
  VOYAGE_DIMENSIONS,
  VOYAGE_DOCUMENT_INPUT_TYPE,
  VOYAGE_MODEL,
  VOYAGE_OUTPUT_DTYPE,
  VOYAGE_QUERY_INPUT_TYPE,
} from './contract.js';
import type { WorkerConfig } from './config.js';

// Voyage呼出しの失敗カテゴリ。retryableだけをpendingへ戻し、契約不正等はfailedで保持する。
export class VoyageCallError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}

export type VoyageOperation = 'document' | 'query';

export interface VoyageEmbeddingRequest {
  model: string;
  input: string[];
  input_type: string;
  output_dimension: number;
  output_dtype: string;
  truncation: boolean;
}

export interface VoyageEmbeddingResponse {
  vectors: number[][];
  model: string;
  inputTokens: number | null;
}

// delta-secondsとHTTP-dateの両方を受け付け、0..1hへclampする。
function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 60 * 60 * 1_000);
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(date - Date.now(), 0), 60 * 60 * 1_000);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 応答本文からmodelだけを取り出す。検証結果とは独立にusageへ記録する。推測補完はしない。
export function extractVoyageResponseModel(json: unknown): string | null {
  if (!isRecord(json)) {
    return null;
  }
  const model = json.model;
  return typeof model === 'string' && model.length > 0 ? model : null;
}

// 応答本文のusage.total_tokensだけを取り出す。不正・不明はnullにする。
export function extractVoyageInputTokens(json: unknown): number | null {
  if (!isRecord(json)) {
    return null;
  }
  const usage = json.usage;
  if (!isRecord(usage)) {
    return null;
  }
  const total = usage.total_tokens;
  return typeof total === 'number' && Number.isInteger(total) && total >= 0 ? total : null;
}

// 件数・index・model・次元・有限値・非ゼロ・usageを検証し、index順に入力対応へ並べ直す。
export function validateVoyageResponse(json: unknown, expectedCount: number): VoyageEmbeddingResponse {
  if (!isRecord(json)) {
    throw new VoyageCallError('provider_contract_invalid', false);
  }
  if (json.model !== VOYAGE_MODEL) {
    throw new VoyageCallError('provider_contract_invalid', false);
  }
  const data = json.data;
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new VoyageCallError('provider_contract_invalid', false);
  }
  const vectors: number[][] = new Array<number[]>(expectedCount);
  const seen = new Set<number>();
  for (const entry of data) {
    if (!isRecord(entry)) {
      throw new VoyageCallError('provider_contract_invalid', false);
    }
    const index = entry.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= expectedCount || seen.has(index)) {
      throw new VoyageCallError('provider_contract_invalid', false);
    }
    seen.add(index);
    const embedding = entry.embedding;
    if (!Array.isArray(embedding) || embedding.length !== VOYAGE_DIMENSIONS) {
      throw new VoyageCallError('provider_contract_invalid', false);
    }
    const vector: number[] = new Array<number>(embedding.length);
    let hasNonZero = false;
    for (let position = 0; position < embedding.length; position += 1) {
      const value = embedding[position];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new VoyageCallError('provider_contract_invalid', false);
      }
      vector[position] = value;
      if (value !== 0) {
        hasNonZero = true;
      }
    }
    if (!hasNonZero) {
      throw new VoyageCallError('provider_contract_invalid', false);
    }
    vectors[index] = vector;
  }
  if (seen.size !== expectedCount) {
    throw new VoyageCallError('provider_contract_invalid', false);
  }
  const usage = json.usage;
  if (!isRecord(usage)) {
    throw new VoyageCallError('provider_contract_invalid', false);
  }
  const totalTokens = usage.total_tokens;
  if (typeof totalTokens !== 'number' || !Number.isInteger(totalTokens) || totalTokens < 0) {
    throw new VoyageCallError('provider_contract_invalid', false);
  }
  return { vectors, model: VOYAGE_MODEL, inputTokens: totalTokens };
}

export interface VoyageCallResult {
  json: unknown;
  durationMs: number;
}

// Voyageへ1回POSTする。3xxは追従せず、408/429/5xx/timeoutだけをretryableにする。
export async function callVoyage(config: WorkerConfig, operation: VoyageOperation, texts: readonly string[]): Promise<VoyageCallResult> {
  const body: VoyageEmbeddingRequest = {
    model: VOYAGE_MODEL,
    input: [...texts],
    input_type: operation === 'document' ? VOYAGE_DOCUMENT_INPUT_TYPE : VOYAGE_QUERY_INPUT_TYPE,
    output_dimension: VOYAGE_DIMENSIONS,
    output_dtype: VOYAGE_OUTPUT_DTYPE,
    truncation: false,
  };
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(config.voyageApiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.voyageApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(config.voyageRequestTimeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new VoyageCallError(timedOut ? 'provider_timeout' : 'provider_unavailable', true);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new VoyageCallError('provider_redirect_rejected', false);
  }
  if (!response.ok) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429) {
      throw new VoyageCallError('provider_rate_limited', true, retryAfterMs);
    }
    if (response.status === 408) {
      throw new VoyageCallError('provider_timeout', true, retryAfterMs);
    }
    if (response.status >= 500) {
      throw new VoyageCallError('provider_unavailable', true, retryAfterMs);
    }
    throw new VoyageCallError('provider_rejected', false);
  }
  // headers受信後のbody受信timeout/Abortもretryableにする。durationはbody受信・parse完了まで含める。
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new VoyageCallError(timedOut ? 'provider_timeout' : 'provider_unavailable', true);
  }
  const durationMs = Date.now() - started;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new VoyageCallError('provider_contract_invalid', false);
  }
  return { json, durationMs };
}
