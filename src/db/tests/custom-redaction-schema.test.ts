import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { v7 as uuidv7 } from 'uuid';
import { createPool, requireDatabaseUrl } from '../pool.js';
import { runMigrations } from '../migrator.js';
import { insertCompany, resetDatabase, seedWorkspace, type WorkspaceFixture } from './fixtures.js';

// 会社単位の伏せ字policy（version付き）とproject repository aliasのDB契約。
// 管理者は別repositoryのyori-cliからDBへliteralを更新するため、重複・空・placeholder・長さはDB制約でも拒否する。

const pool = createPool(requireDatabaseUrl());
let workspace: WorkspaceFixture;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const PREVIOUS_MIGRATIONS = [
  '0001_init.sql',
  '0002_m3.sql',
  '0003_m3_response_model.sql',
  '0004_m4.sql',
  '0005_m5.sql',
  '0006_m6.sql',
  '0007_m7.sql',
  '0008_m8.sql',
  '0009_column_names.sql',
] as const;

const MAX_CUSTOM_LITERAL_CODE_POINTS = 512;

before(async () => {
  await runMigrations(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
  workspace = await seedWorkspace(pool);
});

after(async () => {
  await pool.end();
});

async function expectDbError(operation: Promise<unknown>, code: string, label: string): Promise<void> {
  await assert.rejects(
    operation,
    (error: { code?: string }) => {
      assert.equal(error.code, code, `${label}: 期待したSQLSTATE ${code} ではなく ${String(error.code)}`);
      return true;
    },
    `${label}: DBエラーにならない`,
  );
}

async function readMigrationFile(file: string): Promise<string> {
  try {
    return await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  } catch {
    assert.fail(`${file} が存在しない`);
  }
}

async function insertPolicy(companyId: string, version: number, rules: string[] = []): Promise<void> {
  await pool.query('INSERT INTO company_redaction_policies (company_id, version) VALUES ($1, $2)', [companyId, version]);
  for (const rule of rules) {
    await pool.query('INSERT INTO company_redaction_rules (company_id, literal) VALUES ($1, $2)', [companyId, rule]);
  }
}

function insertRule(companyId: string, literal: string): Promise<unknown> {
  return pool.query('INSERT INTO company_redaction_rules (company_id, literal) VALUES ($1, $2)', [companyId, literal]);
}

function insertAlias(projectId: string, companyId: string, repository: string): Promise<unknown> {
  return pool.query('INSERT INTO project_repositories (project_id, company_id, repository_identifier) VALUES ($1, $2, $3)', [
    projectId,
    companyId,
    repository,
  ]);
}

describe('custom伏せ字policyのschema契約', () => {
  it('会社単位のversionとrulesを保存し、未登録会社は行を持たない', async () => {
    await insertPolicy(workspace.companyId, 2, ['AcmeSecret', 'hunter2']);

    const policy = await pool.query<{ version: number }>('SELECT version FROM company_redaction_policies WHERE company_id = $1', [
      workspace.companyId,
    ]);
    assert.equal(policy.rows[0]?.version, 2);

    const rules = await pool.query<{ literal: string }>(
      'SELECT literal FROM company_redaction_rules WHERE company_id = $1 ORDER BY literal',
      [workspace.companyId],
    );
    assert.deepEqual(rules.rows.map((row) => row.literal), ['AcmeSecret', 'hunter2']);

    const otherCompanyId = await insertCompany(pool, 'company-policy-empty');
    const otherPolicy = await pool.query('SELECT version FROM company_redaction_policies WHERE company_id = $1', [otherCompanyId]);
    assert.equal(otherPolicy.rows.length, 0, '未登録会社へversion行を作っている（未登録はversion 0・rules空として扱う）');
  });

  it('空・placeholder・上限超過literal、重複、version 0、親のないruleを拒否する', async () => {
    await insertPolicy(workspace.companyId, 1, ['AcmeSecret']);

    await expectDbError(insertRule(workspace.companyId, ''), '23514', '空literal');
    await expectDbError(insertRule(workspace.companyId, '[REDACTED:custom]'), '23514', 'placeholder literal');
    for (const fragment of ['REDACTED', 'custom', '[REDACTED', 'ED:custom]', 'env_value', 'authorization']) {
      await expectDbError(insertRule(workspace.companyId, fragment), '23514', `placeholder部分文字列 ${fragment}`);
    }
    await insertRule(workspace.companyId, 'ProjectCodename');
    const accepted = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM company_redaction_rules WHERE company_id = $1 AND literal = 'ProjectCodename'",
      [workspace.companyId],
    );
    assert.equal(accepted.rows[0]?.count, '1', '部分文字列でないliteralを拒否している');

    // 512 code pointsの最大literalは主キーのB-tree index row上限内で保存・読出しでき、513は拒否する。
    const maxLiteral = 'x'.repeat(MAX_CUSTOM_LITERAL_CODE_POINTS);
    await insertRule(workspace.companyId, maxLiteral);
    const storedMax = await pool.query<{ literal: string }>(
      'SELECT literal FROM company_redaction_rules WHERE company_id = $1 AND literal = $2',
      [workspace.companyId, maxLiteral],
    );
    assert.equal(storedMax.rows[0]?.literal, maxLiteral, '512 code pointsのliteralを保存・読出しできない');
    await expectDbError(insertRule(workspace.companyId, maxLiteral), '23505', '境界literalの重複');
    await expectDbError(
      insertRule(workspace.companyId, 'x'.repeat(MAX_CUSTOM_LITERAL_CODE_POINTS + 1)),
      '23514',
      '上限超過literal',
    );
    await expectDbError(insertRule(workspace.companyId, 'AcmeSecret'), '23505', '重複literal');
    await expectDbError(
      pool.query('INSERT INTO company_redaction_policies (company_id, version) VALUES ($1, 2)', [workspace.companyId]),
      '23505',
      '会社あたり1行のversion（主キー）',
    );
    const versionZeroCompanyId = await insertCompany(pool, 'company-policy-zero');
    await expectDbError(
      pool.query('INSERT INTO company_redaction_policies (company_id, version) VALUES ($1, 0)', [versionZeroCompanyId]),
      '23514',
      'version 0（未登録会社の既定値は保存しない）',
    );

    const orphanCompanyId = await insertCompany(pool, 'company-policy-orphan');
    await expectDbError(insertRule(orphanCompanyId, 'AcmeSecret'), '23503', 'policy行のない会社のrule');

    await pool.query('UPDATE company_redaction_policies SET version = 3 WHERE company_id = $1', [workspace.companyId]);
    const updated = await pool.query<{ version: number }>('SELECT version FROM company_redaction_policies WHERE company_id = $1', [
      workspace.companyId,
    ]);
    assert.equal(updated.rows[0]?.version, 3);
  });

  it('規則件数をDBで100件に制限し、並行atomic replaceでも101件目を拒否する', async () => {
    const companyId = await insertCompany(pool, 'company-rule-limit');
    await insertPolicy(
      companyId,
      1,
      Array.from({ length: 99 }, (_, index) => `rule-${String(index).padStart(3, '0')}`),
    );
    assert.equal(await ruleCount(companyId), 99);

    await insertRule(companyId, 'rule-100');
    assert.equal(await ruleCount(companyId), 100);
    await expectDbError(insertRule(companyId, 'rule-101'), '23514', '101件目のrule');
    assert.equal(await ruleCount(companyId), 100, '拒否後も100件を維持していない');

    // yori-cliのatomic replace（新versionのruleを一括insert）でも、超過分はtransactionごとrollbackする。
    const replaceClient = await pool.connect();
    try {
      await replaceClient.query('BEGIN');
      await expectDbError(
        replaceClient.query('INSERT INTO company_redaction_rules (company_id, literal) VALUES ($1, $2)', [companyId, 'rule-102']),
        '23514',
        'transaction内101件目',
      );
      await replaceClient.query('ROLLBACK');
    } finally {
      replaceClient.release();
    }
    assert.equal(await ruleCount(companyId), 100, 'rollbackで件数が変わっている');

    // 並行transactionではpolicy行lockにより100件目が片方だけ成功する。
    const raceCompanyId = await insertCompany(pool, 'company-rule-race');
    await insertPolicy(
      raceCompanyId,
      1,
      Array.from({ length: 99 }, (_, index) => `race-${String(index).padStart(3, '0')}`),
    );
    const insertSql = 'INSERT INTO company_redaction_rules (company_id, literal) VALUES ($1, $2)';
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('BEGIN');
      await clientA.query(insertSql, [raceCompanyId, 'race-a']);
      await clientB.query('BEGIN');
      const second = clientB.query(insertSql, [raceCompanyId, 'race-b']);
      await clientA.query('COMMIT');
      const outcome = await second.then(
        () => 'fulfilled' as const,
        (error: { code?: string }) => ({ code: error.code }),
      );
      assert.deepEqual(outcome, { code: '23514' }, `並行insertが ${JSON.stringify(outcome)} になった`);
      await clientB.query('ROLLBACK');
    } finally {
      clientA.release();
      clientB.release();
    }
    assert.equal(await ruleCount(raceCompanyId), 100, '並行insertで上限を越えている');

    // 同会社内のliteral変更は件数を増やさないため許可する。
    await pool.query("UPDATE company_redaction_rules SET literal = 'rule-100-renamed' WHERE company_id = $1 AND literal = 'rule-100'", [
      companyId,
    ]);
    assert.equal(await ruleCount(companyId), 100, '同会社内UPDATEで件数が変わっている');

    // 別会社のruleをcompany_id UPDATEで満杯の会社へ移すと拒否する。
    const fullCompanyId = await insertCompany(pool, 'company-rule-full');
    await insertPolicy(fullCompanyId, 1, Array.from({ length: 100 }, (_, index) => `full-${String(index).padStart(3, '0')}`));
    const sourceCompanyId = await insertCompany(pool, 'company-rule-source');
    await insertPolicy(sourceCompanyId, 1, ['move-me']);
    await expectDbError(
      pool.query('UPDATE company_redaction_rules SET company_id = $1 WHERE company_id = $2', [fullCompanyId, sourceCompanyId]),
      '23514',
      '満杯会社へのcompany_id UPDATE',
    );
    assert.equal(await ruleCount(sourceCompanyId), 1, '拒否後に移動元ruleが消えている');

    // 空きのある会社へはcompany_id UPDATEで移動できる。
    const roomCompanyId = await insertCompany(pool, 'company-rule-room');
    await insertPolicy(roomCompanyId, 1, ['room-1']);
    await pool.query('UPDATE company_redaction_rules SET company_id = $1 WHERE company_id = $2', [roomCompanyId, sourceCompanyId]);
    assert.equal(await ruleCount(roomCompanyId), 2, '空き会社へのcompany_id UPDATEが反映されていない');
    assert.equal(await ruleCount(sourceCompanyId), 0);

    // 並行のcompany_id UPDATEでもtarget policy lockで100件を越えない。
    const raceTargetId = await insertCompany(pool, 'company-rule-move-race');
    await insertPolicy(raceTargetId, 1, Array.from({ length: 99 }, (_, index) => `t-${String(index).padStart(3, '0')}`));
    const moveSourceAId = await insertCompany(pool, 'company-rule-move-a');
    await insertPolicy(moveSourceAId, 1, ['move-a']);
    const moveSourceBId = await insertCompany(pool, 'company-rule-move-b');
    await insertPolicy(moveSourceBId, 1, ['move-b']);
    const moveSql = 'UPDATE company_redaction_rules SET company_id = $1 WHERE company_id = $2';
    const moveClientA = await pool.connect();
    const moveClientB = await pool.connect();
    try {
      await moveClientA.query('BEGIN');
      await moveClientA.query(moveSql, [raceTargetId, moveSourceAId]);
      await moveClientB.query('BEGIN');
      const moveSecond = moveClientB.query(moveSql, [raceTargetId, moveSourceBId]);
      await moveClientA.query('COMMIT');
      const moveOutcome = await moveSecond.then(
        () => 'fulfilled' as const,
        (error: { code?: string }) => ({ code: error.code }),
      );
      assert.deepEqual(moveOutcome, { code: '23514' }, `並行company_id UPDATEが ${JSON.stringify(moveOutcome)} になった`);
      await moveClientB.query('ROLLBACK');
    } finally {
      moveClientA.release();
      moveClientB.release();
    }
    assert.equal(await ruleCount(raceTargetId), 100, '並行UPDATEで上限を越えている');
  });
});

async function ruleCount(companyId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM company_redaction_rules WHERE company_id = $1',
    [companyId],
  );
  return Number(result.rows[0]?.count);
}

describe('project repository aliasのschema契約', () => {
  it('primary repositoryをbackfillし、同じ会社の重複aliasを拒否して会社境界を保つ', async () => {
    const aliasRepository = 'github.com/Org/Alias';
    await insertAlias(workspace.projectId, workspace.companyId, aliasRepository);

    await expectDbError(insertAlias(workspace.projectId, workspace.companyId, aliasRepository), '23505', '同一project内の重複alias');

    const secondProject = await pool.query<{ id: string }>(
      'INSERT INTO projects (id, company_id, repository_identifier) VALUES ($1, $2, $3) RETURNING id',
      [uuidv7(), workspace.companyId, 'repo-b'],
    );
    await expectDbError(insertAlias(secondProject.rows[0]!.id, workspace.companyId, 'repo-a'), '23505', '同一会社で同じrepositoryを複数projectへ割当');

    const otherCompanyId = await insertCompany(pool, 'company-alias');
    const otherProject = await pool.query<{ id: string }>(
      'INSERT INTO projects (id, company_id, repository_identifier) VALUES ($1, $2, $3) RETURNING id',
      [uuidv7(), otherCompanyId, 'repo-c'],
    );
    await insertAlias(otherProject.rows[0]!.id, otherCompanyId, 'repo-a');
    const otherAliases = await pool.query('SELECT project_id FROM project_repositories WHERE project_id = $1', [otherProject.rows[0]!.id]);
    assert.equal(otherAliases.rows.length, 1, '別会社では同じcanonical repositoryを拒否している');

    await expectDbError(insertAlias(workspace.projectId, otherCompanyId, 'github.com/Org/Mismatch'), '23503', 'projectと別会社の組合せ');
    await expectDbError(insertAlias(uuidv7(), workspace.companyId, 'github.com/Org/Unknown'), '23503', '不存在projectのalias');
  });

  it('primary/aliasをまたぐrepository一意性をINSERT/UPDATE双方で保証する', async () => {
    const aliasRepository = 'github.com/Org/Alias';
    await insertAlias(workspace.projectId, workspace.companyId, aliasRepository);
    // 同一projectのprimary backfill行は許可し続ける。
    await insertAlias(workspace.projectId, workspace.companyId, 'repo-a');

    const secondProjectId = uuidv7();
    await pool.query('INSERT INTO projects (id, company_id, repository_identifier) VALUES ($1, $2, $3)', [
      secondProjectId,
      workspace.companyId,
      'repo-b',
    ]);

    await expectDbError(
      pool.query('INSERT INTO projects (id, company_id, repository_identifier) VALUES ($1, $2, $3)', [
        uuidv7(),
        workspace.companyId,
        aliasRepository,
      ]),
      '23505',
      '他projectのaliasをprimaryとしてINSERT',
    );
    await expectDbError(
      pool.query('UPDATE projects SET repository_identifier = $1 WHERE id = $2', [aliasRepository, secondProjectId]),
      '23505',
      '他projectのaliasへprimaryをUPDATE',
    );

    await insertAlias(secondProjectId, workspace.companyId, 'github.com/Org/Other');
    await expectDbError(
      pool.query(
        'UPDATE project_repositories SET repository_identifier = $1 WHERE project_id = $2 AND repository_identifier = $3',
        ['repo-a', secondProjectId, 'github.com/Org/Other'],
      ),
      '23505',
      '他projectのprimaryへaliasをUPDATE',
    );
    await expectDbError(
      pool.query(
        'UPDATE project_repositories SET repository_identifier = $1 WHERE project_id = $2 AND repository_identifier = $3',
        [aliasRepository, secondProjectId, 'github.com/Org/Other'],
      ),
      '23505',
      '他projectのaliasへaliasをUPDATE',
    );

    // project_repositories UPDATE project_id: primary行を同会社の別projectへ移すと衝突する。
    const thirdProjectId = uuidv7();
    await pool.query('INSERT INTO projects (id, company_id, repository_identifier) VALUES ($1, $2, $3)', [
      thirdProjectId,
      workspace.companyId,
      'repo-c',
    ]);
    await expectDbError(
      pool.query(
        'UPDATE project_repositories SET project_id = $1 WHERE project_id = $2 AND repository_identifier = $3',
        [thirdProjectId, workspace.projectId, 'repo-a'],
      ),
      '23505',
      'project_idを別projectへUPDATE',
    );

    // projects UPDATE company_id: 移動先会社のaliasと同じrepositoryへは移せない。
    const otherCompanyWithAlias = await insertCompany(pool, 'company-alias-move');
    await pool.query('INSERT INTO projects (id, company_id, repository_identifier) VALUES ($1, $2, $3)', [
      uuidv7(),
      otherCompanyWithAlias,
      'repo-move',
    ]);
    const moveProject = await pool.query<{ id: string }>(
      'SELECT id FROM projects WHERE company_id = $1',
      [otherCompanyWithAlias],
    );
    await insertAlias(moveProject.rows[0]!.id, otherCompanyWithAlias, 'repo-a');
    await expectDbError(
      pool.query('UPDATE projects SET company_id = $1 WHERE id = $2', [otherCompanyWithAlias, workspace.projectId]),
      '23505',
      'projects company_id UPDATEで他社aliasと衝突',
    );

    // 同一projectのaliasは制限なく登録でき、一意性は他projectとの間だけで保たれる。
    await insertAlias(secondProjectId, workspace.companyId, 'github.com/Org/Second-Alias');
    const secondAliases = await pool.query<{ repository_identifier: string }>(
      'SELECT repository_identifier FROM project_repositories WHERE project_id = $1 ORDER BY repository_identifier',
      [secondProjectId],
    );
    assert.deepEqual(secondAliases.rows.map((row) => row.repository_identifier), [
      'github.com/Org/Other',
      'github.com/Org/Second-Alias',
    ]);
  });

  it('0009適用済みDBのprimary repositoryを新migrationでaliasへbackfillする', async () => {
    const databaseName = `yori_custom_redaction_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await pool.query(`CREATE DATABASE ${databaseName}`);
    const legacyUrl = new URL(requireDatabaseUrl());
    legacyUrl.pathname = `/${databaseName}`;
    const legacy = createPool(legacyUrl.toString());
    try {
      for (const file of PREVIOUS_MIGRATIONS) {
        await legacy.query(await readMigrationFile(file));
      }
      await legacy.query(
        `CREATE TABLE schema_migrations (
           version text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      for (const file of PREVIOUS_MIGRATIONS) {
        await legacy.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      }

      const companyId = uuidv7();
      const projectId = uuidv7();
      await legacy.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [companyId, 'legacy-policy-company']);
      await legacy.query('INSERT INTO projects (id, company_id, repository_identifier) VALUES ($1, $2, $3)', [
        projectId,
        companyId,
        'github.com/Legacy/Primary',
      ]);

      const applied = await runMigrations(legacy);
      assert.ok(applied.length >= 1, 'primary repository backfillを含む新migrationが適用されていない');

      const alias = await legacy.query<{ project_id: string; company_id: string; repository_identifier: string }>(
        'SELECT project_id, company_id, repository_identifier FROM project_repositories WHERE project_id = $1',
        [projectId],
      );
      assert.deepEqual(alias.rows, [
        { project_id: projectId, company_id: companyId, repository_identifier: 'github.com/Legacy/Primary' },
      ]);
    } finally {
      await legacy.end();
      await pool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    }
  });
});
