import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';

// テストごとに業務データを消す。migrationが作る業務テーブルのみを対象にする。
const DATA_TABLES = [
  'event_receipts',
  'search_requests',
  'jobs',
  'message_revisions',
  'messages',
  'sessions',
  'auth_tokens',
  'project_members',
  'projects',
  'employees',
  'companies',
] as const;

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE ${DATA_TABLES.join(', ')} CASCADE`);
}

// 原文のcontent_hash・receiptのrequest_hash計算に使う。UTF-8バイト列をそのままハッシュする。
export function sha256Bytes(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function sha256Hex(value: string): string {
  return sha256Bytes(value).toString('hex');
}

export async function insertCompany(pool: Pool, name = 'company-a'): Promise<string> {
  const id = uuidv7();
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [id, name]);
  return id;
}

export async function insertEmployee(pool: Pool, companyId: string, displayName = 'employee-a'): Promise<string> {
  const id = uuidv7();
  await pool.query('INSERT INTO employees (id, company_id, display_name) VALUES ($1, $2, $3)', [id, companyId, displayName]);
  return id;
}

export async function insertProject(pool: Pool, companyId: string, repositoryIdentifier = 'repo-a'): Promise<string> {
  const id = uuidv7();
  await pool.query('INSERT INTO projects (id, company_id, repository_identifier) VALUES ($1, $2, $3)', [
    id,
    companyId,
    repositoryIdentifier,
  ]);
  return id;
}

export async function addProjectMember(pool: Pool, projectId: string, employeeId: string): Promise<void> {
  await pool.query('INSERT INTO project_members (project_id, employee_id) VALUES ($1, $2)', [projectId, employeeId]);
}

// 生tokenは呼出元だけが保持する。DBにはSHA-256のみを保存する。
export async function issueAuthToken(pool: Pool, companyId: string, employeeId: string): Promise<string> {
  const token = `yori_${randomBytes(24).toString('base64url')}`;
  await pool.query('INSERT INTO auth_tokens (id, company_id, employee_id, token_hash) VALUES ($1, $2, $3, $4)', [
    uuidv7(),
    companyId,
    employeeId,
    sha256Bytes(token),
  ]);
  return token;
}

export interface WorkspaceFixture {
  companyId: string;
  employeeId: string;
  projectId: string;
  token: string;
}

// 1社員が1案件へ参加済みで、その社員のtokenを返す最小構成。
export async function seedWorkspace(pool: Pool, options: { name?: string; repositoryIdentifier?: string } = {}): Promise<WorkspaceFixture> {
  const companyId = await insertCompany(pool, options.name ?? 'company-a');
  const employeeId = await insertEmployee(pool, companyId);
  const projectId = await insertProject(pool, companyId, options.repositoryIdentifier ?? 'repo-a');
  await addProjectMember(pool, projectId, employeeId);
  const token = await issueAuthToken(pool, companyId, employeeId);
  return { companyId, employeeId, projectId, token };
}

export type DataTable = (typeof DATA_TABLES)[number];

export async function countRows(pool: Pool, table: DataTable): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(result.rows[0].count);
}

export async function revokeAuthToken(pool: Pool, token: string): Promise<void> {
  await pool.query('UPDATE auth_tokens SET revoked_at = now() WHERE token_hash = $1', [sha256Bytes(token)]);
}

export interface SessionRowInput {
  projectId: string;
  employeeId: string;
  source?: 'codex' | 'claude_code';
  sourceScope?: string;
  sourceSessionId?: string;
  startedAt?: Date;
}

export async function insertSession(pool: Pool, input: SessionRowInput): Promise<string> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO sessions (id, project_id, employee_id, source, source_scope, source_session_id, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      input.projectId,
      input.employeeId,
      input.source ?? 'codex',
      input.sourceScope ?? 'scope-a',
      input.sourceSessionId ?? `session-${id}`,
      input.startedAt ?? new Date(),
    ],
  );
  return id;
}

export interface MessageRowInput {
  sessionId: string;
  sourceMessageId: string;
  sequenceNo: number;
  role?: 'user' | 'assistant' | 'agent_report';
  occurredAt?: Date;
  text?: string;
}

// messagesとrevision 1を1トランザクションで入れる。jobやsearch_requestのFK先として使う。
export async function insertMessage(pool: Pool, input: MessageRowInput): Promise<{ messageId: string; revision: number }> {
  const messageId = uuidv7();
  const text = input.text ?? '保存済みの発言';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO messages (id, session_id, source_message_id, sequence_no, role, occurred_at, current_revision)
       VALUES ($1, $2, $3, $4, $5, $6, 1)`,
      [messageId, input.sessionId, input.sourceMessageId, input.sequenceNo, input.role ?? 'user', input.occurredAt ?? new Date()],
    );
    await client.query(
      `INSERT INTO message_revisions (message_id, revision, text, content_hash) VALUES ($1, 1, $2, $3)`,
      [messageId, text, sha256Bytes(text)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { messageId, revision: 1 };
}
