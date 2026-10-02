import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { buildApp } from '../app.js';
import { projectRegistrationResponseSchema, projectRemovalResponseSchema } from '../response-schema.js';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import {
  countRows,
  insertCompany,
  insertEmployee,
  insertMessage,
  insertProject,
  insertSession,
  issueAuthToken,
  resetDatabase,
  seedWorkspace,
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

function authorization(token: string, json = true): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) };
}

function errorCode(response: { json<T>(): T }): string | undefined {
  return response.json<{ error?: { code?: string } }>().error?.code;
}

describe('project登録API', () => {
  it('通常tokenで新規登録し、同じrepositoryの再実行は同じprojectをalreadyで返して行を増やさない', async () => {
    const repository = 'github.com/Org/New-Repo';
    const first = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authorization(workspace.token),
      payload: { repository },
    });
    assert.equal(first.statusCode, 201, first.body);
    const created = projectRegistrationResponseSchema.parse(first.json());
    assert.deepEqual(created, { status: 'done', project_id: created.project_id, repository });
    assert.equal(await countRows(pool, 'projects'), 2);
    assert.equal(await countRows(pool, 'project_members'), 1, 'project登録時にmemberを自動追加している');

    const second = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authorization(workspace.token),
      payload: { repository },
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(projectRegistrationResponseSchema.parse(second.json()), {
      status: 'already',
      project_id: created.project_id,
      repository,
    });
    assert.equal(await countRows(pool, 'projects'), 2);
    assert.equal(await countRows(pool, 'project_members'), 1);

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authorization(workspace.token),
      payload: { repository, company_id: workspace.companyId },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(errorCode(invalid), 'invalid_request');
  });

  it('別companyのprimaryまたはaliasとrepositoryが衝突したら情報非開示のrepository_conflictを返す', async () => {
    const otherCompanyId = await insertCompany(pool, 'other-company');
    const primaryProjectId = await insertProject(pool, otherCompanyId, 'github.com/Other/Primary');
    await pool.query(
      'INSERT INTO project_repositories (project_id, company_id, repository_identifier) VALUES ($1, $2, $3)',
      [primaryProjectId, otherCompanyId, 'github.com/Other/Alias'],
    );
    const before = await countRows(pool, 'projects');

    for (const repository of ['github.com/Other/Primary', 'github.com/Other/Alias']) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: authorization(workspace.token),
        payload: { repository },
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(errorCode(response), 'repository_conflict');
      assert.deepEqual(Object.keys(response.json()), ['error']);
      assert.ok(!response.body.includes(otherCompanyId), '衝突先companyを開示している');
      assert.ok(!response.body.includes(primaryProjectId), '衝突先projectを開示している');
    }
    assert.equal(await countRows(pool, 'projects'), before);
  });
});

describe('project削除API', () => {
  it('company admin tokenで案件を収集済みデータごと削除し、他の案件のデータは残す', async () => {
    const adminToken = await issueAuthToken(pool, workspace.companyId, workspace.employeeId, 'company_admin');
    const keptProjectId = await insertProject(pool, workspace.companyId, 'github.com/org/kept');
    const removedSessionId = await insertSession(pool, { projectId: workspace.projectId, employeeId: workspace.employeeId });
    await insertMessage(pool, { sessionId: removedSessionId, sourceMessageId: 'removed-1', sequenceNo: 1 });
    const keptSessionId = await insertSession(pool, { projectId: keptProjectId, employeeId: workspace.employeeId });
    await insertMessage(pool, { sessionId: keptSessionId, sourceMessageId: 'kept-1', sequenceNo: 1 });

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${workspace.projectId}`,
      headers: authorization(adminToken, false),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(projectRemovalResponseSchema.parse(response.json()), { status: 'done', project_id: workspace.projectId });

    const projects = await pool.query<{ id: string }>('SELECT id FROM projects');
    assert.deepEqual(projects.rows, [{ id: keptProjectId }]);
    const sessions = await pool.query<{ id: string }>('SELECT id FROM sessions');
    assert.deepEqual(sessions.rows, [{ id: keptSessionId }]);
    assert.equal(await countRows(pool, 'messages'), 1);
    assert.equal(await countRows(pool, 'message_revisions'), 1);
    assert.equal(await countRows(pool, 'project_members'), 0);
    assert.equal(await countRows(pool, 'employees'), 1);

    const again = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${workspace.projectId}`,
      headers: authorization(adminToken, false),
    });
    assert.equal(again.statusCode, 404, again.body);
    assert.equal(errorCode(again), 'not_found');
  });

  it('社員tokenは403、token無しは401で拒否し、案件を消さない', async () => {
    const url = `/v1/projects/${workspace.projectId}`;
    const employee = await app.inject({ method: 'DELETE', url, headers: authorization(workspace.token, false) });
    assert.equal(employee.statusCode, 403, employee.body);
    assert.equal(errorCode(employee), 'forbidden');

    const anonymous = await app.inject({ method: 'DELETE', url });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    assert.equal(errorCode(anonymous), 'unauthorized');
    assert.equal(await countRows(pool, 'projects'), 1);
  });

  it('別companyのcompany admin tokenには存在を開示せず404を返し、案件を消さない', async () => {
    const otherCompanyId = await insertCompany(pool, 'company-b');
    const otherEmployeeId = await insertEmployee(pool, otherCompanyId, 'employee-b');
    const otherAdminToken = await issueAuthToken(pool, otherCompanyId, otherEmployeeId, 'company_admin');

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${workspace.projectId}`,
      headers: authorization(otherAdminToken, false),
    });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(errorCode(response), 'not_found');
    assert.equal(await countRows(pool, 'projects'), 1);
  });

  it('UUIDでないproject_idとbody付きの要求を400で拒否する', async () => {
    const adminToken = await issueAuthToken(pool, workspace.companyId, workspace.employeeId, 'company_admin');
    const malformed = await app.inject({ method: 'DELETE', url: '/v1/projects/not-a-uuid', headers: authorization(adminToken, false) });
    assert.equal(malformed.statusCode, 400, malformed.body);

    const withBody = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${workspace.projectId}`,
      headers: authorization(adminToken),
      payload: { repository: 'repo-a' },
    });
    assert.equal(withBody.statusCode, 400, withBody.body);
    assert.equal(await countRows(pool, 'projects'), 1);
  });
});
