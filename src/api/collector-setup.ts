import type { Pool } from 'pg';
import type { AuthContext } from './events.js';
import { loadCompanyRedactionPolicy } from './redaction-policy.js';
import type { RedactionPolicy } from './redaction.js';

export interface CollectorSetup {
  project_id: string;
  repository: string;
  redaction_policy: RedactionPolicy;
}

// canonical repositoryから、tokenのemployeeがmemberである同一会社projectを1件だけ解決する。
// primary repository（projects.repository_identifier）と追加aliasの両方を受け、0件はnullにして存在を開示しない。
export async function resolveCollectorSetup(
  pool: Pool,
  auth: AuthContext,
  repository: string,
): Promise<CollectorSetup | null> {
  const result = await pool.query<{ id: string }>(
    `SELECT p.id
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.employee_id = $3
      WHERE p.company_id = $1
        AND (p.repository_identifier = $2
             OR EXISTS (SELECT 1
                          FROM project_repositories pr
                         WHERE pr.project_id = p.id
                           AND pr.company_id = $1
                           AND pr.repository_identifier = $2))
      LIMIT 1`,
    [auth.companyId, repository, auth.employeeId],
  );
  const project = result.rows[0];
  if (project === undefined) {
    return null;
  }
  return {
    project_id: project.id,
    repository,
    redaction_policy: await loadCompanyRedactionPolicy(pool, auth.companyId),
  };
}
