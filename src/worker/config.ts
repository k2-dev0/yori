import { z } from 'zod';
import { DEFAULT_JOB_LEASE_MS } from '../jobs/queue.js';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_INPUT_BUDGET_BYTES,
  DEFAULT_JEV_API_URL,
  DEFAULT_JEV_MODEL,
  DEFAULT_VOYAGE_API_URL,
  JEV_API_PATH,
  VOYAGE_API_PATH,
} from './contract.js';

// M3 workerの接続・判定設定。
export interface WorkerConfig {
  // Jev APIの完全endpoint。loopback HTTPはテストの合成fixtureにだけ使う。
  apiUrl: string;
  apiKey: string;
  accountRef: string;
  model: string;
  confidenceThreshold: number;
  inputBudgetBytes: number;
  requestTimeoutMs: number;
  // Voyage APIの完全endpoint。loopback HTTPはテストの合成fixtureにだけ使う。
  voyageApiUrl: string;
  voyageApiKey: string;
  voyageAccountRef: string;
  voyageRequestTimeoutMs: number;
  // runnerがclaim・延長に使うlease。未指定はDEFAULT_JOB_LEASE_MS。
  leaseMs?: number;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// JEVの完全endpointとして許可できる値か。HTTPS、または開発用loopback HTTPだけを受け付ける。
export function isWorkerEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    return false;
  }
  if (url.pathname !== JEV_API_PATH) {
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

const endpointSchema = z.string().min(1).refine(isWorkerEndpoint, {
  message: `JEV_API_URLはHTTPS${JEV_API_PATH}（開発用loopback HTTPのみ）で指定してください`,
});

// Voyageの完全endpointとして許可できる値か。Jevと同じくHTTPS、または開発用loopback HTTPだけを受け付ける。
export function isVoyageEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    return false;
  }
  if (url.pathname !== VOYAGE_API_PATH) {
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

const voyageEndpointSchema = z.string().min(1).refine(isVoyageEndpoint, {
  message: `VOYAGE_API_URLはHTTPS${VOYAGE_API_PATH}（開発用loopback HTTPのみ）で指定してください`,
});

// 起動時に必須の接続設定。未設定・不正はworkerを起動せず、偽の判定へ進まない。
export const workerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JEV_API_KEY: z.string().min(1),
  JEV_ACCOUNT_REF: z.string().min(1),
  JEV_API_URL: endpointSchema.default(DEFAULT_JEV_API_URL),
  JEV_MODEL: z.string().min(1).default(DEFAULT_JEV_MODEL),
  JEV_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(DEFAULT_CONFIDENCE_THRESHOLD),
  JEV_INPUT_BUDGET_BYTES: z.coerce.number().int().min(256).default(DEFAULT_INPUT_BUDGET_BYTES),
  JEV_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).default(20_000),
  JEV_JOB_LEASE_MS: z.coerce.number().int().min(1_000).max(24 * 60 * 60 * 1_000).default(DEFAULT_JOB_LEASE_MS),
  JEV_WORKER_POLL_MS: z.coerce.number().int().min(10).default(1_000),
  // M4 Voyage埋め込み。実データ送信前にキーと学習利用条件の確認を必須にする。
  VOYAGE_API_KEY: z.string().min(1),
  VOYAGE_ACCOUNT_REF: z.string().min(1),
  VOYAGE_API_URL: voyageEndpointSchema.default(DEFAULT_VOYAGE_API_URL),
  VOYAGE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).default(20_000),
});

export interface LoadedWorkerConfig {
  databaseUrl: string;
  config: WorkerConfig;
  pollIntervalMs: number;
}

// 環境変数を検証してworker設定を返す。外部待ちtimeoutはleaseより短くなければならない。
export function loadWorkerConfig(source: NodeJS.ProcessEnv = process.env): LoadedWorkerConfig {
  const parsed = workerEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      'workerの必須設定が未設定または不正です（DATABASE_URL / JEV_API_KEY / JEV_ACCOUNT_REF / JEV_API_URL / VOYAGE_API_KEY / VOYAGE_ACCOUNT_REF等を確認してください）',
    );
  }
  const env = parsed.data;
  if (env.JEV_REQUEST_TIMEOUT_MS >= env.JEV_JOB_LEASE_MS) {
    throw new Error('JEV_REQUEST_TIMEOUT_MSはJEV_JOB_LEASE_MSより短くしてください');
  }
  if (env.VOYAGE_REQUEST_TIMEOUT_MS >= env.JEV_JOB_LEASE_MS) {
    throw new Error('VOYAGE_REQUEST_TIMEOUT_MSはJEV_JOB_LEASE_MSより短くしてください');
  }
  return {
    databaseUrl: env.DATABASE_URL,
    config: {
      apiUrl: env.JEV_API_URL,
      apiKey: env.JEV_API_KEY,
      accountRef: env.JEV_ACCOUNT_REF,
      model: env.JEV_MODEL,
      confidenceThreshold: env.JEV_CONFIDENCE_THRESHOLD,
      inputBudgetBytes: env.JEV_INPUT_BUDGET_BYTES,
      requestTimeoutMs: env.JEV_REQUEST_TIMEOUT_MS,
      voyageApiUrl: env.VOYAGE_API_URL,
      voyageApiKey: env.VOYAGE_API_KEY,
      voyageAccountRef: env.VOYAGE_ACCOUNT_REF,
      voyageRequestTimeoutMs: env.VOYAGE_REQUEST_TIMEOUT_MS,
      leaseMs: env.JEV_JOB_LEASE_MS,
    },
    pollIntervalMs: env.JEV_WORKER_POLL_MS,
  };
}
