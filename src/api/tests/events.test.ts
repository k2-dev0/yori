import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validate as isUuid, version as uuidVersion } from 'uuid';
import { buildApp } from '../app.js';
import { AUTO_SEARCH_POLICY_VERSION, MAX_TEXT_LENGTH, type EventInput, type EventsResponse } from '../contract.js';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import {
  addProjectMember,
  countRows,
  insertCompany,
  insertEmployee,
  insertProject,
  issueAuthToken,
  resetDatabase,
  revokeAuthToken,
  seedWorkspace,
  sha256Bytes,
  type WorkspaceFixture,
} from '../../db/tests/fixtures.js';
import { assertNoEventWrites, buildEventBatch, buildEventInput, canonicalReceiptHash, postEvents } from './support.js';

const pool = createPool(requireDatabaseUrl());
const app = buildApp({ pool });
let workspace: WorkspaceFixture;

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

function assertUuidV7(value: unknown): void {
  assert.equal(typeof value, 'string', `UUIDv7が文字列ではない: ${String(value)}`);
  assert.ok(isUuid(value as string), `UUID形式ではない: ${String(value)}`);
  assert.equal(uuidVersion(value as string), 7, `UUIDv7ではない: ${String(value)}`);
}

describe('POST /v1/events 正常保存', () => {
  it('userイベントを202で受理し、原文・classify job・自動検索受付を同一TXで保存する', async () => {
    const userText = '改行\nと日本語テキスト\r\nと行末空白  ';
    const assistantText = ' 前後空白を保持するAI発言 ';
    const user = buildEventInput({ idempotency_key: 'idem-user-1', source_message_id: 'msg-1', sequence_no: 1, text: userText });
    const assistant = buildEventInput({
      idempotency_key: 'idem-assistant-1',
      source_message_id: 'msg-2',
      sequence_no: 2,
      role: 'assistant',
      text: assistantText,
    });

    const response = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [user, assistant]) });

    assert.equal(response.statusCode, 202, `受付に失敗: ${response.body}`);
    const body = response.json<EventsResponse>();
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].idempotency_key, 'idem-user-1');
    assertUuidV7(body.results[0].message_id);
    assert.equal(body.results[0].revision, 1);
    assertUuidV7(body.results[0].request_id);
    assert.equal(body.results[1].idempotency_key, 'idem-assistant-1');
    assertUuidV7(body.results[1].message_id);
    assert.equal(body.results[1].revision, 1);
    assert.equal(body.results[1].request_id, null);

    const userMessageId = body.results[0].message_id;
    const assistantMessageId = body.results[1].message_id;

    const messageRows = await pool.query<{
      id: string;
      session_id: string;
      sequence_no: number;
      role: string;
      occurred_at: Date;
      current_revision: number;
    }>('SELECT id, session_id, sequence_no, role, occurred_at, current_revision FROM messages ORDER BY sequence_no');
    assert.equal(messageRows.rows.length, 2);
    assert.equal(messageRows.rows[0].role, 'user');
    assert.equal(messageRows.rows[1].role, 'assistant');
    assert.equal(messageRows.rows[0].sequence_no, 1);
    assert.equal(messageRows.rows[1].sequence_no, 2);
    assert.equal(messageRows.rows[0].occurred_at.toISOString(), '2026-09-21T01:00:00.000Z');
    assert.equal(messageRows.rows[0].current_revision, 1);
    assert.equal(messageRows.rows[1].current_revision, 1);

    const sessionRow = await pool.query<{
      id: string;
      project_id: string;
      employee_id: string;
      source: string;
      source_scope: string;
      source_session_id: string;
    }>('SELECT id, project_id, employee_id, source, source_scope, source_session_id FROM sessions');
    assert.equal(sessionRow.rows.length, 1);
    assert.equal(sessionRow.rows[0].project_id, workspace.projectId);
    assert.equal(sessionRow.rows[0].employee_id, workspace.employeeId);
    assert.equal(sessionRow.rows[0].source, 'codex');
    assert.equal(sessionRow.rows[0].source_session_id, 'session-a');
    assert.ok(sessionRow.rows[0].source_scope.length > 0);

    // revisionはmessage単位で照合する。同一revision数のSQL行順は定義されないため、message_idで引く。
    const userRevision = await pool.query<{ revision: number; text: string; content_hash: Buffer }>(
      'SELECT revision, text, content_hash FROM message_revisions WHERE message_id = $1',
      [userMessageId],
    );
    assert.equal(userRevision.rows.length, 1);
    assert.equal(userRevision.rows[0].revision, 1);
    assert.equal(userRevision.rows[0].text, userText);
    assert.deepEqual(userRevision.rows[0].content_hash, sha256Bytes(userText));

    const assistantRevision = await pool.query<{ revision: number; text: string; content_hash: Buffer }>(
      'SELECT revision, text, content_hash FROM message_revisions WHERE message_id = $1',
      [assistantMessageId],
    );
    assert.equal(assistantRevision.rows.length, 1);
    assert.equal(assistantRevision.rows[0].revision, 1);
    assert.equal(assistantRevision.rows[0].text, assistantText);
    assert.deepEqual(assistantRevision.rows[0].content_hash, sha256Bytes(assistantText));
    assert.equal(await countRows(pool, 'message_revisions'), 2);

    const jobs = await pool.query<{
      kind: string;
      status: string;
      session_id: string | null;
      message_id: string | null;
      target_revision: number | null;
    }>('SELECT kind, status, session_id, message_id, target_revision FROM jobs');
    assert.equal(jobs.rows.filter((row) => row.kind === 'classify_message').length, 2, 'classify jobは発言ごとに1件');
    assert.equal(jobs.rows.filter((row) => row.kind === 'route_search').length, 1, 'route_search jobはuser発言にだけ1件');
    for (const job of jobs.rows) {
      assert.equal(job.status, 'pending');
      assert.equal(job.session_id, sessionRow.rows[0].id);
    }
    const userClassify = jobs.rows.find((row) => row.kind === 'classify_message' && row.message_id === userMessageId);
    assert.equal(userClassify?.target_revision, 1);
    const routeJob = jobs.rows.find((row) => row.kind === 'route_search');
    assert.equal(routeJob?.message_id, userMessageId);

    const requests = await pool.query<{
      id: string;
      company_id: string;
      project_id: string;
      employee_id: string;
      session_id: string;
      input_id: string;
      input_revision: number;
      input_sequence_no: number;
      trigger: string;
      status: string;
      policy_version: string;
    }>(
      'SELECT id, company_id, project_id, employee_id, session_id, input_id, input_revision, input_sequence_no, trigger, status, policy_version FROM search_requests',
    );
    assert.equal(requests.rows.length, 1);
    const searchRequest = requests.rows[0];
    assert.equal(searchRequest.company_id, workspace.companyId);
    assert.equal(searchRequest.project_id, workspace.projectId);
    assert.equal(searchRequest.employee_id, workspace.employeeId);
    assert.equal(searchRequest.session_id, sessionRow.rows[0].id);
    assert.equal(searchRequest.input_id, userMessageId);
    assert.equal(searchRequest.input_revision, 1);
    assert.equal(searchRequest.input_sequence_no, 1);
    assert.equal(searchRequest.trigger, 'auto');
    assert.equal(searchRequest.status, 'pending');
    assert.equal(searchRequest.policy_version, AUTO_SEARCH_POLICY_VERSION);
    assertUuidV7(searchRequest.id);
    assert.equal(body.results[0].request_id, searchRequest.id);

    const receipts = await pool.query<{
      idempotency_key: string;
      request_hash: Buffer;
      message_id: string;
      revision: number;
      request_id: string | null;
    }>('SELECT idempotency_key, request_hash, message_id, revision, request_id FROM event_receipts');
    assert.equal(receipts.rows.length, 2);
    const userReceipt = receipts.rows.find((row) => row.idempotency_key === 'idem-user-1');
    assert.equal(userReceipt?.message_id, userMessageId);
    assert.equal(userReceipt?.revision, 1);
    assert.equal(userReceipt?.request_id, searchRequest.id);
    assert.deepEqual(
      userReceipt?.request_hash,
      canonicalReceiptHash({
        ...user,
        company_id: workspace.companyId,
        employee_id: workspace.employeeId,
        project_id: workspace.projectId,
      }),
    );
  });

  it('occurred_atはオフセット付きISO日時を同一時刻として保存する', async () => {
    const event = buildEventInput({ occurred_at: '2026-09-21T10:00:00.000+09:00', text: 'オフセット確認' });
    const response = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [event]) });
    assert.equal(response.statusCode, 202, `受付に失敗: ${response.body}`);

    const rows = await pool.query<{ occurred_at: Date }>('SELECT occurred_at FROM messages');
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].occurred_at.toISOString(), '2026-09-21T01:00:00.000Z');
  });

  it('assistant・agent_reportは自動検索を作らず、AIを起動しない', async () => {
    const assistant = buildEventInput({
      idempotency_key: 'idem-a',
      source_message_id: 'msg-a',
      sequence_no: 1,
      source: 'claude_code',
      role: 'assistant',
      text: 'AIの回答',
    });
    const report = buildEventInput({
      idempotency_key: 'idem-r',
      source_message_id: 'msg-r',
      sequence_no: 2,
      role: 'agent_report',
      text: '作業報告',
    });

    const response = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [assistant, report]) });
    assert.equal(response.statusCode, 202, `受付に失敗: ${response.body}`);
    const body = response.json<EventsResponse>();
    assert.equal(body.results[0].request_id, null);
    assert.equal(body.results[1].request_id, null);

    assert.equal(await countRows(pool, 'search_requests'), 0, 'AI発言に自動検索を作っている');
    assert.equal(await countRows(pool, 'jobs'), 2, 'classify jobは発言ごとのみ');
    const kinds = await pool.query<{ kind: string }>('SELECT DISTINCT kind FROM jobs');
    assert.deepEqual(
      kinds.rows.map((row) => row.kind).sort(),
      ['classify_message'],
    );
  });

  it('source_scopeはcompany/employee単位で分離され、別社員の同名sessionは別になる', async () => {
    const employeeB = await insertEmployee(pool, workspace.companyId, 'employee-b');
    await addProjectMember(pool, workspace.projectId, employeeB);
    const tokenB = await issueAuthToken(pool, workspace.companyId, employeeB);

    const shared = {
      source_scope: 'shared-scope',
      source_session_id: 'shared-session',
      source_message_id: 'shared-msg',
      sequence_no: 1,
    };
    const eventA = buildEventInput({ ...shared, idempotency_key: 'idem-a', text: 'Aの発言' });
    const eventB = buildEventInput({ ...shared, idempotency_key: 'idem-b', text: 'Bの発言' });

    const responseA = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [eventA]) });
    assert.equal(responseA.statusCode, 202, `Aの受付に失敗: ${responseA.body}`);
    const responseB = await postEvents(app, { token: tokenB, body: buildEventBatch(workspace.projectId, [eventB]) });
    assert.equal(responseB.statusCode, 202, `Bの受付に失敗: ${responseB.body}`);
    assert.notEqual(responseA.json<EventsResponse>().results[0].message_id, responseB.json<EventsResponse>().results[0].message_id);

    const sessions = await pool.query<{ id: string; employee_id: string; source_session_id: string }>(
      'SELECT id, employee_id, source_session_id FROM sessions',
    );
    assert.equal(sessions.rows.length, 2, '別社員の同名sessionが1件に統合されている');
    assert.deepEqual(sessions.rows.map((row) => row.employee_id).sort(), [workspace.employeeId, employeeB].sort());
    for (const session of sessions.rows) {
      assert.equal(session.source_session_id, 'shared-session');
    }
    assert.equal(await countRows(pool, 'messages'), 2);
  });
});

describe('POST /v1/events 冪等・revision', () => {
  it('再送は同じIDを返し、message・revision・job・検索受付を増殖させない', async () => {
    const user = buildEventInput({ idempotency_key: 'idem-rs', source_message_id: 'msg-rs', text: '再送対象の本文' });
    const batch = buildEventBatch(workspace.projectId, [user]);

    const first = await postEvents(app, { token: workspace.token, body: batch });
    assert.equal(first.statusCode, 202, `初回受付に失敗: ${first.body}`);
    const firstBody = first.json<EventsResponse>();

    const second = await postEvents(app, { token: workspace.token, body: batch });
    assert.equal(second.statusCode, 202, `再送に失敗: ${second.body}`);
    assert.deepEqual(second.json<EventsResponse>(), firstBody, '同じ冪等キーの再送が同じ結果を返さない');

    assert.equal(await countRows(pool, 'messages'), 1);
    assert.equal(await countRows(pool, 'message_revisions'), 1);
    assert.equal(await countRows(pool, 'jobs'), 2);
    assert.equal(await countRows(pool, 'search_requests'), 1);
    assert.equal(await countRows(pool, 'event_receipts'), 1);
    assert.equal(await countRows(pool, 'sessions'), 1);

    const withNewKey = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, [{ ...user, idempotency_key: 'idem-rs-2' }]),
    });
    assert.equal(withNewKey.statusCode, 202, `別キーでの再送に失敗: ${withNewKey.body}`);
    const newKeyBody = withNewKey.json<EventsResponse>();
    assert.equal(newKeyBody.results[0].message_id, firstBody.results[0].message_id, '同message/revision/本文で別IDになった');
    assert.equal(newKeyBody.results[0].revision, 1);
    assert.equal(newKeyBody.results[0].request_id, firstBody.results[0].request_id, '自動検索受付が増殖した');
    assert.equal(await countRows(pool, 'message_revisions'), 1);
    assert.equal(await countRows(pool, 'jobs'), 2);
    assert.equal(await countRows(pool, 'search_requests'), 1);
    assert.equal(await countRows(pool, 'event_receipts'), 2);

    const conflict = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, [{ ...user, text: '改変された本文' }]),
    });
    assert.equal(conflict.statusCode, 409, `異内容の再送が409にならない: ${conflict.body}`);
    const stored = await pool.query<{ text: string }>('SELECT text FROM message_revisions');
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].text, '再送対象の本文', '409時に保存済み原文が書き換わった');
  });

  it('同じeventの並行再送は全て202で同じIDを返し、保存行を増やさない', async () => {
    const user = buildEventInput({ idempotency_key: 'idem-cc-1', source_message_id: 'msg-cc', text: '並行再送の本文' });
    const batch = buildEventBatch(workspace.projectId, [user]);

    // 同一キーで同時に再送しても、message・revision・job・検索受付・receiptは1回分だけ保存する。
    const sameKeyResponses = await Promise.all(Array.from({ length: 4 }, () => postEvents(app, { token: workspace.token, body: batch })));
    const firstBody = sameKeyResponses[0].json<EventsResponse>();
    for (const response of sameKeyResponses) {
      assert.equal(response.statusCode, 202, `並行再送に失敗: ${response.body}`);
      assert.deepEqual(response.json<EventsResponse>(), firstBody, '並行再送が同じ結果を返さない');
    }
    assert.equal(await countRows(pool, 'messages'), 1);
    assert.equal(await countRows(pool, 'message_revisions'), 1);
    assert.equal(await countRows(pool, 'jobs'), 2);
    assert.equal(await countRows(pool, 'search_requests'), 1);
    assert.equal(await countRows(pool, 'event_receipts'), 1);
    assert.equal(await countRows(pool, 'sessions'), 1);

    // 別の冪等キーでも、同じsource identity・revision・本文なら同じmessage/受付へ集約し、receiptだけ増える。
    const otherKeyResponses = await Promise.all(
      ['idem-cc-2', 'idem-cc-3'].map((key) =>
        postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [{ ...user, idempotency_key: key }]) }),
      ),
    );
    for (const response of otherKeyResponses) {
      assert.equal(response.statusCode, 202, `別キーの並行再送に失敗: ${response.body}`);
      const result = response.json<EventsResponse>().results[0];
      assert.equal(result.message_id, firstBody.results[0].message_id, '同じsource identityが別messageになった');
      assert.equal(result.revision, 1);
      assert.equal(result.request_id, firstBody.results[0].request_id, '自動検索受付が増殖した');
    }
    assert.equal(await countRows(pool, 'messages'), 1);
    assert.equal(await countRows(pool, 'message_revisions'), 1);
    assert.equal(await countRows(pool, 'jobs'), 2);
    assert.equal(await countRows(pool, 'search_requests'), 1);
    assert.equal(await countRows(pool, 'event_receipts'), 3);
    assert.equal(await countRows(pool, 'sessions'), 1);
  });

  it('revisionは1から始まり、更新はcurrent+1、過去revisionの再送はcurrentを巻き戻さない', async () => {
    const identity = { source_message_id: 'msg-rev', sequence_no: 3 };
    const first = buildEventInput({ ...identity, idempotency_key: 'idem-v1', revision: 1, text: '初版' });
    const firstResponse = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [first]) });
    assert.equal(firstResponse.statusCode, 202, `初版の受付に失敗: ${firstResponse.body}`);
    const messageId = firstResponse.json<EventsResponse>().results[0].message_id;

    const second = buildEventInput({ ...identity, idempotency_key: 'idem-v2', revision: 2, text: '改訂版' });
    const secondResponse = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [second]) });
    assert.equal(secondResponse.statusCode, 202, `revision 2の受付に失敗: ${secondResponse.body}`);
    assert.equal(secondResponse.json<EventsResponse>().results[0].message_id, messageId);
    assert.equal(secondResponse.json<EventsResponse>().results[0].revision, 2);

    let message = await pool.query<{ current_revision: number }>('SELECT current_revision FROM messages');
    assert.equal(message.rows[0].current_revision, 2);
    const revisions = await pool.query<{ revision: number; text: string; content_hash: Buffer }>(
      'SELECT revision, text, content_hash FROM message_revisions ORDER BY revision',
    );
    assert.deepEqual(revisions.rows.map((row) => row.revision), [1, 2]);
    assert.deepEqual(revisions.rows.map((row) => row.text), ['初版', '改訂版']);
    assert.deepEqual(revisions.rows[1].content_hash, sha256Bytes('改訂版'));

    const pastResend = buildEventInput({ ...identity, idempotency_key: 'idem-v1-again', revision: 1, text: '初版' });
    const pastResponse = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [pastResend]) });
    assert.equal(pastResponse.statusCode, 202, `過去revision再送に失敗: ${pastResponse.body}`);
    assert.equal(pastResponse.json<EventsResponse>().results[0].message_id, messageId);
    assert.equal(pastResponse.json<EventsResponse>().results[0].revision, 1);
    message = await pool.query<{ current_revision: number }>('SELECT current_revision FROM messages');
    assert.equal(message.rows[0].current_revision, 2, '過去revisionの再送でcurrent_revisionが巻き戻った');
    assert.equal(await countRows(pool, 'message_revisions'), 2);

    const sameRevisionResend = buildEventInput({ ...identity, idempotency_key: 'idem-v2-again', revision: 2, text: '改訂版' });
    const sameResponse = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [sameRevisionResend]) });
    assert.equal(sameResponse.statusCode, 202, `同revision再送に失敗: ${sameResponse.body}`);
    assert.equal(await countRows(pool, 'message_revisions'), 2);

    const sameRevisionDifferentText = buildEventInput({ ...identity, idempotency_key: 'idem-v2-bad', revision: 2, text: '別の本文' });
    const badResponse = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [sameRevisionDifferentText]) });
    assert.equal(badResponse.statusCode, 409, `同revision異内容が409にならない: ${badResponse.body}`);
    assert.equal(await countRows(pool, 'message_revisions'), 2);

    const skippedRevision = buildEventInput({ ...identity, idempotency_key: 'idem-v4', revision: 4, text: '飛越した本文' });
    const skipResponse = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [skippedRevision]) });
    assert.equal(skipResponse.statusCode, 409, `revision飛越しが409にならない: ${skipResponse.body}`);
    assert.equal(await countRows(pool, 'message_revisions'), 2);

    const third = buildEventInput({ ...identity, idempotency_key: 'idem-v3', revision: 3, text: '第3版' });
    const thirdResponse = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [third]) });
    assert.equal(thirdResponse.statusCode, 202, `revision 3の受付に失敗: ${thirdResponse.body}`);
    message = await pool.query<{ current_revision: number }>('SELECT current_revision FROM messages');
    assert.equal(message.rows[0].current_revision, 3);
    const thirdRevisionRows = await pool.query<{ revision: number; text: string }>(
      'SELECT revision, text FROM message_revisions ORDER BY revision',
    );
    assert.deepEqual(thirdRevisionRows.rows.map((row) => row.revision), [1, 2, 3]);
    assert.deepEqual(thirdRevisionRows.rows.map((row) => row.text), ['初版', '改訂版', '第3版']);
  });

  it('同messageのsession所属・sequence_no・role・occurred_atは変更できない', async () => {
    const original = buildEventInput({
      idempotency_key: 'idem-fixed',
      source_message_id: 'msg-fixed',
      sequence_no: 5,
      role: 'user',
      occurred_at: '2026-09-21T01:00:00.000Z',
      text: '固定された発言',
    });
    const saved = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [original]) });
    assert.equal(saved.statusCode, 202, `保存に失敗: ${saved.body}`);
    const countsBefore = {
      messages: await countRows(pool, 'messages'),
      revisions: await countRows(pool, 'message_revisions'),
      receipts: await countRows(pool, 'event_receipts'),
    };

    const mutations: Array<{ name: string; event: EventInput }> = [
      { name: 'sequence_no', event: { ...original, idempotency_key: 'k-seq', sequence_no: 6 } },
      { name: 'role', event: { ...original, idempotency_key: 'k-role', role: 'assistant' } },
      { name: 'occurred_at', event: { ...original, idempotency_key: 'k-time', occurred_at: '2026-09-21T02:00:00.000Z' } },
    ];
    for (const mutation of mutations) {
      const response = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [mutation.event]) });
      assert.equal(response.statusCode, 409, `${mutation.name}の変更が409にならない: ${response.body}`);
    }

    assert.equal(await countRows(pool, 'messages'), countsBefore.messages);
    assert.equal(await countRows(pool, 'message_revisions'), countsBefore.revisions);
    assert.equal(await countRows(pool, 'event_receipts'), countsBefore.receipts);
    const stored = await pool.query<{ sequence_no: number; role: string; occurred_at: Date }>(
      'SELECT sequence_no, role, occurred_at FROM messages',
    );
    assert.equal(stored.rows[0].sequence_no, 5);
    assert.equal(stored.rows[0].role, 'user');
    assert.equal(stored.rows[0].occurred_at.toISOString(), '2026-09-21T01:00:00.000Z');
  });

  it('batch途中の衝突では先行イベントも含めて全rollbackする', async () => {
    const saved = buildEventInput({ idempotency_key: 'idem-saved', source_message_id: 'msg-saved', text: '保存済み' });
    const firstResponse = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [saved]) });
    assert.equal(firstResponse.statusCode, 202, `事前保存に失敗: ${firstResponse.body}`);
    const countsBefore = {
      messages: await countRows(pool, 'messages'),
      revisions: await countRows(pool, 'message_revisions'),
      jobs: await countRows(pool, 'jobs'),
      requests: await countRows(pool, 'search_requests'),
      receipts: await countRows(pool, 'event_receipts'),
    };

    const newEvent = buildEventInput({ idempotency_key: 'idem-new', source_message_id: 'msg-new', sequence_no: 2, text: '新規発言' });
    const conflictingUpdate = buildEventInput({ idempotency_key: 'idem-jump', source_message_id: 'msg-saved', revision: 4, text: '飛越' });
    const conflictResponse = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, [newEvent, conflictingUpdate]),
    });
    assert.equal(conflictResponse.statusCode, 409, `途中衝突が409にならない: ${conflictResponse.body}`);
    assert.equal(await countRows(pool, 'messages'), countsBefore.messages, '衝突batchの先行イベントが残った');
    assert.equal(await countRows(pool, 'message_revisions'), countsBefore.revisions);
    assert.equal(await countRows(pool, 'jobs'), countsBefore.jobs);
    assert.equal(await countRows(pool, 'search_requests'), countsBefore.requests);
    assert.equal(await countRows(pool, 'event_receipts'), countsBefore.receipts);

    const duplicateKeyInBatch = [
      buildEventInput({ idempotency_key: 'idem-dup', source_message_id: 'msg-dup-1', sequence_no: 1, text: '本文1' }),
      buildEventInput({ idempotency_key: 'idem-dup', source_message_id: 'msg-dup-2', sequence_no: 2, text: '本文2' }),
    ];
    const duplicateResponse = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, duplicateKeyInBatch),
    });
    assert.equal(duplicateResponse.statusCode, 409, `batch内の同キー異内容が409にならない: ${duplicateResponse.body}`);
    assert.equal(await countRows(pool, 'messages'), countsBefore.messages);
    assert.equal(await countRows(pool, 'event_receipts'), countsBefore.receipts);
  });
});

describe('POST /v1/events DB失敗rollback', () => {
  // event1で先行保存を作り、event2のINSERTを実DBのtriggerで失敗させる。APIにテスト専用分岐は作らない。
  function buildInjectionBatch(projectId: string, prefix: string) {
    const first = buildEventInput({
      idempotency_key: `${prefix}-key-1`,
      source_message_id: `${prefix}-msg-1`,
      sequence_no: 1,
      role: 'assistant',
      text: '先行して保存されるAI発言',
    });
    const second = buildEventInput({
      idempotency_key: `${prefix}-key-2`,
      source_message_id: `${prefix}-msg-2`,
      sequence_no: 2,
      role: 'user',
      text: '後半で失敗するユーザー発言',
    });
    return buildEventBatch(projectId, [first, second]);
  }

  it('batch後半のjobs INSERT失敗は先行原文・receiptごと全rollbackする', async () => {
    const control = await postEvents(app, { token: workspace.token, body: buildInjectionBatch(workspace.projectId, 'control-jobs') });
    assert.equal(control.statusCode, 202, `注入前の受理に失敗: ${control.body}`);

    await resetDatabase(pool);
    workspace = await seedWorkspace(pool);

    // event2のmessageに対するjobs INSERTだけを失敗させる。triggerはexternalに作るのでAPIからは見えない。
    await pool.query(`
      CREATE FUNCTION yori_test_block_jobs_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.message_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM messages WHERE id = NEW.message_id AND source_message_id = 'inject-jobs-msg-2'
        ) THEN
          RAISE EXCEPTION 'injected jobs insert failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await pool.query(
      'CREATE TRIGGER yori_test_block_jobs_insert BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION yori_test_block_jobs_insert()',
    );
    try {
      const response = await postEvents(app, { token: workspace.token, body: buildInjectionBatch(workspace.projectId, 'inject-jobs') });
      assert.ok(response.statusCode >= 500, `DB失敗が5xxにならない: ${response.statusCode} ${response.body}`);
      await assertNoEventWrites(pool);
      assert.equal(await countRows(pool, 'event_receipts'), 0, '先行receiptがrollbackされていない');
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS yori_test_block_jobs_insert ON jobs');
      await pool.query('DROP FUNCTION IF EXISTS yori_test_block_jobs_insert()');
    }
  });

  it('batch後半のsearch_requests INSERT失敗は先行原文・receiptごと全rollbackする', async () => {
    const control = await postEvents(app, { token: workspace.token, body: buildInjectionBatch(workspace.projectId, 'control-search') });
    assert.equal(control.statusCode, 202, `注入前の受理に失敗: ${control.body}`);

    await resetDatabase(pool);
    workspace = await seedWorkspace(pool);

    await pool.query(`
      CREATE FUNCTION yori_test_block_search_requests_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected search_requests insert failure';
      END;
      $$;
    `);
    await pool.query(
      'CREATE TRIGGER yori_test_block_search_requests_insert BEFORE INSERT ON search_requests FOR EACH ROW EXECUTE FUNCTION yori_test_block_search_requests_insert()',
    );
    try {
      const response = await postEvents(app, { token: workspace.token, body: buildInjectionBatch(workspace.projectId, 'inject-search') });
      assert.ok(response.statusCode >= 500, `DB失敗が5xxにならない: ${response.statusCode} ${response.body}`);
      await assertNoEventWrites(pool);
      assert.equal(await countRows(pool, 'event_receipts'), 0, '先行receiptがrollbackされていない');
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS yori_test_block_search_requests_insert ON search_requests');
      await pool.query('DROP FUNCTION IF EXISTS yori_test_block_search_requests_insert()');
    }
  });
});

describe('POST /v1/events 認証・project権限', () => {
  it('tokenなし・不正tokenは401で書き込まない', async () => {
    const body = buildEventBatch(workspace.projectId, [buildEventInput()]);
    const noToken = await postEvents(app, { token: null, body });
    assert.equal(noToken.statusCode, 401, `tokenなしが401にならない: ${noToken.body}`);
    await assertNoEventWrites(pool);

    const invalid = await postEvents(app, { token: 'yori_invalid_token', body });
    assert.equal(invalid.statusCode, 401, `不正tokenが401にならない: ${invalid.body}`);
    await assertNoEventWrites(pool);
  });

  it('失効tokenは401で書き込まない', async () => {
    await revokeAuthToken(pool, workspace.token);
    const response = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [buildEventInput()]) });
    assert.equal(response.statusCode, 401, `失効tokenが401にならない: ${response.body}`);
    await assertNoEventWrites(pool);
  });

  it('project_membersにない社員は403で書き込まない', async () => {
    const outsider = await insertEmployee(pool, workspace.companyId, 'employee-outsider');
    const outsiderToken = await issueAuthToken(pool, workspace.companyId, outsider);
    const response = await postEvents(app, {
      token: outsiderToken,
      body: buildEventBatch(workspace.projectId, [buildEventInput()]),
    });
    assert.equal(response.statusCode, 403, `非メンバーが403にならない: ${response.body}`);
    await assertNoEventWrites(pool);
  });

  it('他companyのprojectは403で書き込まない', async () => {
    const otherCompany = await insertCompany(pool, 'company-b');
    const otherProject = await insertProject(pool, otherCompany, 'repo-b');
    const response = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(otherProject, [buildEventInput()]),
    });
    assert.equal(response.statusCode, 403, `他社projectが403にならない: ${response.body}`);
    await assertNoEventWrites(pool);
  });

  it('body内のcompany_id・employee_idはunknown fieldとして400で書き込まない', async () => {
    const forgedTopLevel = await postEvents(app, {
      token: workspace.token,
      body: { project_id: workspace.projectId, company_id: workspace.companyId, events: [buildEventInput()] },
    });
    assert.equal(forgedTopLevel.statusCode, 400, `top-level company_idが400にならない: ${forgedTopLevel.body}`);
    await assertNoEventWrites(pool);

    const forgedEvent = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, [{ ...buildEventInput(), employee_id: workspace.employeeId } as EventInput]),
    });
    assert.equal(forgedEvent.statusCode, 400, `event内employee_idが400にならない: ${forgedEvent.body}`);
    await assertNoEventWrites(pool);
  });
});

describe('POST /v1/events 入力検証', () => {
  it('batchは1..100件に収める', async () => {
    const empty = await postEvents(app, { token: workspace.token, body: { project_id: workspace.projectId, events: [] } });
    assert.equal(empty.statusCode, 400, `空batchが400にならない: ${empty.body}`);
    await assertNoEventWrites(pool);

    const tooMany = Array.from({ length: 101 }, (_value, index) =>
      buildEventInput({ idempotency_key: `idem-${index}`, source_message_id: `msg-${index}`, sequence_no: index + 1 }),
    );
    const response = await postEvents(app, {
      token: workspace.token,
      body: { project_id: workspace.projectId, events: tooMany },
    });
    assert.equal(response.statusCode, 400, `101件が400にならない: ${response.body}`);
    await assertNoEventWrites(pool);
  });

  it('textは非空65536 Unicode文字までを受け付ける', async () => {
    const emptyText = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, [buildEventInput({ text: '' })]),
    });
    assert.equal(emptyText.statusCode, 400, `空textが400にならない: ${emptyText.body}`);
    await assertNoEventWrites(pool);

    const tooLong = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, [buildEventInput({ text: 'あ'.repeat(MAX_TEXT_LENGTH + 1) })]),
    });
    assert.equal(tooLong.statusCode, 400, `65537文字が400にならない: ${tooLong.body}`);
    await assertNoEventWrites(pool);

    const maxLength = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, [buildEventInput({ text: 'あ'.repeat(MAX_TEXT_LENGTH) })]),
    });
    assert.equal(maxLength.statusCode, 202, `65536文字が受付されない: ${maxLength.body}`);
    const stored = await pool.query<{ length: number }>('SELECT length(text) AS length FROM message_revisions');
    assert.equal(stored.rows[0].length, MAX_TEXT_LENGTH);

    // Unicode文字はコードポイント数で数える（サロゲートペアを2文字と数えない）。
    const astralTooLong = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, [buildEventInput({ text: '😀'.repeat(MAX_TEXT_LENGTH + 1) })]),
    });
    assert.equal(astralTooLong.statusCode, 400, `サロゲートペア65537文字が400にならない: ${astralTooLong.body}`);

    const astralMax = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, [
        buildEventInput({ source_message_id: 'msg-astral', sequence_no: 2, text: '😀'.repeat(MAX_TEXT_LENGTH) }),
      ]),
    });
    assert.equal(astralMax.statusCode, 202, `サロゲートペア65536文字が受付されない: ${astralMax.body}`);
    const astralStored = await pool.query<{ length: number }>(
      `SELECT length(text) AS length FROM message_revisions WHERE revision = 1 AND text LIKE '😀%'`,
    );
    assert.equal(astralStored.rows[0].length, MAX_TEXT_LENGTH);
  });

  it('schema違反とunknown fieldは400で書き込まない', async () => {
    const invalidEvents: Array<{ name: string; event: Partial<EventInput> }> = [
      { name: 'sourceが未知', event: { source: 'other' as EventInput['source'] } },
      { name: 'roleが未知', event: { role: 'tool' as EventInput['role'] } },
      { name: 'sequence_noが0', event: { sequence_no: 0 } },
      { name: 'sequence_noが小数', event: { sequence_no: 1.5 } },
      { name: 'revisionが0', event: { revision: 0 } },
      { name: 'occurred_atが日時でない', event: { occurred_at: 'not-a-date' } },
      { name: 'textがnull', event: { text: null as unknown as string } },
      { name: 'idempotency_keyが空', event: { idempotency_key: '' } },
      { name: 'unknown field employee_id', event: { employee_id: workspace.employeeId } as unknown as Partial<EventInput> },
    ];
    for (const invalid of invalidEvents) {
      const response = await postEvents(app, {
        token: workspace.token,
        body: buildEventBatch(workspace.projectId, [buildEventInput(invalid.event)]),
      });
      assert.equal(response.statusCode, 400, `${invalid.name}が400にならない: ${response.body}`);
      await assertNoEventWrites(pool);
    }

    const invalidBodies: Array<{ name: string; body: unknown }> = [
      { name: 'project_idがUUIDでない', body: { project_id: 'not-a-uuid', events: [buildEventInput()] } },
      { name: 'eventsがない', body: { project_id: workspace.projectId } },
      { name: 'eventsが配列でない', body: { project_id: workspace.projectId, events: 'x' } },
      { name: 'eventがobjectでない', body: { project_id: workspace.projectId, events: ['x'] } },
      { name: 'project_idなし', body: { events: [buildEventInput()] } },
    ];
    for (const invalid of invalidBodies) {
      const response = await postEvents(app, { token: workspace.token, body: invalid.body });
      assert.equal(response.statusCode, 400, `${invalid.name}が400にならない: ${response.body}`);
      await assertNoEventWrites(pool);
    }
  });

  it('1MiBを超えるbodyは413で書き込まない', async () => {
    const response = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, [buildEventInput({ text: 'a'.repeat(1_100_000) })]),
    });
    assert.equal(response.statusCode, 413, `1MiB超が413にならない: ${response.body}`);
    await assertNoEventWrites(pool);
  });

  it('JSONとして壊れたbodyは400で書き込まない', async () => {
    const response = await postEvents(app, { token: workspace.token, payload: '{"project_id":' });
    assert.equal(response.statusCode, 400, `壊れたJSONが400にならない: ${response.body}`);
    await assertNoEventWrites(pool);
  });
});

describe('POST /v1/events 秘匿値の置換', () => {
  it('textの秘匿値をplaceholderへ置換して保存し、再送・過去revision再送も置換後の本文で照合する', async () => {
    const rawKey = `AKIA${'A'.repeat(16)}`;
    const masked = 'キーは [REDACTED:aws_access_key] です';
    const event = buildEventInput({ idempotency_key: 'idem-redact-1', source_message_id: 'msg-redact', text: `キーは ${rawKey} です` });

    const response = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [event]) });
    assert.equal(response.statusCode, 202, `受付に失敗: ${response.body}`);
    const [result] = response.json<EventsResponse>().results;
    assert.ok(result, '受付結果がない');

    const stored = await pool.query<{ text: string; content_hash: Buffer }>(
      'SELECT text, content_hash FROM message_revisions WHERE message_id = $1 AND revision = 1',
      [result.message_id],
    );
    assert.equal(stored.rows[0]?.text, masked, '保存本文が置換されていない');
    assert.ok(stored.rows[0]?.content_hash.equals(sha256Bytes(masked)), 'content_hashが置換後の本文と一致しない');

    const receipt = await pool.query<{ request_hash: Buffer }>('SELECT request_hash FROM event_receipts WHERE idempotency_key = $1', [
      'idem-redact-1',
    ]);
    const canonical = canonicalReceiptHash({
      ...event,
      text: masked,
      company_id: workspace.companyId,
      employee_id: workspace.employeeId,
      project_id: workspace.projectId,
    });
    assert.ok(receipt.rows[0]?.request_hash.equals(canonical), 'receipt hashが置換後の本文と一致しない');

    // 同じ本文の再送は同じmessageを返し、revision・job・検索受付を増やさない。
    const resend = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [event]) });
    assert.equal(resend.statusCode, 202, `再送に失敗: ${resend.body}`);
    assert.equal(resend.json<EventsResponse>().results[0]?.message_id, result.message_id);

    // 別の冪等キーでの過去revision再送も、保存済みの置換後本文と一致すれば409にしない。
    const pastResend = buildEventInput({ ...event, idempotency_key: 'idem-redact-past' });
    const pastResponse = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [pastResend]) });
    assert.equal(pastResponse.statusCode, 202, `過去revisionの再送が拒否された: ${pastResponse.body}`);
    const revisions = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM message_revisions WHERE message_id = $1', [
      result.message_id,
    ]);
    assert.equal(revisions.rows[0]?.count, '1', '再送でrevisionが増えている');
  });
});
