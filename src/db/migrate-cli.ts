import { createPool, requireDatabaseUrl } from './pool.js';
import { runMigrations } from './migrator.js';

// スキーマ適用CLI。適用済みmigrationは再実行しない。
const pool = createPool(requireDatabaseUrl());
try {
  const migrated = await runMigrations(pool);
  if (migrated.length === 0) {
    console.log('適用済みのmigrationはありません');
  } else {
    console.log(`適用したmigration: ${migrated.join(', ')}`);
  }
} finally {
  await pool.end();
}
