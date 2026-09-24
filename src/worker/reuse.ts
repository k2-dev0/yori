import { z } from 'zod';
import type { Pool } from 'pg';
import { WORKER_POLICY_VERSION } from './contract.js';
import type { JobTarget, PriorSearch } from './context.js';

// 再利用元チェーンの上限。循環・過長chainは拒否してnew_searchへ進む。
const MAX_REUSE_CHAIN = 10;

const evidenceSchema = z.object({
  message_id: z.uuid(),
  revision: z.int().min(1),
});

const matchedResultSchema = z.object({
  matches: z
    .array(
      z.object({
        evidence: z.array(evidenceSchema),
      }),
    )
    .min(1),
});

export interface ReuseDecision {
  eligible: boolean;
  originRequestId: string | null;
}

// 10.3のmatched結果からevidenceのmessage/rerevisionだけを取り出す。不明な形式は再利用しない。
function parseEvidence(result: unknown): Array<{ messageId: string; revision: number }> | null {
  const parsed = matchedResultSchema.safeParse(result);
  if (!parsed.success) {
    return null;
  }
  const evidence = parsed.data.matches.flatMap((match) => match.evidence);
  if (evidence.length === 0) {
    return null;
  }
  return evidence.map((item) => ({ messageId: item.message_id, revision: item.revision }));
}

// evidenceの原文が現行revision・同案件で、progress_only化・revoke/changeで無効化されていないか確認する。
async function evidenceReusable(pool: Pool, target: JobTarget, prior: PriorSearch): Promise<boolean> {
  if (prior.status === 'pending' || prior.status === 'running') {
    return true;
  }
  if (prior.status !== 'completed' || prior.outcome !== 'matched' || prior.expiresAt === null || prior.expiresAt.getTime() <= Date.now()) {
    return false;
  }
  const evidence = parseEvidence(prior.result);
  if (evidence === null) {
    return false;
  }
  for (const item of evidence) {
    const message = await pool.query<{ current_revision: number; project_id: string; company_id: string }>(
      `SELECT m.current_revision, s.project_id, p.company_id
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         JOIN projects p ON p.id = s.project_id
        WHERE m.id = $1`,
      [item.messageId],
    );
    const row = message.rows[0];
    if (!row || row.project_id !== target.projectId || row.company_id !== target.companyId || row.current_revision !== item.revision) {
      return false;
    }
    const analysis = await pool.query<{ retention: string; is_searchable: boolean }>(
      `SELECT retention, is_searchable
         FROM message_analysis
        WHERE message_id = $1 AND revision = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [item.messageId, item.revision],
    );
    const latest = analysis.rows[0];
    if (latest && (latest.retention === 'progress_only' || !latest.is_searchable)) {
      return false;
    }
    const invalidated = await pool.query(
      `SELECT 1
         FROM message_relations
        WHERE target_message_id = $1 AND target_revision = $2 AND relation IN ('revoke', 'change')
        LIMIT 1`,
      [item.messageId, item.revision],
    );
    if (invalidated.rows.length > 0) {
      return false;
    }
  }
  return true;
}

interface ChainRow {
  id: string;
  search_action: string | null;
  reused_from_request_id: string | null;
}

// 直接のnew_search元だけを参照する。不適格な候補へ飛ばず、循環・過長chainは拒否する。
async function resolveOrigin(pool: Pool, target: JobTarget, prior: PriorSearch): Promise<string | null> {
  const visited = new Set<string>();
  let currentId = prior.requestId;
  let searchAction = prior.searchAction;
  let reusedFrom = prior.reusedFromRequestId;
  for (let depth = 0; depth <= MAX_REUSE_CHAIN; depth += 1) {
    if (visited.has(currentId) || depth === MAX_REUSE_CHAIN) {
      return null;
    }
    visited.add(currentId);
    if (reusedFrom === null) {
      return searchAction === null || searchAction === 'new_search' ? currentId : null;
    }
    const parent = await pool.query<ChainRow>(
      `SELECT id, search_action, reused_from_request_id
         FROM search_requests
        WHERE id = $1 AND company_id = $2 AND project_id = $3 AND employee_id = $4 AND session_id = $5 AND policy_version = $6`,
      [reusedFrom, target.companyId, target.projectId, target.employeeId, target.sessionId, WORKER_POLICY_VERSION],
    );
    const row = parent.rows[0];
    if (!row) {
      return null;
    }
    currentId = row.id;
    searchAction = row.search_action;
    reusedFrom = row.reused_from_request_id;
  }
  return null;
}

// 直近先行検索が再利用条件（scope/権限/revision/期限/根拠）を満たす時だけ、直接のnew_search元を返す。
export async function resolveReuse(pool: Pool, target: JobTarget, prior: PriorSearch | undefined): Promise<ReuseDecision> {
  if (!prior || prior.inputText === null || prior.inputCurrentRevision === null) {
    return { eligible: false, originRequestId: null };
  }
  if (prior.policyVersion !== WORKER_POLICY_VERSION || prior.inputCurrentRevision !== prior.inputRevision) {
    return { eligible: false, originRequestId: null };
  }
  const member = await pool.query(
    `SELECT 1
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
      WHERE pm.project_id = $1 AND pm.employee_id = $2 AND p.company_id = $3`,
    [target.projectId, target.employeeId, target.companyId],
  );
  if (member.rows.length === 0) {
    return { eligible: false, originRequestId: null };
  }
  if (!(await evidenceReusable(pool, target, prior))) {
    return { eligible: false, originRequestId: null };
  }
  const originRequestId = await resolveOrigin(pool, target, prior);
  return originRequestId === null ? { eligible: false, originRequestId: null } : { eligible: true, originRequestId };
}
