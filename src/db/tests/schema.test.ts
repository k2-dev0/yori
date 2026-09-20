import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { v7 as uuidv7 } from 'uuid';
import { createPool, requireDatabaseUrl } from '../pool.js';
import { runMigrations } from '../migrator.js';
import {
  addProjectMember,
  resetDatabase,
  seedWorkspace,
  sha256Bytes,
  insertMessage,
  insertSession,
  type WorkspaceFixture,
} from './fixtures.js';

const pool = createPool(requireDatabaseUrl());
let workspace: WorkspaceFixture;

const REQUIRED_TABLES = [
  'companies',
  'employees',
  'projects',
  'project_members',
  'auth_tokens',
  'sessions',
  'messages',
  'message_revisions',
  'event_receipts',
  'jobs',
  'search_requests',
  'schema_migrations',
];

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

async function insertReceipt(input: { companyId: string; employeeId: string; projectId: string; messageId: string; idempotencyKey: string }): Promise<void> {
  await pool.query(
    `INSERT INTO event_receipts (id, company_id, employee_id, project_id, idempotency_key, request_hash, message_id, revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
    [uuidv7(), input.companyId, input.employeeId, input.projectId, input.idempotencyKey, sha256Bytes('receipt'), input.messageId],
  );
}

async function insertSearchRequest(input: { trigger: 'auto' | 'manual'; inputId: string; sessionId: string; policyVersion?: string }): Promise<void> {
  await pool.query(
    `INSERT INTO search_requests (id, company_id, project_id, employee_id, session_id, input_id, input_revision, input_sequence_no, trigger, policy_version)
     VALUES ($1, $2, $3, $4, $5, $6, 1, 1, $7, $8)`,
    [
      uuidv7(),
      workspace.companyId,
      workspace.projectId,
      workspace.employeeId,
      input.sessionId,
      input.inputId,
      input.trigger,
      input.policyVersion ?? 'initial-v1',
    ],
  );
}

describe('migration管理', () => {
  it('必須テーブルが作られ、migrationは再実行されない', async () => {
    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = new Set(tables.rows.map((row) => row.table_name));
    for (const table of REQUIRED_TABLES) {
      assert.ok(names.has(table), `必須テーブル ${table} がない`);
    }

    const versions = await pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(versions.rows.map((row) => row.version), ['0001_init.sql']);
  });

  it('並行実行でもadvisory lockで1回だけ適用される', async () => {
    const [first, second] = await Promise.all([runMigrations(pool), runMigrations(pool)]);
    assert.deepEqual(first, []);
    assert.deepEqual(second, []);
    const versions = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM schema_migrations');
    assert.equal(versions.rows[0].count, '1');
  });

  it('migrationは明示SQLファイルとして存在する', async () => {
    const files = await readdir(new URL('../migrations', import.meta.url));
    assert.ok(files.includes('0001_init.sql'), '0001_init.sql がない');
    assert.ok(files.every((file) => file.endsWith('.sql')), 'SQL以外のファイルがmigrationsに混在している');
  });

  it('pgvector拡張が有効になっている', async () => {
    const extension = await pool.query<{ extversion: string }>("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    assert.equal(extension.rows.length, 1, 'vector拡張が無効');
    assert.ok(extension.rows[0].extversion.length > 0);
  });
});

describe('カラム型', () => {
  it('IDはuuid、日時はtimestamptz、payload/resultはjsonb、hashはbyteaを使う', async () => {
    const columns = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'",
    );
    const typeOf = (table: string, column: string) =>
      columns.rows.find((row) => row.table_name === table && row.column_name === column)?.data_type;

    const expectations: Array<[string, string, string]> = [
      ['companies', 'id', 'uuid'],
      ['employees', 'company_id', 'uuid'],
      ['projects', 'active_generation_id', 'uuid'],
      ['project_members', 'project_id', 'uuid'],
      ['auth_tokens', 'token_hash', 'bytea'],
      ['sessions', 'started_at', 'timestamp with time zone'],
      ['messages', 'occurred_at', 'timestamp with time zone'],
      ['messages', 'current_revision', 'integer'],
      ['message_revisions', 'content_hash', 'bytea'],
      ['message_revisions', 'received_at', 'timestamp with time zone'],
      ['event_receipts', 'request_hash', 'bytea'],
      ['jobs', 'payload', 'jsonb'],
      ['jobs', 'lease_token', 'uuid'],
      ['jobs', 'lease_expires_at', 'timestamp with time zone'],
      ['search_requests', 'result', 'jsonb'],
      ['search_requests', 'created_at', 'timestamp with time zone'],
    ];
    for (const [table, column, expected] of expectations) {
      assert.equal(typeOf(table, column), expected, `${table}.${column} の型が違う`);
    }
  });

  it('timestamptzは時刻を保持し、textは改行とマルチバイトを無加工で往復する', async () => {
    const sessionId = await insertSession(pool, { projectId: workspace.projectId, employeeId: workspace.employeeId });
    const raw = '行1\n行2\r\n日本語 と 空白  ';
    const occurredAt = new Date('2026-09-21T01:00:00.000Z');
    const { messageId } = await insertMessage(pool, {
      sessionId,
      sourceMessageId: 'msg-roundtrip',
      sequenceNo: 1,
      occurredAt,
      text: raw,
    });

    const row = await pool.query<{ text: string; content_hash: Buffer; occurred_at: Date }>(
      `SELECT r.text, r.content_hash, m.occurred_at FROM message_revisions r JOIN messages m ON m.id = r.message_id WHERE r.message_id = $1`,
      [messageId],
    );
    assert.equal(row.rows[0].text, raw);
    assert.deepEqual(row.rows[0].content_hash, sha256Bytes(raw));
    assert.equal(row.rows[0].occurred_at.toISOString(), occurredAt.toISOString());
  });
});

describe('一意制約', () => {
  it('auth_tokens.token_hashは一意', async () => {
    const hash = sha256Bytes('same-token');
    const insert = () =>
      pool.query('INSERT INTO auth_tokens (id, company_id, employee_id, token_hash) VALUES ($1, $2, $3, $4)', [
        uuidv7(),
        workspace.companyId,
        workspace.employeeId,
        hash,
      ]);
    await insert();
    await expectDbError(insert(), '23505', 'token_hash重複');
  });

  it('sessionsは(source, source_scope, source_session_id)が一意', async () => {
    await insertSession(pool, { projectId: workspace.projectId, employeeId: workspace.employeeId, sourceSessionId: 'dup-session' });
    await expectDbError(
      insertSession(pool, { projectId: workspace.projectId, employeeId: workspace.employeeId, sourceSessionId: 'dup-session' }),
      '23505',
      'session重複',
    );
  });

  it('messagesは(session_id, source_message_id)と(session_id, sequence_no)が一意', async () => {
    const sessionId = await insertSession(pool, { projectId: workspace.projectId, employeeId: workspace.employeeId });
    await insertMessage(pool, { sessionId, sourceMessageId: 'dup-message', sequenceNo: 1 });
    await expectDbError(
      insertMessage(pool, { sessionId, sourceMessageId: 'dup-message', sequenceNo: 2 }),
      '23505',
      'source_message_id重複',
    );
    await expectDbError(
      insertMessage(pool, { sessionId, sourceMessageId: 'other-message', sequenceNo: 1 }),
      '23505',
      'sequence_no重複',
    );
  });

  it('event_receiptsは(company, employee, idempotency key)が一意', async () => {
    const sessionId = await insertSession(pool, { projectId: workspace.projectId, employeeId: workspace.employeeId });
    const { messageId } = await insertMessage(pool, { sessionId, sourceMessageId: 'msg-receipt', sequenceNo: 1 });
    const receipt = { companyId: workspace.companyId, employeeId: workspace.employeeId, projectId: workspace.projectId, messageId, idempotencyKey: 'idem-dup' };
    await insertReceipt(receipt);
    await expectDbError(insertReceipt(receipt), '23505', 'receipt重複');
  });

  it('jobs.idempotency_keyは一意', async () => {
    const insert = (key: string) =>
      pool.query(
        `INSERT INTO jobs (id, kind, status, priority, idempotency_key) VALUES ($1, 'classify_message', 'pending', 0, $2)`,
        [uuidv7(), key],
      );
    await insert('job-key-1');
    await expectDbError(insert('job-key-1'), '23505', 'job冪等キー重複');
  });

  it('search_requestsの自動受付だけが(input_id, input_revision, policy_version)で一意', async () => {
    const sessionId = await insertSession(pool, { projectId: workspace.projectId, employeeId: workspace.employeeId });
    const { messageId } = await insertMessage(pool, { sessionId, sourceMessageId: 'msg-request', sequenceNo: 1 });

    await insertSearchRequest({ trigger: 'auto', inputId: messageId, sessionId });
    await expectDbError(insertSearchRequest({ trigger: 'auto', inputId: messageId, sessionId }), '23505', '自動受付重複');

    await insertSearchRequest({ trigger: 'manual', inputId: messageId, sessionId });
    await insertSearchRequest({ trigger: 'manual', inputId: messageId, sessionId });
    const count = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM search_requests WHERE trigger = 'manual'");
    assert.equal(count.rows[0].count, '2', '手動検索まで一意制約に巻き込まれている');
  });

  it('project_membersは同じ組み合わせを重複登録できない', async () => {
    await expectDbError(addProjectMember(pool, workspace.projectId, workspace.employeeId), '23505', 'member重複');
  });
});

describe('CHECK制約', () => {
  it('source・role・sequence_no・revision・status・kind・triggerの値を制限する', async () => {
    await expectDbError(
      pool.query(
        `INSERT INTO sessions (id, project_id, employee_id, source, source_scope, source_session_id, started_at)
         VALUES ($1, $2, $3, 'other', 'scope', 's', now())`,
        [uuidv7(), workspace.projectId, workspace.employeeId],
      ),
      '23514',
      'source=other',
    );

    const sessionId = await insertSession(pool, { projectId: workspace.projectId, employeeId: workspace.employeeId });
    const insertMessageRaw = (fields: { role?: string; sequenceNo?: number; currentRevision?: number }) =>
      pool.query(
        `INSERT INTO messages (id, session_id, source_message_id, sequence_no, role, occurred_at, current_revision)
         VALUES ($1, $2, $3, $4, $5, now(), $6)`,
        [
          uuidv7(),
          sessionId,
          `msg-${uuidv7()}`,
          fields.sequenceNo ?? 1,
          fields.role ?? 'user',
          fields.currentRevision ?? 1,
        ],
      );
    await expectDbError(insertMessageRaw({ role: 'tool' }), '23514', 'role=tool');
    await expectDbError(insertMessageRaw({ sequenceNo: 0 }), '23514', 'sequence_no=0');
    await expectDbError(insertMessageRaw({ currentRevision: 0 }), '23514', 'current_revision=0');

    await expectDbError(
      pool.query(`INSERT INTO jobs (id, kind, status, idempotency_key) VALUES ($1, 'other', 'pending', $2)`, [uuidv7(), `k-${uuidv7()}`]),
      '23514',
      'job kind=other',
    );
    await expectDbError(
      pool.query(`INSERT INTO jobs (id, kind, status, idempotency_key) VALUES ($1, 'classify_message', 'other', $2)`, [uuidv7(), `k-${uuidv7()}`]),
      '23514',
      'job status=other',
    );

    const { messageId } = await insertMessage(pool, { sessionId, sourceMessageId: 'msg-trigger', sequenceNo: 2 });
    await expectDbError(
      pool.query(
        `INSERT INTO search_requests (id, company_id, project_id, employee_id, session_id, input_id, input_revision, input_sequence_no, trigger, policy_version)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 'other', 'initial-v1')`,
        [uuidv7(), workspace.companyId, workspace.projectId, workspace.employeeId, sessionId, messageId],
      ),
      '23514',
      'trigger=other',
    );
  });

  it('message_revisions.revisionは1以上', async () => {
    const sessionId = await insertSession(pool, { projectId: workspace.projectId, employeeId: workspace.employeeId });
    const { messageId } = await insertMessage(pool, { sessionId, sourceMessageId: 'msg-rev-check', sequenceNo: 1 });
    await expectDbError(
      pool.query('INSERT INTO message_revisions (message_id, revision, text, content_hash) VALUES ($1, 0, $2, $3)', [
        messageId,
        'text',
        sha256Bytes('text'),
      ]),
      '23514',
      'revision=0',
    );
  });
});
