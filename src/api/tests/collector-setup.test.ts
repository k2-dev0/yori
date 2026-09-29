import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import {
  insertCompany,
  insertEmployee,
  insertProject,
  issueAuthToken,
  resetDatabase,
  seedWorkspace,
  type WorkspaceFixture,
} from '../../db/tests/fixtures.js';

// 認証済みcollector setup API。canonical repositoryから、tokenのemployeeがmemberである同一会社projectを解決し、
// current redaction policyを返す。0件・別会社・非memberは存在を開示せず404、unknown field/不正repositoryは400。

const pool = createPool(requireDatabaseUrl());
const app = buildApp({ pool });
let workspace: WorkspaceFixture;

const PRIMARY_REPOSITORY = 'github.com/Org/Repo';

before(async () => {
  await runMigrations(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
  workspace = await seedWorkspace(pool, { repositoryIdentifier: PRIMARY_REPOSITORY });
});

after(async () => {
  await app.close();
  await pool.end();
});

async function postSetup(app: FastifyInstance, options: { token?: string | null; body: unknown }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? ''}`;
  }
  return app.inject({ method: 'POST', url: '/v1/collector/setup', headers, payload: JSON.stringify(options.body) });
}

function errorCode(response: { json<T>(): T }): string | undefined {
  return response.json<{ error?: { code?: string } }>().error?.code;
}

interface StructuredRule {
  type: 'literal' | 'assignment_key';
  value: string;
}

async function savePolicy(companyId: string, version: number, rules: StructuredRule[]): Promise<void> {
  await pool.query('INSERT INTO company_redaction_policies (company_id, version) VALUES ($1, $2)', [companyId, version]);
  for (const rule of rules) {
    await pool.query(
      'INSERT INTO company_redaction_rules (company_id, rule_type, value, normalized_value) VALUES ($1, $2, $3, $4)',
      [companyId, rule.type, rule.value, rule.type === 'literal' ? rule.value : rule.value.toLowerCase()],
    );
  }
}

async function addAlias(projectId: string, companyId: string, repository: string): Promise<void> {
  await pool.query('INSERT INTO project_repositories (project_id, company_id, repository_identifier) VALUES ($1, $2, $3)', [
    projectId,
    companyId,
    repository,
  ]);
}

describe('POST /v1/collector/setup', () => {
  it('memberのprimary repositoryからprojectを解決し、未登録会社のpolicyをversion 0・rules空で返す', async () => {
    const response = await postSetup(app, { token: workspace.token, body: { repository: PRIMARY_REPOSITORY } });

    assert.equal(response.statusCode, 200, `setupに失敗: ${response.statusCode} ${response.body}`);
    const body = response.json<{ project_id: string; repository: string; redaction_policy: { version: number; rules: string[] } }>();
    assert.equal(body.project_id, workspace.projectId);
    assert.equal(body.repository, PRIMARY_REPOSITORY);
    assert.deepEqual(body.redaction_policy, { version: 0, rules: [] });
    assert.ok(!response.body.includes(workspace.token), 'setup応答へtokenが露出している');
  });

  it('追加repository aliasを解決し、current policyのversionとstructured rulesを返す', async () => {
    await addAlias(workspace.projectId, workspace.companyId, 'github.com/Org/Alias');
    await savePolicy(workspace.companyId, 3, [
      { type: 'literal', value: 'AcmeSecret' },
      { type: 'assignment_key', value: 'pass' },
    ]);

    const response = await postSetup(app, { token: workspace.token, body: { repository: 'github.com/Org/Alias' } });

    assert.equal(response.statusCode, 200, `alias解決に失敗: ${response.statusCode} ${response.body}`);
    const body = response.json<{
      project_id: string;
      repository: string;
      redaction_policy: { version: number; rules: Array<{ type: string; value: string }> };
    }>();
    assert.equal(body.project_id, workspace.projectId);
    assert.equal(body.repository, 'github.com/Org/Alias');
    assert.equal(body.redaction_policy.version, 3);
    const rules = [...body.redaction_policy.rules].sort((left, right) =>
      `${left.type}:${left.value}`.localeCompare(`${right.type}:${right.value}`),
    );
    assert.deepEqual(
      rules,
      [
        { type: 'assignment_key', value: 'pass' },
        { type: 'literal', value: 'AcmeSecret' },
      ],
      'setup応答のrulesがtype/valueのobject unionで返っていない',
    );
    for (const rule of rules) {
      assert.equal(typeof rule, 'object', `ruleがstringのまま返っている: ${JSON.stringify(rule)}`);
      assert.ok(typeof rule.type === 'string' && typeof rule.value === 'string', 'ruleのtype/valueが欠落している');
    }
  });

  it('別会社・非member・未登録repositoryは存在を開示せず404にする', async () => {
    const otherCompanyId = await insertCompany(pool, 'company-setup-other');
    const otherEmployeeId = await insertEmployee(pool, otherCompanyId);
    await insertProject(pool, otherCompanyId, 'github.com/Other/Repo');

    const otherCompanyResponse = await postSetup(app, { token: workspace.token, body: { repository: 'github.com/Other/Repo' } });
    const unknownResponse = await postSetup(app, { token: workspace.token, body: { repository: 'github.com/Unknown/Repo' } });
    assert.equal(otherCompanyResponse.statusCode, 404, `他社repositoryが404でない: ${otherCompanyResponse.statusCode}`);
    assert.equal(unknownResponse.statusCode, 404, `未登録repositoryが404でない: ${unknownResponse.statusCode}`);
    assert.equal(errorCode(otherCompanyResponse), 'not_found');
    assert.equal(errorCode(unknownResponse), 'not_found');

    const nonMemberEmployeeId = await insertEmployee(pool, workspace.companyId);
    const nonMemberToken = await issueAuthToken(pool, workspace.companyId, nonMemberEmployeeId);
    const nonMemberResponse = await postSetup(app, { token: nonMemberToken, body: { repository: PRIMARY_REPOSITORY } });
    assert.equal(nonMemberResponse.statusCode, 404, `非memberが404でない: ${nonMemberResponse.statusCode}`);

    const otherCompanyToken = await issueAuthToken(pool, otherCompanyId, otherEmployeeId);
    const crossCompanyResponse = await postSetup(app, { token: otherCompanyToken, body: { repository: PRIMARY_REPOSITORY } });
    assert.equal(crossCompanyResponse.statusCode, 404, `別会社tokenが404でない: ${crossCompanyResponse.statusCode}`);
    assert.ok(!crossCompanyResponse.body.includes(workspace.projectId), '存在しないproject_idを露出している');
  });

  it('未認証は401、unknown fieldと不正repositoryは400にする', async () => {
    const unauthorized = await postSetup(app, { token: null, body: { repository: PRIMARY_REPOSITORY } });
    assert.equal(unauthorized.statusCode, 401);

    const invalidToken = await postSetup(app, { token: 'invalid-token', body: { repository: PRIMARY_REPOSITORY } });
    assert.equal(invalidToken.statusCode, 401);

    const unknownField = await postSetup(app, { token: workspace.token, body: { repository: PRIMARY_REPOSITORY, project_id: workspace.projectId } });
    assert.equal(unknownField.statusCode, 400, `unknown fieldを受理している: ${unknownField.statusCode} ${unknownField.body}`);

    for (const repository of ['', '   ', '/local/path']) {
      const invalid = await postSetup(app, { token: workspace.token, body: { repository } });
      assert.equal(invalid.statusCode, 400, `不正repository ${JSON.stringify(repository)} を受理している: ${invalid.statusCode}`);
    }
  });
});
