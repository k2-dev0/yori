import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MAX_SOURCE_IDENTIFIER_BYTES } from '../api/contract.js';
import { normalizeRepositoryIdentifier } from './remote.js';

export interface CollectorProject {
  repository: string;
  project_id: string;
}

export interface CollectorConfig {
  api_url: string;
  token_env: string;
  state_dir: string;
  projects: CollectorProject[];
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// api_urlはHTTPS、または開発用のloopback HTTPだけを許可し、資格情報・query・fragmentを拒否する。
const apiUrlSchema = z.string().min(1).refine((value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}, { message: 'api_urlはHTTPS（開発用loopback HTTPのみ）で指定してください' });

const projectSchema = z.strictObject({
  repository: z
    .string()
    .min(1)
    .refine((value) => normalizeRepositoryIdentifier(value) !== null, { message: 'repositoryはcanonical host/pathで指定してください' })
    .transform((value) => normalizeRepositoryIdentifier(value) as string)
    // server契約（schema.tsのsourceIdentifier）と同じく、正規化後のNUL・単独サロゲート・1024 UTF-8 bytes超を拒否する。
    .refine((value) => !value.includes('\u0000') && !/[\uD800-\uDFFF]/u.test(value), {
      message: 'repositoryはNULおよび単独サロゲートを指定できません',
    })
    .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_SOURCE_IDENTIFIER_BYTES, {
      message: `repositoryはUTF-8で${MAX_SOURCE_IDENTIFIER_BYTES}バイト以内にしてください`,
    }),
  project_id: z.uuid().transform((value) => value.toLowerCase()),
});

const collectorConfigSchema = z
  .strictObject({
    api_url: apiUrlSchema,
    token_env: z.string().min(1),
    state_dir: z.string().min(1).refine((value) => path.isAbsolute(value), { message: 'state_dirは絶対pathで指定してください' }),
    projects: z.array(projectSchema),
  })
  .superRefine((config, ctx) => {
    const repositories = new Set<string>();
    for (const project of config.projects) {
      if (repositories.has(project.repository)) {
        ctx.addIssue({ code: 'custom', path: ['projects'], message: 'repositoryが重複しています' });
        return;
      }
      repositories.add(project.repository);
    }
  });

// 設定ファイルのJSONを検証し、repositoryをcanonical形式へ揃えた設定を返す。
export function parseCollectorConfig(input: unknown): CollectorConfig {
  const parsed = collectorConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('collector設定が不正です');
  }
  return parsed.data;
}

// 設定ファイルを読み、JSONとして検証する。tokenは環境変数から取得するため保存しない。
export function loadCollectorConfig(configPath: string): CollectorConfig {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    throw new Error('collector設定ファイルを読めません');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('collector設定ファイルがJSONとして不正です');
  }
  return parseCollectorConfig(value);
}
