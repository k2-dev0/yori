import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validate as isUuid, v7 as uuidv7 } from 'uuid';
import { buildApp } from '../app.js';
import { MAX_TEXT_LENGTH, type EventInput, type EventsResponse } from '../contract.js';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import {
  addProjectMember,
  countRows,
  insertEmployee,
  issueAuthToken,
  resetDatabase,
  seedWorkspace,
  type WorkspaceFixture,
} from '../../db/tests/fixtures.js';
import { buildEventBatch, buildEventInput, postEvents } from './support.js';
import {
  advanceMessageRevision,
  buildMatchedResult,
  countJobs,
  countManualSearchRequests,
  getSearchById,
  getSearchByInput,
  postSearch,
  readJobs,
  readMessage,
  readSearchRequest,
  readSearchRequestFull,
  sleep,
  updateSearchRequest,
  type ErrorResponseBody,
  type SearchByInputResponseBody,
  type SearchResponseBody,
} from './m6-support.js';

// M6の契約（docs/m6-design.md）のうち、ユーザー採用シナリオ1〜4・7をHTTP境界で確認するRedテスト。
// 新規route未実装の間はFastifyの既定404等で失敗し、各itで要求差分が判別できる。
// 採用シナリオ:
// 1. request IDごとのstatus/outcome区別とreuse元追跡
// 2. 内部input_id/外部source IDによる現在入力照合とnot_received
// 3. wait_ms最大5秒のlong-poll、期限後もjobを取消さない
// 4. 同条件の自動受付再利用、別条件/force refreshのmanual受付とexecute_search同一TX作成、冪等性
// 7. 認証・案件membership・非開示・不正入力の固定code区別

const pool = createPool(requireDatabaseUrl());
const app = buildApp({ pool });
let workspace: WorkspaceFixture;
let nextSequence = 1;

before(async () => {
  await runMigrations(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
  workspace = await seedWorkspace(pool);
  nextSequence = 1;
});

after(async () => {
  await app.close();
  await pool.end();
});

function assertUuid(value: unknown, label: string): void {
  assert.equal(typeof value, 'string', `${label}が文字列ではない: ${String(value)}`);
  assert.ok(isUuid(value as string), `${label}がUUID形式ではない: ${String(value)}`);
}

function assertAccepted(response: { statusCode: number; body: string }, label: string): void {
  assert.ok([200, 201, 202].includes(response.statusCode), `${label}: ${response.statusCode} ${response.body}`);
}

function errorCode(response: { json<T>(): T }): string | undefined {
  return response.json<ErrorResponseBody>().error?.code;
}

interface IngestedEvent {
  messageId: string;
  requestId: string | null;
  sessionId: string;
  event: EventInput;
}

async function ingestEvent(
  role: 'user' | 'assistant',
  text: string,
  options: { token?: string; projectId?: string; sessionId?: string; sequenceNo?: number } = {},
): Promise<IngestedEvent> {
  const token = options.token ?? workspace.token;
  const projectId = options.projectId ?? workspace.projectId;
  const event = buildEventInput({
    idempotency_key: `m6-${randomUUID()}`,
    source_session_id: options.sessionId ?? 'm6-session-a',
    source_message_id: `msg-${randomUUID()}`,
    sequence_no: options.sequenceNo ?? nextSequence++,
    role,
    text,
  });
  const response = await postEvents(app, { token, body: buildEventBatch(projectId, [event]) });
  assert.equal(response.statusCode, 202, `イベント受付に失敗: ${response.statusCode} ${response.body}`);
  const result = response.json<EventsResponse>().results[0];
  assert.ok(result, 'イベント結果がない');
  const message = await readMessage(pool, result.message_id);
  return { messageId: result.message_id, requestId: result.request_id, sessionId: message.session_id, event };
}

type IngestedUserInput = Omit<IngestedEvent, 'requestId'> & { requestId: string };

async function ingestUserInput(
  text: string,
  options: { token?: string; projectId?: string; sessionId?: string; sequenceNo?: number } = {},
): Promise<IngestedUserInput> {
  const result = await ingestEvent('user', text, options);
  assert.ok(result.requestId, 'userイベントの自動検索受付request_idがない');
  return { ...result, requestId: result.requestId };
}

function buildSearchBody(input: {
  messageId: string;
  query: string;
  projectId?: string;
  idempotencyKey?: string;
  forceRefresh?: boolean;
  inputRevision?: number;
}) {
  return {
    project_id: input.projectId ?? workspace.projectId,
    input_id: input.messageId,
    input_revision: input.inputRevision ?? 1,
    query: input.query,
    idempotency_key: input.idempotencyKey ?? `search-idem-${randomUUID()}`,
    force_refresh: input.forceRefresh ?? false,
  };
}

function evidenceFor(input: IngestedEvent, text: string) {
  return {
    messageId: input.messageId,
    revision: 1,
    employeeId: workspace.employeeId,
    role: 'user',
    occurredAt: '2026-09-21T01:00:00.000Z',
    text,
  };
}

describe('M6 GET /v1/searches/:id 状態とoutcomeの区別', () => {
  it('pending/running/completed/failed/expiredを区別し、completedのoutcomeはmatched/no_match/skippedを区別する', async () => {
    const input = await ingestUserInput('状態区別の入力');

    await updateSearchRequest(pool, input.requestId, { status: 'pending', outcome: null });
    let response = await getSearchById(app, { token: workspace.token, id: input.requestId });
    assert.equal(response.statusCode, 200, `pending取得に失敗: ${response.statusCode} ${response.body}`);
    let body = response.json<SearchResponseBody>();
    assert.equal(body.status, 'pending');
    assert.equal(body.outcome ?? null, null, 'pendingでoutcomeを返している');
    assert.equal(body.request_id, input.requestId);
    assert.equal(body.input_id, input.messageId);
    assert.equal(body.input_revision, 1);
    assert.equal(body.project_id, workspace.projectId);

    await updateSearchRequest(pool, input.requestId, { status: 'running', outcome: null });
    response = await getSearchById(app, { token: workspace.token, id: input.requestId });
    assert.equal(response.statusCode, 200, `running取得に失敗: ${response.body}`);
    body = response.json<SearchResponseBody>();
    assert.equal(body.status, 'running');
    assert.equal(body.outcome ?? null, null, 'runningでoutcomeを返している');

    await updateSearchRequest(pool, input.requestId, {
      status: 'completed',
      outcome: 'matched',
      searchAction: 'new_search',
      stage: 'completed',
      result: buildMatchedResult({
        requestId: input.requestId,
        inputId: input.messageId,
        inputRevision: 1,
        projectId: workspace.projectId,
        evidence: [evidenceFor(input, 'matched根拠の原文')],
      }),
    });
    response = await getSearchById(app, { token: workspace.token, id: input.requestId });
    assert.equal(response.statusCode, 200, `matched取得に失敗: ${response.body}`);
    body = response.json<SearchResponseBody>();
    assert.equal(body.status, 'completed');
    assert.equal(body.outcome, 'matched');
    assert.equal(body.matches?.[0]?.evidence[0]?.message_id, input.messageId, 'matchedの根拠原文が返っていない');

    await updateSearchRequest(pool, input.requestId, { outcome: 'no_match', result: null });
    response = await getSearchById(app, { token: workspace.token, id: input.requestId });
    assert.equal(response.statusCode, 200, `no_match取得に失敗: ${response.body}`);
    body = response.json<SearchResponseBody>();
    assert.equal(body.status, 'completed');
    assert.equal(body.outcome, 'no_match');

    await updateSearchRequest(pool, input.requestId, { outcome: 'skipped', searchAction: 'skip' });
    response = await getSearchById(app, { token: workspace.token, id: input.requestId });
    assert.equal(response.statusCode, 200, `skipped取得に失敗: ${response.body}`);
    body = response.json<SearchResponseBody>();
    assert.equal(body.status, 'completed');
    assert.equal(body.outcome, 'skipped');
    assert.equal(body.search_action, 'skip');

    await updateSearchRequest(pool, input.requestId, {
      status: 'failed',
      outcome: null,
      searchAction: 'new_search',
      errorCode: 'provider_error',
    });
    response = await getSearchById(app, { token: workspace.token, id: input.requestId });
    assert.equal(response.statusCode, 200, `failed取得に失敗: ${response.body}`);
    body = response.json<SearchResponseBody>();
    assert.equal(body.status, 'failed');
    assert.notEqual(body.outcome, 'no_match', 'failedをno_matchへ変換している');
    assert.ok(body.outcome === null || body.outcome === undefined, `failedでoutcome=${String(body.outcome)}を返している`);
    assert.equal(body.error_code, 'provider_error', 'failedの機械可読理由を返していない');

    await updateSearchRequest(pool, input.requestId, {
      status: 'expired',
      outcome: null,
      errorCode: 'input_revision_stale',
    });
    response = await getSearchById(app, { token: workspace.token, id: input.requestId });
    assert.equal(response.statusCode, 200, `expired取得に失敗: ${response.body}`);
    body = response.json<SearchResponseBody>();
    assert.equal(body.status, 'expired');
    assert.notEqual(body.outcome, 'no_match', 'expiredをno_matchへ変換している');
    assert.equal(body.error_code, 'input_revision_stale', 'expiredの機械可読理由を返していない');
  });

  it('reuseのGETは現在受付のrequest_id/input_idと元受付の状態・根拠をreused_from_request_idで追跡する', async () => {
    const origin = await ingestUserInput('再利用元の質問');
    const evidence = await ingestEvent('assistant', '保存成功時にキャッシュを無効化した');
    await updateSearchRequest(pool, origin.requestId, {
      status: 'completed',
      outcome: 'matched',
      searchAction: 'new_search',
      stage: 'completed',
      result: buildMatchedResult({
        requestId: origin.requestId,
        inputId: origin.messageId,
        inputRevision: 1,
        projectId: workspace.projectId,
        evidence: [
          {
            messageId: evidence.messageId,
            revision: 1,
            employeeId: workspace.employeeId,
            role: 'assistant',
            occurredAt: '2026-09-21T01:01:00.000Z',
            text: '保存成功時にキャッシュを無効化した',
          },
        ],
      }),
    });

    const current = await ingestUserInput('現在の入力');
    await updateSearchRequest(pool, current.requestId, {
      status: 'pending',
      outcome: null,
      searchAction: 'reuse',
      stage: 'awaiting_reused_search',
      reusedFromRequestId: origin.requestId,
      originalRequestId: origin.requestId,
    });

    const response = await getSearchById(app, { token: workspace.token, id: current.requestId });
    assert.equal(response.statusCode, 200, `reuse取得に失敗: ${response.statusCode} ${response.body}`);
    const body = response.json<SearchResponseBody>();
    assert.equal(body.request_id, current.requestId, '現在受付のrequest_idを返していない');
    assert.equal(body.input_id, current.messageId, '現在入力のinput_idを返していない');
    assert.equal(body.input_revision, 1);
    assert.equal(body.reused_from_request_id, origin.requestId, 'reuse元のrequest_idを返していない');
    assert.equal(body.status, 'completed', '元受付のstatusを追跡していない');
    assert.equal(body.outcome, 'matched', '元受付のoutcomeを追跡していない');
    assert.equal(
      body.matches?.[0]?.evidence[0]?.message_id,
      evidence.messageId,
      '元受付の根拠原文を追跡していない',
    );
    assert.equal(body.matches?.[0]?.evidence[0]?.text, '保存成功時にキャッシュを無効化した');

    const currentRow = await readSearchRequestFull(pool, current.requestId);
    assert.equal(currentRow.result, null, '元resultを現在受付へ複製している');
  });

  it('reuse先がfailed/expired/skipped/no_matchの時は元状態を返し、matchedへ変換しない', async () => {
    const origin = await ingestUserInput('状態追跡の元入力');
    const current = await ingestUserInput('状態追跡の現在入力');
    await updateSearchRequest(pool, current.requestId, {
      status: 'pending',
      outcome: null,
      searchAction: 'reuse',
      stage: 'awaiting_reused_search',
      reusedFromRequestId: origin.requestId,
      originalRequestId: origin.requestId,
    });

    const cases = [
      { label: 'failed', status: 'failed', outcome: null, errorCode: 'provider_error', expectedStatus: 'failed', expectedOutcome: null },
      { label: 'expired', status: 'expired', outcome: null, errorCode: 'input_identity_mismatch', expectedStatus: 'expired', expectedOutcome: null },
      { label: 'skipped', status: 'completed', outcome: 'skipped', errorCode: null, expectedStatus: 'completed', expectedOutcome: 'skipped' },
      { label: 'no_match', status: 'completed', outcome: 'no_match', errorCode: null, expectedStatus: 'completed', expectedOutcome: 'no_match' },
    ];

    for (const item of cases) {
      await updateSearchRequest(pool, origin.requestId, {
        status: item.status,
        outcome: item.outcome,
        searchAction: item.outcome === 'skipped' ? 'skip' : 'new_search',
        stage: 'completed',
        errorCode: item.errorCode,
        result: null,
      });
      const response = await getSearchById(app, { token: workspace.token, id: current.requestId });
      assert.equal(response.statusCode, 200, `${item.label}のreuse取得に失敗: ${response.body}`);
      const body = response.json<SearchResponseBody>();
      assert.equal(body.request_id, current.requestId, `${item.label}: 現在受付のrequest_idを返していない`);
      assert.equal(body.reused_from_request_id, origin.requestId, `${item.label}: reuse元を返していない`);
      assert.equal(body.status, item.expectedStatus, `${item.label}: 元受付のstatusを追跡していない`);
      if (item.expectedOutcome === null) {
        assert.notEqual(body.outcome, 'matched', `${item.label}をmatchedへ変換している`);
      } else {
        assert.equal(body.outcome, item.expectedOutcome, `${item.label}: 元受付のoutcomeを追跡していない`);
      }
    }
  });

  it('reuse先のmatchedでも根拠revisionが現在と異なればmatchedとして返さない', async () => {
    const origin = await ingestUserInput('改訂される根拠を持つ元入力');
    const evidence = await ingestEvent('assistant', '改訂前の根拠原文');
    await updateSearchRequest(pool, origin.requestId, {
      status: 'completed',
      outcome: 'matched',
      searchAction: 'new_search',
      stage: 'completed',
      result: buildMatchedResult({
        requestId: origin.requestId,
        inputId: origin.messageId,
        inputRevision: 1,
        projectId: workspace.projectId,
        evidence: [
          {
            messageId: evidence.messageId,
            revision: 1,
            employeeId: workspace.employeeId,
            role: 'assistant',
            occurredAt: '2026-09-21T01:01:00.000Z',
            text: '改訂前の根拠原文',
          },
        ],
      }),
    });
    await advanceMessageRevision(pool, evidence.messageId, '改訂後の根拠原文');

    const current = await ingestUserInput('無効根拠の現在入力');
    await updateSearchRequest(pool, current.requestId, {
      status: 'pending',
      outcome: null,
      searchAction: 'reuse',
      stage: 'awaiting_reused_search',
      reusedFromRequestId: origin.requestId,
      originalRequestId: origin.requestId,
    });

    const response = await getSearchById(app, { token: workspace.token, id: current.requestId });
    assert.equal(response.statusCode, 200, `無効根拠のreuse取得に失敗: ${response.body}`);
    const body = response.json<SearchResponseBody>();
    assert.notEqual(body.outcome, 'matched', '現在revisionと異なる根拠をmatchedとして返している');
    assert.ok(!body.matches || body.matches.length === 0, '無効な根拠をmatchesへ含めている');
  });

  it('reuse先のmatched根拠が別案件ならmatchedとして返さない', async () => {
    const other = await seedWorkspace(pool, { name: 'company-b', repositoryIdentifier: 'repo-b' });
    const otherInput = await ingestUserInput('他会社の根拠入力', {
      token: other.token,
      projectId: other.projectId,
      sequenceNo: 1,
    });

    const origin = await ingestUserInput('別案件根拠を持つ元入力');
    await updateSearchRequest(pool, origin.requestId, {
      status: 'completed',
      outcome: 'matched',
      searchAction: 'new_search',
      stage: 'completed',
      result: buildMatchedResult({
        requestId: origin.requestId,
        inputId: origin.messageId,
        inputRevision: 1,
        projectId: workspace.projectId,
        evidence: [
          {
            messageId: otherInput.messageId,
            revision: 1,
            employeeId: other.employeeId,
            role: 'user',
            occurredAt: '2026-09-21T01:02:00.000Z',
            text: '他会社の根拠入力',
          },
        ],
      }),
    });

    const current = await ingestUserInput('別案件根拠の現在入力');
    await updateSearchRequest(pool, current.requestId, {
      status: 'pending',
      outcome: null,
      searchAction: 'reuse',
      stage: 'awaiting_reused_search',
      reusedFromRequestId: origin.requestId,
      originalRequestId: origin.requestId,
    });

    const response = await getSearchById(app, { token: workspace.token, id: current.requestId });
    assert.equal(response.statusCode, 200, `別案件根拠のreuse取得に失敗: ${response.body}`);
    const body = response.json<SearchResponseBody>();
    assert.notEqual(body.outcome, 'matched', '別案件の根拠をmatchedとして返している');
    assert.ok(!body.matches || body.matches.length === 0, '別案件の根拠をmatchesへ含めている');
  });
});

describe('M6 GET /v1/searches/by-input 入力照合', () => {
  it('内部input_id・revisionと外部source/session/message IDで同じ自動受付を返す', async () => {
    const input = await ingestUserInput('照合対象の入力');

    const internal = await getSearchByInput(app, {
      token: workspace.token,
      query: { project_id: workspace.projectId, input_id: input.messageId, input_revision: 1 },
    });
    assert.equal(internal.statusCode, 200, `内部ID照合に失敗: ${internal.statusCode} ${internal.body}`);
    const internalBody = internal.json<SearchByInputResponseBody>();
    assert.equal(internalBody.request_id, input.requestId, '内部input_idで自動受付を返していない');
    assert.notEqual(internalBody.lookup_status, 'not_received');

    const external = await getSearchByInput(app, {
      token: workspace.token,
      query: {
        project_id: workspace.projectId,
        source: input.event.source,
        source_scope: input.event.source_scope,
        source_session_id: input.event.source_session_id,
        source_message_id: input.event.source_message_id,
        revision: input.event.revision,
      },
    });
    assert.equal(external.statusCode, 200, `外部ID照合に失敗: ${external.statusCode} ${external.body}`);
    const externalBody = external.json<SearchByInputResponseBody>();
    assert.equal(externalBody.request_id, input.requestId, '外部入力IDで同じ自動受付を返していない');
    assert.equal(externalBody.status, 'pending');
  });

  it('未受信の内部ID・revision・外部IDはnot_receivedで、no_matchとは区別する', async () => {
    const input = await ingestUserInput('受付済みの入力');
    const assistant = await ingestEvent('assistant', '自動受付を持たないAI発言');

    const cases: Array<{ label: string; query: Record<string, string | number> }> = [
      {
        label: '未知のinput_id',
        query: { project_id: workspace.projectId, input_id: uuidv7(), input_revision: 1 },
      },
      {
        label: '未受信revision',
        query: { project_id: workspace.projectId, input_id: input.messageId, input_revision: 5 },
      },
      {
        label: '未知の外部message ID',
        query: {
          project_id: workspace.projectId,
          source: input.event.source,
          source_scope: input.event.source_scope,
          source_session_id: input.event.source_session_id,
          source_message_id: `missing-${randomUUID()}`,
          revision: 1,
        },
      },
      {
        label: '自動受付のないassistant message',
        query: { project_id: workspace.projectId, input_id: assistant.messageId, input_revision: 1 },
      },
    ];

    for (const item of cases) {
      const response = await getSearchByInput(app, { token: workspace.token, query: item.query });
      assert.equal(response.statusCode, 200, `${item.label}: ${response.statusCode} ${response.body}`);
      const body = response.json<SearchByInputResponseBody>();
      assert.equal(body.lookup_status, 'not_received', `${item.label}: not_receivedを返していない`);
      assert.notEqual(body.outcome, 'no_match', `${item.label}: not_receivedをno_matchへ変換している`);
      assert.equal(body.request_id ?? null, null, `${item.label}: 未受付なのにrequest_idを返している`);
    }
  });

  it('外部IDは認証社員のnamespaceで照合し、他社員・別scopeの受付を推測しない', async () => {
    const input = await ingestUserInput('namespace照合の入力');
    const employeeB = await insertEmployee(pool, workspace.companyId);
    await addProjectMember(pool, workspace.projectId, employeeB);
    const tokenB = await issueAuthToken(pool, workspace.companyId, employeeB);

    const sameProjectOtherEmployee = await getSearchByInput(app, {
      token: tokenB,
      query: {
        project_id: workspace.projectId,
        source: input.event.source,
        source_scope: input.event.source_scope,
        source_session_id: input.event.source_session_id,
        source_message_id: input.event.source_message_id,
        revision: input.event.revision,
      },
    });
    assert.equal(sameProjectOtherEmployee.statusCode, 200, `他社員照合: ${sameProjectOtherEmployee.body}`);
    assert.equal(
      sameProjectOtherEmployee.json<SearchByInputResponseBody>().lookup_status,
      'not_received',
      '他社員のnamespaceで別社員の外部IDを推測している',
    );

    const internalOtherEmployee = await getSearchByInput(app, {
      token: tokenB,
      query: { project_id: workspace.projectId, input_id: input.messageId, input_revision: 1 },
    });
    assert.equal(internalOtherEmployee.statusCode, 200, `他社員の内部ID照合: ${internalOtherEmployee.body}`);
    assert.equal(
      internalOtherEmployee.json<SearchByInputResponseBody>().lookup_status,
      'not_received',
      '他社員のsessionのinput_idを照合している',
    );

    const otherScope = await getSearchByInput(app, {
      token: workspace.token,
      query: {
        project_id: workspace.projectId,
        source: input.event.source,
        source_scope: 'scope-b',
        source_session_id: input.event.source_session_id,
        source_message_id: input.event.source_message_id,
        revision: input.event.revision,
      },
    });
    assert.equal(otherScope.statusCode, 200, `別scope照合: ${otherScope.body}`);
    assert.equal(
      otherScope.json<SearchByInputResponseBody>().lookup_status,
      'not_received',
      '別scopeの外部IDを推測している',
    );
  });

  it('by-inputはproject_idとinput指定を必須にし、不正入力は400 invalid_requestで拒否する', async () => {
    const input = await ingestUserInput('by-input不正入力');
    const invalidQueries: Array<Record<string, string | number>> = [
      { input_id: input.messageId, input_revision: 1 },
      { project_id: workspace.projectId, input_revision: 1 },
      { project_id: workspace.projectId, input_id: input.messageId, input_revision: 0 },
      { project_id: workspace.projectId, input_id: 'not-a-uuid', input_revision: 1 },
      { project_id: workspace.projectId, input_id: input.messageId, input_revision: 1, unknown_field: 'x' },
    ];

    for (const [index, query] of invalidQueries.entries()) {
      const response = await getSearchByInput(app, { token: workspace.token, query });
      assert.equal(response.statusCode, 400, `不正query ${index} を受理した: ${response.statusCode} ${response.body}`);
      assert.equal(errorCode(response), 'invalid_request', `不正query ${index} の固定code`);
    }
  });
});

describe('M6 GET /v1/searches/:id wait_ms long-poll', () => {
  it('wait_ms=5000でも状態変更で期限前に復帰する', async () => {
    const input = await ingestUserInput('long-pollで状態が変わる入力');
    const started = Date.now();
    const pending = getSearchById(app, { token: workspace.token, id: input.requestId, waitMs: 5000 });
    await sleep(150);
    await updateSearchRequest(pool, input.requestId, {
      status: 'completed',
      outcome: 'no_match',
      stage: 'completed',
      searchAction: 'new_search',
    });
    const response = await pending;
    const elapsed = Date.now() - started;

    assert.equal(response.statusCode, 200, `long-poll取得に失敗: ${response.body}`);
    const body = response.json<SearchResponseBody>();
    assert.equal(body.status, 'completed', '状態変更後の状態を返していない');
    assert.equal(body.outcome, 'no_match');
    assert.ok(elapsed < 2500, `状態変更後もlong-pollが復帰しない: ${elapsed}ms`);
  });

  it('期限到達時は処理中状態を返し、受付とjobを取消さない', async () => {
    const input = await ingestUserInput('期限到達の入力');
    const started = Date.now();
    const response = await getSearchById(app, { token: workspace.token, id: input.requestId, waitMs: 1000 });
    const elapsed = Date.now() - started;

    assert.equal(response.statusCode, 200, `期限応答に失敗: ${response.body}`);
    const body = response.json<SearchResponseBody>();
    assert.equal(body.status, 'pending', '期限到達時に処理中状態を返していない');
    assert.ok(elapsed >= 900, `wait_ms=1000より早く期限応答した: ${elapsed}ms`);
    assert.ok(elapsed < 4000, `期限応答が遅すぎる: ${elapsed}ms`);

    const row = await readSearchRequest(pool, input.requestId);
    assert.equal(row.status, 'pending', '期限到達で受付を取消している');
    const routeJobs = (await readJobs(pool)).filter((job) => job.kind === 'route_search');
    assert.equal(routeJobs.length, 1, 'route_search jobが増減している');
    assert.equal(routeJobs[0]?.status, 'pending', '期限到達でjobを取消している');
  });

  it('wait_msは0〜5000の整数だけを受理し、範囲外・小数・非数は400 invalid_request', async () => {
    const input = await ingestUserInput('wait_ms境界の入力');
    for (const rawWaitMs of ['5001', '-1', '1.5', 'abc', '']) {
      const response = await getSearchById(app, { token: workspace.token, id: input.requestId, rawWaitMs });
      assert.equal(response.statusCode, 400, `wait_ms=${rawWaitMs} を受理した: ${response.statusCode} ${response.body}`);
      assert.equal(errorCode(response), 'invalid_request', `wait_ms=${rawWaitMs} の固定code`);
    }
    const zero = await getSearchById(app, { token: workspace.token, id: input.requestId, waitMs: 0 });
    assert.equal(zero.statusCode, 200, `wait_ms=0を拒否した: ${zero.body}`);
  });
});

describe('M6 POST /v1/searches 受付', () => {
  it('同じ入力原文のforce_refresh=falseは自動受付を再利用し、manual受付やjobを複製しない', async () => {
    const input = await ingestUserInput('保存後に画面へ反映されない');
    const response = await postSearch(app, {
      token: workspace.token,
      body: buildSearchBody({ messageId: input.messageId, query: '保存後に画面へ反映されない' }),
    });
    assertAccepted(response, '自動受付再利用に失敗');
    const body = response.json<{ request_id: string }>();
    assert.equal(body.request_id, input.requestId, '同じ入力原文で自動受付を再利用していない');
    assert.equal(await countRows(pool, 'search_requests'), 1, '自動受付を複製している');
    assert.equal(await countManualSearchRequests(pool), 0, 'manual受付を作っている');
    assert.equal(await countJobs(pool, 'execute_search'), 0, '再利用時にexecute_search jobを作っている');
  });

  it('自動受付がfailedでも同条件のforce_refresh=falseは同じ自動受付を返す', async () => {
    const input = await ingestUserInput('failed後も再利用する原文');
    await updateSearchRequest(pool, input.requestId, { status: 'failed', errorCode: 'provider_error' });

    const response = await postSearch(app, {
      token: workspace.token,
      body: buildSearchBody({ messageId: input.messageId, query: 'failed後も再利用する原文' }),
    });
    assertAccepted(response, 'failed時の自動受付再利用に失敗');
    const body = response.json<{ request_id: string }>();
    assert.equal(body.request_id, input.requestId, '処理状態にかかわらず同じ自動受付を返していない');
    assert.equal(await countRows(pool, 'search_requests'), 1);
    assert.equal(await countManualSearchRequests(pool), 0);
    assert.equal(await countJobs(pool, 'execute_search'), 0);
  });

  it('別queryはmanual受付とexecute_search jobを同一TXで作り、質問を受付へ保存する', async () => {
    const input = await ingestUserInput('元の入力文');
    const query = '別画面のキャッシュ更新手順と原因';
    const response = await postSearch(app, {
      token: workspace.token,
      body: buildSearchBody({ messageId: input.messageId, query }),
    });
    assertAccepted(response, 'manual受付に失敗');
    const body = response.json<{ request_id: string }>();
    assertUuid(body.request_id, 'manual request_id');
    assert.notEqual(body.request_id, input.requestId, '別queryで自動受付を返している');

    const row = await readSearchRequest(pool, body.request_id);
    assert.equal(row.trigger, 'manual');
    assert.equal(row.project_id, workspace.projectId);
    assert.equal(row.employee_id, workspace.employeeId);
    assert.equal(row.input_id, input.messageId);
    assert.equal(row.input_revision, 1);
    assert.equal(row.status, 'pending');
    assert.equal(row.outcome, null);
    assert.equal(row.search_action, 'new_search');
    assert.equal(row.stage, 'awaiting_search');
    assert.equal(row.reused_from_request_id, null);

    const serialized = JSON.stringify(await readSearchRequestFull(pool, body.request_id));
    assert.ok(serialized.includes(query), 'manual質問が受付へ保存されていない');

    const executeJobs = (await readJobs(pool)).filter((job) => job.kind === 'execute_search');
    assert.equal(executeJobs.length, 1, 'execute_search jobが1件ではない');
    const job = executeJobs[0];
    assert.ok(job);
    assert.equal(job.status, 'pending');
    assert.equal(job.payload?.search_request_id, body.request_id, 'execute_search jobがmanual受付を指していない');
    assert.equal(job.session_id, input.sessionId);
    assert.equal(job.message_id, input.messageId);
    assert.equal(job.target_revision, 1);
    assert.equal(
      new Date(row.created_at).getTime(),
      new Date(job.created_at).getTime(),
      'manual受付とexecute_search jobが同一TXで作られていない',
    );

    const autoRow = await readSearchRequest(pool, input.requestId);
    assert.equal(autoRow.trigger, 'auto');
    assert.equal(autoRow.status, 'pending');
    assert.equal(autoRow.search_action, null, 'manual受付が自動受付を上書きしている');
  });

  it('force_refresh=trueは同じ原文でもmanual受付とexecute_search jobを作る', async () => {
    const input = await ingestUserInput('強制再検索の原文');
    const response = await postSearch(app, {
      token: workspace.token,
      body: buildSearchBody({ messageId: input.messageId, query: '強制再検索の原文', forceRefresh: true }),
    });
    assertAccepted(response, 'force_refreshのmanual受付に失敗');
    const body = response.json<{ request_id: string }>();
    assert.notEqual(body.request_id, input.requestId, 'force_refresh=trueで自動受付を返している');

    const row = await readSearchRequest(pool, body.request_id);
    assert.equal(row.trigger, 'manual');
    assert.equal(row.search_action, 'new_search');
    assert.equal(row.status, 'pending');
    assert.equal(await countJobs(pool, 'execute_search'), 1);
    assert.equal(await countManualSearchRequests(pool), 1);
    const autoRow = await readSearchRequest(pool, input.requestId);
    assert.equal(autoRow.search_action, null);
  });

  it('同じ冪等キー・同じ内容の再送は同じmanual requestを返し、重複を作らない', async () => {
    const input = await ingestUserInput('再送対象の入力');
    const idempotencyKey = `idem-${randomUUID()}`;
    const body = buildSearchBody({ messageId: input.messageId, query: '再送で同一になる質問', idempotencyKey });

    const first = await postSearch(app, { token: workspace.token, body });
    assertAccepted(first, '初回のmanual受付に失敗');
    const firstId = first.json<{ request_id: string }>().request_id;
    const second = await postSearch(app, { token: workspace.token, body });
    assertAccepted(second, '再送のmanual受付に失敗');
    const secondId = second.json<{ request_id: string }>().request_id;

    assert.equal(secondId, firstId, '同じ冪等キー・同じ内容で別requestを返している');
    assert.equal(await countManualSearchRequests(pool), 1, '再送でmanual受付を増殖している');
    assert.equal(await countJobs(pool, 'execute_search'), 1, '再送でexecute_search jobを増殖している');
  });

  it('同じ冪等キーで内容が違う再送は409 conflictにし、受付やjobを増やさない', async () => {
    const input = await ingestUserInput('conflict対象の入力');
    const idempotencyKey = `idem-${randomUUID()}`;
    const first = await postSearch(app, {
      token: workspace.token,
      body: buildSearchBody({ messageId: input.messageId, query: '最初の質問', idempotencyKey }),
    });
    assertAccepted(first, '初回のmanual受付に失敗');

    const differentQuery = await postSearch(app, {
      token: workspace.token,
      body: buildSearchBody({ messageId: input.messageId, query: '別内容の質問', idempotencyKey }),
    });
    assert.equal(differentQuery.statusCode, 409, `同じkeyの別内容を受理した: ${differentQuery.body}`);
    assert.equal(errorCode(differentQuery), 'conflict');

    const differentForceRefresh = await postSearch(app, {
      token: workspace.token,
      body: buildSearchBody({
        messageId: input.messageId,
        query: '最初の質問',
        idempotencyKey,
        forceRefresh: true,
      }),
    });
    assert.equal(differentForceRefresh.statusCode, 409, `force_refresh違いを受理した: ${differentForceRefresh.body}`);
    assert.equal(errorCode(differentForceRefresh), 'conflict');

    assert.equal(await countManualSearchRequests(pool), 1, 'conflictでmanual受付を増やしている');
    assert.equal(await countJobs(pool, 'execute_search'), 1, 'conflictでexecute_search jobを増やしている');
    assert.equal(await countRows(pool, 'search_requests'), 2, '自動受付以外が増減している');
  });

  it('冪等キーは社員ごとに独立で、他社員・他会社の同じキーと衝突しない', async () => {
    const inputA = await ingestUserInput('key scope A');
    const employeeB = await insertEmployee(pool, workspace.companyId);
    await addProjectMember(pool, workspace.projectId, employeeB);
    const tokenB = await issueAuthToken(pool, workspace.companyId, employeeB);
    const inputB = await ingestUserInput('key scope B', { token: tokenB, sequenceNo: 1 });

    const otherWorkspace = await seedWorkspace(pool, { name: 'company-b', repositoryIdentifier: 'repo-b' });
    const inputOther = await ingestUserInput('key scope 他会社', {
      token: otherWorkspace.token,
      projectId: otherWorkspace.projectId,
      sequenceNo: 1,
    });

    const idempotencyKey = `idem-${randomUUID()}`;
    const responseA = await postSearch(app, {
      token: workspace.token,
      body: buildSearchBody({ messageId: inputA.messageId, query: 'Aの質問', idempotencyKey }),
    });
    const responseB = await postSearch(app, {
      token: tokenB,
      body: buildSearchBody({ messageId: inputB.messageId, query: 'Bの質問', idempotencyKey }),
    });
    const responseOther = await postSearch(app, {
      token: otherWorkspace.token,
      body: buildSearchBody({
        messageId: inputOther.messageId,
        projectId: otherWorkspace.projectId,
        query: '他会社の質問',
        idempotencyKey,
      }),
    });
    assertAccepted(responseA, 'Aのmanual受付に失敗');
    assertAccepted(responseB, 'Bのmanual受付に失敗');
    assertAccepted(responseOther, '他会社のmanual受付に失敗');

    const idA = responseA.json<{ request_id: string }>().request_id;
    const idB = responseB.json<{ request_id: string }>().request_id;
    const idOther = responseOther.json<{ request_id: string }>().request_id;
    assert.notEqual(idA, idB, '別社員の同じ冪等キーを同一requestへ統合している');
    assert.notEqual(idA, idOther, '他会社の同じ冪等キーを同一requestへ統合している');
    assert.equal(await countManualSearchRequests(pool), 3);
  });

  it('指定revisionがcurrentでなければ409 conflictにし、manual受付を作らない', async () => {
    const input = await ingestUserInput('revision照合の入力');
    await advanceMessageRevision(pool, input.messageId, '改訂後の入力');

    const response = await postSearch(app, {
      token: workspace.token,
      body: buildSearchBody({ messageId: input.messageId, query: '古いrevisionでの質問', inputRevision: 1 }),
    });
    assert.equal(response.statusCode, 409, `currentでないrevisionを受理した: ${response.body}`);
    assert.equal(errorCode(response), 'conflict');
    assert.equal(await countManualSearchRequests(pool), 0, '古いrevisionでmanual受付を作っている');
    assert.equal(await countJobs(pool, 'execute_search'), 0);
  });

  it('POST /v1/searchesは不正入力を400 invalid_requestで拒否し、manual受付を作らない', async () => {
    const input = await ingestUserInput('不正入力の対象');
    const base = buildSearchBody({ messageId: input.messageId, query: '不正入力の質問' });
    const withoutQuery: Record<string, unknown> = { ...base };
    delete withoutQuery.query;
    const invalidBodies: Array<Record<string, unknown>> = [
      { ...base, unknown_field: 'x' },
      { ...base, query: '' },
      { ...base, input_revision: 0 },
      { ...base, input_id: 'not-a-uuid' },
      { ...base, force_refresh: 'yes' },
      { ...base, query: 'あ'.repeat(MAX_TEXT_LENGTH + 1) },
      { ...base, idempotency_key: '' },
      withoutQuery,
      { project_id: workspace.projectId, input_id: input.messageId, input_revision: 1, query: 'q', idempotency_key: 'k' },
    ];

    for (const [index, body] of invalidBodies.entries()) {
      const response = await postSearch(app, { token: workspace.token, body });
      assert.equal(response.statusCode, 400, `不正body ${index} を受理した: ${response.statusCode} ${response.body}`);
      assert.equal(errorCode(response), 'invalid_request', `不正body ${index} の固定code`);
    }
    assert.equal(await countManualSearchRequests(pool), 0, '不正入力でmanual受付を作っている');
    assert.equal(await countJobs(pool, 'execute_search'), 0);
  });
});

describe('M6 認証と案件境界', () => {
  it('GET /v1/searches/:idは未認証401、他社・非member・未知IDは404で存在を開示しない', async () => {
    const input = await ingestUserInput('境界確認の入力');

    const unauthenticated = await getSearchById(app, { token: null, id: input.requestId });
    assert.equal(unauthenticated.statusCode, 401, `未認証を受理した: ${unauthenticated.body}`);
    assert.equal(errorCode(unauthenticated), 'unauthorized');

    const employeeB = await insertEmployee(pool, workspace.companyId);
    const tokenB = await issueAuthToken(pool, workspace.companyId, employeeB);
    const nonMember = await getSearchById(app, { token: tokenB, id: input.requestId });
    assert.equal(nonMember.statusCode, 404, `非memberへ受付の存在を開示した: ${nonMember.body}`);
    assert.equal(errorCode(nonMember), 'not_found');

    const other = await seedWorkspace(pool, { name: 'company-b', repositoryIdentifier: 'repo-b' });
    const otherCompany = await getSearchById(app, { token: other.token, id: input.requestId });
    assert.equal(otherCompany.statusCode, 404, `他会社へ受付の存在を開示した: ${otherCompany.body}`);
    assert.equal(errorCode(otherCompany), 'not_found');

    const unknown = await getSearchById(app, { token: workspace.token, id: uuidv7() });
    assert.equal(unknown.statusCode, 404);
    assert.equal(errorCode(unknown), 'not_found');
  });

  it('POST /v1/searchesは未認証401、非member403、他社員の入力404、assistant入力400を固定codeで返す', async () => {
    const own = await ingestUserInput('自社員の入力');
    const employeeB = await insertEmployee(pool, workspace.companyId);
    const tokenB = await issueAuthToken(pool, workspace.companyId, employeeB);
    const base = buildSearchBody({ messageId: own.messageId, query: '境界確認の追加質問' });

    const unauthenticated = await postSearch(app, { token: null, body: base });
    assert.equal(unauthenticated.statusCode, 401, `未認証を受理した: ${unauthenticated.body}`);
    assert.equal(errorCode(unauthenticated), 'unauthorized');

    const nonMember = await postSearch(app, {
      token: tokenB,
      body: { ...base, idempotency_key: `nonmember-${randomUUID()}` },
    });
    assert.equal(nonMember.statusCode, 403, `非memberを受理した: ${nonMember.body}`);
    assert.equal(errorCode(nonMember), 'forbidden');

    await addProjectMember(pool, workspace.projectId, employeeB);
    const otherEmployeeInput = await postSearch(app, {
      token: tokenB,
      body: { ...base, idempotency_key: `other-employee-${randomUUID()}` },
    });
    assert.equal(otherEmployeeInput.statusCode, 404, `他社員のsession入力を照合した: ${otherEmployeeInput.body}`);
    assert.equal(errorCode(otherEmployeeInput), 'not_found');

    const assistant = await ingestEvent('assistant', 'manual検索対象にならないAI発言');
    const assistantInput = await postSearch(app, {
      token: workspace.token,
      body: { ...buildSearchBody({ messageId: assistant.messageId, query: 'AI発言への質問' }), idempotency_key: `assistant-${randomUUID()}` },
    });
    assert.equal(assistantInput.statusCode, 400, `assistant入力を受理した: ${assistantInput.body}`);
    assert.equal(errorCode(assistantInput), 'invalid_request');

    assert.equal(await countManualSearchRequests(pool), 0, '拒否時にmanual受付を作っている');
    assert.equal(await countJobs(pool, 'execute_search'), 0);
  });
});
