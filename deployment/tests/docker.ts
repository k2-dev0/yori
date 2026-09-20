import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'deployment', 'compose.yaml');

// 開発用compose (project yori / volume yori-*) と開発データを共有しないテスト専用のproject・volume。
const TEST_PROJECT_NAME = process.env.YORI_TEST_PROJECT ?? 'yori-test';
const TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  YORI_PGDATA_VOLUME: process.env.YORI_TEST_PGDATA_VOLUME ?? 'yori-test-pgdata',
  YORI_NODE_MODULES_VOLUME: process.env.YORI_TEST_NODE_MODULES_VOLUME ?? 'yori-test-node-modules',
  YORI_NPM_CACHE_VOLUME: process.env.YORI_TEST_NPM_CACHE_VOLUME ?? 'yori-test-npm-cache',
};

export const API_BASE_URL = `http://127.0.0.1:${process.env.YORI_API_PORT ?? '39119'}`;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

// dockerは標準のcontext/configを使う。このマシン固有のsocket・config・symlinkは指定しない。
export function runDocker(args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: REPO_ROOT, env: TEST_ENV });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function compose(args: string[]): Promise<CommandResult> {
  return runDocker(['compose', '-p', TEST_PROJECT_NAME, '--file', COMPOSE_FILE, ...args]);
}

export async function composeOk(args: string[]): Promise<string> {
  const result = await compose(args);
  if (result.code !== 0) {
    throw new Error(`docker compose ${args.join(' ')} が失敗しました (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export async function psql(sql: string): Promise<string> {
  const stdout = await composeOk(['exec', '-T', 'db', 'psql', '-U', 'yori', '-d', 'yori', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]);
  return stdout.trim();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForHttp(pathname: string, timeoutMs = 120_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '応答なし';
  while (Date.now() < deadline) {
    try {
      return await fetch(`${API_BASE_URL}${pathname}`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(500);
    }
  }
  throw new Error(`APIが${timeoutMs}ms以内に応答しませんでした: ${pathname}: ${lastError}`);
}

export async function waitForDbReady(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'pg_isready未完了';
  while (Date.now() < deadline) {
    try {
      const result = await psql('SELECT 1');
      if (result === '1') {
        return;
      }
      lastError = `予期した応答: ${result}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`DBが${timeoutMs}ms以内にreadyになりませんでした: ${lastError}`);
}

export async function resetDb(): Promise<void> {
  await psql(
    'TRUNCATE event_receipts, search_requests, jobs, message_revisions, messages, sessions, auth_tokens, project_members, projects, employees, companies CASCADE',
  );
}
