import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { v7 as uuidv7 } from 'uuid';
import { createPool, requireDatabaseUrl } from '../pool.js';
import { runMigrations } from '../migrator.js';
import {
  addProjectMember,
  insertCompany,
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
  'message_analysis',
  'message_relations',
  'provider_policy_approvals',
  'usage_events',
  'schema_migrations',
  // M4: 決定的文書分割・埋め込み世代・公開状態。
  'embedding_generations',
  'search_documents',
  'search_document_revisions',
  'search_document_sources',
  'document_embeddings',
  'document_publications',
  'embedding_cache',
  // M5: 明示識別子の完全一致検索。
  'document_entities',
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
    assert.deepEqual(versions.rows.map((row) => row.version), [
      '0001_init.sql',
      '0002_m3.sql',
      '0003_m3_response_model.sql',
      '0004_m4.sql',
      '0005_m5.sql',
    ]);
  });

  it('並行実行でもadvisory lockで1回だけ適用される', async () => {
    const [first, second] = await Promise.all([runMigrations(pool), runMigrations(pool)]);
    assert.deepEqual(first, []);
    assert.deepEqual(second, []);
    const versions = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM schema_migrations');
    assert.equal(versions.rows[0].count, '5');
  });

  it('migrationは明示SQLファイルとして存在する', async () => {
    const files = await readdir(new URL('../migrations', import.meta.url));
    assert.ok(files.includes('0001_init.sql'), '0001_init.sql がない');
    assert.ok(files.includes('0002_m3.sql'), '0002_m3.sql がない');
    assert.ok(files.includes('0003_m3_response_model.sql'), '0003_m3_response_model.sql がない');
    assert.ok(files.includes('0004_m4.sql'), '0004_m4.sql がない');
    assert.ok(files.includes('0005_m5.sql'), '0005_m5.sql がない');
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
      ['jev_evaluations', 'response_model', 'text'],
      ['usage_events', 'response_model', 'text'],
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

// M4のschema契約。migration名・ファイル名には依存せず、実DBのcatalogで予定schemaの振る舞いを確認する。
const M4_REQUIRED_TABLES = [
  'embedding_generations',
  'search_documents',
  'search_document_revisions',
  'search_document_sources',
  'document_embeddings',
  'document_publications',
  'embedding_cache',
] as const;

async function m4TableColumns(table: string): Promise<Map<string, { dataType: string }>> {
  const result = await pool.query<{ column_name: string; data_type: string }>(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
    [table],
  );
  return new Map(result.rows.map((row) => [row.column_name, { dataType: row.data_type }]));
}

async function requireM4Columns(table: string, columns: readonly string[]): Promise<Map<string, { dataType: string }>> {
  const found = await m4TableColumns(table);
  assert.ok(found.size > 0, `M4の必須テーブル ${table} がない`);
  for (const column of columns) {
    assert.ok(found.has(column), `M4の必須カラム ${table}.${column} がない`);
  }
  return found;
}

function expectColumnType(
  found: Map<string, { dataType: string }>,
  table: string,
  column: string,
  expected: readonly string[],
): void {
  const info = found.get(column);
  assert.ok(info, `M4の必須カラム ${table}.${column} がない`);
  assert.ok(expected.includes(info.dataType), `${table}.${column} の型が違う: ${info.dataType}`);
}

async function m4UniqueColumnSets(table: string): Promise<string[][]> {
  const result = await pool.query<{ columns: string[] }>(
    `SELECT array_agg(a.attname::text ORDER BY key.ordinality) AS columns
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum
      WHERE c.oid = to_regclass($1) AND n.nspname = 'public' AND i.indisunique
      GROUP BY i.indexrelid`,
    [table],
  );
  return result.rows.map((row) => [...row.columns].sort());
}

function expectUniqueKey(actual: readonly string[][], expected: readonly string[], label: string): void {
  const wanted = [...expected].sort();
  assert.ok(
    actual.some((columns) => columns.length === wanted.length && columns.every((column, index) => column === wanted[index])),
    `${label}: 期待するUNIQUE(${expected.join(', ')})がない。実際: ${actual.map((columns) => `(${columns.join(', ')})`).join(' ') || 'なし'}`,
  );
}

describe('M4 schema契約', () => {
  it('M4の必須テーブルがすべて存在する', async () => {
    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = new Set(tables.rows.map((row) => row.table_name));
    for (const table of M4_REQUIRED_TABLES) {
      assert.ok(names.has(table), `M4の必須テーブル ${table} がない`);
    }
  });

  it('projects.active_generation_idはembedding_generations(id)を参照する', async () => {
    await requireM4Columns('embedding_generations', ['id']);
    const constraints = await pool.query<{ columns: string[]; ref_table: string }>(
      `SELECT array_agg(a.attname::text) AS columns, c.confrelid::regclass::text AS ref_table
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = to_regclass('projects') AND c.contype = 'f'
        GROUP BY c.oid, c.confrelid`,
    );
    const target = constraints.rows.find((row) => row.columns.includes('active_generation_id'));
    assert.ok(target, 'projects.active_generation_idの外部キーがない');
    assert.equal(target.ref_table, 'embedding_generations', 'active_generation_idの参照先がembedding_generationsでない');
  });

  it('search_documentsは(project_id, document_key)、search_document_revisionsは(document_id, revision)が一意', async () => {
    await requireM4Columns('search_documents', ['project_id', 'document_key']);
    await requireM4Columns('search_document_revisions', ['document_id', 'revision']);
    expectUniqueKey(
      await m4UniqueColumnSets('search_documents'),
      ['project_id', 'document_key'],
      'search_documents',
    );
    expectUniqueKey(
      await m4UniqueColumnSets('search_document_revisions'),
      ['document_id', 'revision'],
      'search_document_revisions',
    );
  });

  it('document_embeddingsは(document_id, revision, generation_id)、document_publicationsは(document_id, generation_id)が一意', async () => {
    await requireM4Columns('document_embeddings', ['document_id', 'revision', 'generation_id']);
    await requireM4Columns('document_publications', ['document_id', 'generation_id']);
    expectUniqueKey(
      await m4UniqueColumnSets('document_embeddings'),
      ['document_id', 'revision', 'generation_id'],
      'document_embeddings',
    );
    expectUniqueKey(
      await m4UniqueColumnSets('document_publications'),
      ['document_id', 'generation_id'],
      'document_publications',
    );
  });

  it('document_embeddingsはvector(1024)列をちょうど1つ持つ', async () => {
    await requireM4Columns('document_embeddings', ['document_id', 'revision', 'generation_id']);
    const columns = await pool.query<{ attname: string; column_type: string }>(
      `SELECT attname, format_type(atttypid, atttypmod) AS column_type
         FROM pg_attribute
        WHERE attrelid = to_regclass('document_embeddings') AND attnum > 0 AND NOT attisdropped`,
    );
    const vectors = columns.rows.filter((row) => row.column_type === 'vector(1024)');
    assert.equal(
      vectors.length,
      1,
      `vector(1024)列が1つでない。実際: ${columns.rows.map((row) => `${row.attname}:${row.column_type}`).join(', ')}`,
    );
    assert.ok(
      columns.rows.some((row) => /hash/.test(row.attname)),
      'document_embeddingsに入力hash列がない',
    );
  });

  it('search_document_revisions.statusはpending/embedding/ready/failed/superseded/excludedだけを許す', async () => {
    await requireM4Columns('search_document_revisions', ['status']);
    const constraints = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = to_regclass('search_document_revisions') AND contype = 'c'`,
    );
    const definition = constraints.rows.map((row) => row.definition).join(' ');
    for (const status of ['pending', 'embedding', 'ready', 'failed', 'superseded', 'excluded']) {
      assert.ok(definition.includes(`'${status}'`), `revision status制約に ${status} がない: ${definition}`);
    }
  });

  it('search_document_sourcesはmessage_id/message_revision/UTF-16 offset/display_orderを保持する', async () => {
    const found = await requireM4Columns('search_document_sources', [
      'document_id',
      'revision',
      'message_id',
      'message_revision',
      'display_order',
    ]);
    const names = [...found.keys()];
    const startColumns = names.filter((name) => /(start|begin)/.test(name));
    const endColumns = names.filter((name) => /(end|stop)/.test(name));
    assert.ok(startColumns.length >= 1, `search_document_sourcesにstart offset列がない。実際: ${names.join(', ')}`);
    assert.ok(endColumns.length >= 1, `search_document_sourcesにend offset列がない。実際: ${names.join(', ')}`);
    for (const name of [...startColumns, ...endColumns]) {
      expectColumnType(found, 'search_document_sources', name, ['smallint', 'integer', 'bigint']);
    }
  });

  it('embedding_generationsはprovider/model/dimensions/statusとtokenizer・前処理版・metricを保持する', async () => {
    const found = await requireM4Columns('embedding_generations', ['id', 'provider', 'model', 'dimensions', 'status']);
    expectColumnType(found, 'embedding_generations', 'dimensions', ['smallint', 'integer', 'bigint']);
    expectColumnType(found, 'embedding_generations', 'provider', ['text', 'character varying']);
    expectColumnType(found, 'embedding_generations', 'model', ['text', 'character varying']);
    const names = [...found.keys()];
    assert.ok(names.some((name) => /token/.test(name)), `tokenizer版の列がない。実際: ${names.join(', ')}`);
    assert.ok(names.some((name) => /(document|doc)/.test(name)), `document前処理版の列がない。実際: ${names.join(', ')}`);
    assert.ok(names.some((name) => /query/.test(name)), `query前処理版の列がない。実際: ${names.join(', ')}`);
    assert.ok(names.some((name) => /(metric|distance)/.test(name)), `距離方式の列がない。実際: ${names.join(', ')}`);
  });

  it('embedding_cacheはcompany_id/generation/operation/input hashで一意', async () => {
    await requireM4Columns('embedding_cache', ['company_id']);
    const uniqueKeys = await m4UniqueColumnSets('embedding_cache');
    const cacheKey = uniqueKeys.find(
      (columns) =>
        columns.includes('company_id') &&
        columns.some((column) => /generation/.test(column)) &&
        columns.some((column) => /operation/.test(column)) &&
        columns.some((column) => /hash/.test(column)),
    );
    assert.ok(
      cacheKey,
      `embedding_cacheの一意キーがcompany+generation+operation+input hashでない。実際: ${uniqueKeys.map((columns) => `(${columns.join(', ')})`).join(' ') || 'なし'}`,
    );
  });

  it('search_document_sourcesは(message_id, message_revision)をmessage_revisionsへ複合FKで保証する', async () => {
    await requireM4Columns('search_document_sources', ['message_id', 'message_revision']);
    const constraints = await pool.query<{ columns: string[]; ref_table: string }>(
      `SELECT array_agg(a.attname::text ORDER BY key.ordinality) AS columns, c.confrelid::regclass::text AS ref_table
         FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum
        WHERE c.conrelid = to_regclass('search_document_sources') AND c.contype = 'f'
        GROUP BY c.oid, c.confrelid`,
    );
    const target = constraints.rows.find(
      (row) =>
        row.ref_table === 'message_revisions' &&
        row.columns.includes('message_id') &&
        row.columns.includes('message_revision'),
    );
    assert.ok(
      target,
      `message_revisionsへの複合FK(message_id, message_revision)がない。実際: ${
        constraints.rows.map((row) => `${row.ref_table}(${row.columns.join(', ')})`).join(' ') || 'なし'
      }`,
    );
  });

  it('embedding_generations.dimensionsは1..2000だけを許す', async () => {
    const boundary = await insertEmbeddingGeneration({ companyId: workspace.companyId, dimensions: 2_000 });
    assert.ok(boundary, 'dimensions=2000が登録できない');
    await expectDbError(
      insertEmbeddingGeneration({ companyId: workspace.companyId, dimensions: 0 }),
      '23514',
      'dimensions=0',
    );
    await expectDbError(
      insertEmbeddingGeneration({ companyId: workspace.companyId, dimensions: 2_001 }),
      '23514',
      'dimensions=2001',
    );
  });

  it('projectsは別会社のgenerationをactive世代にできず、同一会社だけを複合FKで許す', async () => {
    const ownGenerationId = await insertEmbeddingGeneration({ companyId: workspace.companyId });
    await pool.query('UPDATE projects SET active_generation_id = $2 WHERE id = $1', [workspace.projectId, ownGenerationId]);

    const otherCompanyId = await insertCompany(pool, 'company-other');
    const otherGenerationId = await insertEmbeddingGeneration({ companyId: otherCompanyId });
    await expectDbError(
      pool.query('UPDATE projects SET active_generation_id = $2 WHERE id = $1', [workspace.projectId, otherGenerationId]),
      '23503',
      '別会社generationのactive参照',
    );
  });

  async function insertEmbeddingGeneration(input: { companyId: string; dimensions?: number; status?: string }): Promise<string> {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO embedding_generations
         (id, company_id, provider, account_ref, endpoint, model, dimensions, metric, tokenizer_version,
          document_input_type, query_input_type, normalization, status)
       VALUES ($1, $2, 'voyage_direct', 'acct-a', 'https://api.voyageai.com/v1/embeddings', 'voyage-4-lite', $3, 'cosine',
               'test-tokenizer', 'document', 'query', 'provider_default', $4)`,
      [id, input.companyId, input.dimensions ?? 1024, input.status ?? 'active'],
    );
    return id;
  }

  it('search_documents/search_document_revisions/document_publicationsの必須カラム型', async () => {
    const documents = await requireM4Columns('search_documents', [
      'id',
      'company_id',
      'project_id',
      'session_id',
      'document_key',
      'desired_revision',
      'is_searchable',
    ]);
    expectColumnType(documents, 'search_documents', 'desired_revision', ['smallint', 'integer', 'bigint']);
    expectColumnType(documents, 'search_documents', 'is_searchable', ['boolean']);

    const revisions = await requireM4Columns('search_document_revisions', [
      'document_id',
      'revision',
      'chunker_version',
      'status',
    ]);
    expectColumnType(revisions, 'search_document_revisions', 'revision', ['smallint', 'integer', 'bigint']);
    expectColumnType(revisions, 'search_document_revisions', 'chunker_version', ['text', 'character varying']);
    expectColumnType(revisions, 'search_document_revisions', 'status', ['text', 'character varying']);
    assert.ok(
      ['text', 'search_text', 'body', 'content'].some((name) => revisions.has(name)),
      `search_document_revisionsの検索本文列がない。実際: ${[...revisions.keys()].join(', ')}`,
    );

    const publications = await requireM4Columns('document_publications', ['document_id', 'generation_id', 'revision']);
    expectColumnType(publications, 'document_publications', 'revision', ['smallint', 'integer', 'bigint']);
    assert.ok(
      [...publications.entries()].some(([name, info]) => /stale/.test(name) && info.dataType === 'boolean'),
      'document_publicationsのstale boolean列がない',
    );
  });
});
