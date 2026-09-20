import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { AUTO_SEARCH_POLICY_VERSION, RECEIPT_PAYLOAD_KEYS, type EventResult, type EventsResponse } from './contract.js';
import { CLASSIFY_MESSAGE_PRIORITY, ROUTE_SEARCH_PRIORITY, enqueueJob } from '../jobs/queue.js';
import type { EventsRequest, ParsedEvent } from './schema.js';

// 同一社員のイベント受付を直列化するadvisory lock key1。key2は会社・社員から導出する。
const EVENT_WRITE_LOCK_NAMESPACE = 20260922;

export interface AuthContext {
  companyId: string;
  employeeId: string;
}

export class EventConflictError extends Error {
  constructor() {
    super('受信イベントが保存済みの内容・identityと衝突しました');
  }
}

// AuthorizationヘッダーのBearer tokenをSHA-256で照合し、tokenと会社が整合する社員だけを返す。
export async function authenticate(pool: Pool, authorization: string | undefined): Promise<AuthContext | null> {
  const token = parseBearerToken(authorization);
  if (!token) {
    return null;
  }
  const result = await pool.query<{ company_id: string; employee_id: string }>(
    `SELECT t.company_id, t.employee_id
       FROM auth_tokens t
       JOIN employees e ON e.id = t.employee_id AND e.company_id = t.company_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
    [sha256Utf8(token)],
  );
  const row = result.rows[0];
  return row ? { companyId: row.company_id, employeeId: row.employee_id } : null;
}

// 認証済み社員が、同じ会社に属するプロジェクトのメンバーであることを要求する。
export async function isProjectMember(pool: Pool, auth: AuthContext, projectId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
      WHERE p.id = $1 AND p.company_id = $2 AND pm.employee_id = $3`,
    [projectId, auth.companyId, auth.employeeId],
  );
  return result.rows.length > 0;
}

// バッチ全体を1トランザクションで保存する。途中の衝突・DB失敗では先行イベントごとrollbackする。
export async function ingestEvents(pool: Pool, auth: AuthContext, request: EventsRequest): Promise<EventsResponse> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // batchの並び順に依存しない短い社員単位ロック。外部API待ちの間は保持しない。
    await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [
      EVENT_WRITE_LOCK_NAMESPACE,
      `${auth.companyId}:${auth.employeeId}`,
    ]);
    const results: EventResult[] = [];
    for (const event of request.events) {
      results.push(await applyEvent(client, auth, request.project_id, event));
    }
    await client.query('COMMIT');
    return { results };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface StoredReceipt {
  request_hash: Buffer;
  message_id: string;
  revision: number;
  request_id: string | null;
}

interface StoredMessage {
  id: string;
  sequence_no: number;
  role: string;
  occurred_at: Date;
  current_revision: number;
}

// 1件のイベントを冪等キー→session→message/revision→検索受付→job→receiptの順で保存する。
async function applyEvent(client: PoolClient, auth: AuthContext, projectId: string, event: ParsedEvent): Promise<EventResult> {
  const requestHash = receiptHash({ companyId: auth.companyId, employeeId: auth.employeeId, projectId, event });
  const storedReceipt = await client.query<StoredReceipt>(
    `SELECT request_hash, message_id, revision, request_id
       FROM event_receipts
      WHERE company_id = $1 AND employee_id = $2 AND idempotency_key = $3`,
    [auth.companyId, auth.employeeId, event.idempotency_key],
  );
  const receipt = storedReceipt.rows[0];
  if (receipt) {
    if (!receipt.request_hash.equals(requestHash)) {
      throw new EventConflictError();
    }
    return {
      idempotency_key: event.idempotency_key,
      message_id: receipt.message_id,
      revision: receipt.revision,
      request_id: receipt.request_id,
    };
  }

  const sessionId = await resolveSession(client, auth, projectId, event);
  const occurredAt = new Date(event.occurred_at);
  const storedMessage = await findMessage(client, sessionId, event.source_message_id);
  let messageId: string;
  if (storedMessage) {
    assertMessageIdentity(storedMessage, event, occurredAt);
    messageId = storedMessage.id;
    await applyRevision(client, storedMessage, event);
  } else {
    if (event.revision !== 1) {
      throw new EventConflictError();
    }
    messageId = uuidv7();
    await client.query(
      `INSERT INTO messages (id, session_id, source_message_id, sequence_no, role, occurred_at, current_revision)
       VALUES ($1, $2, $3, $4, $5, $6, 1)`,
      [messageId, sessionId, event.source_message_id, event.sequence_no, event.role, occurredAt],
    );
    await insertRevision(client, messageId, event.revision, event.text);
  }

  const requestId = event.role === 'user' ? await resolveAutoSearchRequest(client, auth, projectId, sessionId, messageId, event) : null;

  await enqueueJob(client, {
    kind: 'classify_message',
    idempotencyKey: `classify_message:${messageId}:${event.revision}:${AUTO_SEARCH_POLICY_VERSION}`,
    priority: CLASSIFY_MESSAGE_PRIORITY,
    sessionId,
    messageId,
    targetRevision: event.revision,
  });
  if (event.role === 'user') {
    // 再送・過去revision再送では同じキーになり、route_search jobを重複させない。
    await enqueueJob(client, {
      kind: 'route_search',
      idempotencyKey: `route_search:${messageId}:${event.revision}:${AUTO_SEARCH_POLICY_VERSION}`,
      priority: ROUTE_SEARCH_PRIORITY,
      sessionId,
      messageId,
      targetRevision: event.revision,
    });
  }

  await client.query(
    `INSERT INTO event_receipts (id, company_id, employee_id, project_id, idempotency_key, request_hash, message_id, revision, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [uuidv7(), auth.companyId, auth.employeeId, projectId, event.idempotency_key, requestHash, messageId, event.revision, requestId],
  );

  return { idempotency_key: event.idempotency_key, message_id: messageId, revision: event.revision, request_id: requestId };
}

// source_scopeは会社・社員・クライアントscopeを前置きで名前空間化し、別社員の同名sessionを統合しない。
async function resolveSession(client: PoolClient, auth: AuthContext, projectId: string, event: ParsedEvent): Promise<string> {
  const sourceScope = `v1|${auth.companyId}|${auth.employeeId}|${event.source_scope}`;
  const existing = await client.query<{ id: string; project_id: string }>(
    'SELECT id, project_id FROM sessions WHERE source = $1 AND source_scope = $2 AND source_session_id = $3',
    [event.source, sourceScope, event.source_session_id],
  );
  const session = existing.rows[0];
  if (session) {
    if (session.project_id !== projectId) {
      throw new EventConflictError();
    }
    return session.id;
  }
  const id = uuidv7();
  await client.query(
    `INSERT INTO sessions (id, project_id, employee_id, source, source_scope, source_session_id, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, projectId, auth.employeeId, event.source, sourceScope, event.source_session_id, new Date(event.occurred_at)],
  );
  return id;
}

async function findMessage(client: PoolClient, sessionId: string, sourceMessageId: string): Promise<StoredMessage | undefined> {
  const result = await client.query<StoredMessage>(
    'SELECT id, sequence_no, role, occurred_at, current_revision FROM messages WHERE session_id = $1 AND source_message_id = $2',
    [sessionId, sourceMessageId],
  );
  return result.rows[0];
}

// session所属・sequence_no・role・occurred_atはmessageの同一性なので、再送でも変更させない。
function assertMessageIdentity(message: StoredMessage, event: ParsedEvent, occurredAt: Date): void {
  const sameInstant = message.occurred_at.getTime() === occurredAt.getTime();
  if (message.sequence_no !== event.sequence_no || message.role !== event.role || !sameInstant) {
    throw new EventConflictError();
  }
}

// 初版1からcurrent+1だけを新revisionとして保存し、過去revisionの再送ではcurrent_revisionを巻き戻さない。
async function applyRevision(client: PoolClient, message: StoredMessage, event: ParsedEvent): Promise<void> {
  if (event.revision > message.current_revision + 1) {
    throw new EventConflictError();
  }
  if (event.revision === message.current_revision + 1) {
    await insertRevision(client, message.id, event.revision, event.text);
    await client.query('UPDATE messages SET current_revision = $2, updated_at = now() WHERE id = $1', [message.id, event.revision]);
    return;
  }
  const existing = await client.query<{ text: string }>(
    'SELECT text FROM message_revisions WHERE message_id = $1 AND revision = $2',
    [message.id, event.revision],
  );
  const revision = existing.rows[0];
  if (!revision || revision.text !== event.text) {
    throw new EventConflictError();
  }
}

async function insertRevision(client: PoolClient, messageId: string, revision: number, text: string): Promise<void> {
  await client.query('INSERT INTO message_revisions (message_id, revision, text, content_hash) VALUES ($1, $2, $3, $4)', [
    messageId,
    revision,
    text,
    sha256Utf8(text),
  ]);
}

// user発言の自動検索受付をrevision単位で1件だけ作成し、再送では既存request_idを返す。
async function resolveAutoSearchRequest(
  client: PoolClient,
  auth: AuthContext,
  projectId: string,
  sessionId: string,
  messageId: string,
  event: ParsedEvent,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id
       FROM search_requests
      WHERE input_id = $1 AND input_revision = $2 AND policy_version = $3 AND trigger = 'auto'`,
    [messageId, event.revision, AUTO_SEARCH_POLICY_VERSION],
  );
  const request = existing.rows[0];
  if (request) {
    return request.id;
  }
  const id = uuidv7();
  await client.query(
    `INSERT INTO search_requests (id, company_id, project_id, employee_id, session_id, input_id, input_revision, input_sequence_no, trigger, policy_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'auto', $9)`,
    [id, auth.companyId, projectId, auth.employeeId, sessionId, messageId, event.revision, event.sequence_no, AUTO_SEARCH_POLICY_VERSION],
  );
  return id;
}

interface ReceiptHashInput {
  companyId: string;
  employeeId: string;
  projectId: string;
  event: ParsedEvent;
}

// receipt payloadはcontractで固定したキー順のJSONに直列化し、occurred_atは受信文字列をそのまま使う。
function receiptHash(input: ReceiptHashInput): Buffer {
  const values: Record<string, string | number> = {
    company_id: input.companyId,
    employee_id: input.employeeId,
    project_id: input.projectId,
    idempotency_key: input.event.idempotency_key,
    source: input.event.source,
    source_scope: input.event.source_scope,
    source_session_id: input.event.source_session_id,
    source_message_id: input.event.source_message_id,
    sequence_no: input.event.sequence_no,
    revision: input.event.revision,
    role: input.event.role,
    occurred_at: input.event.occurred_at,
    text: input.event.text,
  };
  const ordered = RECEIPT_PAYLOAD_KEYS.map((key) => [key, values[key]] as const);
  return sha256Utf8(JSON.stringify(Object.fromEntries(ordered)));
}

// "Bearer <token>"だけを受理する。空tokenや別schemeは未認証として扱う。
function parseBearerToken(authorization: string | undefined): string | null {
  const match = /^Bearer (.+)$/i.exec(authorization?.trim() ?? '');
  return match ? match[1] : null;
}

// 原文・tokenのhashはUTF-8バイト列をそのままSHA-256へ渡す。
function sha256Utf8(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
