import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../../api/app.js';
import type { EventsResponse } from '../../api/contract.js';
import { runMigrations } from '../../db/migrator.js';
import { createPool } from '../../db/pool.js';
import { countRows, resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { collectFromHook } from '../collect.js';
import {
  ackResponse,
  buildHook,
  codexMessageLine,
  codexSessionLine,
  createCollectorFixture,
  installFetchMock,
  writeTranscript,
} from './support.js';

// collectorが生成したbatchを既存Fastify app.injectへ渡し、実PostgreSQLで保存・重複・自動検索受付を確認する。
const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase: (name: string, fn: () => void) => void = databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('collector → 既存APIの縦通し (DATABASE_URL必須)', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let workspace: WorkspaceFixture;

  before(async () => {
    pool = createPool(databaseUrl as string);
    app = buildApp({ pool });
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    workspace = await seedWorkspace(pool, { repositoryIdentifier: 'github.test/Org/Repo' });
  });

  after(async () => {
    await app.close();
    await pool.end();
  });

  it('collectorのbatchを202で受理し、原文・重複なし・自動検索受付を保存する', async () => {
    assert.ok(databaseUrl, 'DATABASE_URLが未設定');
    const fixture = await createCollectorFixture({
      remoteUrl: 'https://github.test/Org/Repo.git',
      binding: { repository: 'github.test/Org/Repo', project_id: workspace.projectId },
    });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-db'),
        codexMessageLine({ sessionId: 'session-db', messageId: 'item-user', role: 'user', text: '質問本文' }),
        codexMessageLine({ sessionId: 'session-db', messageId: 'item-assistant', role: 'assistant', text: '回答本文' }),
      ]);
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-db', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: workspace.token,
      };

      await collectFromHook(options);
      assert.equal(mock.requests.length, 1);
      const body = mock.requests[0].body;

      const response = await app.inject({
        method: 'POST',
        url: '/v1/events',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${workspace.token}` },
        payload: body,
      });
      assert.equal(response.statusCode, 202, `受付に失敗: ${response.body}`);
      const results = response.json<EventsResponse>().results;
      assert.equal(results.length, 2);

      const messages = await pool.query<{ role: string; sequence_no: number; source_message_id: string; text: string }>(
        `SELECT m.role, m.sequence_no, m.source_message_id, r.text
           FROM messages m
           JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
          ORDER BY m.sequence_no`,
      );
      assert.deepEqual(
        messages.rows.map((row) => [row.role, row.sequence_no, row.source_message_id, row.text]),
        [
          ['user', 1, 'item-user', '質問本文'],
          ['assistant', 2, 'item-assistant', '回答本文'],
        ],
      );
      const sessionRow = await pool.query<{ source: string; source_scope: string; source_session_id: string }>(
        'SELECT source, source_scope, source_session_id FROM sessions',
      );
      assert.equal(sessionRow.rows.length, 1);
      assert.equal(sessionRow.rows[0].source, 'codex');
      // 既存APIはsource_scopeへ会社・社員の前置きを付けて保存する（src/api/events.ts）。
      assert.equal(sessionRow.rows[0].source_scope, `v1|${workspace.companyId}|${workspace.employeeId}|github.test/Org/Repo`);
      assert.equal(sessionRow.rows[0].source_session_id, 'session-db');
      assert.equal(await countRows(pool, 'search_requests'), 1, 'user発言の自動検索受付が保存されていない');

      // 同じbodyの再送（応答消失後の再送相当）は同じmessage_idを返し、行を増やさない。
      const replay = await app.inject({
        method: 'POST',
        url: '/v1/events',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${workspace.token}` },
        payload: body,
      });
      assert.equal(replay.statusCode, 202, `再送に失敗: ${replay.body}`);
      assert.deepEqual(
        replay.json<EventsResponse>().results.map((result) => result.message_id),
        results.map((result) => result.message_id),
      );
      assert.equal(await countRows(pool, 'messages'), 2);
      assert.equal(await countRows(pool, 'search_requests'), 1);

      // 送信済みのcollector再実行は新規送信もDB重複も起こさない。
      const secondMock = installFetchMock(ackResponse);
      try {
        await collectFromHook(options);
        assert.equal(secondMock.requests.length, 0, '送信済みの発言を再送している');
      } finally {
        secondMock.restore();
      }
      assert.equal(await countRows(pool, 'messages'), 2);
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });
});

