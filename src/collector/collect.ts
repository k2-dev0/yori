import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync, type BigIntStats } from 'node:fs';
import { z } from 'zod';
import { MAX_SOURCE_IDENTIFIER_BYTES, MAX_TEXT_LENGTH, SUSPECTED_SECRET_OBSERVED, type EventSource } from '../api/contract.js';
import { emptyRedactionPolicy, redactConversationText, sanitizeConversationText, type RedactionPolicy } from '../api/redaction.js';
import { SUPPORTED_CLAUDE_CODE_VERSION, parseClaudeTranscriptLine } from './adapters/claude.js';
import { SUPPORTED_CODEX_CLI_VERSIONS, codexTurnMessageId, parseCodexTranscriptLine } from './adapters/codex.js';
import { SUPPORTED_DEEPSEEK_HARNESS_VERSIONS, createDeepSeekTranscriptParser, decompressDeepSeekTranscript } from './adapters/deepseek.js';
import { resolveRepositoryFromCwd } from './remote.js';
import { deliverPending, resolvedTargetKey } from './send.js';
import { decryptCachedPolicy, encryptCachedPolicy } from './policy-cache.js';
import { fetchCollectorSetup } from './setup.js';
import type { CollectorConfig } from './config.js';
import type { TranscriptMessageRecord, TranscriptRecord } from './transcript.js';
import {
  NO_OFFSET,
  closeCollectorState,
  collectorNamespace,
  enqueueOutbox,
  getCachedProjectPolicy,
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
  upsertCachedProjectPolicy,
  upsertCursor,
  type CollectorState,
  type CursorRow,
  type SessionRow,
} from './state.js';

const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const FINGERPRINT_BYTES = 4096;

// 共通fieldに加え、Codexの安定hook契約からturn境界のuser/assistant本文を受け取る。
export interface CollectorHookInput {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  turn_id?: string;
  // DeepSeek Harnessが会話記録へ書く発言のID。入力時点では会話fileに無い発言を、同じIDで先に取り込む。
  message_id?: string;
  generation_id?: string;
  prompt?: string;
  text?: string;
  workspace_roots?: string[];
  model_id?: string;
  client_version?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
}

export interface CollectFromHookInput {
  source: EventSource;
  hook: CollectorHookInput;
  config: CollectorConfig;
  token: string;
  // CLIがlocalのYORI_KNOWN_SECRETS_JSONからparseした値。process.envへは残さない。
  knownSecrets?: readonly string[];
}

export interface FlushCollectorInput {
  config: CollectorConfig;
  token: string;
  knownSecrets?: readonly string[];
}

// このcollect呼出しのSQLite commitで新規追加またはrevision更新として確定したuser発言identity。
// 本文・promptは含めず、通知のby-input照合に必要なidentityだけを返す。
export interface ConfirmedUserInput {
  sourceMessageId: string;
  revision: number;
  sequenceNo: number;
  sourceScope: string;
  projectId: string;
}

export interface CollectFromHookResult {
  confirmedUserInputs: ConfirmedUserInput[];
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

// versionは互換性の診断情報にだけ使う。本文は各adapterの構造検証を通ったrecordだけを扱う。
function isSupportedTranscriptVersion(source: EventSource, version: string): boolean {
  if (source === 'codex') {
    return SUPPORTED_CODEX_CLI_VERSIONS.includes(version);
  }
  if (source === 'claude_code') {
    return version === SUPPORTED_CLAUDE_CODE_VERSION;
  }
  return source === 'deepseek_harness' && SUPPORTED_DEEPSEEK_HARNESS_VERSIONS.map(String).includes(version);
}

function createTranscriptLineParser(source: EventSource): (line: string) => TranscriptRecord[] {
  if (source === 'codex') {
    return (line) => [parseCodexTranscriptLine(line)];
  }
  if (source === 'claude_code') {
    return (line) => [parseClaudeTranscriptLine(line)];
  }
  if (source === 'deepseek_harness') {
    return createDeepSeekTranscriptParser().parseLine;
  }
  return () => [{ kind: 'unknown' }];
}

type HookMessageSelection =
  | { kind: 'transcript' }
  | { kind: 'empty' }
  | {
      kind: 'message';
      sourceMessageId: string;
      role: 'user' | 'assistant';
      text: string;
      modelId?: string;
      clientVersion?: string;
    };

// Codex hookが正式に渡すturn_idと本文を通常収集の正本にする。旧hook・flushはtranscriptへfallbackする。
function selectHookMessage(source: EventSource, hook: CollectorHookInput): HookMessageSelection {
  if (source === 'cursor') {
    if (hook.generation_id === undefined || hook.model_id === undefined || hook.client_version === undefined) {
      return { kind: 'empty' };
    }
    if (hook.hook_event_name === 'beforeSubmitPrompt' && hook.prompt !== undefined) {
      return {
        kind: 'message',
        sourceMessageId: `generation:${hook.generation_id}:user`,
        role: 'user',
        text: hook.prompt,
        modelId: hook.model_id,
        clientVersion: hook.client_version,
      };
    }
    if (hook.hook_event_name === 'afterAgentResponse' && hook.text !== undefined) {
      return {
        kind: 'message',
        sourceMessageId: `generation:${hook.generation_id}:assistant`,
        role: 'assistant',
        text: hook.text,
        modelId: hook.model_id,
        clientVersion: hook.client_version,
      };
    }
    return { kind: 'empty' };
  }
  if (source === 'deepseek_harness' && hook.hook_event_name === 'UserPromptSubmit' && hook.message_id !== undefined && hook.prompt !== undefined) {
    return { kind: 'message', sourceMessageId: hook.message_id, role: 'user', text: hook.prompt };
  }
  if (source !== 'codex') {
    return { kind: 'transcript' };
  }
  if (hook.hook_event_name === 'UserPromptSubmit') {
    if (hook.turn_id === undefined || hook.prompt === undefined) {
      return { kind: 'empty' };
    }
    return { kind: 'message', sourceMessageId: codexTurnMessageId(hook.turn_id, 'user'), role: 'user', text: hook.prompt };
  }
  if (hook.hook_event_name === 'Stop') {
    if (hook.turn_id === undefined || hook.last_assistant_message === undefined || hook.last_assistant_message === null) {
      return { kind: 'empty' };
    }
    return {
      kind: 'message',
      sourceMessageId: codexTurnMessageId(hook.turn_id, 'assistant'),
      role: 'assistant',
      text: hook.last_assistant_message,
    };
  }
  return { kind: 'transcript' };
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
  onInvalidUtf8: (byteOffset: number) => void;
  maxReadBytes?: number;
  // 圧縮された会話fileの展開済み本文。指定時はfdではなくこの本文を読み、offsetも本文上の位置になる。
  content?: Buffer;
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
  const maxReadBytes = input.maxReadBytes ?? MAX_READ_BYTES;
  while (consumed < maxReadBytes && !input.shouldStop()) {
    const toRead = Math.min(READ_CHUNK_BYTES, maxReadBytes - consumed);
    const buffer = Buffer.allocUnsafe(toRead);
    const read = input.content === undefined ? readSync(input.fd, buffer, 0, toRead, position) : input.content.copy(buffer, 0, position, position + toRead);
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
          if (isUtf8(lineBytes)) {
            input.onLine(lineBytes.toString('utf8'), lineStart);
          } else {
            input.onInvalidUtf8(lineStart);
          }
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
  policy: RedactionPolicy;
  knownSecrets: readonly string[];
  version: string | null;
  nextSequence: number;
  sessionExists: boolean;
  held: boolean;
  // このTXでcommit対象になったuser発言のidentity。rollback時はcollectFromHookが返さない。
  confirmedUserInputs: Array<{ sourceMessageId: string; revision: number; sequenceNo: number }>;
  // 保留scanはTXごとrollbackするため、原因の固定code/offsetを別途保存できるよう保持する。
  heldDiagnostic: { code: string; byteOffset: number } | null;
}

// 1件の発言を検証し、同一message IDは本文一致を無視・本文変更をrevision+1としてoutboxへ積む。
function ingestMessage(ctx: IngestContext, record: TranscriptMessageRecord, byteOffset: number): void {
  // transcript messageのparse直後、hash/revision/SQLite/outboxより前にsanitizeする。
  // blockはmessage/outboxを保存せず固定codeとoffsetだけを残し、cursorはそのまま進める。
  const sanitized = sanitizeConversationText(record.text, ctx.policy, ctx.knownSecrets);
  if (sanitized.action === 'block') {
    recordDiagnostic(ctx.state, ctx.namespace, 'message_blocked_suspected_secret', byteOffset);
    return;
  }
  const text = sanitized.text;
  if (sanitized.findings.includes(SUSPECTED_SECRET_OBSERVED)) {
    recordDiagnostic(ctx.state, ctx.namespace, 'message_suspected_secret', byteOffset);
  }
  if (!isStorableText(text)) {
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
  if (
    (record.model_id !== undefined && !isStorableIdentifier(record.model_id)) ||
    (record.client_version !== undefined && !isStorableIdentifier(record.client_version))
  ) {
    recordDiagnostic(ctx.state, ctx.namespace, 'message_invalid_identifier', byteOffset);
    return;
  }
  let occurredAt = new Date(record.occurred_at).toISOString();
  // custom policyの変更だけでrevisionを増やさないよう、source変更検知はbuilt-in適用後（custom適用前）で固定する。
  const sourceText = redactConversationText(record.text);
  const textHash = sha256Hex(sourceText);
  const contentHash = record.model_id === undefined ? textHash : sha256Hex(JSON.stringify([sourceText, record.model_id]));
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
    if (record.role === 'user') {
      ctx.confirmedUserInputs.push({ sourceMessageId: record.source_message_id, revision, sequenceNo });
    }
  } else {
    if (stored.role !== record.role) {
      recordDiagnostic(ctx.state, ctx.namespace, 'message_identity_conflict', byteOffset);
      return;
    }
    // turn hookにはagent側timestampがないため初回観測時刻を固定し、後続backfillのログ時刻では変更しない。
    if (
      (ctx.source === 'codex' && record.source_message_id.startsWith('turn:')) ||
      (ctx.source === 'cursor' && record.source_message_id.startsWith('generation:'))
    ) {
      occurredAt = stored.occurred_at;
    } else if (stored.occurred_at !== occurredAt) {
      recordDiagnostic(ctx.state, ctx.namespace, 'message_identity_conflict', byteOffset);
      return;
    }
    // modelを付けずに取り込んだ発言を後からmodel付きで読み直しても、本文が同じならrevisionを増やさない。
    if (stored.content_hash === contentHash || stored.content_hash === textHash) {
      return;
    }
    sequenceNo = stored.sequence_no;
    revision = stored.revision + 1;
    updateStoredMessageRevision(ctx.state, ctx.namespace, ctx.source, ctx.hook.session_id, record.source_message_id, revision, contentHash);
    if (record.role === 'user') {
      ctx.confirmedUserInputs.push({ sourceMessageId: record.source_message_id, revision, sequenceNo });
    }
  }

  // 区切り文字が識別子に含まれても組の境界が崩れないよう、配列をJSONとして直列化してhashする。
  const idempotencyKey = sha256Hex(
    JSON.stringify([ctx.namespace, ctx.source, ctx.repository, ctx.hook.session_id, record.source_message_id, String(revision)]),
  );
  // 診断は固定codeと参照offsetだけを残し、置換した値も種類も保存しない。
  if (text !== record.text) {
    recordDiagnostic(ctx.state, ctx.namespace, 'message_redacted', byteOffset);
  }
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
    model_id: record.model_id,
    client_version: record.client_version,
    text,
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
    if (!isSupportedTranscriptVersion(ctx.source, record.transcript_version)) {
      recordDiagnostic(ctx.state, ctx.namespace, 'transcript_unverified_version', byteOffset);
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
  if (version === null) {
    recordDiagnostic(ctx.state, ctx.namespace, 'transcript_missing_version', byteOffset);
  } else {
    if (!isSupportedTranscriptVersion(ctx.source, version)) {
      recordDiagnostic(ctx.state, ctx.namespace, 'transcript_unverified_version', byteOffset);
    }
    ctx.version = version;
  }
  ingestMessage(ctx, record, byteOffset);
}

export interface IngestResult {
  held: boolean;
  projectId?: string;
  // commitで確定したuser発言identity。rollback/保留時は未設定。
  confirmedUserInputs?: Array<{ sourceMessageId: string; revision: number; sequenceNo: number }>;
}

function upsertRegisteredSource(
  state: CollectorState,
  input: { namespace: string; source: EventSource; hook: CollectorHookInput },
): void {
  if (input.source === 'cursor') {
    if (input.hook.cwd === undefined) {
      return;
    }
    state.db
      .prepare(
        `INSERT INTO direct_sources (namespace, source, source_session_id, cwd) VALUES (?, ?, ?, ?)
         ON CONFLICT (namespace, source, source_session_id) DO UPDATE SET cwd = excluded.cwd`,
      )
      .run(input.namespace, input.source, input.hook.session_id, input.hook.cwd);
    return;
  }
  if (input.hook.transcript_path === undefined || input.hook.cwd === undefined) {
    return;
  }
  state.db
    .prepare(
      `INSERT INTO sources (namespace, source, source_session_id, transcript_path, cwd, registered) VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT (namespace, source, source_session_id, transcript_path)
       DO UPDATE SET cwd = excluded.cwd, registered = max(sources.registered, excluded.registered)`,
    )
    .run(input.namespace, input.source, input.hook.session_id, input.hook.transcript_path, input.hook.cwd);
}

// Codexの安定hook fieldから1件だけをtransactionへ反映する。timestampは初回観測時に固定する。
function ingestHookMessage(
  state: CollectorState,
  input: {
    namespace: string;
    source: EventSource;
    hook: CollectorHookInput;
    repository: string;
    projectId: string;
    policy: RedactionPolicy;
    knownSecrets: readonly string[];
    message: Extract<HookMessageSelection, { kind: 'message' }>;
  },
): IngestResult {
  if (!isStorableIdentifier(input.hook.session_id)) {
    recordDiagnostic(state, input.namespace, 'session_invalid_identifier', NO_OFFSET);
    return { held: true };
  }
  if (!isStorableIdentifier(input.repository)) {
    recordDiagnostic(state, input.namespace, 'scope_invalid_identifier', NO_OFFSET);
    return { held: true };
  }
  const existing = getSession(state, input.namespace, input.source, input.hook.session_id);
  if (existing !== undefined && (existing.source_scope !== input.repository || existing.project_id !== input.projectId)) {
    recordDiagnostic(state, input.namespace, 'source_project_reassignment', NO_OFFSET);
    return { held: true, projectId: existing.project_id };
  }

  upsertRegisteredSource(state, input);
  state.db.exec('BEGIN IMMEDIATE');
  try {
    const session = getSession(state, input.namespace, input.source, input.hook.session_id);
    if (session !== undefined && (session.source_scope !== input.repository || session.project_id !== input.projectId)) {
      recordDiagnostic(state, input.namespace, 'source_project_reassignment', NO_OFFSET);
      state.db.exec('COMMIT');
      return { held: true, projectId: session.project_id };
    }
    const stored = getStoredMessage(state, input.namespace, input.source, input.hook.session_id, input.message.sourceMessageId);
    const ctx: IngestContext = {
      state,
      namespace: input.namespace,
      source: input.source,
      hook: input.hook,
      repository: input.repository,
      projectId: input.projectId,
      policy: input.policy,
      knownSecrets: input.knownSecrets,
      version: session?.transcript_version ?? null,
      nextSequence: session?.next_sequence ?? 1,
      sessionExists: session !== undefined,
      held: false,
      confirmedUserInputs: [],
      heldDiagnostic: null,
    };
    ingestMessage(
      ctx,
      {
        kind: 'message',
        source_session_id: input.hook.session_id,
        transcript_version: null,
        source_message_id: input.message.sourceMessageId,
        occurred_at: stored?.occurred_at ?? new Date().toISOString(),
        role: input.message.role,
        model_id: input.message.modelId,
        client_version: input.message.clientVersion,
        text: input.message.text,
      },
      NO_OFFSET,
    );
    if (ctx.sessionExists) {
      updateSessionNextSequence(state, input.namespace, input.source, input.hook.session_id, ctx.nextSequence);
    }
    state.db.exec('COMMIT');
    return { held: false, confirmedUserInputs: ctx.confirmedUserInputs };
  } catch (error) {
    state.db.exec('ROLLBACK');
    throw error;
  }
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
    // 未指定はbusiness rule無し。公開ingestTranscriptの既存callerと後方互換にする。
    policy?: RedactionPolicy;
    knownSecrets?: readonly string[];
  },
): IngestResult {
  const transcriptPath = input.hook.transcript_path;
  if (transcriptPath === undefined || input.hook.cwd === undefined || input.source === 'cursor') {
    recordDiagnostic(state, input.namespace, 'transcript_unreadable', NO_OFFSET);
    return { held: true };
  }
  if (!isStorableIdentifier(input.hook.session_id)) {
    recordDiagnostic(state, input.namespace, 'session_invalid_identifier', NO_OFFSET);
    return { held: true };
  }
  // server契約を超えるscopeはsource/session/outboxを作らず保留し、他projectの送信を妨げない。
  if (!isStorableIdentifier(input.repository)) {
    recordDiagnostic(state, input.namespace, 'scope_invalid_identifier', NO_OFFSET);
    return { held: true };
  }
  const existing = getSession(state, input.namespace, input.source, input.hook.session_id);
  if (existing !== undefined && (existing.source_scope !== input.repository || existing.project_id !== input.projectId)) {
    recordDiagnostic(state, input.namespace, 'source_project_reassignment', NO_OFFSET);
    return { held: true, projectId: existing.project_id };
  }

  upsertRegisteredSource(state, input);

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
      fd = openSync(transcriptPath, 'r');
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
      const cursor = getCursor(state, input.namespace, input.source, input.hook.session_id, transcriptPath);
      // DeepSeekのassistant確定はturn/endまでの状態を要する。backfill再実行は先頭から読み、
      // stored message/outboxの既存冪等性で重複を除く。途中offsetから推測復元しない。
      const start = input.source === 'deepseek_harness' ? { offset: 0, skipStart: null } : resolveStartOffset(fd, cursor, size, device, inode);
      const parseLine = createTranscriptLineParser(input.source);
      const ctx: IngestContext = {
        state,
        namespace: input.namespace,
        source: input.source,
        hook: input.hook,
        repository: input.repository,
        projectId: input.projectId,
        policy: input.policy ?? emptyRedactionPolicy(),
        knownSecrets: input.knownSecrets ?? [],
        version: session?.transcript_version ?? null,
        nextSequence: session?.next_sequence ?? 1,
        sessionExists: session !== undefined,
        held: false,
        confirmedUserInputs: [],
        heldDiagnostic: null,
      };
      const scan = scanLines({
        fd,
        startOffset: start.offset,
        skipStart: start.skipStart,
        shouldStop: () => ctx.held,
        onLine: (line, offset) => {
          for (const record of parseLine(line)) {
            processRecord(ctx, record, offset);
            if (ctx.held) {
              break;
            }
          }
        },
        onOversize: (offset) => recordDiagnostic(state, input.namespace, 'transcript_line_too_long', offset),
        onInvalidUtf8: (offset) => recordDiagnostic(state, input.namespace, 'transcript_invalid_utf8', offset),
        maxReadBytes: input.source === 'deepseek_harness' ? Number.MAX_SAFE_INTEGER : undefined,
        content: input.source === 'deepseek_harness' ? decompressDeepSeekTranscript(readFileSync(fd)) : undefined,
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
        if (ctx.version !== null) {
          updateSessionVersion(state, input.namespace, input.source, input.hook.session_id, ctx.version);
        }
      }
      const finalStat = fstatSync(fd, { bigint: true });
      // scan中にpathが別inodeへ差し替わった場合は、旧fileのoffsetを新inodeへ記録せずrollbackして次回へ回す。
      let pathStat: BigIntStats;
      try {
        pathStat = statSync(transcriptPath, { bigint: true });
      } catch {
        state.db.exec('ROLLBACK');
        return { held: true };
      }
      if (pathStat.dev !== finalStat.dev || pathStat.ino !== finalStat.ino) {
        state.db.exec('ROLLBACK');
        return { held: true };
      }
      const fingerprint = fingerprintOf(fd, Number(finalStat.size));
      upsertCursor(state, input.namespace, input.source, input.hook.session_id, transcriptPath, {
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
      return { held: false, confirmedUserInputs: ctx.confirmedUserInputs };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    state.db.exec('ROLLBACK');
    throw error;
  }
}

// 未解決sourceの参照だけを保持する。本文は読まず、後続hook・flushで再解決できるようにする。
function recordSourceReference(
  state: CollectorState,
  namespace: string,
  source: EventSource,
  hook: CollectorHookInput,
): void {
  if (source === 'cursor') {
    if (hook.cwd !== undefined) {
      state.db
        .prepare(
          `INSERT INTO direct_sources (namespace, source, source_session_id, cwd) VALUES (?, ?, ?, ?)
           ON CONFLICT (namespace, source, source_session_id) DO UPDATE SET cwd = excluded.cwd`,
        )
        .run(namespace, source, hook.session_id, hook.cwd);
    }
    return;
  }
  if (hook.transcript_path === undefined || hook.cwd === undefined) {
    return;
  }
  state.db
    .prepare(
      `INSERT INTO sources (namespace, source, source_session_id, transcript_path, cwd, registered) VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT (namespace, source, source_session_id, transcript_path)
       DO UPDATE SET cwd = excluded.cwd`,
    )
    .run(namespace, source, hook.session_id, hook.transcript_path, hook.cwd);
}

// 過去にsetupで解決したprojectとpolicyのcacheを復号して返す。復号できないcacheは使わない。
function cachedPolicyOf(
  input: Pick<CollectFromHookInput | FlushCollectorInput, 'config' | 'token'>,
  state: CollectorState,
  namespace: string,
  repository: string,
): { projectId: string; policy: RedactionPolicy } | undefined {
  const cached = getCachedProjectPolicy(state, namespace, repository);
  if (cached === undefined) {
    return undefined;
  }
  const policy = decryptCachedPolicy(input.token, input.config.api_url, cached.encryptedPolicy);
  return policy === undefined ? undefined : { projectId: cached.projectId, policy };
}

// setup APIからcurrent policyを毎collect/flush取得し、成功時はcacheを更新して返す。
// 取得失敗時はdecryptできるlast-known policyへfallbackし、cacheも無ければnullにして呼出元が本文を読まず保留する。
async function resolveServerPolicy(
  input: Pick<CollectFromHookInput | FlushCollectorInput, 'config' | 'token'>,
  state: CollectorState,
  namespace: string,
  repository: string,
): Promise<{ projectId: string; policy: RedactionPolicy } | null> {
  const cached = cachedPolicyOf(input, state, namespace, repository);

  const setup = await fetchCollectorSetup({ api_url: input.config.api_url, token: input.token, repository });
  if (setup !== null) {
    upsertCachedProjectPolicy(state, namespace, repository, {
      projectId: setup.projectId,
      version: setup.policy.version,
      encryptedPolicy: encryptCachedPolicy(input.token, input.config.api_url, setup.policy),
    });
    return { projectId: setup.projectId, policy: setup.policy };
  }
  if (cached !== undefined) {
    // cacheありの一時通信失敗はlast-known policyで継続する。
    return cached;
  }
  return null;
}

// hookのworkspaceからcanonical repositoryを一意に決め、Cursorの複数repository誤帰属を拒否する。
function resolveHookRepository(
  source: EventSource,
  hook: CollectorHookInput,
): { kind: 'resolved'; repository: string; cwd: string } | { kind: 'unresolved' } | { kind: 'ambiguous' } {
  if (source !== 'cursor') {
    if (hook.cwd === undefined) {
      return { kind: 'unresolved' };
    }
    const repository = resolveRepositoryFromCwd(hook.cwd);
    return repository === null ? { kind: 'unresolved' } : { kind: 'resolved', repository, cwd: hook.cwd };
  }
  const candidates = (hook.workspace_roots ?? [])
    .map((cwd) => ({ cwd, repository: resolveRepositoryFromCwd(cwd) }))
    .filter((candidate): candidate is { cwd: string; repository: string } => candidate.repository !== null);
  const repositories = new Set(candidates.map((candidate) => candidate.repository));
  if (repositories.size > 1) {
    return { kind: 'ambiguous' };
  }
  const candidate = candidates[0];
  return candidate === undefined ? { kind: 'unresolved' } : { kind: 'resolved', repository: candidate.repository, cwd: candidate.cwd };
}

// hookを契機にtranscriptの差分を読み、SQLiteへ保存して未送信分の送信を試みる。
export async function collectFromHook(input: CollectFromHookInput): Promise<CollectFromHookResult> {
  const namespace = collectorNamespace(input.config.api_url, input.token);
  const state = openCollectorState(input.config.state_dir);
  try {
    // 不正session_idは収集境界で拒否し、source/sessionを保存せず他のsessionの送信を妨げない。
    if (!isStorableIdentifier(input.hook.session_id)) {
      recordDiagnostic(state, namespace, 'session_invalid_identifier', NO_OFFSET);
      return { confirmedUserInputs: [] };
    }
    const resolution = resolveHookRepository(input.source, input.hook);
    if (resolution.kind === 'ambiguous') {
      recordDiagnostic(state, namespace, 'cursor_workspace_ambiguous', NO_OFFSET);
      return { confirmedUserInputs: [] };
    }
    if (resolution.kind === 'unresolved') {
      recordSourceReference(state, namespace, input.source, input.hook);
      if (input.source === 'cursor') {
        recordDiagnostic(state, namespace, 'repository_unresolved', NO_OFFSET);
      }
      await deliverPending({ state, namespace, config: input.config, token: input.token, automatic: true, blockedProjects: new Set() });
      return { confirmedUserInputs: [] };
    }
    const repository = resolution.repository;
    const hook = input.hook.cwd === resolution.cwd ? input.hook : { ...input.hook, cwd: resolution.cwd };
    // 旧設定のrepository対応表があれば設定を正本にする。無ければsetup APIでprojectとpolicyを解決する。
    const configured = input.config.projects.find((candidate) => candidate.repository === repository);
    const resolvedTargets = new Set<string>();
    let projectId: string;
    let policy: RedactionPolicy;
    if (configured !== undefined) {
      // 旧設定（projects対応表）はproject解決を正本とし、client側からsetup APIを呼ばない。
      // 過去にsetupで解決したcacheがある場合だけcustom policyを併用し、無ければbuilt-in置換だけで送信する。
      projectId = configured.project_id;
      policy = cachedPolicyOf(input, state, namespace, repository)?.policy ?? emptyRedactionPolicy();
    } else if (input.config.projects.length > 0) {
      // 旧設定は対応表を正本にし、未登録repositoryは従来どおり本文を読まず保留する。
      recordSourceReference(state, namespace, input.source, hook);
      await deliverPending({ state, namespace, config: input.config, token: input.token, automatic: true, blockedProjects: new Set() });
      return { confirmedUserInputs: [] };
    } else {
      const resolved = await resolveServerPolicy(input, state, namespace, repository);
      if (resolved === null) {
        // cacheなしの初回取得失敗はtranscript本文を読まず、送信も0件にする。
        recordSourceReference(state, namespace, input.source, hook);
        recordDiagnostic(state, namespace, 'policy_unavailable', NO_OFFSET);
        return { confirmedUserInputs: [] };
      }
      projectId = resolved.projectId;
      policy = resolved.policy;
    }
    resolvedTargets.add(resolvedTargetKey(projectId, repository));
    const hookMessage = selectHookMessage(input.source, hook);
    if (input.source === 'deepseek_harness' && hookMessage.kind === 'message') {
      // 前のturnの回答は会話fileにしか無い。今の入力より先に取り込み、発言の順番を保つ。
      // file側が保留になっても、入力の取り込みは同じ検査を自分で行うので止めない。
      const knownSecrets = input.knownSecrets ?? [];
      ingestTranscript(state, { namespace, source: input.source, hook, repository, projectId, policy, knownSecrets });
    }
    let result: IngestResult;
    if (hookMessage.kind === 'message') {
      result = ingestHookMessage(state, {
        namespace,
        source: input.source,
        hook,
        repository,
        projectId,
        policy,
        knownSecrets: input.knownSecrets ?? [],
        message: hookMessage,
      });
    } else if (hookMessage.kind === 'transcript') {
      result = ingestTranscript(state, {
        namespace,
        source: input.source,
        hook,
        repository,
        projectId,
        policy,
        knownSecrets: input.knownSecrets ?? [],
      });
    } else {
      upsertRegisteredSource(state, { namespace, source: input.source, hook });
      result = { held: false, confirmedUserInputs: [] };
    }
    if (result.held) {
      return { confirmedUserInputs: [] };
    }
    // commitで確定したidentityをここで固定し、deliverPendingのHTTP待機中の後続collectと混ぜない。
    const confirmedUserInputs = (result.confirmedUserInputs ?? []).map((item) => ({
      sourceMessageId: item.sourceMessageId,
      revision: item.revision,
      sequenceNo: item.sequenceNo,
      sourceScope: repository,
      projectId,
    }));
    await deliverPending({
      state,
      namespace,
      config: input.config,
      token: input.token,
      automatic: true,
      blockedProjects: new Set(),
      resolvedTargets,
    });
    return { confirmedUserInputs };
  } finally {
    closeCollectorState(state);
  }
}

// 保留sourceの対応表を再確認して未読分を取り込み、未送信のoutboxを再送する。
export async function flushCollector(input: FlushCollectorInput): Promise<void> {
  const namespace = collectorNamespace(input.config.api_url, input.token);
  const state = openCollectorState(input.config.state_dir);
  const blockedProjects = new Set<string>();
  const resolvedTargets = new Set<string>();
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
      const configured = input.config.projects.find((candidate) => candidate.repository === repository);
      let projectId: string;
      let policy: RedactionPolicy;
      if (configured !== undefined) {
        // 旧設定（projects対応表）はproject解決を正本とし、client側からsetup APIを呼ばない。
        projectId = configured.project_id;
        policy = cachedPolicyOf(input, state, namespace, repository)?.policy ?? emptyRedactionPolicy();
      } else if (input.config.projects.length > 0) {
        // 旧設定は対応表を正本にし、未登録repositoryの保留sourceは再解決しない。
        const session = getSession(state, namespace, source, sessionId);
        if (session !== undefined) {
          blockedProjects.add(session.project_id);
        }
        continue;
      } else {
        // 明示flushでもsetupを再取得する。成功時はcacheを更新し、失敗時はlast-known policyで継続する。
        const resolved = await resolveServerPolicy(input, state, namespace, repository);
        if (resolved === null) {
          // cacheなしの失敗では本文を読まず、そのsourceの送信も0件にする。
          const session = getSession(state, namespace, source, sessionId);
          if (session !== undefined) {
            blockedProjects.add(session.project_id);
          }
          continue;
        }
        projectId = resolved.projectId;
        policy = resolved.policy;
      }
      resolvedTargets.add(resolvedTargetKey(projectId, repository));
      const result = ingestTranscript(state, {
        namespace,
        source,
        hook: { session_id: sessionId, transcript_path: String(row.transcript_path), cwd: String(row.cwd) },
        repository,
        projectId,
        policy,
        knownSecrets: input.knownSecrets ?? [],
      });
      if (result.held && result.projectId !== undefined) {
        blockedProjects.add(result.projectId);
      }
    }
    const directSources = state.db
      .prepare('SELECT source, source_session_id, cwd FROM direct_sources WHERE namespace = ? ORDER BY rowid')
      .all(namespace);
    for (const row of directSources) {
      const source = row.source as EventSource;
      const sessionId = String(row.source_session_id);
      const repository = resolveRepositoryFromCwd(String(row.cwd));
      if (repository === null) {
        continue;
      }
      const configured = input.config.projects.find((candidate) => candidate.repository === repository);
      let projectId: string;
      if (configured !== undefined) {
        projectId = configured.project_id;
      } else if (input.config.projects.length > 0) {
        const session = getSession(state, namespace, source, sessionId);
        if (session !== undefined) {
          blockedProjects.add(session.project_id);
        }
        continue;
      } else {
        const resolved = await resolveServerPolicy(input, state, namespace, repository);
        if (resolved === null) {
          const session = getSession(state, namespace, source, sessionId);
          if (session !== undefined) {
            blockedProjects.add(session.project_id);
          }
          continue;
        }
        projectId = resolved.projectId;
      }
      resolvedTargets.add(resolvedTargetKey(projectId, repository));
    }
    await deliverPending({
      state,
      namespace,
      config: input.config,
      token: input.token,
      automatic: false,
      blockedProjects,
      resolvedTargets,
    });
  } finally {
    closeCollectorState(state);
  }
}
