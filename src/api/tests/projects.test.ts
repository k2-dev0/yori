import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { buildApp } from '../app.js';
import { projectRegistrationResponseSchema } from '../response-schema.js';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import {
  countRows,
  insertCompany,
  insertProject,
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
