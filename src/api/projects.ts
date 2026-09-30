import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { AuthContext } from './events.js';
import type { ProjectRegistrationResponse } from './response-schema.js';

export class ProjectRepositoryConflictError extends Error {}

export async function registerProject(
  pool: Pool,
  auth: AuthContext,
  repository: string,
): Promise<{ statusCode: 200 | 201; response: ProjectRegistrationResponse }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // primary/aliasの別tableをまたぐ確認をrepository単位で直列化する。
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [repository]);
    const existing = await client.query<{ project_id: string; company_id: string }>(
      `SELECT p.id AS project_id, p.company_id
         FROM projects p
        WHERE p.repository_identifier = $1
       UNION
       SELECT p.id AS project_id, p.company_id
         FROM project_repositories pr
         JOIN projects p ON p.id = pr.project_id AND p.company_id = pr.company_id
        WHERE pr.repository_identifier = $1`,
      [repository],
    );
    if (existing.rows.some((row) => row.company_id !== auth.companyId)) {
      throw new ProjectRepositoryConflictError();
    }
    const own = existing.rows[0];
    if (own !== undefined) {
      await client.query('COMMIT');
      return {
        statusCode: 200,
        response: { status: 'already', project_id: own.project_id, repository },
      };
    }

    const projectId = uuidv7();
    await client.query(
      'INSERT INTO projects (id, company_id, repository_identifier) VALUES ($1, $2, $3)',
      [projectId, auth.companyId, repository],
    );
    await client.query('COMMIT');
    return {
      statusCode: 201,
      response: { status: 'done', project_id: projectId, repository },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
