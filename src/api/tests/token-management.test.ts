import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { buildApp } from '../app.js';
import {
  employeeListResponseSchema,
  meResponseSchema,
  tokenIssueResponseSchema,
  tokenListResponseSchema,
  tokenRevokeResponseSchema,
} from '../response-schema.js';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import {
  countRows,
  insertCompany,
  insertEmployee,
  issueAuthToken,
  resetDatabase,
  seedWorkspace,
  sha256Bytes,
  type WorkspaceFixture,
} from '../../db/tests/fixtures.js';

const pool = createPool(requireDatabaseUrl());
const app = buildApp({ pool });
let workspace: WorkspaceFixture;

before(async () => {
  await runMigrations(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
  workspace = await seedWorkspace(pool);
});

after(async () => {
  await app.close();
  await pool.end();
});

function headers(token: string, json = false): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) };
}

function errorCode(response: { json<T>(): T }): string | undefined {
  return response.json<{ error?: { code?: string } }>().error?.code;
}

async function tokenIdOf(rawToken: string): Promise<string> {
  const result = await pool.query<{ id: string }>('SELECT id FROM auth_tokens WHERE token_hash = $1', [sha256Bytes(rawToken)]);
  return result.rows[0]!.id;
}

describe('本人・社員・token管理API', () => {
  it('/v1/meは本人と現在のBearer token metadataだけを返し、raw token/hashを返さない', async () => {
    await issueAuthToken(pool, workspace.companyId, workspace.employeeId, 'company_admin');
    const response = await app.inject({ method: 'GET', url: '/v1/me', headers: headers(workspace.token) });
    assert.equal(response.statusCode, 200, response.body);
    const body = meResponseSchema.parse(response.json());
    assert.equal(body.company_id, workspace.companyId);
    assert.equal(body.employee_id, workspace.employeeId);
    assert.equal(body.token.token_id, await tokenIdOf(workspace.token));
    assert.equal(body.token.scope, 'employee');
    assert.equal(body.token.revoked_at, null);
    assert.ok(!response.body.includes(workspace.token), 'raw tokenを返している');
    assert.ok(!response.body.includes(sha256Bytes(workspace.token).toString('hex')), 'token hashを返している');
  });

  it('employee tokenは社員/token一覧・発行・失効を403にし、DBを変更しない', async () => {
    const targetEmployeeId = await insertEmployee(pool, workspace.companyId, 'target');
    const tokenId = await tokenIdOf(workspace.token);
    const before = await countRows(pool, 'auth_tokens');
    const requests = [
      { method: 'GET', url: '/v1/employees' },
      { method: 'GET', url: '/v1/tokens' },
      { method: 'POST', url: `/v1/employees/${targetEmployeeId}/tokens`, payload: { scope: 'employee' } },
      { method: 'DELETE', url: `/v1/tokens/${tokenId}` },
    ];
    for (const request of requests) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: headers(workspace.token, request.payload !== undefined),
        ...(request.payload === undefined ? {} : { payload: request.payload }),
      });
      assert.equal(response.statusCode, 403, `${request.method} ${request.url}: ${response.body}`);
      assert.equal(errorCode(response), 'forbidden');
    }
    assert.equal(await countRows(pool, 'auth_tokens'), before);
    const current = await pool.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM auth_tokens WHERE id = $1', [tokenId]);
    assert.equal(current.rows[0]!.revoked_at, null);
  });

  it('admin tokenは同じcompanyだけを一覧し、通常/admin tokenを発行して冪等に失効する', async () => {
    const adminToken = await issueAuthToken(pool, workspace.companyId, workspace.employeeId, 'company_admin');
    const targetEmployeeId = await insertEmployee(pool, workspace.companyId, 'target');
    const otherCompanyId = await insertCompany(pool, 'other-company');
    const otherEmployeeId = await insertEmployee(pool, otherCompanyId, 'other');
    await issueAuthToken(pool, otherCompanyId, otherEmployeeId, 'company_admin');

    const employeesResponse = await app.inject({ method: 'GET', url: '/v1/employees', headers: headers(adminToken) });
    assert.equal(employeesResponse.statusCode, 200, employeesResponse.body);
    const employees = employeeListResponseSchema.parse(employeesResponse.json()).employees;
    assert.deepEqual(employees.map((employee) => employee.employee_id).sort(), [workspace.employeeId, targetEmployeeId].sort());
    assert.ok(!employees.some((employee) => employee.employee_id === otherEmployeeId));

    for (const scope of ['employee', 'company_admin'] as const) {
      const issuedResponse = await app.inject({
        method: 'POST',
        url: `/v1/employees/${targetEmployeeId}/tokens`,
        headers: headers(adminToken, true),
        payload: { scope },
      });
      assert.equal(issuedResponse.statusCode, 201, issuedResponse.body);
      const issued = tokenIssueResponseSchema.parse(issuedResponse.json());
      assert.equal(issued.status, 'done');
      assert.equal(issued.employee_id, targetEmployeeId);
      assert.equal(issued.scope, scope);
      assert.match(issued.token, /^yori_[A-Za-z0-9_-]+$/);

      const tokensResponse = await app.inject({ method: 'GET', url: '/v1/tokens', headers: headers(adminToken) });
      assert.equal(tokensResponse.statusCode, 200, tokensResponse.body);
      const tokens = tokenListResponseSchema.parse(tokensResponse.json()).tokens;
      assert.ok(tokens.some((token) => token.token_id === issued.token_id && token.employee_id === targetEmployeeId && token.scope === scope));
      assert.ok(!tokens.some((token) => token.employee_id === otherEmployeeId));
      assert.ok(!tokensResponse.body.includes(issued.token), '一覧へraw tokenを返している');
      assert.ok(!tokensResponse.body.includes('token_hash'), '一覧へtoken_hash fieldを返している');

      if (scope === 'employee') {
        const first = await app.inject({ method: 'DELETE', url: `/v1/tokens/${issued.token_id}`, headers: headers(adminToken) });
        assert.equal(first.statusCode, 200, first.body);
        assert.deepEqual(tokenRevokeResponseSchema.parse(first.json()), { status: 'done', token_id: issued.token_id });
        const second = await app.inject({ method: 'DELETE', url: `/v1/tokens/${issued.token_id}`, headers: headers(adminToken) });
        assert.equal(second.statusCode, 200, second.body);
        assert.deepEqual(tokenRevokeResponseSchema.parse(second.json()), { status: 'already', token_id: issued.token_id });
        const revoked = await app.inject({ method: 'GET', url: '/v1/me', headers: headers(issued.token) });
        assert.equal(revoked.statusCode, 401);
        assert.equal(errorCode(revoked), 'unauthorized');
      }
    }
  });

  it('別companyまたは不存在のemployee/tokenはadminにも404として存在を開示しない', async () => {
    const adminToken = await issueAuthToken(pool, workspace.companyId, workspace.employeeId, 'company_admin');
    const otherCompanyId = await insertCompany(pool, 'other-company');
    const otherEmployeeId = await insertEmployee(pool, otherCompanyId, 'other');
    const otherToken = await issueAuthToken(pool, otherCompanyId, otherEmployeeId, 'employee');
    const otherTokenId = await tokenIdOf(otherToken);

    const issue = await app.inject({
      method: 'POST',
      url: `/v1/employees/${otherEmployeeId}/tokens`,
      headers: headers(adminToken, true),
      payload: { scope: 'employee' },
    });
    assert.equal(issue.statusCode, 404, issue.body);
    assert.equal(errorCode(issue), 'not_found');

    const revoke = await app.inject({ method: 'DELETE', url: `/v1/tokens/${otherTokenId}`, headers: headers(adminToken) });
    assert.equal(revoke.statusCode, 404, revoke.body);
    assert.equal(errorCode(revoke), 'not_found');
    assert.ok(!issue.body.includes(otherCompanyId));
    assert.ok(!revoke.body.includes(otherCompanyId));
  });

  it('最後の有効company_admin tokenは409 conflictで失効を拒否する', async () => {
    const adminToken = await issueAuthToken(pool, workspace.companyId, workspace.employeeId, 'company_admin');
    const adminTokenId = await tokenIdOf(adminToken);
    const response = await app.inject({ method: 'DELETE', url: `/v1/tokens/${adminTokenId}`, headers: headers(adminToken) });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(errorCode(response), 'conflict');
    const stored = await pool.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM auth_tokens WHERE id = $1', [adminTokenId]);
    assert.equal(stored.rows[0]!.revoked_at, null);
  });
});
