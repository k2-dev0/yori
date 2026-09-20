import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import type { EventInput, EventsResponse } from '../contract.js';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import {
  addProjectMember,
  countRows,
  insertCompany,
  insertEmployee,
  issueAuthToken,
  resetDatabase,
} from '../../db/tests/fixtures.js';
import { buildEventBatch, buildEventInput, canonicalReceiptHash, postEvents } from './support.js';

const pool = createPool(requireDatabaseUrl());
const app = buildApp({ pool });

// 英字を必ず含む固定project UUID。UUIDは大文字小文字を区別しない意味的同一性を持つ。
const PROJECT_ID = 'abcdef01-2345-7abc-8def-0123456789ab';
const UPPER_PROJECT_ID = PROJECT_ID.toUpperCase();

interface CaseWorkspace {
  companyId: string;
  employeeId: string;
  token: string;
}

let workspace: CaseWorkspace;

before(async () => {
  await runMigrations(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
  const companyId = await insertCompany(pool);
  const employeeId = await insertEmployee(pool, companyId);
  await pool.query('INSERT INTO projects (id, company_id, repository_identifier) VALUES ($1, $2, $3)', [
    PROJECT_ID,
    companyId,
    'repo-case',
  ]);
  await addProjectMember(pool, PROJECT_ID, employeeId);
  const token = await issueAuthToken(pool, companyId, employeeId);
  workspace = { companyId, employeeId, token };
});

after(async () => {
  await app.close();
  await pool.end();
});

// 同一sessionの2件batch。意味的に同じproject UUIDの大文字表記と小文字表記で送る。
function buildCaseEvents(): EventInput[] {
  return [
    buildEventInput({
      idempotency_key: 'idem-case-1',
      source_message_id: 'msg-case-1',
      sequence_no: 1,
      text: '大文字projectのuser発言',
    }),
    buildEventInput({
      idempotency_key: 'idem-case-2',
      source_message_id: 'msg-case-2',
      sequence_no: 2,
      role: 'assistant',
      text: '大文字projectのAI発言',
    }),
  ];
}

describe('POST /v1/events project_idのUUID表記ゆれ', () => {
  it('大文字のproject UUIDを受理し、小文字表記の再送は同一IDを返して重複しない', async () => {
    const events = buildCaseEvents();
    const first = await postEvents(app, { token: workspace.token, body: buildEventBatch(UPPER_PROJECT_ID, events) });
    assert.equal(first.statusCode, 202, `大文字project_idのbatchが202にならない: ${first.statusCode} ${first.body}`);
    const firstBody = first.json<EventsResponse>();

    const sessions = await pool.query<{ project_id: string }>('SELECT project_id FROM sessions');
    assert.equal(sessions.rows.length, 1, '同一sessionになるべきbatchでsessionが増えた');
    assert.equal(sessions.rows[0].project_id, PROJECT_ID, 'DBのproject_idが正規形(小文字)でない');

    const second = await postEvents(app, { token: workspace.token, body: buildEventBatch(PROJECT_ID, events) });
    assert.equal(second.statusCode, 202, `小文字表記の再送が202にならない: ${second.statusCode} ${second.body}`);
    assert.deepEqual(second.json<EventsResponse>(), firstBody, '意味的に同一のproject_id再送が同じIDを返さない');

    assert.equal(await countRows(pool, 'sessions'), 1);
    assert.equal(await countRows(pool, 'messages'), 2);
    assert.equal(await countRows(pool, 'message_revisions'), 2);
    assert.equal(await countRows(pool, 'event_receipts'), 2);

    const receipts = await pool.query<{ idempotency_key: string; request_hash: Buffer }>(
      'SELECT idempotency_key, request_hash FROM event_receipts',
    );
    for (const event of events) {
      const receipt = receipts.rows.find((row) => row.idempotency_key === event.idempotency_key);
      assert.ok(receipt, `receiptが保存されていない: ${event.idempotency_key}`);
      assert.deepEqual(
        receipt.request_hash,
        canonicalReceiptHash({ ...event, company_id: workspace.companyId, employee_id: workspace.employeeId, project_id: PROJECT_ID }),
        `${event.idempotency_key}のrequest_hashが正規化されたproject_idで計算されていない`,
      );
    }
  });
});
