import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v7 as uuidv7 } from 'uuid';
import type { EventInput } from '../../api/contract.js';
import { eventsRequestSchema, type EventsRequest } from '../../api/schema.js';
import { SUPPORTED_CLAUDE_CODE_VERSION } from '../adapters/claude.js';
import { SUPPORTED_CODEX_CLI_VERSION } from '../adapters/codex.js';
import type { CollectorHookInput } from '../collect.js';
import type { CollectorConfig, CollectorProject } from '../config.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// ---- temp dir / git fixture ----

export async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'yori-collector-'));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ---- テスト専用PATH git shim ----
// テスト用Node imageと実行sandboxはgit/.gitを用意できないため、-Cと許可subcommandだけに応答する
// gitをPATH先頭へ置く。productionへの注入口は足さず、子プロセスの引数配列とremote/worktree契約を検証する。
const GIT_SHIM_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
function fail(message, code) {
  process.stderr.write('fixture git: ' + message + '\\n');
  process.exit(code);
}
if (args[0] !== '-C' || args.length < 4) {
  fail('unsupported args: ' + args.join(' '), 2);
}
const directory = args[1];
const command = args.slice(2);
const isToplevel = command.length === 2 && command[0] === 'rev-parse' && command[1] === '--show-toplevel';
const isRemote = command.length === 3 && command[0] === 'config' && command[1] === '--get' && command[2] === 'remote.origin.url';
if (!isToplevel && !isRemote) {
  fail('unsupported subcommand: ' + command.join(' '), 2);
}
const mappingFile = process.env.YORI_GIT_FIXTURE_FILE;
if (!mappingFile) {
  fail('YORI_GIT_FIXTURE_FILE is not set', 2);
}
const mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
const entry = mapping[directory];
if (!entry) {
  process.exit(1);
}
if (isToplevel) {
  process.stdout.write(String(entry.toplevel) + '\\n');
  process.exit(0);
}
if (entry.remote === null) {
  process.exit(1);
}
process.stdout.write(String(entry.remote) + '\\n');
`;

interface GitFixtureEntry {
  toplevel: string;
  remote: string | null;
}

interface GitFixturePaths {
  dir: string;
  binDir: string;
  mappingFile: string;
}

let gitFixturePaths: GitFixturePaths | null = null;

// 最初のfixture利用時にshimと対応表を作り、プロセス終了までPATH/envへ固定する。
function ensureGitFixture(): GitFixturePaths {
  if (gitFixturePaths) {
    return gitFixturePaths;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'yori-collector-git-'));
  const binDir = path.join(dir, 'bin');
  mkdirSync(binDir);
  const mappingFile = path.join(dir, 'mapping.json');
  writeFileSync(mappingFile, '{}', 'utf8');
  writeFileSync(path.join(binDir, 'git'), GIT_SHIM_SOURCE, { mode: 0o755 });
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  process.env.YORI_GIT_FIXTURE_FILE = mappingFile;
  process.once('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 終了時cleanupの失敗はテスト結果へ影響させない
    }
  });
  gitFixturePaths = { dir, binDir, mappingFile };
  return gitFixturePaths;
}

function readGitMapping(mappingFile: string): Record<string, GitFixtureEntry> {
  return JSON.parse(readFileSync(mappingFile, 'utf8')) as Record<string, GitFixtureEntry>;
}

// -Cへ渡されるpathはsymlink解決前後のどちらもあり得るため、両方を同じ応答で登録する。
function registerGitEntry(mapping: Record<string, GitFixtureEntry>, dir: string, entry: GitFixtureEntry, mappingFile: string): void {
  mapping[dir] = entry;
  const resolved = realpathSync(dir);
  mapping[resolved] = { ...entry, toplevel: resolved };
  writeFileSync(mappingFile, JSON.stringify(mapping), 'utf8');
}

// dirをgit repositoryとして登録する。remoteUrlがnullならorigin無しのrepoとして振る舞う。
export async function createGitRepository(dir: string, remoteUrl: string | null): Promise<void> {
  await mkdir(dir, { recursive: true });
  const { mappingFile } = ensureGitFixture();
  registerGitEntry(readGitMapping(mappingFile), dir, { toplevel: dir, remote: remoteUrl }, mappingFile);
}

// 同じremoteを持つworktreeとして登録する。toplevelだけがworktreeのpathになる。
export async function addGitWorktree(repoDir: string, worktreeDir: string): Promise<void> {
  const { mappingFile } = ensureGitFixture();
  const mapping = readGitMapping(mappingFile);
  const base = mapping[repoDir] ?? mapping[realpathSync(repoDir)];
  if (!base) {
    throw new Error(`git fixture: ${repoDir} が未登録です`);
  }
  await mkdir(worktreeDir, { recursive: true });
  registerGitEntry(mapping, worktreeDir, { toplevel: worktreeDir, remote: base.remote }, mappingFile);
}

// ---- transcript fixture ----

export async function writeTranscript(filePath: string, lines: string[], options: { trailingNewline?: boolean } = {}): Promise<void> {
  await writeFile(filePath, lines.join('\n') + (options.trailingNewline === false ? '' : '\n'), 'utf8');
}

export async function appendTranscript(filePath: string, text: string): Promise<void> {
  await appendFile(filePath, text, 'utf8');
}

// 行頭のUTF-8 byte offset。診断の参照offsetと比較する。
export function lineByteOffset(lines: string[], index: number): number {
  if (index === 0) {
    return 0;
  }
  return Buffer.byteLength(`${lines.slice(0, index).join('\n')}\n`, 'utf8');
}

export function codexSessionLine(sessionId: string, cliVersion: string = SUPPORTED_CODEX_CLI_VERSION): string {
  return JSON.stringify({
    timestamp: '2026-09-21T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: sessionId, cli_version: cliVersion, cwd: '/fixture' },
  });
}

export function codexMessageLine(input: {
  sessionId: string;
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
  phase?: string;
}): string {
  const item =
    input.role === 'user'
      ? { id: input.messageId, type: 'UserMessage', content: [{ type: 'text', text: input.text }] }
      : { id: input.messageId, type: 'AgentMessage', phase: input.phase ?? 'final_answer', content: [{ type: 'Text', text: input.text }] };
  return JSON.stringify({
    timestamp: input.timestamp ?? '2026-09-21T00:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: input.sessionId, item },
  });
}

export function claudeMessageLine(input: {
  sessionId: string;
  uuid: string;
  role: 'user' | 'assistant';
  content: unknown;
  timestamp?: string;
  version?: string;
  extra?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    type: input.role,
    uuid: input.uuid,
    sessionId: input.sessionId,
    timestamp: input.timestamp ?? '2026-09-21T00:00:01.000Z',
    version: input.version ?? SUPPORTED_CLAUDE_CODE_VERSION,
    message: { role: input.role, content: input.content },
    ...(input.extra ?? {}),
  });
}

export function buildHook(input: { session_id: string; transcript_path: string; cwd: string; extra?: Record<string, unknown> }): CollectorHookInput {
  return {
    ...(input.extra ?? {}),
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
  } as CollectorHookInput;
}

export function buildCollectorConfig(input: { state_dir: string; projects?: CollectorProject[]; api_url?: string; token_env?: string }): CollectorConfig {
  return {
    api_url: input.api_url ?? 'https://api.example.test',
    token_env: input.token_env ?? 'YORI_TEST_TOKEN',
    state_dir: input.state_dir,
    projects: input.projects ?? [],
  };
}

export interface CollectorFixture {
  root: string;
  repoDir: string;
  stateDir: string;
  config: CollectorConfig;
  projectId: string | null;
  cleanup(): Promise<void>;
}

// 1 repository + 任意のproject対応を持つ最小の収集環境を作る。transcriptは呼出元が書く。
export async function createCollectorFixture(input: { remoteUrl?: string | null; binding?: CollectorProject | null } = {}): Promise<CollectorFixture> {
  const root = await makeTempDir();
  const repoDir = path.join(root, 'repo');
  await createGitRepository(repoDir, input.remoteUrl === undefined ? 'https://github.com/Org/Repo.git' : input.remoteUrl);
  const stateDir = path.join(root, 'state');
  return {
    root,
    repoDir,
    stateDir,
    config: buildCollectorConfig({ state_dir: stateDir, projects: input.binding ? [input.binding] : [] }),
    projectId: input.binding?.project_id ?? null,
    cleanup: () => removeTempDir(root),
  };
}

// ---- global fetch mock ----

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: RequestInit['redirect'];
}

export type FetchResponder = (request: CapturedRequest) => Response | Promise<Response>;

export interface FetchMock {
  requests: CapturedRequest[];
  setResponder(responder: FetchResponder): void;
  restore(): void;
}

function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  if (headers === undefined) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries([...headers.entries()]);
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key.toLowerCase(), String(value)]));
  }
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

// 実HTTPを起こさず、collectorがglobal fetchで送ったrequestを捕捉する。
export function installFetchMock(responder: FetchResponder): FetchMock {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  let currentResponder = responder;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const request: CapturedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: headerRecord(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
      redirect: init?.redirect,
    };
    requests.push(request);
    return currentResponder(request);
  }) as typeof fetch;
  return {
    requests,
    setResponder(next) {
      currentResponder = next;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function parseSentBatches(requests: CapturedRequest[]): EventsRequest[] {
  return requests.map((request) => eventsRequestSchema.parse(JSON.parse(request.body)));
}

export function sentEvents(requests: CapturedRequest[]): EventInput[] {
  return parseSentBatches(requests).flatMap((batch) => batch.events);
}

// 各eventへserver側の受付結果を返す。message_idはAPI契約どおりUUIDv7にする。
export function ackResponse(request: CapturedRequest): Response {
  const events = eventsRequestSchema.parse(JSON.parse(request.body)).events;
  return jsonResponse(202, {
    results: events.map((event) => ({
      idempotency_key: event.idempotency_key,
      message_id: uuidv7(),
      revision: event.revision,
      request_id: null,
    })),
  });
}

// ackの一部fieldだけを壊した応答を作る。patchは一致判定の境界を検証する。
export function ackBodyFor(
  request: CapturedRequest,
  patch: (event: EventInput, index: number) => Record<string, unknown> = () => ({}),
): { results: Record<string, unknown>[] } {
  const events = eventsRequestSchema.parse(JSON.parse(request.body)).events;
  return {
    results: events.map((event, index) => ({
      idempotency_key: event.idempotency_key,
      message_id: uuidv7(),
      revision: event.revision,
      request_id: null,
      ...patch(event, index),
    })),
  };
}

// ---- state_dir inspection ----

export async function readStateFiles(stateDir: string): Promise<{ name: string; bytes: Buffer }[]> {
  const entries = await readdir(stateDir, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => ({ name: entry.name, bytes: await readFile(path.join(stateDir, entry.name)) })),
  );
}

// 診断や保留に生本文・資格情報が混ざっていないことをstate_dir全体で確認する。
export async function assertStateDoesNotContain(stateDir: string, secret: string): Promise<void> {
  for (const file of await readStateFiles(stateDir)) {
    assert.ok(!file.bytes.includes(Buffer.from(secret, 'utf8')), `state_dirの${file.name}へ秘匿文字列が保存されている`);
  }
}

// ---- CLI child process ----

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

// 公開CLIを実プロセスとして起動する。送信のない経路だけをchild processで検証する。
export function runCollectorCli(args: string[], options: { stdin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO_ROOT, 'src/collector/cli.ts'), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}
