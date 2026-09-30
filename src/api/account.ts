import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { TokenScope } from './contract.js';
import type { AuthContext } from './events.js';
import type {
  CompanyResponse,
  EmployeeCreateResponse,
  MeResponse,
  TokenIssueResponse,
  TokenRevokeResponse,
} from './response-schema.js';

export class AccountTargetNotFoundError extends Error {}
export class LastCompanyAdminError extends Error {}

interface CompanyRow {
  id: string;
  name: string;
}

interface EmployeeRow {
  id: string;
  display_name: string;
  created_at: Date;
}

interface ProjectRow {
  id: string;
  repository_identifier: string;
  created_at: Date;
}

interface TokenRow {
  id: string;
  employee_id: string;
  scope: TokenScope;
  created_at: Date;
  revoked_at: Date | null;
}

function companyView(row: CompanyRow): CompanyResponse['company'] {
  return { company_id: row.id, name: row.name };
}

function employeeView(row: EmployeeRow): CompanyResponse['employees'][number] {
  return { employee_id: row.id, display_name: row.display_name, created_at: row.created_at.toISOString() };
}

function projectView(row: ProjectRow): CompanyResponse['projects'][number] {
  return { project_id: row.id, repository: row.repository_identifier, created_at: row.created_at.toISOString() };
}

function tokenView(row: TokenRow): CompanyResponse['tokens'][number] {
  return {
    token_id: row.id,
    employee_id: row.employee_id,
    scope: row.scope,
    created_at: row.created_at.toISOString(),
    revoked_at: row.revoked_at?.toISOString() ?? null,
  };
}

export async function loadMe(pool: Pool, auth: AuthContext): Promise<MeResponse> {
  const [companyResult, employeeResult, projectsResult] = await Promise.all([
    pool.query<CompanyRow>('SELECT id, name FROM companies WHERE id = $1', [auth.companyId]),
    pool.query<EmployeeRow>('SELECT id, display_name, created_at FROM employees WHERE id = $1 AND company_id = $2', [
      auth.employeeId,
      auth.companyId,
    ]),
    pool.query<ProjectRow>(
      'SELECT id, repository_identifier, created_at FROM projects WHERE company_id = $1 ORDER BY created_at, id',
      [auth.companyId],
    ),
  ]);
  const company = companyResult.rows[0];
  const employee = employeeResult.rows[0];
  if (company === undefined || employee === undefined) {
    throw new AccountTargetNotFoundError();
  }
  return {
    company: companyView(company),
    employee: employeeView(employee),
    token: {
      token_id: auth.tokenId,
      scope: auth.tokenScope,
      created_at: auth.tokenCreatedAt,
      revoked_at: auth.tokenRevokedAt,
    },
    projects: projectsResult.rows.map(projectView),
  };
}

export async function loadCompany(pool: Pool, auth: AuthContext): Promise<CompanyResponse> {
  const [companyResult, employeesResult, projectsResult, tokensResult] = await Promise.all([
    pool.query<CompanyRow>('SELECT id, name FROM companies WHERE id = $1', [auth.companyId]),
    pool.query<EmployeeRow>('SELECT id, display_name, created_at FROM employees WHERE company_id = $1 ORDER BY created_at, id', [
      auth.companyId,
    ]),
    pool.query<ProjectRow>(
      'SELECT id, repository_identifier, created_at FROM projects WHERE company_id = $1 ORDER BY created_at, id',
      [auth.companyId],
    ),
    // token_hashは取得しない。管理一覧はmetadataだけを返す。
    pool.query<TokenRow>(
      'SELECT id, employee_id, scope, created_at, revoked_at FROM auth_tokens WHERE company_id = $1 ORDER BY created_at, id',
      [auth.companyId],
    ),
  ]);
  const company = companyResult.rows[0];
  if (company === undefined) {
    throw new AccountTargetNotFoundError();
  }
  return {
    company: companyView(company),
    employees: employeesResult.rows.map(employeeView),
    projects: projectsResult.rows.map(projectView),
    tokens: tokensResult.rows.map(tokenView),
  };
}

export async function createCompanyEmployee(
  pool: Pool,
  auth: AuthContext,
  displayName: string,
): Promise<EmployeeCreateResponse> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const employeeId = uuidv7();
    const inserted = await client.query<{ created_at: Date }>(
      `INSERT INTO employees (id, company_id, display_name)
       VALUES ($1, $2, $3)
       RETURNING created_at`,
      [employeeId, auth.companyId, displayName],
    );
    await client.query('COMMIT');
    return {
      status: 'done',
      employee_id: employeeId,
      display_name: displayName,
      created_at: inserted.rows[0]!.created_at.toISOString(),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function issueCompanyToken(
  pool: Pool,
  auth: AuthContext,
  employeeId: string,
  scope: TokenScope,
): Promise<TokenIssueResponse> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const employee = await client.query('SELECT 1 FROM employees WHERE id = $1 AND company_id = $2 FOR SHARE', [
      employeeId,
      auth.companyId,
    ]);
    if (employee.rows.length === 0) {
      throw new AccountTargetNotFoundError();
    }
    const tokenId = uuidv7();
    const token = `yori_${randomBytes(24).toString('base64url')}`;
    const tokenHash = createHash('sha256').update(token, 'utf8').digest();
    await client.query(
      'INSERT INTO auth_tokens (id, company_id, employee_id, token_hash, scope) VALUES ($1, $2, $3, $4, $5)',
      [tokenId, auth.companyId, employeeId, tokenHash, scope],
    );
    await client.query('COMMIT');
    return { status: 'done', token_id: tokenId, employee_id: employeeId, scope, token };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeCompanyToken(pool: Pool, auth: AuthContext, tokenId: string): Promise<TokenRevokeResponse> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const targetResult = await client.query<TokenRow>(
      'SELECT id, employee_id, scope, created_at, revoked_at FROM auth_tokens WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [tokenId, auth.companyId],
    );
    const target = targetResult.rows[0];
    if (target === undefined) {
      throw new AccountTargetNotFoundError();
    }
    if (target.revoked_at !== null) {
      await client.query('COMMIT');
      return { status: 'already', token_id: tokenId };
    }
    if (target.scope === 'company_admin') {
      const activeAdmins = await client.query<{ id: string }>(
        `SELECT id FROM auth_tokens
          WHERE company_id = $1 AND scope = 'company_admin' AND revoked_at IS NULL
          ORDER BY id FOR UPDATE`,
        [auth.companyId],
      );
      if (activeAdmins.rows.length <= 1) {
        throw new LastCompanyAdminError();
      }
    }
    await client.query('UPDATE auth_tokens SET revoked_at = now() WHERE id = $1', [tokenId]);
    await client.query('COMMIT');
    return { status: 'done', token_id: tokenId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
