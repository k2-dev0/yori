import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseClaudeTranscriptLine } from './adapters/claude.js';
import { parseCodexTranscriptLine } from './adapters/codex.js';
import { DEEPSEEK_HARNESS_VERSION, createDeepSeekTranscriptParser, deepSeekSessionMetadata } from './adapters/deepseek.js';
import { collectFromHook } from './collect.js';
import type { CollectorConfig } from './config.js';
import { resolveRepositoryFromCwd } from './remote.js';
import { fetchCollectorSetup } from './setup.js';

export const BACKFILL_SOURCES = ['codex', 'claude_code', 'deepseek_harness'] as const;
export type BackfillSource = (typeof BACKFILL_SOURCES)[number];

export class BackfillArgumentError extends Error {}
export class BackfillExecutionError extends Error {
  readonly code = 'collector_setup_unavailable';
}

interface SourceSummary {
  sessions: number;
  candidates: number;
  excluded: number;
  versions: string[];
}

export interface BackfillSummary {
  status: 'dry_run' | 'completed';
  sources: Partial<Record<BackfillSource, SourceSummary>>;
  totals: { sessions: number; candidates: number; excluded: number };
}

interface DiscoveredSession {
  source: BackfillSource;
  sessionId: string;
  transcriptPath: string;
}

interface DiscoveryResult {
  summary: SourceSummary;
  sessions: DiscoveredSession[];
}

function emptySummary(): SourceSummary {
  return { sessions: 0, candidates: 0, excluded: 0, versions: [] };
}

function userHome(): string {
  const value = process.env.HOME;
  if (value === undefined || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error('invalid_home');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function safeVersion(value: string): string | null {
  return value.length <= 64 && /^[0-9]+(?:\.[0-9]+){0,3}(?:[-+][0-9A-Za-z.-]{1,48})?$/.test(value) ? value : null;
}

function addVersion(versions: Set<string>, value: string): void {
  const safe = safeVersion(value);
  if (safe !== null) {
    versions.add(safe);
  }
}

function filesRecursively(root: string, basename?: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesRecursively(entryPath, basename));
    } else if (entry.isFile() && (basename === undefined ? entry.name.endsWith('.jsonl') : entry.name === basename)) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function readLines(filePath: string): string[] {
  try {
    return readFileSync(filePath, 'utf8').split('\n').filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function discoverCodex(home: string, repository: string): DiscoveryResult {
  const summary = emptySummary();
  const sessions: DiscoveredSession[] = [];
  const versions = new Set<string>();
  const files = [
    ...filesRecursively(path.join(home, '.codex', 'sessions')),
    ...filesRecursively(path.join(home, '.codex', 'archived_sessions')),
  ];
  for (const transcriptPath of files) {
    const lines = readLines(transcriptPath);
    const sessionLine = lines.find((line) => parseJson(line)?.type === 'session_meta');
    if (sessionLine === undefined) {
      continue;
    }
    const raw = parseJson(sessionLine);
    const payload = raw !== null && isRecord(raw.payload) ? raw.payload : null;
    if (payload === null || payload.cwd !== repository) {
      continue;
    }
    if (payload.source !== 'cli' || typeof payload.id !== 'string' || typeof payload.cli_version !== 'string') {
      summary.excluded += 1;
      continue;
    }
    const parsedSession = parseCodexTranscriptLine(sessionLine);
    if (parsedSession.kind !== 'session' || parsedSession.source_session_id !== payload.id) {
      summary.excluded += 1;
      continue;
    }
    summary.sessions += 1;
    addVersion(versions, payload.cli_version);
    summary.candidates += lines.reduce((count, line) => {
      const record = parseCodexTranscriptLine(line);
      return count + (record.kind === 'message' && record.source_session_id === payload.id ? 1 : 0);
    }, 0);
    sessions.push({ source: 'codex', sessionId: payload.id, transcriptPath });
  }
  summary.versions = [...versions].sort();
  return { summary, sessions };
}

function discoverClaude(home: string, repository: string): DiscoveryResult {
  const summary = emptySummary();
  const sessions: DiscoveredSession[] = [];
  const versions = new Set<string>();
  const projectsRoot = path.join(home, '.claude', 'projects');
  if (!existsSync(projectsRoot)) {
    return { summary, sessions };
  }
  const files = readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(path.join(projectsRoot, entry.name), { withFileTypes: true })
        .filter((child) => child.isFile() && child.name.endsWith('.jsonl'))
        .map((child) => path.join(projectsRoot, entry.name, child.name)),
    )
    .sort();
  for (const transcriptPath of files) {
    const lines = readLines(transcriptPath);
    const rawRecords = lines.map(parseJson).filter((value): value is Record<string, unknown> => value !== null);
    const repositoryRecords = rawRecords.filter((value) => value.cwd === repository);
    if (repositoryRecords.length === 0) {
      continue;
    }
    const identity = repositoryRecords.find(
      (value) => typeof value.sessionId === 'string' && typeof value.version === 'string' && value.isSidechain !== true,
    );
    if (identity === undefined) {
      summary.excluded += 1;
      continue;
    }
    const sessionId = identity.sessionId as string;
    const version = identity.version as string;
    summary.sessions += 1;
    addVersion(versions, version);
    summary.candidates += lines.reduce((count, line) => {
      const record = parseClaudeTranscriptLine(line);
      return count + (record.kind === 'message' && record.source_session_id === sessionId ? 1 : 0);
    }, 0);
    sessions.push({ source: 'claude_code', sessionId, transcriptPath });
  }
  summary.versions = [...versions].sort();
  return { summary, sessions };
}

function discoverDeepSeek(home: string, repository: string): DiscoveryResult {
  const summary = emptySummary();
  const sessions: DiscoveredSession[] = [];
  const versions = new Set<string>();
  const repositoryHash = createHash('sha256').update(repository).digest('hex');
  const root = path.join(home, 'Library', 'Application Support', 'deepseek-bridge', 'dsh-home', repositoryHash, 'sessions');
  for (const transcriptPath of filesRecursively(root, 'session.v3.jsonl')) {
    const lines = readLines(transcriptPath);
    const sessionLine = lines.find((line) => parseJson(line)?.type === 'session');
    if (sessionLine === undefined) {
      continue;
    }
    const metadata = deepSeekSessionMetadata(sessionLine);
    if (metadata === null || metadata.cwd !== repository) {
      continue;
    }
    if (metadata.version !== DEEPSEEK_HARNESS_VERSION || metadata.delegationDepth !== 0 || metadata.isSeeded) {
      summary.excluded += 1;
      addVersion(versions, String(metadata.version));
      continue;
    }
    const parser = createDeepSeekTranscriptParser({ repository });
    const records = lines.flatMap((line) => parser.parseLine(line));
    summary.sessions += 1;
    summary.candidates += records.filter((record) => record.kind === 'message').length;
    addVersion(versions, String(metadata.version));
    sessions.push({ source: 'deepseek_harness', sessionId: metadata.sessionId, transcriptPath });
  }
  summary.versions = [...versions].sort();
  return { summary, sessions };
}

function discover(source: BackfillSource, home: string, repository: string): DiscoveryResult {
  if (source === 'codex') {
    return discoverCodex(home, repository);
  }
  return source === 'claude_code' ? discoverClaude(home, repository) : discoverDeepSeek(home, repository);
}

export async function backfillCollector(input: {
  repository: string;
  config: CollectorConfig;
  token: string;
  knownSecrets: readonly string[];
  dryRun: boolean;
  source?: BackfillSource;
}): Promise<BackfillSummary> {
  if (!path.isAbsolute(input.repository)) {
    throw new BackfillArgumentError('invalid_repository');
  }
  let repository: string;
  try {
    repository = realpathSync(input.repository);
  } catch {
    throw new BackfillArgumentError('invalid_repository');
  }
  if (!input.dryRun) {
    const canonicalRepository = resolveRepositoryFromCwd(repository);
    if (canonicalRepository === null) {
      throw new BackfillExecutionError();
    }
    const configured = input.config.projects.find((candidate) => candidate.repository === canonicalRepository);
    if (configured === undefined) {
      if (input.config.projects.length > 0) {
        throw new BackfillExecutionError();
      }
      const setup = await fetchCollectorSetup({
        api_url: input.config.api_url,
        token: input.token,
        repository: canonicalRepository,
      });
      if (setup === null) {
        throw new BackfillExecutionError();
      }
    }
  }
  const sources = input.source === undefined ? BACKFILL_SOURCES : [input.source];
  const home = userHome();
  const discovered = sources.map((source) => [source, discover(source, home, repository)] as const);
  const summaries: Partial<Record<BackfillSource, SourceSummary>> = {};
  for (const [source, result] of discovered) {
    summaries[source] = result.summary;
  }
  if (!input.dryRun) {
    for (const [, result] of discovered) {
      for (const session of result.sessions) {
        await collectFromHook({
          source: session.source,
          hook: { session_id: session.sessionId, transcript_path: session.transcriptPath, cwd: repository },
          config: input.config,
          token: input.token,
          knownSecrets: input.knownSecrets,
        });
      }
    }
  }
  const totals = Object.values(summaries).reduce(
    (total, summary) => ({
      sessions: total.sessions + summary.sessions,
      candidates: total.candidates + summary.candidates,
      excluded: total.excluded + summary.excluded,
    }),
    { sessions: 0, candidates: 0, excluded: 0 },
  );
  return { status: input.dryRun ? 'dry_run' : 'completed', sources: summaries, totals };
}
