import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { createPool, requireDatabaseUrl } from '../pool.js';
import { runMigrations } from '../migrator.js';
import { insertMessage, insertSession, resetDatabase, seedWorkspace, type WorkspaceFixture } from './fixtures.js';

// M7採用シナリオ1の保存契約（docs/m7-design.md）をmigration境界で確認するRedテスト。
// session_links未実装の間はtable不在のassertで失敗し、列・index・制約の不足をit単位で示す。

const pool = createPool(requireDatabaseUrl());
let workspace: WorkspaceFixture;

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

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1) AS exists",
    [table],
  );
  return result.rows[0]?.exists === true;
}

async function requireSessionLinks(pool: Pool): Promise<void> {
  assert.equal(await tableExists(pool, 'session_links'), true, 'M7の必須テーブル session_links がない（M7 migration未適用）');
}

async function tableIndexDefs(pool: Pool, table: string): Promise<string[]> {
  const result = await pool.query<{ indexdef: string }>(
    'SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2',
    ['public', table],
  );
  return result.rows.map((row) => row.indexdef);
}

async function tableConstraintDefs(pool: Pool, table: string): Promise<string[]> {
  const result = await pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1`,
    [table],
  );
  return result.rows.map((row) => row.def);
}

interface LinkSeed {
  fromSessionId: string;
  toSessionId: string;
  evidenceMessageId: string;
  evidenceRevision?: number;
  idempotencyKey: string;
  status?: string;
  isExplicit?: boolean;
  companyId?: string;
  projectId?: string;
  createdByEmployeeId?: string;
}

// condition_hashの値自体は実装が決める。NOT NULL契約を満たす固定長の検査値だけを作る。
function testConditionHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// M7 migrationのsession_links保存契約をそのまま使い、アプリ生成UUIDv7のidだけをテスト側で採番する。
async function insertLink(pool: Pool, input: LinkSeed): Promise<string> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO session_links
       (id, company_id, project_id, from_session_id, to_session_id, evidence_message_id, evidence_revision,
        is_explicit, status, created_by_employee_id, idempotency_key, condition_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      input.companyId ?? workspace.companyId,
      input.projectId ?? workspace.projectId,
      input.fromSessionId,
      input.toSessionId,
      input.evidenceMessageId,
      input.evidenceRevision ?? 1,
      input.isExplicit ?? true,
      input.status ?? 'active',
      input.createdByEmployeeId ?? workspace.employeeId,
      input.idempotencyKey,
      testConditionHash(input.idempotencyKey),
    ],
  );
  return id;
}

async function seedSessionWithMessage(): Promise<{ sessionId: string; messageId: string }> {
  const sessionId = await insertSession(pool, {
    projectId: workspace.projectId,
    employeeId: workspace.employeeId,
    sourceSessionId: `evidence-session-${uuidv7()}`,
  });
  const message = await insertMessage(pool, { sessionId, sourceMessageId: `evidence-${uuidv7()}`, sequenceNo: 1 });
  return { sessionId, messageId: message.messageId };
}

describe('M7 session_links schema', () => {
  it('session_linksは保存契約の列・from/to個別index・冪等キーを持つ', async () => {
    await requireSessionLinks(pool);

    const columns = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'session_links'",
    );
    const names = new Set(columns.rows.map((row) => row.column_name));
    for (const column of [
      'id',
      'company_id',
      'project_id',
      'from_session_id',
      'to_session_id',
      'evidence_message_id',
      'evidence_revision',
      'is_explicit',
      'status',
      'created_by_employee_id',
      'idempotency_key',
      'condition_hash',
      'created_at',
      'updated_at',
    ]) {
      assert.ok(names.has(column), `session_linksに${column}列がない`);
    }

    const indexes = await tableIndexDefs(pool, 'session_links');
    assert.ok(
      indexes.some((def) => /\(from_session_id\b/.test(def)),
      `from_session_idのindexがない: ${indexes.join(' | ')}`,
    );
    assert.ok(
      indexes.some((def) => /\(to_session_id\b/.test(def)),
      `to_session_idのindexがない: ${indexes.join(' | ')}`,
    );

    const uniqueDefs = [
      ...indexes.filter((def) => def.startsWith('CREATE UNIQUE INDEX')),
      ...(await tableConstraintDefs(pool, 'session_links')),
    ];
    assert.ok(
      uniqueDefs.some((def) =>
        ['company_id', 'created_by_employee_id', 'idempotency_key'].every((column) => def.includes(column)),
      ),
      'session_linksに(company_id, created_by_employee_id, idempotency_key)の一意キーがない',
    );
  });

  it('同じactiveな元・先・根拠の重複保存を拒否する', async () => {
    await requireSessionLinks(pool);
    const from = await seedSessionWithMessage();
    const to = await seedSessionWithMessage();
    const evidence = await seedSessionWithMessage();

    await insertLink(pool, {
      fromSessionId: from.sessionId,
      toSessionId: to.sessionId,
      evidenceMessageId: evidence.messageId,
      idempotencyKey: 'idem-active-1',
    });
    await expectDbError(
      insertLink(pool, {
        fromSessionId: from.sessionId,
        toSessionId: to.sessionId,
        evidenceMessageId: evidence.messageId,
        idempotencyKey: 'idem-active-2',
      }),
      '23505',
      '同じactiveな元・先・根拠の重複',
    );
  });

  it('fromとtoは異なるsessionを要求し、statusはactive/revokedだけを許す', async () => {
    await requireSessionLinks(pool);
    const from = await seedSessionWithMessage();
    const evidence = await seedSessionWithMessage();

    await expectDbError(
      insertLink(pool, {
        fromSessionId: from.sessionId,
        toSessionId: from.sessionId,
        evidenceMessageId: evidence.messageId,
        idempotencyKey: 'idem-self-link',
      }),
      '23514',
      '自己リンク',
    );
    await expectDbError(
      insertLink(pool, {
        fromSessionId: from.sessionId,
        toSessionId: evidence.sessionId,
        evidenceMessageId: evidence.messageId,
        idempotencyKey: 'idem-bad-status',
        status: 'pending',
      }),
      '23514',
      '不正status',
    );
  });
});
