import { z } from 'zod';
import type { PoolClient } from 'pg';
import { WORKER_POLICY_VERSION } from './contract.js';
import { loadPriorSearchById, type JobTarget, type PriorSearch } from './context.js';

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

// 10.3のmatched結果からevidenceのmessage/revisionだけを取り出す。不明な形式は再利用しない。
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
async function evidenceReusable(pool: PoolClient, target: JobTarget, prior: PriorSearch): Promise<boolean> {
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

// chainの1受付が再利用条件（policy・原文revisionの存在とcurrent一致・status/期限・根拠）を満たすか。
// scopeと対象sequenceより前であることはloadPriorSearchById/loadPriorSearchのqueryで保証する。
async function chainRowEligible(pool: PoolClient, target: JobTarget, row: PriorSearch): Promise<boolean> {
  if (row.policyVersion !== WORKER_POLICY_VERSION) {
    return false;
  }
  if (row.inputText === null || row.inputCurrentRevision === null || row.inputCurrentRevision !== row.inputRevision) {
    return false;
  }
  return evidenceReusable(pool, target, row);
}

// 直近先行検索が再利用条件（scope/権限/revision/期限/根拠）を満たす時だけ、
// 呼出元の保存TXでchainの受付・元入力をロックし、直接のnew_search元へ解決する。
// 各受付が同じ適格性を満たさなければnew_searchへ戻す。
export async function resolveReuse(pool: PoolClient, target: JobTarget, prior: PriorSearch): Promise<ReuseDecision> {
  const ineligible: ReuseDecision = { eligible: false, originRequestId: null };
  // 外部評価中に先行入力が改訂・失効するため、評価した受付を同じIDで読み直す。
  // 別の受付へ切り替えず、Jevが比較した入力revisionが今も有効な場合だけ再利用する。
  const refreshed = await loadPriorSearchById(pool, target, prior.requestId);
  if (
    refreshed === undefined ||
    refreshed.inputId !== prior.inputId ||
    refreshed.inputRevision !== prior.inputRevision ||
    !(await chainRowEligible(pool, target, refreshed))
  ) {
    return ineligible;
  }
  const member = await pool.query(
    `SELECT 1
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
      WHERE pm.project_id = $1 AND pm.employee_id = $2 AND p.company_id = $3`,
    [target.projectId, target.employeeId, target.companyId],
  );
  if (member.rows.length === 0) {
    return ineligible;
  }
  const visited = new Set<string>();
  let current = refreshed;
  for (let depth = 0; depth <= MAX_REUSE_CHAIN; depth += 1) {
    if (visited.has(current.requestId) || depth === MAX_REUSE_CHAIN) {
      return ineligible;
    }
    visited.add(current.requestId);
    if (current.reusedFromRequestId === null) {
      return current.searchAction === 'new_search'
        ? { eligible: true, originRequestId: current.requestId }
        : ineligible;
    }
    const parent = await loadPriorSearchById(pool, target, current.reusedFromRequestId);
    if (parent === undefined || !(await chainRowEligible(pool, target, parent))) {
      return ineligible;
    }
    current = parent;
  }
  return ineligible;
}
