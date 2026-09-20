import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import type { EventInput } from '../contract.js';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { assertNoEventWrites, buildEventBatch, buildEventInput, postEvents } from './support.js';

const pool = createPool(requireDatabaseUrl());
const app = buildApp({ pool });
let workspace: WorkspaceFixture;

const NUL = '\u0000';
const LONE_HIGH_SURROGATE = '\ud800';
const LONE_LOW_SURROGATE = '\udc00';
const EMOJI = '😀';

// JSONエスケープで送る無効文字と、そのpayloadに現れるエスケープ表記。
const INVALID_VALUES = [
  { name: 'NUL', value: NUL, escape: '\\u0000' },
  { name: '単独highサロゲート', value: LONE_HIGH_SURROGATE, escape: '\\ud800' },
  { name: '単独lowサロゲート', value: LONE_LOW_SURROGATE, escape: '\\udc00' },
] as const;

// 原文だけでなく保存・identityに使う受信文字列も境界で拒否する。
const SENSITIVE_FIELDS = ['idempotency_key', 'source_scope', 'source_session_id', 'source_message_id'] as const;

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

describe('POST /v1/events NUL・不正UTF-16', () => {
  it('textのNUL・単独サロゲートは400で全テーブルへ書かない', async () => {
    for (const invalid of INVALID_VALUES) {
      const event = buildEventInput({ text: `前${invalid.value}後` });
      const payload = JSON.stringify(buildEventBatch(workspace.projectId, [event]));
      assert.ok(payload.includes(invalid.escape), `textの${invalid.name}がJSONエスケープで送られていない: ${payload}`);
      const response = await postEvents(app, { token: workspace.token, payload });
      assert.equal(response.statusCode, 400, `textの${invalid.name}が400にならない: ${response.statusCode} ${response.body}`);
      await assertNoEventWrites(pool);
    }
  });

  it('保存・identityに使う文字列のNUL・単独サロゲートは400で全テーブルへ書かない', async () => {
    for (const field of SENSITIVE_FIELDS) {
      for (const invalid of INVALID_VALUES) {
        const overrides: Partial<EventInput> = {};
        overrides[field] = `a${invalid.value}b`;
        const event = buildEventInput(overrides);
        const payload = JSON.stringify(buildEventBatch(workspace.projectId, [event]));
        assert.ok(payload.includes(invalid.escape), `${field}の${invalid.name}がJSONエスケープで送られていない: ${payload}`);
        const response = await postEvents(app, { token: workspace.token, payload });
        assert.equal(
          response.statusCode,
          400,
          `${field}の${invalid.name}が400にならない: ${response.statusCode} ${response.body}`,
        );
        await assertNoEventWrites(pool);
      }
    }
  });

  it('有効なサロゲートペアは保存・identityに使う各文字列と原文で保持される', async () => {
    const event = buildEventInput({
      idempotency_key: `idem-${EMOJI}`,
      source_scope: `scope-${EMOJI}`,
      source_session_id: `session-${EMOJI}`,
      source_message_id: `msg-${EMOJI}`,
      text: `本文${EMOJI}`,
    });
    const payload = JSON.stringify(buildEventBatch(workspace.projectId, [event]));
    const response = await postEvents(app, { token: workspace.token, payload });
    assert.equal(response.statusCode, 202, `有効なサロゲートペアが受理されない: ${response.statusCode} ${response.body}`);

    const stored = await pool.query<{
      text: string;
      source_scope: string;
      source_session_id: string;
      source_message_id: string;
      idempotency_key: string;
    }>(
      `SELECT (SELECT text FROM message_revisions) AS text,
              (SELECT source_scope FROM sessions) AS source_scope,
              (SELECT source_session_id FROM sessions) AS source_session_id,
              (SELECT source_message_id FROM messages) AS source_message_id,
              (SELECT idempotency_key FROM event_receipts) AS idempotency_key`,
    );
    assert.equal(stored.rows[0].text, event.text, '原文のサロゲートペアが変化した');
    assert.equal(
      stored.rows[0].source_scope,
      `v1|${workspace.companyId}|${workspace.employeeId}|${event.source_scope}`,
      'source_scopeのサロゲートペアが変化した、またはscopeの名前空間が変わった',
    );
    assert.equal(stored.rows[0].source_session_id, event.source_session_id, 'source_session_idのサロゲートペアが変化した');
    assert.equal(stored.rows[0].source_message_id, event.source_message_id, 'source_message_idのサロゲートペアが変化した');
    assert.equal(stored.rows[0].idempotency_key, event.idempotency_key, 'idempotency_keyのサロゲートペアが変化した');
  });
});
