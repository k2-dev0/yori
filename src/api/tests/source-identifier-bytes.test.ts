import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import type { EventsResponse } from '../contract.js';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { assertNoEventWrites, buildEventBatch, buildEventInput, postEvents } from './support.js';

const pool = createPool(requireDatabaseUrl());
const app = buildApp({ pool });
let workspace: WorkspaceFixture;
const SOURCE_FIELDS = ['source_scope', 'source_session_id', 'source_message_id'] as const;

// 全て異なるCJK文字で、圧縮で索引サイズの問題が隠れにくい識別子を作る。
const cjkIdentifier = Array.from({ length: 1024 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join('');

before(async () => {
  await runMigrations(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
  workspace = await seedWorkspace(pool);
});

after(async () => {
  await app.close();
  await pool.end();
});

describe('取り込み元識別子のUTF-8バイト上限', () => {
  for (const field of SOURCE_FIELDS) {
    it(`${field}は1024バイトを超える入力を400で拒否する`, async () => {
      const invalidValues = [
        `${'a'.repeat(1021)}😀`,
        `${cjkIdentifier.slice(0, 341)}ab`,
        cjkIdentifier,
      ];
      for (const value of invalidValues) {
        assert.ok(value.length <= 1024, '文字数上限ではなくバイト上限の検証にする');
        assert.ok(Buffer.byteLength(value, 'utf8') > 1024);
        const response = await postEvents(app, {
          token: workspace.token,
          body: buildEventBatch(workspace.projectId, [buildEventInput({ [field]: value })]),
        });
        assert.equal(response.statusCode, 400, `${field}の過大な識別子が400にならない: ${response.body}`);
        await assertNoEventWrites(pool);
      }
    });
  }

  for (const [name, identifier] of [
    ['ASCII', 'a'.repeat(1024)],
    ['CJK', `${cjkIdentifier.slice(0, 341)}a`],
    ['サロゲートペア', `${'a'.repeat(1020)}😀`],
  ] as const) {
    it(`${name}の1024バイト識別子を全フィールドで保存し、再送でも維持する`, async () => {
      assert.equal(Buffer.byteLength(identifier, 'utf8'), 1024);
      const event = buildEventInput({
        source: 'claude_code',
        source_scope: identifier,
        source_session_id: identifier,
        source_message_id: identifier,
      });
      const body = buildEventBatch(workspace.projectId, [event]);
      const first = await postEvents(app, { token: workspace.token, body });
      assert.equal(first.statusCode, 202, `上限ちょうどの識別子が保存できない: ${first.body}`);
      const second = await postEvents(app, { token: workspace.token, body });
      assert.equal(second.statusCode, 202);
      assert.deepEqual(second.json<EventsResponse>(), first.json<EventsResponse>());

      const stored = await pool.query<{
        source_scope: string;
        source_session_id: string;
        source_message_id: string;
      }>(`SELECT s.source_scope, s.source_session_id, m.source_message_id
            FROM messages m JOIN sessions s ON s.id = m.session_id`);
      assert.equal(stored.rows.length, 1);
      assert.equal(stored.rows[0].source_scope, `v1|${workspace.companyId}|${workspace.employeeId}|${identifier}`);
      assert.equal(stored.rows[0].source_session_id, identifier);
      assert.equal(stored.rows[0].source_message_id, identifier);
    });
  }
});
