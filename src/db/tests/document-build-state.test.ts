import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createPool, requireDatabaseUrl } from '../pool.js';
import { runMigrations } from '../migrator.js';
import { seedWorkspace, insertSession, insertMessage } from './fixtures.js';

const pool = createPool(requireDatabaseUrl());
after(async () => { await pool.end(); });

it('0013からの移行で既存sessionを全体構築待ちにし、原文とrevisionを保持する', async () => {
  const name = `yori_build_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${name}`;
  const legacy = createPool(url.toString());
  try {
    const directory = new URL('../migrations/', import.meta.url);
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql') && file < '0014').sort();
    await legacy.query('CREATE TABLE schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      await legacy.query(await readFile(new URL(file, directory), 'utf8'));
      await legacy.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
    }
    const workspace = await seedWorkspace(legacy);
    const sessionId = await insertSession(legacy, { projectId: workspace.projectId, employeeId: workspace.employeeId });
    const { messageId } = await insertMessage(legacy, { sessionId, sourceMessageId: 'legacy', sequenceNo: 1, text: '保持する原文' });
    assert.deepEqual(await runMigrations(legacy), ['0014_document_build_state.sql']);
    const state = await legacy.query('SELECT dirty_sequence, tail, built_version FROM document_build_states WHERE session_id = $1', [sessionId]);
    assert.deepEqual(state.rows, [{ dirty_sequence: '0', tail: null, built_version: null }]);
    assert.equal((await legacy.query('SELECT text FROM message_revisions WHERE message_id = $1 AND revision = 1', [messageId])).rows[0].text, '保持する原文');
    assert.deepEqual(await runMigrations(legacy), []);
    await legacy.query('BEGIN');
    await legacy.query('UPDATE messages SET current_revision = 2 WHERE id = $1', [messageId]);
    await legacy.query('ROLLBACK');
    assert.equal((await legacy.query('SELECT version FROM document_build_states WHERE session_id = $1', [sessionId])).rows[0].version, '0',
      '原文のrollbackで変更番号だけが進んだ');
  } finally {
    await legacy.end();
    await pool.query(`DROP DATABASE ${name} WITH (FORCE)`);
  }
});
