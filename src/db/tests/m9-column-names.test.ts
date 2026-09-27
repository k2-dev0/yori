import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { createPool, requireDatabaseUrl } from '../pool.js';
import { runMigrations } from '../migrator.js';
import {
  insertMessage,
  insertSession,
  resetDatabase,
  seedWorkspace,
  sha256Bytes,
  type WorkspaceFixture,
} from './fixtures.js';

const pool = createPool(requireDatabaseUrl());
let workspace: WorkspaceFixture;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const COLUMN_NAMES_MIGRATION = '0009_column_names.sql';
const PREVIOUS_MIGRATIONS = [
  '0001_init.sql',
  '0002_m3.sql',
  '0003_m3_response_model.sql',
  '0004_m4.sql',
  '0005_m5.sql',
  '0006_m6.sql',
  '0007_m7.sql',
  '0008_m8.sql',
] as const;

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

async function readMigrationFile(file: string): Promise<string> {
  try {
    return await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  } catch {
    assert.fail(`${file} が存在しない`);
  }
}

async function tableColumns(client: Pool, table: string): Promise<Map<string, { dataType: string; isNullable: string; columnDefault: string | null }>> {
  const result = await client.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
    [table],
  );
  return new Map(result.rows.map((row) => [row.column_name, { dataType: row.data_type, isNullable: row.is_nullable, columnDefault: row.column_default }]));
}

async function uniqueColumnSets(client: Pool, table: string): Promise<string[][]> {
  const result = await client.query<{ columns: string[] }>(
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

async function foreignKeyColumns(client: Pool, table: string): Promise<Array<{ columns: string[]; refTable: string }>> {
  const result = await client.query<{ columns: string[]; ref_table: string }>(
    `SELECT array_agg(a.attname::text ORDER BY key.ordinality) AS columns, c.confrelid::regclass::text AS ref_table
       FROM pg_constraint c
       JOIN unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum
      WHERE c.conrelid = to_regclass($1) AND c.contype = 'f'
      GROUP BY c.oid, c.confrelid`,
    [table],
  );
  return result.rows.map((row) => ({ columns: row.columns, refTable: row.ref_table }));
}

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

describe('M9 カラム命名移行のschema契約', () => {
  it('rename後の新カラムが実DBに存在し、型とNULL許可を引き継ぐ', async () => {
    const renamed: Array<{ table: string; column: string; dataType: string; nullable: string }> = [
      { table: 'sessions', column: 'source_namespace', dataType: 'text', nullable: 'NO' },
      { table: 'message_analysis', column: 'response_models', dataType: 'jsonb', nullable: 'NO' },
      { table: 'message_analysis', column: 'retention_category', dataType: 'text', nullable: 'NO' },
      { table: 'message_relations', column: 'from_message_id', dataType: 'uuid', nullable: 'NO' },
      { table: 'message_relations', column: 'from_message_revision', dataType: 'integer', nullable: 'NO' },
      { table: 'message_relations', column: 'to_message_id', dataType: 'uuid', nullable: 'NO' },
      { table: 'message_relations', column: 'to_message_revision', dataType: 'integer', nullable: 'NO' },
      { table: 'provider_policy_approvals', column: 'training_disabled', dataType: 'boolean', nullable: 'NO' },
      { table: 'provider_policy_approvals', column: 'is_active', dataType: 'boolean', nullable: 'NO' },
      { table: 'search_requests', column: 'input_message_id', dataType: 'uuid', nullable: 'NO' },
      { table: 'search_requests', column: 'input_message_revision', dataType: 'integer', nullable: 'NO' },
      { table: 'event_receipts', column: 'search_request_id', dataType: 'uuid', nullable: 'YES' },
      { table: 'event_receipts', column: 'message_revision', dataType: 'integer', nullable: 'NO' },
      { table: 'search_document_sources', column: 'document_revision', dataType: 'integer', nullable: 'NO' },
      { table: 'jev_evaluations', column: 'requested_model', dataType: 'text', nullable: 'NO' },
      { table: 'usage_events', column: 'requested_model', dataType: 'text', nullable: 'NO' },
      { table: 'document_publications', column: 'is_stale', dataType: 'boolean', nullable: 'NO' },
    ];
    for (const item of renamed) {
      const columns = await tableColumns(pool, item.table);
      const found = columns.get(item.column);
      assert.ok(found, `新カラム ${item.table}.${item.column} がない`);
      assert.equal(found.dataType, item.dataType, `${item.table}.${item.column} の型が違う`);
      assert.equal(found.isNullable, item.nullable, `${item.table}.${item.column} のNULL許可が違う`);
    }

    const defaults: Array<[string, string, string]> = [
      ['provider_policy_approvals', 'training_disabled', 'false'],
      ['provider_policy_approvals', 'is_active', 'true'],
      ['document_publications', 'is_stale', 'false'],
    ];
    for (const [table, column, expected] of defaults) {
      const found = (await tableColumns(pool, table)).get(column);
      assert.ok(found?.columnDefault?.includes(expected), `${table}.${column} の既定値 ${expected} を失っている: ${String(found?.columnDefault)}`);
    }
  });

  it('旧カラムは消え、rename対象外の同名カラムは残る', async () => {
    const removed: Array<[string, string]> = [
      ['sessions', 'source_scope'],
      ['message_analysis', 'model_version'],
      ['message_analysis', 'retention'],
      ['message_relations', 'source_message_id'],
      ['message_relations', 'source_revision'],
      ['message_relations', 'target_message_id'],
      ['message_relations', 'target_revision'],
      ['provider_policy_approvals', 'learning_disabled'],
      ['provider_policy_approvals', 'active'],
      ['search_requests', 'input_id'],
      ['search_requests', 'input_revision'],
      ['search_requests', 'original_request_id'],
      ['event_receipts', 'request_id'],
      ['event_receipts', 'revision'],
      ['search_document_sources', 'revision'],
      ['jev_evaluations', 'model'],
      ['usage_events', 'model'],
      ['document_publications', 'stale'],
    ];
    const cache = new Map<string, Map<string, unknown>>();
    for (const [table, column] of removed) {
      const columns = cache.get(table) ?? (await tableColumns(pool, table));
      cache.set(table, columns);
      assert.ok(!columns.has(column), `旧カラム ${table}.${column} が残っている`);
    }

    const retained: Array<[string, string]> = [
      ['messages', 'source_message_id'],
      ['message_revisions', 'revision'],
      ['jobs', 'target_revision'],
      ['embedding_generations', 'model'],
      ['search_document_sources', 'message_revision'],
      ['event_receipts', 'message_id'],
      ['usage_events', 'response_model'],
      ['jev_evaluations', 'response_model'],
      ['provider_policy_approvals', 'retention_terms'],
      ['sessions', 'source_session_id'],
      ['document_publications', 'revision'],
    ];
    for (const [table, column] of retained) {
      const columns = cache.get(table) ?? (await tableColumns(pool, table));
      cache.set(table, columns);
      assert.ok(columns.has(column), `rename対象外の ${table}.${column} を失っている`);
    }
  });

  it('rename後も一意制約・部分索引・複合FKの意味が保たれる', async () => {
    expectUniqueKey(await uniqueColumnSets(pool, 'sessions'), ['source', 'source_namespace', 'source_session_id'], 'sessions');
    expectUniqueKey(
      await uniqueColumnSets(pool, 'message_relations'),
      ['from_message_id', 'from_message_revision', 'to_message_id', 'to_message_revision', 'relation', 'policy_version'],
      'message_relations',
    );
    expectUniqueKey(await uniqueColumnSets(pool, 'document_publications'), ['document_id', 'generation_id'], 'document_publications');
    expectUniqueKey(
      await uniqueColumnSets(pool, 'event_receipts'),
      ['company_id', 'employee_id', 'idempotency_key'],
      'event_receipts',
    );

    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'",
    );
    const indexDef = (name: string) => indexes.rows.find((row) => row.indexname === name)?.indexdef ?? '';
    const autoIndex = indexDef('search_requests_auto_input_idx');
    for (const column of ['input_message_id', 'input_message_revision', 'policy_version']) {
      assert.ok(autoIndex.includes(column), `search_requests_auto_input_idx に ${column} がない: ${autoIndex}`);
    }
    assert.ok(autoIndex.includes("trigger = 'auto'"), `search_requests_auto_input_idx の自動受付条件を失っている: ${autoIndex}`);
    const activeIndex = indexDef('provider_policy_approvals_active_idx');
    assert.ok(activeIndex.includes('is_active'), `provider_policy_approvals_active_idx がis_active限定でない: ${activeIndex}`);
    const sourceIndex = indexDef('search_document_sources_document_idx');
    assert.ok(sourceIndex.includes('document_revision'), `search_document_sources_document_idx がdocument_revisionでない: ${sourceIndex}`);

    const sourceForeignKeys = await foreignKeyColumns(pool, 'search_document_sources');
    assert.ok(
      sourceForeignKeys.some(
        (foreignKey) =>
          foreignKey.refTable === 'message_revisions' &&
          foreignKey.columns.includes('message_id') &&
          foreignKey.columns.includes('message_revision'),
      ),
      `search_document_sourcesの複合FK(message_id, message_revision)がない: ${JSON.stringify(sourceForeignKeys)}`,
    );
    assert.ok(
      sourceForeignKeys.some(
        (foreignKey) =>
          foreignKey.refTable === 'search_document_revisions' &&
          foreignKey.columns.includes('document_id') &&
          foreignKey.columns.includes('document_revision'),
      ),
      `search_document_sourcesの複合FK(document_id, document_revision)がない: ${JSON.stringify(sourceForeignKeys)}`,
    );
    const receiptForeignKeys = await foreignKeyColumns(pool, 'event_receipts');
    assert.ok(
      receiptForeignKeys.some((foreignKey) => foreignKey.refTable === 'search_requests' && foreignKey.columns.includes('search_request_id')),
      `event_receipts.search_request_idのFKがない: ${JSON.stringify(receiptForeignKeys)}`,
    );
    const searchForeignKeys = await foreignKeyColumns(pool, 'search_requests');
    assert.ok(
      searchForeignKeys.some((foreignKey) => foreignKey.refTable === 'search_requests' && foreignKey.columns.includes('reused_from_request_id')),
      `search_requests.reused_from_request_idの自己FKがない: ${JSON.stringify(searchForeignKeys)}`,
    );
  });

  it('新カラムはDB制約を維持し、不正値・重複・不正参照を拒否する', async () => {
    const sessionId = await insertSession(pool, {
      projectId: workspace.projectId,
      employeeId: workspace.employeeId,
      sourceSessionId: 'm9-unique',
    });
    await expectDbError(
      insertSession(pool, { projectId: workspace.projectId, employeeId: workspace.employeeId, sourceSessionId: 'm9-unique' }),
      '23505',
      'sessions(source_namespace)一意',
    );

    const { messageId } = await insertMessage(pool, { sessionId, sourceMessageId: 'm9-message', sequenceNo: 1 });
    const { messageId: otherMessageId } = await insertMessage(pool, { sessionId, sourceMessageId: 'm9-message-2', sequenceNo: 2 });
    const insertRelation = () =>
      pool.query(
        `INSERT INTO message_relations
           (id, from_message_id, from_message_revision, to_message_id, to_message_revision, relation, is_explicit, policy_version, evidence_ranges)
         VALUES ($1, $2, 1, $3, 1, 'change', true, 'initial-v1', '[]'::jsonb)`,
        [uuidv7(), messageId, otherMessageId],
      );
    await insertRelation();
    await expectDbError(insertRelation(), '23505', 'message_relations一意');

    const insertSearch = (revision: number) =>
      pool.query(
        `INSERT INTO search_requests
           (id, company_id, project_id, employee_id, session_id, input_message_id, input_message_revision, input_sequence_no, trigger, policy_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'auto', 'initial-v1')`,
        [uuidv7(), workspace.companyId, workspace.projectId, workspace.employeeId, sessionId, messageId, revision],
      );
    await insertSearch(1);
    await expectDbError(insertSearch(1), '23505', 'search_requests自動受付一意');
    await expectDbError(insertSearch(0), '23514', 'input_message_revision=0');

    const insertReceipt = (revision: number, requestId: string | null) =>
      pool.query(
        `INSERT INTO event_receipts
           (id, company_id, employee_id, project_id, idempotency_key, request_hash, message_id, message_revision, search_request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          uuidv7(),
          workspace.companyId,
          workspace.employeeId,
          workspace.projectId,
          `m9-${uuidv7()}`,
          sha256Bytes('m9-receipt'),
          messageId,
          revision,
          requestId,
        ],
      );
    await expectDbError(insertReceipt(0, null), '23514', 'message_revision=0');
    await expectDbError(insertReceipt(1, uuidv7()), '23503', 'search_request_id不正参照');

    await pool.query(
      `INSERT INTO message_analysis
         (id, message_id, revision, policy_version, retention_category, primary_intent, technical_labels, decision_action,
          continuity, statement_status, is_searchable, response_models, state_hash, parts)
       VALUES ($1, $2, 1, 'initial-v1', 'substantive', 'implementation', '[]'::jsonb, 'none', 'same_topic', 'request', true,
               '["model-a", "model-b"]'::jsonb, $3, '[]'::jsonb)`,
      [uuidv7(), messageId, sha256Bytes('m9-analysis')],
    );
    const analysis = await pool.query<{ response_models: string[] }>(
      'SELECT response_models FROM message_analysis WHERE message_id = $1 AND revision = 1',
      [messageId],
    );
    assert.deepEqual(analysis.rows[0]?.response_models, ['model-a', 'model-b'], 'response_modelsがjsonb文字列配列で往復しない');
    await expectDbError(
      pool.query('UPDATE message_analysis SET response_models = NULL WHERE message_id = $1', [messageId]),
      '23502',
      'response_models NOT NULL',
    );

    const insertApproval = (active: boolean) =>
      pool.query(
        `INSERT INTO provider_policy_approvals
           (id, company_id, provider, account_ref, endpoint, terms_url, terms_checked_at, training_disabled,
            retention_terms, confirmed_by, confirmed_at, is_active)
         VALUES ($1, $2, 'jev', 'acct-m9', 'https://m9.example/v1', 'https://m9.example/terms', now(), false,
                 'terms', 'admin', now(), $3)`,
        [uuidv7(), workspace.companyId, active],
      );
    await insertApproval(true);
    await expectDbError(insertApproval(true), '23505', 'is_active部分一意');
    await insertApproval(false);
    const approvals = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM provider_policy_approvals WHERE account_ref = 'acct-m9'",
    );
    assert.equal(approvals.rows[0]?.count, '2', '失効済み承認を追加できない');
  });
});

describe('M9 従来schemaからのdata preservation', () => {
  it('0008適用済みDBへ0009を適用し、rename・値変換・FK・unique・再実行を保持する', async () => {
    const migrationSql = await readMigrationFile(COLUMN_NAMES_MIGRATION);
    const databaseName = `yori_m9_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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
      const employeeId = uuidv7();
      const projectId = uuidv7();
      const sessionId = uuidv7();
      const messageId = uuidv7();
      const otherMessageId = uuidv7();
      const generationId = uuidv7();
      const documentId = uuidv7();
      const originRequestId = uuidv7();
      const reusedOnlyRequestId = uuidv7();
      const originalOnlyRequestId = uuidv7();
      const bothRequestId = uuidv7();
      await legacy.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [companyId, 'legacy-company']);
      await legacy.query('INSERT INTO employees (id, company_id, display_name) VALUES ($1, $2, $3)', [employeeId, companyId, 'legacy-employee']);
      await legacy.query('INSERT INTO projects (id, company_id, repository_identifier) VALUES ($1, $2, $3)', [projectId, companyId, 'legacy-repo']);
      await legacy.query(
        `INSERT INTO sessions (id, project_id, employee_id, source, source_scope, source_session_id, started_at)
         VALUES ($1, $2, $3, 'codex', 'legacy-scope', 'legacy-session', now())`,
        [sessionId, projectId, employeeId],
      );
      for (const [id, sourceMessageId, sequenceNo] of [
        [messageId, 'legacy-message', 1],
        [otherMessageId, 'legacy-message-2', 2],
      ] as const) {
        await legacy.query(
          `INSERT INTO messages (id, session_id, source_message_id, sequence_no, role, occurred_at, current_revision)
           VALUES ($1, $2, $3, $4, 'user', now(), 1)`,
          [id, sessionId, sourceMessageId, sequenceNo],
        );
        await legacy.query(
          'INSERT INTO message_revisions (message_id, revision, text, content_hash) VALUES ($1, 1, $2, $3)',
          [id, `legacy text ${sequenceNo}`, sha256Bytes(`legacy text ${sequenceNo}`)],
        );
      }

      const legacyParts = JSON.stringify([
        { offset: 0, length: 3, retention: 'substantive', model_version: 'model-a' },
        { offset: 3, length: 4, retention: 'progress_only' },
      ]);
      const analyses: Array<{ revision: number; retention: string; modelVersion: string; parts: string }> = [
        { revision: 1, retention: 'substantive', modelVersion: '', parts: legacyParts },
        { revision: 2, retention: 'progress_only', modelVersion: 'model-single', parts: '[]' },
        { revision: 3, retention: 'unknown', modelVersion: '["model-a","model-b"]', parts: '[]' },
      ];
      for (const item of analyses) {
        await legacy.query(
          `INSERT INTO message_analysis
             (id, message_id, revision, policy_version, retention, primary_intent, technical_labels, decision_action,
              continuity, statement_status, is_searchable, model_version, state_hash, parts)
           VALUES ($1, $2, $3, 'initial-v1', $4, 'implementation', '[]'::jsonb, 'none', 'same_topic', 'request', true, $5, $6, $7::jsonb)`,
          [uuidv7(), messageId, item.revision, item.retention, item.modelVersion, sha256Bytes(`state-${item.revision}`), item.parts],
        );
      }
      const insertLegacyRequest = (id: string, reusedFrom: string | null, original: string | null) =>
        legacy.query(
          `INSERT INTO search_requests
             (id, company_id, project_id, employee_id, session_id, input_id, input_revision, input_sequence_no,
              trigger, status, outcome, policy_version, reused_from_request_id, original_request_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 'manual', 'completed', 'matched', 'initial-v1', $7, $8, now(), now())`,
          [id, companyId, projectId, employeeId, sessionId, messageId, reusedFrom, original],
        );
      await insertLegacyRequest(originRequestId, null, null);
      await insertLegacyRequest(reusedOnlyRequestId, originRequestId, null);
      await insertLegacyRequest(originalOnlyRequestId, null, originRequestId);
      await insertLegacyRequest(bothRequestId, originRequestId, originalOnlyRequestId);
      await legacy.query(
        `INSERT INTO event_receipts
           (id, company_id, employee_id, project_id, idempotency_key, request_hash, message_id, revision, request_id)
         VALUES ($1, $2, $3, $4, 'legacy-idem', $5, $6, 1, $7)`,
        [uuidv7(), companyId, employeeId, projectId, sha256Bytes('legacy-receipt'), messageId, originRequestId],
      );
      await legacy.query(
        `INSERT INTO message_relations
           (id, source_message_id, source_revision, target_message_id, target_revision, relation, is_explicit, evidence_ranges, policy_version)
         VALUES ($1, $2, 1, $3, 1, 'change', true, '[]'::jsonb, 'initial-v1')`,
        [uuidv7(), messageId, otherMessageId],
      );
      await legacy.query(
        `INSERT INTO provider_policy_approvals
           (id, company_id, provider, account_ref, endpoint, terms_url, terms_checked_at, learning_disabled,
            retention_terms, confirmed_by, confirmed_at, active)
         VALUES ($1, $2, 'jev', 'legacy-acct', 'https://legacy.example/v1', 'https://legacy.example/terms', now(), true,
                 'terms', 'admin', now(), true)`,
        [uuidv7(), companyId],
      );
      await legacy.query(
        `INSERT INTO provider_policy_approvals
           (id, company_id, provider, account_ref, endpoint, terms_url, terms_checked_at, learning_disabled,
            retention_terms, confirmed_by, confirmed_at, active)
         VALUES ($1, $2, 'jev', 'legacy-acct-old', 'https://legacy.example/v1', 'https://legacy.example/terms', now(), false,
                 'terms', 'admin', now(), false)`,
        [uuidv7(), companyId],
      );
      await legacy.query(
        `INSERT INTO embedding_generations
           (id, company_id, provider, account_ref, endpoint, model, dimensions, metric, tokenizer_version,
            document_input_type, query_input_type, normalization, status)
         VALUES ($1, $2, 'voyage_direct', 'acct-a', 'https://legacy.example/embeddings', 'voyage-4-lite', 1024, 'cosine',
                 'tokenizer', 'document', 'query', 'provider_default', 'active')`,
        [generationId, companyId],
      );
      await legacy.query(
        `INSERT INTO search_documents
           (id, company_id, project_id, session_id, document_key, desired_revision, is_searchable)
         VALUES ($1, $2, $3, $4, 'legacy-document', 1, true)`,
        [documentId, companyId, projectId, sessionId],
      );
      await legacy.query(
        `INSERT INTO search_document_revisions (document_id, revision, content, content_hash, chunker_version, status)
         VALUES ($1, 1, 'legacy document', $2, 'chunker-v1', 'ready')`,
        [documentId, sha256Bytes('legacy document')],
      );
      await legacy.query(
        `INSERT INTO search_document_sources
           (id, document_id, revision, message_id, message_revision, start_offset, end_offset, display_order, source_kind)
         VALUES ($1, $2, 1, $3, 1, 0, 10, 0, 'original')`,
        [uuidv7(), documentId, messageId],
      );
      await legacy.query(
        `INSERT INTO document_publications (document_id, generation_id, revision, stale)
         VALUES ($1, $2, 1, false)`,
        [documentId, generationId],
      );
      await legacy.query(
        `INSERT INTO jev_evaluations
           (id, company_id, provider, account_ref, endpoint, model, confidence_threshold, policy_version, questions_version,
            state_hash, answers, response_model)
         VALUES ($1, $2, 'jev', 'acct-a', 'https://legacy.example/jev', 'jev-alias', 0.8, 'initial-v1', 'q-v1', $3, '{}'::jsonb, 'jev-actual')`,
        [uuidv7(), companyId, sha256Bytes('legacy-evaluation')],
      );
      await legacy.query(
        `INSERT INTO usage_events
           (id, company_id, provider, account_ref, endpoint, operation, model, input_tokens, output_tokens, duration_ms, success, response_model)
         VALUES ($1, $2, 'jev', 'acct-a', 'https://legacy.example/jev', 'classify', 'jev-alias', 10, 5, 100, true, 'jev-actual')`,
        [uuidv7(), companyId],
      );

      await legacy.query(migrationSql);
      await legacy.query('INSERT INTO schema_migrations (version) VALUES ($1)', [COLUMN_NAMES_MIGRATION]);

      const sessions = await legacy.query<{ source_namespace: string }>('SELECT source_namespace FROM sessions WHERE id = $1', [sessionId]);
      assert.equal(sessions.rows[0]?.source_namespace, 'legacy-scope', 'source_scopeの値がsource_namespaceへ移っていない');
      await expectDbError(
        legacy.query(
          `INSERT INTO sessions (id, project_id, employee_id, source, source_namespace, source_session_id, started_at)
           VALUES ($1, $2, $3, 'codex', 'legacy-scope', 'legacy-session', now())`,
          [uuidv7(), projectId, employeeId],
        ),
        '23505',
        '移行後のsessions一意',
      );

      const migratedAnalyses = await legacy.query<{
        revision: number;
        retention_category: string;
        response_models: string[];
        parts: Array<Record<string, unknown>>;
      }>(
        'SELECT revision, retention_category, response_models, parts FROM message_analysis WHERE message_id = $1 ORDER BY revision',
        [messageId],
      );
      assert.deepEqual(
        migratedAnalyses.rows.map((row) => row.response_models),
        [[], ['model-single'], ['model-a', 'model-b']],
        'model_versionの空文字・単一・JSON配列がresponse_modelsへ変換されていない',
      );
      assert.deepEqual(
        migratedAnalyses.rows.map((row) => row.retention_category),
        ['substantive', 'progress_only', 'unknown'],
        'retentionがretention_categoryへ移っていない',
      );
      const firstParts = migratedAnalyses.rows[0]?.parts ?? [];
      assert.equal(firstParts.length, 2, 'partsの要素数が変わった');
      assert.deepEqual(
        { offset: firstParts[0]?.offset, length: firstParts[0]?.length, retention: firstParts[0]?.retention, response_model: firstParts[0]?.response_model },
        { offset: 0, length: 3, retention: 'substantive', response_model: 'model-a' },
        'parts[0]のmodel_versionがresponse_modelへ移っていない、または他情報を失っている',
      );
      assert.ok(!Object.hasOwn(firstParts[0] ?? {}, 'model_version'), 'parts[0]にmodel_versionが残っている');
      assert.deepEqual(
        { offset: firstParts[1]?.offset, length: firstParts[1]?.length, retention: firstParts[1]?.retention },
        { offset: 3, length: 4, retention: 'progress_only' },
        'model_versionのないpartの情報を失っている',
      );
      assert.ok(!Object.hasOwn(firstParts[1] ?? {}, 'model_version'), 'parts[1]にmodel_versionが残っている');

      const relations = await legacy.query<{
        from_message_id: string;
        from_message_revision: number;
        to_message_id: string;
        to_message_revision: number;
      }>('SELECT from_message_id, from_message_revision, to_message_id, to_message_revision FROM message_relations');
      assert.deepEqual(
        relations.rows.map((row) => [row.from_message_id, row.from_message_revision, row.to_message_id, row.to_message_revision]),
        [[messageId, 1, otherMessageId, 1]],
        'message_relationsの値が新カラムへ移っていない',
      );
      await expectDbError(
        legacy.query(
          `INSERT INTO message_relations
             (id, from_message_id, from_message_revision, to_message_id, to_message_revision, relation, is_explicit, evidence_ranges, policy_version)
           VALUES ($1, $2, 1, $3, 1, 'change', true, '[]'::jsonb, 'initial-v1')`,
          [uuidv7(), messageId, otherMessageId],
        ),
        '23505',
        '移行後のmessage_relations一意',
      );

      const requests = await legacy.query<{ id: string; reused_from_request_id: string | null }>(
        'SELECT id, reused_from_request_id FROM search_requests',
      );
      const reusedFrom = new Map(requests.rows.map((row) => [row.id, row.reused_from_request_id]));
      assert.equal(reusedFrom.get(originRequestId), null, '直接受付のreuse参照を作っている');
      assert.equal(reusedFrom.get(reusedOnlyRequestId), originRequestId, 'reused_from_request_idの値を失っている');
      assert.equal(reusedFrom.get(originalOnlyRequestId), originRequestId, 'original_request_idだけの参照を失っている');
      assert.equal(
        reusedFrom.get(bothRequestId),
        originalOnlyRequestId,
        '旧buildViewが優先したoriginal_request_idがreused_from_request_idへ引き継がれていない',
      );
      assert.ok(!(await tableColumns(legacy, 'search_requests')).has('original_request_id'), 'original_request_idが残っている');

      const receipts = await legacy.query<{ search_request_id: string | null; message_revision: number }>(
        'SELECT search_request_id, message_revision FROM event_receipts',
      );
      assert.deepEqual(
        receipts.rows.map((row) => [row.search_request_id, row.message_revision]),
        [[originRequestId, 1]],
        'event_receiptsのrequest_id/revisionが新カラムへ移っていない',
      );
      await expectDbError(
        legacy.query(
          `INSERT INTO event_receipts
             (id, company_id, employee_id, project_id, idempotency_key, request_hash, message_id, message_revision, search_request_id)
           VALUES ($1, $2, $3, $4, 'legacy-idem-check', $5, $6, 0, NULL)`,
          [uuidv7(), companyId, employeeId, projectId, sha256Bytes('legacy-receipt-check'), messageId],
        ),
        '23514',
        '移行後のmessage_revision CHECK',
      );

      const approvals = await legacy.query<{ account_ref: string; training_disabled: boolean; is_active: boolean }>(
        'SELECT account_ref, training_disabled, is_active FROM provider_policy_approvals ORDER BY account_ref',
      );
      assert.deepEqual(
        approvals.rows.map((row) => [row.account_ref, row.training_disabled, row.is_active]),
        [
          ['legacy-acct', true, true],
          ['legacy-acct-old', false, false],
        ],
        'learning_disabled/activeの値がtraining_disabled/is_activeへ移っていない',
      );
      await expectDbError(
        legacy.query(
          `INSERT INTO provider_policy_approvals
             (id, company_id, provider, account_ref, endpoint, terms_url, terms_checked_at, training_disabled,
              retention_terms, confirmed_by, confirmed_at, is_active)
           VALUES ($1, $2, 'jev', 'legacy-acct', 'https://legacy.example/v1', 'https://legacy.example/terms', now(), true,
                   'terms', 'admin', now(), true)`,
          [uuidv7(), companyId],
        ),
        '23505',
        '移行後のis_active部分一意',
      );

      const sources = await legacy.query<{ document_revision: number; message_revision: number }>(
        'SELECT document_revision, message_revision FROM search_document_sources',
      );
      assert.deepEqual(sources.rows.map((row) => [row.document_revision, row.message_revision]), [[1, 1]], 'document_revisionへ移っていない');
      await expectDbError(
        legacy.query(
          `INSERT INTO search_document_sources
             (id, document_id, document_revision, message_id, message_revision, start_offset, end_offset, display_order, source_kind)
           VALUES ($1, $2, 1, $3, 99, 0, 1, 1, 'original')`,
          [uuidv7(), documentId, messageId],
        ),
        '23503',
        '移行後のsearch_document_sources複合FK',
      );
      const publications = await legacy.query<{ is_stale: boolean }>('SELECT is_stale FROM document_publications');
      assert.deepEqual(publications.rows.map((row) => row.is_stale), [false], 'staleの値がis_staleへ移っていない');

      const evaluations = await legacy.query<{ requested_model: string; response_model: string | null }>(
        'SELECT requested_model, response_model FROM jev_evaluations',
      );
      assert.deepEqual(
        evaluations.rows.map((row) => [row.requested_model, row.response_model]),
        [['jev-alias', 'jev-actual']],
        'jev_evaluations.modelがrequested_modelへ移っていない、またはresponse_modelを壊している',
      );
      const usage = await legacy.query<{ requested_model: string; response_model: string | null }>(
        'SELECT requested_model, response_model FROM usage_events',
      );
      assert.deepEqual(
        usage.rows.map((row) => [row.requested_model, row.response_model]),
        [['jev-alias', 'jev-actual']],
        'usage_events.modelがrequested_modelへ移っていない、またはresponse_modelを壊している',
      );

      assert.deepEqual(await runMigrations(legacy), [], '0009適用後の再実行でmigrationが再適用された');
      const afterRerun = await legacy.query<{ count: string }>('SELECT count(*)::text AS count FROM sessions');
      assert.equal(afterRerun.rows[0]?.count, '1', '再実行でデータが変わった');
      const afterRerunAnalysis = await legacy.query<{ response_models: string[] }>(
        'SELECT response_models FROM message_analysis WHERE message_id = $1 AND revision = 3',
        [messageId],
      );
      assert.deepEqual(afterRerunAnalysis.rows[0]?.response_models, ['model-a', 'model-b'], '再実行で変換結果が壊れた');
    } finally {
      await legacy.end();
      await pool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    }
  });
});
