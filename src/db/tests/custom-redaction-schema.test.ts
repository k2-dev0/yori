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
// 管理者は別repositoryのyori-cliからDBへruleを更新するため、rule_type/valueの形式・重複・空・placeholder・長さはDB制約でも拒否する。

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

const MAX_TERM_CODE_POINTS = 512;
const MAX_FIELD_CODE_POINTS = 128;
const MAX_CUSTOM_RULES = 100;

interface StructuredRule {
  rule_type: 'term' | 'field';
  value: string;
  normalized_value: string;
}

function termRule(value: string): StructuredRule {
  return { rule_type: 'term', value, normalized_value: value };
}

function fieldRule(value: string): StructuredRule {
  return { rule_type: 'field', value, normalized_value: value.toLowerCase() };
}

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

async function insertPolicy(
  companyId: string,
  version: number,
  rules: StructuredRule[] = [],
  options: { suspicion_mode?: 'observe' | 'block'; detector_version?: string } = {},
): Promise<void> {
  await pool.query(
    'INSERT INTO company_redaction_policies (company_id, version, suspicion_mode, detector_version) VALUES ($1, $2, $3, $4)',
    [companyId, version, options.suspicion_mode ?? 'observe', options.detector_version ?? 'initial-v1'],
  );
  for (const rule of rules) {
    await insertRule(companyId, rule);
  }
}

function insertRule(companyId: string, rule: StructuredRule): Promise<unknown> {
  return pool.query(
    'INSERT INTO company_redaction_rules (company_id, rule_type, value, normalized_value) VALUES ($1, $2, $3, $4)',
    [companyId, rule.rule_type, rule.value, rule.normalized_value],
  );
}

async function ruleCount(companyId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM company_redaction_rules WHERE company_id = $1',
    [companyId],
  );
  return Number(result.rows[0]?.count);
}

function insertAlias(projectId: string, companyId: string, repository: string): Promise<unknown> {
  return pool.query('INSERT INTO project_repositories (project_id, company_id, repository_identifier) VALUES ($1, $2, $3)', [
    projectId,
    companyId,
    repository,
  ]);
}

describe('custom伏せ字policyのschema契約', () => {
  it('rule_type/value/normalized_valueの構造でtermとfieldを保存し、未登録会社は行を持たない', async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'company_redaction_rules'
        ORDER BY column_name`,
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name).sort(),
      ['company_id', 'normalized_value', 'rule_type', 'value'],
      'company_redaction_rulesがrule_type/value/normalized_value構造になっていない',
    );

    const policyColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'company_redaction_policies'
        ORDER BY column_name`,
    );
    assert.deepEqual(
      policyColumns.rows.map((row) => row.column_name).sort(),
      ['company_id', 'detector_version', 'suspicion_mode', 'updated_at', 'version'],
      'company_redaction_policiesがsuspicion_mode/detector_versionを持たない',
    );

    await insertPolicy(workspace.companyId, 2, [termRule('AcmeSecret'), fieldRule('Pass')], {
      suspicion_mode: 'block',
      detector_version: 'initial-v1',
    });

    const policy = await pool.query<{ version: number; suspicion_mode: string; detector_version: string }>(
      'SELECT version, suspicion_mode, detector_version FROM company_redaction_policies WHERE company_id = $1',
      [workspace.companyId],
    );
    assert.equal(policy.rows[0]?.version, 2);
    assert.equal(policy.rows[0]?.suspicion_mode, 'block', 'suspicion_modeを保存・読出しできない');
    assert.equal(policy.rows[0]?.detector_version, 'initial-v1', 'detector_versionを保存・読出しできない');

    const rules = await pool.query<{ rule_type: string; value: string; normalized_value: string }>(
      'SELECT rule_type, value, normalized_value FROM company_redaction_rules WHERE company_id = $1 ORDER BY rule_type, value',
      [workspace.companyId],
    );
    assert.deepEqual(
      rules.rows,
      [
        { rule_type: 'field', value: 'Pass', normalized_value: 'pass' },
        { rule_type: 'term', value: 'AcmeSecret', normalized_value: 'AcmeSecret' },
      ],
      'structured ruleの保存・読出しができない',
    );

    const otherCompanyId = await insertCompany(pool, 'company-policy-empty');
    const otherRules = await pool.query('SELECT 1 FROM company_redaction_rules WHERE company_id = $1', [otherCompanyId]);
    assert.equal(otherRules.rows.length, 0, '未登録会社へrule行を作っている（未登録はversion 0・fields/terms空として扱う）');
  });

  it('不正rule_type・空value・placeholder term・上限超過・大小文字別の重複を拒否する', async () => {
    await insertPolicy(workspace.companyId, 1, [termRule('AcmeSecret')]);

    await expectDbError(
      pool.query(
        "INSERT INTO company_redaction_rules (company_id, rule_type, value, normalized_value) VALUES ($1, 'regex', 'x', 'x')",
        [workspace.companyId],
      ),
      '23514',
      '不正rule_type',
    );
    await expectDbError(insertRule(workspace.companyId, termRule('')), '23514', '空term value');
    await expectDbError(insertRule(workspace.companyId, fieldRule('')), '23514', '空field value');
    await expectDbError(insertRule(workspace.companyId, termRule('[REDACTED:business_term]')), '23514', 'placeholder term');
    for (const fragment of ['REDACTED', 'business_term', 'business_value', 'known_secret', '[REDACTED', 'env_value', 'authorization']) {
      await expectDbError(insertRule(workspace.companyId, termRule(fragment)), '23514', `placeholder部分文字列 ${fragment}`);
    }
    await expectDbError(
      insertRule(workspace.companyId, fieldRule('a'.repeat(MAX_FIELD_CODE_POINTS + 1))),
      '23514',
      '上限超過field',
    );

    // 512/128 code pointsの境界値は保存・読出しでき、超過は拒否する。
    const maxTermValue = 'x'.repeat(MAX_TERM_CODE_POINTS);
    await insertRule(workspace.companyId, termRule(maxTermValue));
    const storedMaxTerm = await pool.query<{ value: string }>(
      'SELECT value FROM company_redaction_rules WHERE company_id = $1 AND rule_type = $2 AND value = $3',
      [workspace.companyId, 'term', maxTermValue],
    );
    assert.equal(storedMaxTerm.rows[0]?.value, maxTermValue, '512 code pointsのtermを保存・読出しできない');
    await expectDbError(insertRule(workspace.companyId, termRule(maxTermValue)), '23505', '境界termの重複');
    await expectDbError(
      insertRule(workspace.companyId, termRule('x'.repeat(MAX_TERM_CODE_POINTS + 1))),
      '23514',
      '上限超過term',
    );

    const maxKey = 'a'.repeat(MAX_FIELD_CODE_POINTS);
    await insertRule(workspace.companyId, fieldRule(maxKey));
    const storedMaxKey = await pool.query<{ value: string; normalized_value: string }>(
      'SELECT value, normalized_value FROM company_redaction_rules WHERE company_id = $1 AND rule_type = $2 AND value = $3',
      [workspace.companyId, 'field', maxKey],
    );
    assert.deepEqual(
      storedMaxKey.rows[0],
      { value: maxKey, normalized_value: maxKey },
      '128 code pointsのfieldを保存・読出しできない',
    );

    await expectDbError(insertRule(workspace.companyId, termRule('AcmeSecret')), '23505', '同一term重複');
    // termはcase-sensitive、fieldはcase-insensitiveに重複を判定する。
    await insertRule(workspace.companyId, termRule('Pass'));
    await insertRule(workspace.companyId, termRule('pass'));
    const caseLiterals = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM company_redaction_rules WHERE company_id = $1 AND rule_type = 'term' AND value IN ('Pass', 'pass')",
      [workspace.companyId],
    );
    assert.equal(caseLiterals.rows[0]?.count, '2', 'term重複をcase-insensitiveに扱っている');
    await insertRule(workspace.companyId, fieldRule('PassKey'));
    await expectDbError(insertRule(workspace.companyId, fieldRule('passkey')), '23505', 'fieldの大小文字違い重複');
    await expectDbError(insertRule(workspace.companyId, fieldRule('PassKey')), '23505', 'fieldの同一value重複');

    // typeが異なれば同名valueを受理する。
    await insertRule(workspace.companyId, termRule('cross_type'));
    await insertRule(workspace.companyId, fieldRule('cross_type'));
    const crossType = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM company_redaction_rules WHERE company_id = $1 AND value = 'cross_type'",
      [workspace.companyId],
    );
    assert.equal(crossType.rows[0]?.count, '2', 'typeが異なる同名valueを拒否している');

    await expectDbError(
      pool.query(
        "INSERT INTO company_redaction_policies (company_id, version, suspicion_mode, detector_version) VALUES ($1, 2, 'observe', 'initial-v1')",
        [workspace.companyId],
      ),
      '23505',
      '会社あたり1行のversion（主キー）',
    );
    const versionZeroCompanyId = await insertCompany(pool, 'company-policy-zero');
    await expectDbError(
      pool.query(
        "INSERT INTO company_redaction_policies (company_id, version, suspicion_mode, detector_version) VALUES ($1, 0, 'observe', 'initial-v1')",
        [versionZeroCompanyId],
      ),
      '23514',
      'version 0（未登録会社の既定値は保存しない）',
    );
    const invalidModeCompanyId = await insertCompany(pool, 'company-policy-invalid-mode');
    await expectDbError(
      pool.query(
        "INSERT INTO company_redaction_policies (company_id, version, suspicion_mode, detector_version) VALUES ($1, 1, 'warn', 'initial-v1')",
        [invalidModeCompanyId],
      ),
      '23514',
      '不正なsuspicion_mode',
    );

    const orphanCompanyId = await insertCompany(pool, 'company-policy-orphan');
    await expectDbError(insertRule(orphanCompanyId, termRule('AcmeSecret')), '23503', 'policy行のない会社のrule');

    await pool.query('UPDATE company_redaction_policies SET version = 3 WHERE company_id = $1', [workspace.companyId]);
    const updated = await pool.query<{ version: number }>('SELECT version FROM company_redaction_policies WHERE company_id = $1', [
      workspace.companyId,
    ]);
    assert.equal(updated.rows[0]?.version, 3);
  });

  it('term/field合算100件limitとatomic replace・会社境界・並行insertを保証する', async () => {
    const companyId = await insertCompany(pool, 'company-rule-limit');
    await insertPolicy(companyId, 1, [
      ...Array.from({ length: 99 }, (_, index) => termRule(`rule-${String(index).padStart(3, '0')}`)),
      fieldRule('pass'),
    ]);
    assert.equal(await ruleCount(companyId), MAX_CUSTOM_RULES);

    await expectDbError(insertRule(companyId, termRule('rule-101')), '23514', 'termの101件目');
    await expectDbError(insertRule(companyId, fieldRule('extra_key')), '23514', 'fieldの101件目');
    assert.equal(await ruleCount(companyId), MAX_CUSTOM_RULES, '拒否後も100件を維持していない');

    // atomic replaceは同一transaction内のDELETE→INSERTで行い、旧100件を新100件へ置換する。
    const replaceClient = await pool.connect();
    try {
      await replaceClient.query('BEGIN');
      await replaceClient.query('DELETE FROM company_redaction_rules WHERE company_id = $1', [companyId]);
      for (let index = 0; index < 99; index += 1) {
        const value = `replaced-${String(index).padStart(3, '0')}`;
        await replaceClient.query(
          'INSERT INTO company_redaction_rules (company_id, rule_type, value, normalized_value) VALUES ($1, $2, $3, $4)',
          [companyId, 'term', value, value],
        );
      }
      await replaceClient.query(
        'INSERT INTO company_redaction_rules (company_id, rule_type, value, normalized_value) VALUES ($1, $2, $3, $4)',
        [companyId, 'field', 'replaced_pass', 'replaced_pass'],
      );
      await replaceClient.query('COMMIT');
    } finally {
      replaceClient.release();
    }
    assert.equal(await ruleCount(companyId), MAX_CUSTOM_RULES, 'atomic replace後の件数が100でない');
    const oldRemaining = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM company_redaction_rules WHERE company_id = $1 AND value = 'rule-000'",
      [companyId],
    );
    assert.equal(oldRemaining.rows[0]?.count, '0', 'replaceで旧ruleが残っている');

    // 失敗したreplaceはrollbackし、replace前のruleを維持する。
    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query('BEGIN');
      await rollbackClient.query('DELETE FROM company_redaction_rules WHERE company_id = $1', [companyId]);
      await rollbackClient.query(
        'INSERT INTO company_redaction_rules (company_id, rule_type, value, normalized_value) VALUES ($1, $2, $3, $4)',
        [companyId, 'term', 'rollback-rule', 'rollback-rule'],
      );
      await rollbackClient.query('ROLLBACK');
    } finally {
      rollbackClient.release();
    }
    assert.equal(await ruleCount(companyId), MAX_CUSTOM_RULES, 'rollbackでreplace前のruleが消えている');

    // 別会社の100件は自社のlimitへ影響しない。
    const otherCompanyId = await insertCompany(pool, 'company-rule-other');
    await insertPolicy(
      otherCompanyId,
      1,
      Array.from({ length: MAX_CUSTOM_RULES }, (_, index) => termRule(`other-${String(index).padStart(3, '0')}`)),
    );
    assert.equal(await ruleCount(otherCompanyId), MAX_CUSTOM_RULES);

    // 並行insertでは99件から2件同時追加の片方だけが成功する。
    const raceCompanyId = await insertCompany(pool, 'company-rule-race');
    await insertPolicy(
      raceCompanyId,
      1,
      Array.from({ length: 99 }, (_, index) => termRule(`race-${String(index).padStart(3, '0')}`)),
    );
    const insertSql = 'INSERT INTO company_redaction_rules (company_id, rule_type, value, normalized_value) VALUES ($1, $2, $3, $4)';
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('BEGIN');
      await clientA.query(insertSql, [raceCompanyId, 'term', 'race-a', 'race-a']);
      await clientB.query('BEGIN');
      const second = clientB.query(insertSql, [raceCompanyId, 'field', 'race_b', 'race_b']);
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
    assert.equal(await ruleCount(raceCompanyId), MAX_CUSTOM_RULES, '並行insertで上限を越えている');

    // 同会社内のvalue更新は件数を増やさないため許可する。
    await pool.query(
      "UPDATE company_redaction_rules SET value = 'replaced-renamed', normalized_value = 'replaced-renamed' WHERE company_id = $1 AND rule_type = 'term' AND value = 'replaced-000'",
      [companyId],
    );
    assert.equal(await ruleCount(companyId), MAX_CUSTOM_RULES, '同会社内UPDATEで件数が変わっている');

    // 満杯会社への会社移動は拒否し、空きのある会社へは移動できる。
    const fullCompanyId = await insertCompany(pool, 'company-rule-full');
    await insertPolicy(
      fullCompanyId,
      1,
      Array.from({ length: MAX_CUSTOM_RULES }, (_, index) => termRule(`full-${String(index).padStart(3, '0')}`)),
    );
    const sourceCompanyId = await insertCompany(pool, 'company-rule-source');
    await insertPolicy(sourceCompanyId, 1, [termRule('move-me')]);
    await expectDbError(
      pool.query('UPDATE company_redaction_rules SET company_id = $1 WHERE company_id = $2', [fullCompanyId, sourceCompanyId]),
      '23514',
      '満杯会社へのcompany_id UPDATE',
    );
    assert.equal(await ruleCount(sourceCompanyId), 1, '拒否後に移動元ruleが消えている');

    const roomCompanyId = await insertCompany(pool, 'company-rule-room');
    await insertPolicy(roomCompanyId, 1, [termRule('room-1')]);
    await pool.query('UPDATE company_redaction_rules SET company_id = $1 WHERE company_id = $2', [roomCompanyId, sourceCompanyId]);
    assert.equal(await ruleCount(roomCompanyId), 2, '空き会社へのcompany_id UPDATEが反映されていない');
    assert.equal(await ruleCount(sourceCompanyId), 0);

    // 並行のcompany_id UPDATEでもtarget policy lockで100件を越えない。
    const raceTargetId = await insertCompany(pool, 'company-rule-move-race');
    await insertPolicy(
      raceTargetId,
      1,
      Array.from({ length: 99 }, (_, index) => termRule(`t-${String(index).padStart(3, '0')}`)),
    );
    const moveSourceAId = await insertCompany(pool, 'company-rule-move-a');
    await insertPolicy(moveSourceAId, 1, [termRule('move-a')]);
    const moveSourceBId = await insertCompany(pool, 'company-rule-move-b');
    await insertPolicy(moveSourceBId, 1, [termRule('move-b')]);
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
    assert.equal(await ruleCount(raceTargetId), MAX_CUSTOM_RULES, '並行UPDATEで上限を越えている');
  });
});

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
