import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// スキーマ管理を排他するadvisory lock。transaction lockなので接続断で自動解放される。
const MIGRATION_LOCK_NAMESPACE = 20260921;
const MIGRATION_LOCK_ID = 1;

// 未適用のSQLファイルを昇順で1トランザクションにまとめて適用し、適用したversionを返す。
// 途中失敗時は全migrationをrollbackし、schema_migrationsへ部分適用を残さない。
export async function runMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const appliedRows = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(appliedRows.rows.map((row) => row.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

    const migrated: string[] = [];
    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      migrated.push(file);
    }

    await client.query('COMMIT');
    return migrated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
