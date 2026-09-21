import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, statSync, type BigIntStats } from 'node:fs';
import { z } from 'zod';
import { MAX_SOURCE_IDENTIFIER_BYTES, MAX_TEXT_LENGTH, type EventSource } from '../api/contract.js';
import { SUPPORTED_CLAUDE_CODE_VERSION, parseClaudeTranscriptLine } from './adapters/claude.js';
import { SUPPORTED_CODEX_CLI_VERSION, parseCodexTranscriptLine } from './adapters/codex.js';
import { resolveRepositoryFromCwd } from './remote.js';
import { deliverPending } from './send.js';
import type { CollectorConfig } from './config.js';
import type { TranscriptMessageRecord, TranscriptRecord } from './transcript.js';
import {
  NO_OFFSET,
  closeCollectorState,
  collectorNamespace,
  enqueueOutbox,
  getCursor,
  getSession,
  getStoredMessage,
  insertSession,
  insertStoredMessage,
  openCollectorState,
  recordDiagnostic,
  updateSessionNextSequence,
  updateSessionVersion,
  updateStoredMessageRevision,
  upsertCursor,
  type CollectorState,
  type CursorRow,
  type SessionRow,
} from './state.js';

const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const FINGERPRINT_BYTES = 4096;

// hook JSONのうち収集に必要なfield。prompt等の本文は使わない。
export interface CollectorHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
}

export interface CollectFromHookInput {
  source: EventSource;
  hook: CollectorHookInput;
  config: CollectorConfig;
  token: string;
}

export interface FlushCollectorInput {
  config: CollectorConfig;
  token: string;
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isStorableText(text: string): boolean {
  if (text.length === 0 || text.includes('\u0000') || /[\uD800-\uDFFF]/u.test(text)) {
    return false;
  }
  return [...text].length <= MAX_TEXT_LENGTH;
}

// server契約（schema.tsのsourceIdentifier）と同じく、空・NUL・単独サロゲート・1024 UTF-8 bytes超を拒否する。
function isStorableIdentifier(value: string): boolean {
  if (value.length === 0 || value.includes('\u0000') || /[\uD800-\uDFFF]/u.test(value)) {
    return false;
  }
  return Buffer.byteLength(value, 'utf8') <= MAX_SOURCE_IDENTIFIER_BYTES;
}

function supportedVersion(source: EventSource): string {
  return source === 'codex' ? SUPPORTED_CODEX_CLI_VERSION : SUPPORTED_CLAUDE_CODE_VERSION;
}

function parseLine(source: EventSource, line: string): TranscriptRecord {
  return source === 'codex' ? parseCodexTranscriptLine(line) : parseClaudeTranscriptLine(line);
}

// scanと同じfile descriptorの先頭固定長bytesのhash。同inode書換えをappendと区別して検知する。
function fingerprintOf(fd: number, size: number, maxBytes = FINGERPRINT_BYTES): { length: number; hash: string } {
  const length = Math.min(size, maxBytes);
  if (length === 0) {
    return { length: 0, hash: sha256Hex(Buffer.alloc(0)) };
  }
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const read = readSync(fd, buffer, total, length - total, total);
    if (read <= 0) {
      break;
    }
    total += read;
  }
  return { length: total, hash: sha256Hex(buffer.subarray(0, total)) };
}

// 前回cursorとのinode・size・fingerprint比較から、読み始めるbyte offsetと継続中のskip状態を決める。
// inode交換・短縮・同inode書換えでは途中のoversize行のskip状態も捨てて0から読み直す。
function resolveStartOffset(
  fd: number,
  cursor: CursorRow | undefined,
  size: number,
  device: string,
  inode: string,
): { offset: number; skipStart: number | null } {
  if (cursor === undefined) {
    return { offset: 0, skipStart: null };
  }
  if (cursor.device !== device || cursor.inode !== inode) {
    return { offset: 0, skipStart: null };
  }
  if (size < cursor.file_size) {
    return { offset: 0, skipStart: null };
  }
  if (cursor.fingerprint_length > 0 && size >= cursor.fingerprint_length) {
    const fingerprint = fingerprintOf(fd, size, cursor.fingerprint_length);
    if (fingerprint.hash !== cursor.fingerprint) {
      return { offset: 0, skipStart: null };
    }
  }
  if (cursor.skip_start !== null && cursor.skip_offset !== null) {
    return { offset: Math.min(cursor.skip_offset, size), skipStart: cursor.skip_start };
  }
  return { offset: Math.min(cursor.byte_offset, size), skipStart: null };
}

interface ScanInput {
  fd: number;
  startOffset: number;
  // 前回のscanから読み捨てを継続している1MiB超行の開始offset。nullなら通常の行処理。
  skipStart: number | null;
  shouldStop: () => boolean;
  onLine: (line: string, byteOffset: number) => void;
  onOversize: (byteOffset: number) => void;
}

// 4MiB予算の範囲で改行単位に読み、未完の末尾行はcursorへ含めない。1MiB超の行は本文を保持せず読み飛ばす。
// 予算はskip中の読取も含めて数え、skipが未完のままEOF/予算へ達した場合は元の行startと読取済みoffsetを返す。
// fdは呼出元が開いたscan対象そのもの。読みの途中でpathが差し替わっても別inodeを混ぜない。
function scanLines(input: ScanInput): { cursor: number; skipStart: number | null; skipOffset: number | null } {
  let position = input.startOffset;
  let lineStart = input.skipStart ?? input.startOffset;
  let partial = Buffer.alloc(0);
  let skipStart = input.skipStart;
  let cursor = lineStart;
  let consumed = 0;
  while (consumed < MAX_READ_BYTES && !input.shouldStop()) {
    const toRead = Math.min(READ_CHUNK_BYTES, MAX_READ_BYTES - consumed);
    const buffer = Buffer.allocUnsafe(toRead);
    const read = readSync(input.fd, buffer, 0, toRead, position);
    if (read === 0) {
      break;
    }
    consumed += read;
    const chunk = buffer.subarray(0, read);
    let start = 0;
    let stopped = false;
    while (true) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        break;
      }
      if (skipStart !== null) {
        input.onOversize(skipStart);
        skipStart = null;
        partial = Buffer.alloc(0);
      } else {
        const lineLength = partial.length + newline - start;
        if (lineLength > MAX_LINE_BYTES) {
          input.onOversize(lineStart);
          partial = Buffer.alloc(0);
        } else {
          const lineBytes = partial.length > 0 ? Buffer.concat([partial, chunk.subarray(start, newline)]) : chunk.subarray(start, newline);
          partial = Buffer.alloc(0);
          input.onLine(lineBytes.toString('utf8'), lineStart);
          if (input.shouldStop()) {
            stopped = true;
            cursor = lineStart;
            break;
          }
        }
      }
      lineStart = position + newline + 1;
      cursor = lineStart;
      start = newline + 1;
    }
    if (stopped) {
      break;
    }
    const rest = chunk.subarray(start);
    if (rest.length > 0 && skipStart === null) {
      partial = partial.length > 0 ? Buffer.concat([partial, rest]) : Buffer.from(rest);
      if (partial.length > MAX_LINE_BYTES) {
        skipStart = lineStart;
        partial = Buffer.alloc(0);
      }
    }
    position += read;
    if (read < toRead) {
      break;
    }
  }
  return { cursor, skipStart, skipOffset: skipStart === null ? null : position };
}

interface IngestContext {
  state: CollectorState;
  namespace: string;
  source: EventSource;
  hook: CollectorHookInput;
  repository: string;
  projectId: string;
  supportedVersion: string;
  version: string | null;
  nextSequence: number;
  sessionExists: boolean;
  held: boolean;
  // 保留scanはTXごとrollbackするため、原因の固定code/offsetを別途保存できるよう保持する。
  heldDiagnostic: { code: string; byteOffset: number } | null;
}

// 1件の発言を検証し、同一message IDは本文一致を無視・本文変更をrevision+1としてoutboxへ積む。
function ingestMessage(ctx: IngestContext, record: TranscriptMessageRecord, byteOffset: number): void {
  if (!isStorableText(record.text)) {
    recordDiagnostic(ctx.state, ctx.namespace, 'message_invalid_text', byteOffset);
    return;
  }
  if (!z.iso.datetime({ offset: true }).safeParse(record.occurred_at).success) {
    recordDiagnostic(ctx.state, ctx.namespace, 'message_invalid_timestamp', byteOffset);
    return;
  }
  if (!isStorableIdentifier(record.source_message_id) || !isStorableIdentifier(ctx.hook.session_id)) {
    recordDiagnostic(ctx.state, ctx.namespace, 'message_invalid_identifier', byteOffset);
    return;
  }
  const occurredAt = new Date(record.occurred_at).toISOString();
  const contentHash = sha256Hex(record.text);
  const stored = getStoredMessage(ctx.state, ctx.namespace, ctx.source, ctx.hook.session_id, record.source_message_id);

  let sequenceNo: number;
  let revision: number;
  if (stored === undefined) {
    sequenceNo = ctx.nextSequence;
    ctx.nextSequence += 1;
    revision = 1;
    if (!ctx.sessionExists) {
      insertSession(ctx.state, ctx.namespace, ctx.source, ctx.hook.session_id, ctx.repository, ctx.projectId);
      ctx.sessionExists = true;
    }
    insertStoredMessage(ctx.state, {
      namespace: ctx.namespace,
      source: ctx.source,
      source_session_id: ctx.hook.session_id,
      source_message_id: record.source_message_id,
      sequence_no: sequenceNo,
      role: record.role,
      occurred_at: occurredAt,
      content_hash: contentHash,
    });
  } else {
    if (stored.role !== record.role || stored.occurred_at !== occurredAt) {
      recordDiagnostic(ctx.state, ctx.namespace, 'message_identity_conflict', byteOffset);
      return;
    }
    if (stored.content_hash === contentHash) {
      return;
    }
    sequenceNo = stored.sequence_no;
    revision = stored.revision + 1;
    updateStoredMessageRevision(ctx.state, ctx.namespace, ctx.source, ctx.hook.session_id, record.source_message_id, revision, contentHash);
  }

  const idempotencyKey = sha256Hex(
    [ctx.namespace, ctx.source, ctx.repository, ctx.hook.session_id, record.source_message_id, String(revision)].join('\n'),
  );
  enqueueOutbox(ctx.state, {
    namespace: ctx.namespace,
    idempotency_key: idempotencyKey,
    project_id: ctx.projectId,
    source: ctx.source,
    source_scope: ctx.repository,
    source_session_id: ctx.hook.session_id,
    source_message_id: record.source_message_id,
    sequence_no: sequenceNo,
    revision,
    role: record.role,
    occurred_at: occurredAt,
    text: record.text,
  });
}

function processRecord(ctx: IngestContext, record: TranscriptRecord, byteOffset: number): void {
  if (record.kind === 'ignored') {
    return;
  }
  if (record.kind === 'invalid') {
    recordDiagnostic(ctx.state, ctx.namespace, 'transcript_invalid_json', byteOffset);
    return;
  }
  if (record.kind === 'unknown') {
    recordDiagnostic(ctx.state, ctx.namespace, 'transcript_unknown_record', byteOffset);
    return;
  }
  if (record.kind === 'session') {
    if (record.source_session_id !== ctx.hook.session_id) {
      ctx.heldDiagnostic = { code: 'session_id_mismatch', byteOffset };
      ctx.held = true;
      return;
    }
    if (record.transcript_version !== ctx.supportedVersion) {
      ctx.heldDiagnostic = { code: 'transcript_unknown_version', byteOffset };
      ctx.held = true;
      return;
    }
    // 確認済みsession_metaの時点でsessionを作成し、発言ゼロでも対応版とscope/project束縛を残す。
    if (!ctx.sessionExists) {
      insertSession(ctx.state, ctx.namespace, ctx.source, ctx.hook.session_id, ctx.repository, ctx.projectId);
      ctx.sessionExists = true;
    }
    ctx.version = record.transcript_version;
    return;
  }
  if (record.source_session_id !== ctx.hook.session_id) {
    ctx.heldDiagnostic = { code: 'session_id_mismatch', byteOffset };
    ctx.held = true;
    return;
  }
  const version = record.transcript_version ?? ctx.version;
  if (version === null || version !== ctx.supportedVersion) {
    // 未知版は本文を取り込まず、cursorも進めず保留する。
    ctx.heldDiagnostic = { code: 'transcript_unknown_version', byteOffset };
    ctx.held = true;
    return;
  }
  ctx.version = version;
  ingestMessage(ctx, record, byteOffset);
}

export interface IngestResult {
  held: boolean;
  projectId?: string;
}

// 指定transcriptの差分を1トランザクションでcursor・message・outbox・診断へ反映する。
export function ingestTranscript(
  state: CollectorState,
  input: {
    namespace: string;
    source: EventSource;
    hook: CollectorHookInput;
    repository: string;
    projectId: string;
  },
): IngestResult {
  if (!isStorableIdentifier(input.hook.session_id)) {
    recordDiagnostic(state, input.namespace, 'session_invalid_identifier', NO_OFFSET);
    return { held: true };
  }
  const existing = getSession(state, input.namespace, input.source, input.hook.session_id);
  if (existing !== undefined && (existing.source_scope !== input.repository || existing.project_id !== input.projectId)) {
    recordDiagnostic(state, input.namespace, 'source_project_reassignment', NO_OFFSET);
    return { held: true, projectId: existing.project_id };
  }

  state.db
    .prepare(
      `INSERT INTO sources (namespace, source, source_session_id, transcript_path, cwd, registered) VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT (namespace, source, source_session_id, transcript_path)
       DO UPDATE SET cwd = excluded.cwd, registered = max(sources.registered, excluded.registered)`,
    )
    .run(input.namespace, input.source, input.hook.session_id, input.hook.transcript_path, input.hook.cwd);

  // 読取からcursor commitまでをBEGIN IMMEDIATEで直列化する。cursor/offsetはTX取得後に読む。
  state.db.exec('BEGIN IMMEDIATE');
  try {
    const session: SessionRow | undefined = getSession(state, input.namespace, input.source, input.hook.session_id);
    if (session !== undefined && (session.source_scope !== input.repository || session.project_id !== input.projectId)) {
      recordDiagnostic(state, input.namespace, 'source_project_reassignment', NO_OFFSET);
      state.db.exec('COMMIT');
      return { held: true, projectId: session.project_id };
    }

    let fd: number;
    try {
      fd = openSync(input.hook.transcript_path, 'r');
    } catch {
      recordDiagnostic(state, input.namespace, 'transcript_unreadable', NO_OFFSET);
      state.db.exec('COMMIT');
      return { held: true };
    }
    try {
      const stat = fstatSync(fd, { bigint: true });
      const device = String(stat.dev);
      const inode = String(stat.ino);
      const size = Number(stat.size);
      const cursor = getCursor(state, input.namespace, input.source, input.hook.session_id, input.hook.transcript_path);
      const start = resolveStartOffset(fd, cursor, size, device, inode);
      const ctx: IngestContext = {
        state,
        namespace: input.namespace,
        source: input.source,
        hook: input.hook,
        repository: input.repository,
        projectId: input.projectId,
        supportedVersion: supportedVersion(input.source),
        version: session?.transcript_version ?? null,
        nextSequence: session?.next_sequence ?? 1,
        sessionExists: session !== undefined,
        held: false,
        heldDiagnostic: null,
      };
      const scan = scanLines({
        fd,
        startOffset: start.offset,
        skipStart: start.skipStart,
        shouldStop: () => ctx.held,
        onLine: (line, offset) => processRecord(ctx, parseLine(input.source, line), offset),
        onOversize: (offset) => recordDiagnostic(state, input.namespace, 'transcript_line_too_long', offset),
      });
      if (ctx.held) {
        // 同scanで積んだ先行message/outbox/採番/cursorは一体で戻し、保留原因の診断だけを残す。
        state.db.exec('ROLLBACK');
        if (ctx.heldDiagnostic !== null) {
          recordDiagnostic(state, input.namespace, ctx.heldDiagnostic.code, ctx.heldDiagnostic.byteOffset);
        }
        return { held: true };
      }
      if (ctx.sessionExists) {
        updateSessionNextSequence(state, input.namespace, input.source, input.hook.session_id, ctx.nextSequence);
        if (input.source === 'codex' && ctx.version !== null) {
          updateSessionVersion(state, input.namespace, input.source, input.hook.session_id, ctx.version);
        }
      }
      const finalStat = fstatSync(fd, { bigint: true });
      // scan中にpathが別inodeへ差し替わった場合は、旧fileのoffsetを新inodeへ記録せずrollbackして次回へ回す。
      let pathStat: BigIntStats;
      try {
        pathStat = statSync(input.hook.transcript_path, { bigint: true });
      } catch {
        state.db.exec('ROLLBACK');
        return { held: true };
      }
      if (pathStat.dev !== finalStat.dev || pathStat.ino !== finalStat.ino) {
        state.db.exec('ROLLBACK');
        return { held: true };
      }
      const fingerprint = fingerprintOf(fd, Number(finalStat.size));
      upsertCursor(state, input.namespace, input.source, input.hook.session_id, input.hook.transcript_path, {
        byte_offset: scan.cursor,
        device: String(finalStat.dev),
        inode: String(finalStat.ino),
        file_size: Number(finalStat.size),
        fingerprint_length: fingerprint.length,
        fingerprint: fingerprint.hash,
        skip_start: scan.skipStart,
        skip_offset: scan.skipOffset,
      });
      state.db.exec('COMMIT');
      return { held: false };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    state.db.exec('ROLLBACK');
    throw error;
  }
}

// hookを契機にtranscriptの差分を読み、SQLiteへ保存して未送信分の送信を試みる。
export async function collectFromHook(input: CollectFromHookInput): Promise<void> {
  const namespace = collectorNamespace(input.config.api_url, input.token);
  const state = openCollectorState(input.config.state_dir);
  try {
    // 不正session_idは収集境界で拒否し、source/sessionを保存せず他のsessionの送信を妨げない。
    if (!isStorableIdentifier(input.hook.session_id)) {
      recordDiagnostic(state, namespace, 'session_invalid_identifier', NO_OFFSET);
      return;
    }
    const repository = resolveRepositoryFromCwd(input.hook.cwd);
    const project = repository === null ? undefined : input.config.projects.find((candidate) => candidate.repository === repository);
    if (repository === null || project === undefined) {
      // 未登録sourceは本文を読まず、cwd/source/session/transcript_pathの参照だけを保持する。
      state.db
        .prepare(
          `INSERT INTO sources (namespace, source, source_session_id, transcript_path, cwd, registered) VALUES (?, ?, ?, ?, ?, 0)
           ON CONFLICT (namespace, source, source_session_id, transcript_path)
           DO UPDATE SET cwd = excluded.cwd`,
        )
        .run(namespace, input.source, input.hook.session_id, input.hook.transcript_path, input.hook.cwd);
      await deliverPending({ state, namespace, config: input.config, token: input.token, automatic: true, blockedProjects: new Set() });
      return;
    }
    const result = ingestTranscript(state, {
      namespace,
      source: input.source,
      hook: input.hook,
      repository,
      projectId: project.project_id,
    });
    if (result.held) {
      return;
    }
    await deliverPending({ state, namespace, config: input.config, token: input.token, automatic: true, blockedProjects: new Set() });
  } finally {
    closeCollectorState(state);
  }
}

// 保留sourceの対応表を再確認して未読分を取り込み、未送信のoutboxを再送する。
export async function flushCollector(input: FlushCollectorInput): Promise<void> {
  const namespace = collectorNamespace(input.config.api_url, input.token);
  const state = openCollectorState(input.config.state_dir);
  const blockedProjects = new Set<string>();
  try {
    const sources = state.db
      .prepare('SELECT source, source_session_id, transcript_path, cwd FROM sources WHERE namespace = ? ORDER BY rowid')
      .all(namespace);
    for (const row of sources) {
      const source = row.source as EventSource;
      const sessionId = String(row.source_session_id);
      // 元cwdが移動・削除されてrepositoryを解決できない場合は、このsourceの未読ログ再収集だけをskipする。
      // 保存済みoutboxの送信は送信側の登録済みproject/scope検証へ委ね、blockedProjectsへ入れない。
      const repository = resolveRepositoryFromCwd(String(row.cwd));
      if (repository === null) {
        continue;
      }
      const project = input.config.projects.find((candidate) => candidate.repository === repository);
      if (project === undefined) {
        const session = getSession(state, namespace, source, sessionId);
        if (session !== undefined) {
          blockedProjects.add(session.project_id);
        }
        continue;
      }
      const result = ingestTranscript(state, {
        namespace,
        source,
        hook: { session_id: sessionId, transcript_path: String(row.transcript_path), cwd: String(row.cwd) },
        repository,
        projectId: project.project_id,
      });
      if (result.held && result.projectId !== undefined) {
        blockedProjects.add(result.projectId);
      }
    }
    await deliverPending({ state, namespace, config: input.config, token: input.token, automatic: false, blockedProjects });
  } finally {
    closeCollectorState(state);
  }
}
