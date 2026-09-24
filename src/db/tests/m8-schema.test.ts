import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, requireDatabaseUrl } from '../pool.js';
import { runMigrations } from '../migrator.js';

// M8のschema契約。再索引run・検索要求の世代固定・DB検索duration観測を
// `src/db/migrations/0008_m8.sql`で永続化する。runtime DDLは行わない。

const pool = createPool(requireDatabaseUrl());
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const M8_MIGRATION = '0008_m8.sql';

before(async () => {
  await runMigrations(pool);
});

after(async () => {
  await pool.end();
});

async function tableExists(table: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return result.rows.length === 1;
}

async function columnNames(table: string): Promise<Set<string>> {
  const result = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(result.rows.map((row) => row.column_name));
}

// 対象tableのCHECK制約定義を集める。tableが無ければ空配列を返し、呼出元のassertで検出する。
async function checkConstraintDefs(table: string): Promise<string[]> {
  const result = await pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relname = $1 AND c.contype = 'c'`,
    [table],
  );
  return result.rows.map((row) => row.def);
}

describe('M8 schema: 再索引run・世代固定・検索duration', () => {
  it('0008_m8.sqlが存在し、migrationとして適用される', async () => {
    const files = await readdir(MIGRATIONS_DIR);
    assert.ok(files.includes(M8_MIGRATION), `${M8_MIGRATION}が無い（M8 migrationはこのファイル名で追加する）`);
    const applied = await pool.query<{ version: string }>('SELECT version FROM schema_migrations WHERE version = $1', [M8_MIGRATION]);
    assert.equal(applied.rows.length, 1, `${M8_MIGRATION}が適用されていない`);
  });

  it('再開可能なreindex runを永続化するreindex_runsがある', async () => {
    assert.ok(await tableExists('reindex_runs'), 'reindex_runsテーブルがない（再開可能なreindex runの永続化）');
    const columns = await columnNames('reindex_runs');
    for (const name of [
      'id',
      'company_id',
      'project_id',
      'source_generation_id',
      'target_generation_id',
      'status',
      'error_code',
      'created_at',
      'updated_at',
      'completed_at',
    ]) {
      assert.ok(columns.has(name), `reindex_runs.${name}がない`);
    }
    // blocked_policy/retry可能/完了を区別して保持できる。
    const defs = (await checkConstraintDefs('reindex_runs')).join('\n');
    for (const status of ['pending', 'running', 'blocked_policy', 'failed', 'completed']) {
      assert.ok(defs.includes(`'${status}'`), `reindex_runs.statusが${status}を保持できない: ${defs}`);
    }
  });

  it('search_requestsが開始時のembedding_generation_idを固定できる', async () => {
    const columns = await columnNames('search_requests');
    assert.ok(
      columns.has('embedding_generation_id'),
      'search_requests.embedding_generation_idがない（検索要求の開始世代の永続固定）',
    );
    const foreignKeys = await pool.query<{ foreign_table: string }>(
      `SELECT ccu.table_name AS foreign_table
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name = 'search_requests'
          AND kcu.column_name = 'embedding_generation_id'`,
    );
    assert.ok(
      foreignKeys.rows.some((row) => row.foreign_table === 'embedding_generations'),
      'search_requests.embedding_generation_idがembedding_generationsを参照していない',
    );
  });

  it('DB検索durationの観測をsearch_duration_samplesへ永続化し、負値を拒否する', async () => {
    assert.ok(
      await tableExists('search_duration_samples'),
      'search_duration_samplesテーブルがない（DB検索duration観測の永続化）',
    );
    const columns = await columnNames('search_duration_samples');
    for (const name of ['id', 'company_id', 'project_id', 'generation_id', 'duration_ms', 'created_at']) {
      assert.ok(columns.has(name), `search_duration_samples.${name}がない`);
    }
    const defs = (await checkConstraintDefs('search_duration_samples')).join('\n');
    assert.match(defs, /duration_ms\s*>=\s*0/, `search_duration_samples.duration_msの非負CHECKがない: ${defs}`);
  });
});
