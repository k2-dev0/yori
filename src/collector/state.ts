import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EventRole, EventSource } from '../api/contract.js';

// 本文を含まない診断レコード。固定codeと参照byte offsetだけを保持する。
export interface CollectorDiagnostic {
  code: string;
  byteOffset: number | null;
}

// SQLite stateのハンドル。state_dir配下のDBを開いている間だけ保持する。
export interface CollectorState {
  readonly stateDir: string;
  readonly dbPath: string;
  readonly db: DatabaseSync;
}

// byte offsetを持たない診断（送信失敗等）はNULLの代わりに-1で保存する。
export const NO_OFFSET = -1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sources (
  namespace TEXT NOT NULL,
  source TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  transcript_path TEXT NOT NULL,
  cwd TEXT NOT NULL,
  registered INTEGER NOT NULL,
  PRIMARY KEY (namespace, source, source_session_id, transcript_path)
);
CREATE TABLE IF NOT EXISTS source_sessions (
  namespace TEXT NOT NULL,
  source TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_scope TEXT NOT NULL,
  project_id TEXT NOT NULL,
  next_sequence INTEGER NOT NULL,
  transcript_version TEXT,
  PRIMARY KEY (namespace, source, source_session_id)
);
CREATE TABLE IF NOT EXISTS file_cursors (
  namespace TEXT NOT NULL,
  source TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  transcript_path TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  device TEXT NOT NULL,
  inode TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  fingerprint_length INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  skip_start INTEGER,
  skip_offset INTEGER,
  PRIMARY KEY (namespace, source, source_session_id, transcript_path)
);
CREATE TABLE IF NOT EXISTS stored_messages (
  namespace TEXT NOT NULL,
  source TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  role TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (namespace, source, source_session_id, source_message_id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_scope TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  role TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (namespace, idempotency_key)
);
CREATE INDEX IF NOT EXISTS outbox_order ON outbox (namespace, project_id, source_session_id, sequence_no, revision, id);
CREATE TABLE IF NOT EXISTS queue_backoff (
  namespace TEXT NOT NULL,
  project_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, project_id)
);
CREATE TABLE IF NOT EXISTS queue_failures (
  namespace TEXT NOT NULL,
  project_id TEXT NOT NULL,
  failed_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, project_id)
);
CREATE TABLE IF NOT EXISTS diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  code TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  occurrences INTEGER NOT NULL,
  UNIQUE (namespace, code, byte_offset)
);
`;

// endpointとtoken hashからstate namespaceを決める。資格情報変更で旧queueを新社員へ送らない。
export function collectorNamespace(apiUrl: string, token: string): string {
  return createHash('sha256').update(`${apiUrl}\n${createHash('sha256').update(token, 'utf8').digest('hex')}`, 'utf8').digest('hex');
}

// 既存stateのtableへ不足している列だけを後方互換で追加する。既存行はNULLのまま扱う。
function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const hasColumn = () => db.prepare(`PRAGMA table_info(${table})`).all().some((row) => String(row.name) === column);
  if (hasColumn()) {
    return;
  }
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    // 並行openで先に追加された場合は、追加済みなら成功として扱う。
    if (!hasColumn()) {
      throw error;
    }
  }
}

// state_dirとSQLiteファイルを作成（0700/0600）し、schemaを用意して開く。
export function openCollectorState(stateDir: string): CollectorState {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const dbPath = path.join(stateDir, 'collector.sqlite3');
  const db = new DatabaseSync(dbPath);
  chmodSync(dbPath, 0o600);
  // 並行hookをbusy_timeoutとBEGIN IMMEDIATEで直列化する。WALは子プロセス併走時のreaderを妨げない。
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    // 並行open中はmode変更に排他lockが必要になる。失敗してもbusy_timeoutとBEGIN IMMEDIATEで直列化する。
    db.exec('PRAGMA journal_mode = WAL');
  } catch {
    // 既定journalのまま継続する
  }
  db.exec(SCHEMA_SQL);
  // oversize行の読み捨て位置を保持する列は、旧stateではCREATE TABLE IF NOT EXISTSで追加されない。
  ensureColumn(db, 'file_cursors', 'skip_start', 'INTEGER');
  ensureColumn(db, 'file_cursors', 'skip_offset', 'INTEGER');
  return { stateDir, dbPath, db };
}

export function closeCollectorState(state: CollectorState): void {
  state.db.close();
}

// 固定codeとoffsetの診断を記録する。同じcode/offsetは件数だけ増やす。
export function recordDiagnostic(state: CollectorState, namespace: string, code: string, byteOffset: number): void {
  state.db
    .prepare(
      `INSERT INTO diagnostics (namespace, code, byte_offset, occurrences) VALUES (?, ?, ?, 1)
       ON CONFLICT (namespace, code, byte_offset) DO UPDATE SET occurrences = occurrences + 1`,
    )
    .run(namespace, code, byteOffset);
}

// namespaceが指定された場合はその資格情報の診断だけを返す。未指定は保存済み全件を返す。
export function listCollectorDiagnostics(state: CollectorState, namespace?: string): CollectorDiagnostic[] {
  const rows =
    namespace === undefined
      ? state.db.prepare('SELECT code, byte_offset FROM diagnostics ORDER BY id').all()
      : state.db.prepare('SELECT code, byte_offset FROM diagnostics WHERE namespace = ? ORDER BY id').all(namespace);
  return rows.map((row) => ({
    code: String(row.code),
    byteOffset: Number(row.byte_offset) === NO_OFFSET ? null : Number(row.byte_offset),
  }));
}

export interface SourceRow {
  source: EventSource;
  source_session_id: string;
  transcript_path: string;
  cwd: string;
  registered: number;
}

export interface SessionRow {
  source_scope: string;
  project_id: string;
  next_sequence: number;
  transcript_version: string | null;
}

export interface CursorRow {
  byte_offset: number;
  device: string;
  inode: string;
  file_size: number;
  fingerprint_length: number;
  fingerprint: string;
  // 1MiB超の行を読み捨てている間だけ、元の行startと読取済みoffsetを保持する。
  skip_start: number | null;
  skip_offset: number | null;
}

export interface StoredMessageRow {
  sequence_no: number;
  revision: number;
  role: EventRole;
  occurred_at: string;
  content_hash: string;
}

export interface OutboxRow {
  id: number;
  idempotency_key: string;
  project_id: string;
  source: EventSource;
  source_scope: string;
  source_session_id: string;
  source_message_id: string;
  sequence_no: number;
  revision: number;
  role: EventRole;
  occurred_at: string;
  text: string;
}

export function getSession(state: CollectorState, namespace: string, source: EventSource, sessionId: string): SessionRow | undefined {
  const row = state.db
    .prepare('SELECT source_scope, project_id, next_sequence, transcript_version FROM source_sessions WHERE namespace = ? AND source = ? AND source_session_id = ?')
    .get(namespace, source, sessionId);
  if (row === undefined) {
    return undefined;
  }
  return {
    source_scope: String(row.source_scope),
    project_id: String(row.project_id),
    next_sequence: Number(row.next_sequence),
    transcript_version: row.transcript_version === null ? null : String(row.transcript_version),
  };
}

export function insertSession(state: CollectorState, namespace: string, source: EventSource, sessionId: string, scope: string, projectId: string): void {
  state.db
    .prepare(
      `INSERT INTO source_sessions (namespace, source, source_session_id, source_scope, project_id, next_sequence, transcript_version)
       VALUES (?, ?, ?, ?, ?, 1, NULL)`,
    )
    .run(namespace, source, sessionId, scope, projectId);
}

export function updateSessionVersion(state: CollectorState, namespace: string, source: EventSource, sessionId: string, version: string): void {
  state.db
    .prepare('UPDATE source_sessions SET transcript_version = ? WHERE namespace = ? AND source = ? AND source_session_id = ?')
    .run(version, namespace, source, sessionId);
}

export function getCursor(state: CollectorState, namespace: string, source: EventSource, sessionId: string, transcriptPath: string): CursorRow | undefined {
  const row = state.db
    .prepare(
      `SELECT byte_offset, device, inode, file_size, fingerprint_length, fingerprint, skip_start, skip_offset
         FROM file_cursors
        WHERE namespace = ? AND source = ? AND source_session_id = ? AND transcript_path = ?`,
    )
    .get(namespace, source, sessionId, transcriptPath);
  if (row === undefined) {
    return undefined;
  }
  return {
    byte_offset: Number(row.byte_offset),
    device: String(row.device),
    inode: String(row.inode),
    file_size: Number(row.file_size),
    fingerprint_length: Number(row.fingerprint_length),
    fingerprint: String(row.fingerprint),
    skip_start: row.skip_start === null ? null : Number(row.skip_start),
    skip_offset: row.skip_offset === null ? null : Number(row.skip_offset),
  };
}

export function upsertCursor(
  state: CollectorState,
  namespace: string,
  source: EventSource,
  sessionId: string,
  transcriptPath: string,
  cursor: {
    byte_offset: number;
    device: string;
    inode: string;
    file_size: number;
    fingerprint_length: number;
    fingerprint: string;
    skip_start: number | null;
    skip_offset: number | null;
  },
): void {
  state.db
    .prepare(
      `INSERT INTO file_cursors (namespace, source, source_session_id, transcript_path, byte_offset, device, inode, file_size, fingerprint_length, fingerprint, skip_start, skip_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (namespace, source, source_session_id, transcript_path) DO UPDATE SET
         byte_offset = excluded.byte_offset, device = excluded.device, inode = excluded.inode,
         file_size = excluded.file_size, fingerprint_length = excluded.fingerprint_length, fingerprint = excluded.fingerprint,
         skip_start = excluded.skip_start, skip_offset = excluded.skip_offset`,
    )
    .run(
      namespace,
      source,
      sessionId,
      transcriptPath,
      cursor.byte_offset,
      cursor.device,
      cursor.inode,
      cursor.file_size,
      cursor.fingerprint_length,
      cursor.fingerprint,
      cursor.skip_start,
      cursor.skip_offset,
    );
}

export function getStoredMessage(
  state: CollectorState,
  namespace: string,
  source: EventSource,
  sessionId: string,
  messageId: string,
): StoredMessageRow | undefined {
  const row = state.db
    .prepare(
      `SELECT sequence_no, revision, role, occurred_at, content_hash
         FROM stored_messages
        WHERE namespace = ? AND source = ? AND source_session_id = ? AND source_message_id = ?`,
    )
    .get(namespace, source, sessionId, messageId);
  if (row === undefined) {
    return undefined;
  }
  return {
    sequence_no: Number(row.sequence_no),
    revision: Number(row.revision),
    role: row.role as EventRole,
    occurred_at: String(row.occurred_at),
    content_hash: String(row.content_hash),
  };
}

export function insertStoredMessage(
  state: CollectorState,
  input: {
    namespace: string;
    source: EventSource;
    source_session_id: string;
    source_message_id: string;
    sequence_no: number;
    role: EventRole;
    occurred_at: string;
    content_hash: string;
  },
): void {
  state.db
    .prepare(
      `INSERT INTO stored_messages (namespace, source, source_session_id, source_message_id, sequence_no, revision, role, occurred_at, content_hash)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(input.namespace, input.source, input.source_session_id, input.source_message_id, input.sequence_no, input.role, input.occurred_at, input.content_hash);
}

export function updateStoredMessageRevision(
  state: CollectorState,
  namespace: string,
  source: EventSource,
  sessionId: string,
  messageId: string,
  revision: number,
  contentHash: string,
): void {
  state.db
    .prepare(
      `UPDATE stored_messages SET revision = ?, content_hash = ?
        WHERE namespace = ? AND source = ? AND source_session_id = ? AND source_message_id = ?`,
    )
    .run(revision, contentHash, namespace, source, sessionId, messageId);
}

export function enqueueOutbox(
  state: CollectorState,
  input: {
    namespace: string;
    idempotency_key: string;
    project_id: string;
    source: EventSource;
    source_scope: string;
    source_session_id: string;
    source_message_id: string;
    sequence_no: number;
    revision: number;
    role: EventRole;
    occurred_at: string;
    text: string;
  },
): void {
  state.db
    .prepare(
      `INSERT INTO outbox (namespace, idempotency_key, project_id, source, source_scope, source_session_id, source_message_id, sequence_no, revision, role, occurred_at, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (namespace, idempotency_key) DO NOTHING`,
    )
    .run(
      input.namespace,
      input.idempotency_key,
      input.project_id,
      input.source,
      input.source_scope,
      input.source_session_id,
      input.source_message_id,
      input.sequence_no,
      input.revision,
      input.role,
      input.occurred_at,
      input.text,
      Date.now(),
    );
}

export function updateSessionNextSequence(
  state: CollectorState,
  namespace: string,
  source: EventSource,
  sessionId: string,
  nextSequence: number,
): void {
  state.db
    .prepare('UPDATE source_sessions SET next_sequence = ? WHERE namespace = ? AND source = ? AND source_session_id = ?')
    .run(nextSequence, namespace, source, sessionId);
}
