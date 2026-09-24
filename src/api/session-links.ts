import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { AuthContext } from './events.js';
import type { ParsedSessionLinkRequest } from './schema.js';

// M7の明示session引き継ぎ登録。外部identityは値parameterで内部IDへ解決し、
// 不存在・別会社・別案件・他社員の存在を404へ統一して開示しない。

export class SessionLinkNotFoundError extends Error {}
export class SessionLinkConflictError extends Error {}
export class SessionLinkInvalidError extends Error {}

export interface SessionLinkResponse {
  link_id: string;
  project_id: string;
  from_session_id: string;
  to_session_id: string;
  evidence_message_id: string;
  evidence_revision: number;
  status: string;
}

export interface CreatedSessionLink {
  statusCode: 200 | 201;
  response: SessionLinkResponse;
}

interface SessionIdentity {
  source: string;
  source_scope: string;
  source_session_id: string;
}

interface SessionRow {
  id: string;
  employee_id: string;
  project_id: string;
  company_id: string;
}

interface ExistingLinkRow {
  id: string;
  project_id: string;
  from_session_id: string;
  to_session_id: string;
  evidence_message_id: string;
  evidence_revision: number;
  status: string;
  condition_hash: Buffer;
}

const SESSION_LINK_LOCK_NAMESPACE = 20260928;

// 資格情報や原文本文はhash対象へ入れず、同じリンクを指す識別子とrevisionだけを固定順でhashする。
function conditionHash(request: ParsedSessionLinkRequest): Buffer {
  const canonical = {
    project_id: request.project_id,
    from: {
      source: request.from.source,
      source_scope: request.from.source_scope,
      source_session_id: request.from.source_session_id,
    },
    to: {
      source: request.to.source,
      source_scope: request.to.source_scope,
      source_session_id: request.to.source_session_id,
    },
    evidence: {
      source: request.evidence.source,
      source_scope: request.evidence.source_scope,
      source_session_id: request.evidence.source_session_id,
      source_message_id: request.evidence.source_message_id,
      revision: request.evidence.revision,
    },
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest();
}

function toResponse(row: {
  id: string;
  project_id: string;
  from_session_id: string;
  to_session_id: string;
  evidence_message_id: string;
  evidence_revision: number;
  status: string;
}): SessionLinkResponse {
  return {
    link_id: row.id,
    project_id: row.project_id,
    from_session_id: row.from_session_id,
    to_session_id: row.to_session_id,
    evidence_message_id: row.evidence_message_id,
    evidence_revision: row.evidence_revision,
    status: row.status,
  };
}

// 認証社員がmemberの案件に属するsessionだけを、取り込み元identityの完全一致で解決する。
async function resolveSession(
  client: PoolClient,
  auth: AuthContext,
  projectId: string,
  identity: SessionIdentity,
): Promise<SessionRow | null> {
  const result = await client.query<SessionRow>(
    `SELECT s.id, s.employee_id, s.project_id, p.company_id
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
      WHERE p.company_id = $1
        AND s.project_id = $2
        AND s.source = $3
        AND s.source_scope = $4
        AND s.source_session_id = $5`,
    [auth.companyId, projectId, identity.source, identity.source_scope, identity.source_session_id],
  );
  return result.rows[0] ?? null;
}

// 根拠発言はendpoint session配下のsource_message_id一致・current revision一致だけを受理する。
async function resolveEvidence(
  client: PoolClient,
  sessionId: string,
  sourceMessageId: string,
  revision: number,
): Promise<{ messageId: string; revision: number } | null> {
  // revision確認からINSERT commitまでmessage行を共有lockし、並行するrevision更新と
  // 「確認したrevision」をずらさない。更新が先にcommitしていれば新しいrevisionを見て400にする。
  const result = await client.query<{ id: string; current_revision: number }>(
    `SELECT m.id, m.current_revision
       FROM messages m
      WHERE m.session_id = $1 AND m.source_message_id = $2
      FOR SHARE OF m`,
    [sessionId, sourceMessageId],
  );
  const row = result.rows[0];
  if (row === undefined || row.current_revision !== revision) {
    return null;
  }
  return { messageId: row.id, revision: row.current_revision };
}

// 同一社員の冪等キーを直列化し、同内容再送は既存行を返し、内容違いはconflictにする。
export async function createSessionLink(
  pool: Pool,
  auth: AuthContext,
  request: ParsedSessionLinkRequest,
): Promise<CreatedSessionLink> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [
      SESSION_LINK_LOCK_NAMESPACE,
      `${auth.companyId}:${auth.employeeId}`,
    ]);
    const from = await resolveSession(client, auth, request.project_id, request.from);
    if (from === null) {
      throw new SessionLinkNotFoundError();
    }
    const to = await resolveSession(client, auth, request.project_id, request.to);
    // 引き継ぎ先は認証社員本人のsessionだけを許可し、他社員の存在を開示しない。
    if (to === null || to.employee_id !== auth.employeeId) {
      throw new SessionLinkNotFoundError();
    }
    if (from.id === to.id) {
      throw new SessionLinkInvalidError();
    }
    const evidenceSession = await resolveSession(client, auth, request.project_id, request.evidence);
    if (evidenceSession === null || (evidenceSession.id !== from.id && evidenceSession.id !== to.id)) {
      throw new SessionLinkInvalidError();
    }
    const evidence = await resolveEvidence(client, evidenceSession.id, request.evidence.source_message_id, request.evidence.revision);
    if (evidence === null) {
      throw new SessionLinkInvalidError();
    }
    const hash = conditionHash(request);
    const existing = await client.query<ExistingLinkRow>(
      `SELECT id, project_id, from_session_id, to_session_id, evidence_message_id, evidence_revision, status, condition_hash
         FROM session_links
        WHERE company_id = $1 AND created_by_employee_id = $2 AND idempotency_key = $3`,
      [auth.companyId, auth.employeeId, request.idempotency_key],
    );
    const current = existing.rows[0];
    if (current !== undefined) {
      if (!current.condition_hash.equals(hash)) {
        throw new SessionLinkConflictError();
      }
      await client.query('COMMIT');
      return { statusCode: 200, response: toResponse(current) };
    }
    const id = uuidv7();
    await client.query(
      `INSERT INTO session_links
         (id, company_id, project_id, from_session_id, to_session_id, evidence_message_id, evidence_revision,
          is_explicit, status, created_by_employee_id, idempotency_key, condition_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'active', $8, $9, $10)`,
      [
        id,
        auth.companyId,
        request.project_id,
        from.id,
        to.id,
        evidence.messageId,
        evidence.revision,
        auth.employeeId,
        request.idempotency_key,
        hash,
      ],
    );
    await client.query('COMMIT');
    return {
      statusCode: 201,
      response: {
        link_id: id,
        project_id: request.project_id,
        from_session_id: from.id,
        to_session_id: to.id,
        evidence_message_id: evidence.messageId,
        evidence_revision: evidence.revision,
        status: 'active',
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
