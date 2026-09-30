import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { v7 as uuidv7, validate as isUuid, version as uuidVersion } from 'uuid';
import { buildApp } from '../app.js';
import { MAX_EVENT_BODY_BYTES } from '../contract.js';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { insertCompany, insertProject, resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { buildEventBatch, buildEventInput, postEvents } from './support.js';
import { buildMatchedResult, getSearchById, getSearchByInput, postSearch, updateSearchRequest } from './m6-support.js';

// API契約実装計画の採用シナリオ3・6を実DBのHTTP応答で確認するRedテスト。
// 実装される契約:
// - src/api/response-schema.ts がHTTP成功・error応答の公開Zod schemaをexportする
// - 実Fastify応答がそのschemaへ適合し、pending/running/completed/failed/expiredと
//   matched/no_match/skipped/not_receivedを別状態として区別する
// - error本文はcodeだけで、SQL・token・原文を含まない
// response schemaが未実装の間は各itが契約欠落としてRedになる。

const responseSchemaModuleUrl = new URL('../response-schema.ts', import.meta.url).href;

const RESPONSE_SCHEMA_EXPORTS = [
  'healthLiveResponseSchema',
  'healthReadyResponseSchema',
  'errorResponseSchema',
  'eventsResponseSchema',
  'projectRegistrationResponseSchema',
  'meResponseSchema',
  'companyResponseSchema',
  'employeeCreateResponseSchema',
  'tokenIssueResponseSchema',
  'tokenRevokeResponseSchema',
  'searchAcceptedResponseSchema',
  'searchViewResponseSchema',
  'notReceivedResponseSchema',
  'searchLookupResponseSchema',
  'evidenceResponseSchema',
  'sessionLinkResponseSchema',
] as const;

interface ParseResult {
  success: boolean;
  data?: unknown;
  error?: unknown;
}

interface SchemaLike {
  safeParse(value: unknown): ParseResult;
}

type ResponseSchemas = Record<(typeof RESPONSE_SCHEMA_EXPORTS)[number], SchemaLike>;

interface HttpResponse {
  statusCode: number;
  body: string;
  json<T = unknown>(): T;
}

interface SearchViewBody {
  request_id: string;
  input_id: string;
  input_revision: number;
  trigger: string;
  search_action: string | null;
  reused_from_request_id: string | null;
  status: string;
  outcome: string | null;
  error_code: string | null;
  project_id: string;
  matches: Array<{
    evidence: Array<Record<string, unknown>>;
    [key: string]: unknown;
  }>;
  warnings: unknown[];
  index_status?: unknown;
}

interface SearchLookupBody extends SearchViewBody {
  lookup_status: string;
}

interface EvidenceBody {
  message_id: string;
  revision: number;
  employee_id: string;
  role: string;
  occurred_at: string;
  text: string;
}

const BASE_VIEW_KEYS = [
  'error_code',
  'input_id',
  'input_revision',
  'matches',
  'outcome',
  'project_id',
  'request_id',
  'reused_from_request_id',
  'search_action',
  'status',
  'trigger',
  'warnings',
].sort();

let schemasCache: ResponseSchemas | undefined;

// response-schema.tsの公開schema一式を読み込み、未実装・export欠落を契約欠落として失敗させる。
async function responseSchemas(): Promise<ResponseSchemas> {
  if (schemasCache !== undefined) {
    return schemasCache;
  }
  let moduleExports: Record<string, unknown>;
  try {
    moduleExports = (await import(responseSchemaModuleUrl)) as Record<string, unknown>;
  } catch (error) {
    assert.fail(
      `src/api/response-schema.ts の公開response schema契約が未実装です: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const name of RESPONSE_SCHEMA_EXPORTS) {
    const candidate = moduleExports[name];
    assert.ok(
      typeof candidate === 'object' && candidate !== null && typeof (candidate as SchemaLike).safeParse === 'function',
      `src/api/response-schema.ts が ${name} をexportしていない`,
    );
  }
  schemasCache = moduleExports as unknown as ResponseSchemas;
  return schemasCache;
}

function parseWith<T = Record<string, unknown>>(schema: SchemaLike, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    assert.fail(`${label}: 公開response schemaへ適合しない: ${JSON.stringify(value)} / ${JSON.stringify(parsed.error)}`);
  }
  return parsed.data as T;
}

// error応答は共通schemaへ適合し、code以外の本文と内部情報を含まないことを確認する。
function assertErrorResponse(schema: SchemaLike, response: HttpResponse, expectedCode: string, label: string): void {
  const body = response.json<unknown>();
  parseWith(schema, body, label);
  assert.deepEqual(body, { error: { code: expectedCode } }, `${label}: error本文がcodeだけではない`);
  for (const forbidden of ['SELECT', 'INSERT INTO', 'auth_tokens', 'token_hash', 'yori_secret']) {
    assert.ok(!response.body.includes(forbidden), `${label}: error本文へ ${forbidden} が漏れている`);
  }
}

function assertUuidV7(value: unknown, label: string): void {
  assert.equal(typeof value, 'string', `${label}が文字列ではない: ${String(value)}`);
  assert.ok(isUuid(value as string), `${label}がUUID形式ではない: ${String(value)}`);
  assert.equal(uuidVersion(value as string), 7, `${label}がUUIDv7ではない: ${String(value)}`);
}

// DB障害時のerror message・SQL・接続情報が応答へ出ないことを確認するためのpool。
function failingPool(message: string): Pool {
  return {
    query: () => Promise.reject(new Error(message)),
    connect: () => Promise.reject(new Error(message)),
  } as unknown as Pool;
}

const pool = createPool(requireDatabaseUrl());
const RELEASE_SHA = '1111111111111111111111111111111111111111';
const app = buildApp({ pool, releaseSha: RELEASE_SHA });
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

interface IngestedUserInput {
  messageId: string;
  requestId: string;
  text: string;
  sourceScope: string;
  sourceSessionId: string;
  sourceMessageId: string;
}

// userイベントを受理させ、自動検索受付まで含む公開応答のrequest_idを返す。
async function ingestUserInput(
  text: string,
  options: { sessionId?: string; sourceMessageId?: string } = {},
): Promise<IngestedUserInput> {
  const sourceScope = 'contract-scope';
  const sourceSessionId = options.sessionId ?? `contract-session-${randomUUID()}`;
  const sourceMessageId = options.sourceMessageId ?? `contract-msg-${randomUUID()}`;
  const event = buildEventInput({
    idempotency_key: `contract-event-${randomUUID()}`,
    source_scope: sourceScope,
    source_session_id: sourceSessionId,
    source_message_id: sourceMessageId,
    sequence_no: 1,
    role: 'user',
    text,
  });
  const response = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [event]) });
  assert.equal(response.statusCode, 202, `イベント受付に失敗: ${response.statusCode} ${response.body}`);
  const result = response.json<{ results: Array<{ message_id: string; request_id: string | null }> }>().results[0];
  assert.ok(result, 'イベント結果がない');
  assert.ok(result.request_id, 'userイベントの自動検索request_idがない');
  return { messageId: result.message_id, requestId: result.request_id, text, sourceScope, sourceSessionId, sourceMessageId };
}

function buildSearchBody(input: { messageId: string; query: string; idempotencyKey?: string }): Record<string, unknown> {
  return {
    project_id: workspace.projectId,
    input_id: input.messageId,
    input_revision: 1,
    query: input.query,
    idempotency_key: input.idempotencyKey ?? `contract-search-${randomUUID()}`,
    force_refresh: false,
  };
}

function sessionIdentity(sourceScope: string, sourceSessionId: string): Record<string, string> {
  return { source: 'codex', source_scope: sourceScope, source_session_id: sourceSessionId };
}

function buildSessionLinkBody(input: {
  idempotencyKey: string;
  from: IngestedUserInput;
  to: IngestedUserInput;
}): Record<string, unknown> {
  return {
    project_id: workspace.projectId,
    idempotency_key: input.idempotencyKey,
    from: sessionIdentity(input.from.sourceScope, input.from.sourceSessionId),
    to: sessionIdentity(input.to.sourceScope, input.to.sourceSessionId),
    evidence: {
      ...sessionIdentity(input.from.sourceScope, input.from.sourceSessionId),
      source_message_id: input.from.sourceMessageId,
      revision: 1,
    },
  };
}

function postSessionLink(body: unknown): Promise<HttpResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/session-links',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workspace.token}` },
    payload: JSON.stringify(body),
  });
}

describe('HTTP公開応答のresponse schema適合', () => {
  it('GET /health/live・/health/readyの正常応答が公開response schemaへ適合する', async () => {
    const schemas = await responseSchemas();

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    assert.equal(live.statusCode, 200, live.body);
    assert.deepEqual(parseWith(schemas.healthLiveResponseSchema, live.json(), 'GET /health/live 200'), { status: 'ok' });

    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.deepEqual(parseWith(schemas.healthReadyResponseSchema, ready.json(), 'GET /health/ready 200'), {
      status: 'ready',
      release_sha: RELEASE_SHA,
      api_contract_version: 1,
    });
  });

  it('GET /health/readyの503応答がschemaへ適合し、接続情報・SQLを漏らさない', async () => {
    const schemas = await responseSchemas();
    const failing = buildApp({
      pool: failingPool('接続失敗: SELECT 1 postgres://yori:yori_secret@db/yori'),
      releaseSha: RELEASE_SHA,
    });
    try {
      const response = await failing.inject({ method: 'GET', url: '/health/ready' });
      assert.equal(response.statusCode, 503, response.body);
      assert.deepEqual(parseWith(schemas.healthReadyResponseSchema, response.json(), 'GET /health/ready 503'), {
        status: 'unavailable',
        release_sha: RELEASE_SHA,
        api_contract_version: 1,
      });
      assert.ok(!response.body.includes('yori_secret') && !response.body.includes('SELECT'), 'ready失敗で内部情報を漏らしている');
    } finally {
      await failing.close();
    }
  });

  it('POST /v1/eventsの202応答がschemaへ適合し、message_idがUUIDv7である', async () => {
    const schemas = await responseSchemas();
    const event = buildEventInput({
      idempotency_key: 'contract-events-1',
      source_message_id: 'contract-events-msg-1',
      text: '契約テストの原文',
    });
    const response = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [event]) });
    assert.equal(response.statusCode, 202, response.body);

    const body = response.json<{ results: Array<Record<string, unknown>> }>();
    const parsed = parseWith<{ results: Array<Record<string, unknown>> }>(schemas.eventsResponseSchema, body, 'POST /v1/events 202');
    assert.deepEqual(parsed, body, 'schemaが公開fieldを欠落・変形している');
    const result = body.results[0];
    assert.ok(result, 'events結果がない');
    assert.deepEqual(Object.keys(result).sort(), ['idempotency_key', 'message_id', 'request_id', 'revision']);
    assertUuidV7(result.message_id, 'message_id');
    assertUuidV7(result.request_id, 'userイベントのrequest_id');
    assert.equal(result.revision, 1);
    assert.equal(result.idempotency_key, 'contract-events-1');
  });

  it('POST /v1/eventsの400/401/403/409/413が共通error schemaのcodeだけを返す', async () => {
    const schemas = await responseSchemas();

    const base = buildEventInput({
      idempotency_key: 'contract-events-error',
      source_message_id: 'contract-events-error-msg',
      text: 'errorへ漏らしてはいけない原文',
    });
    const unknownFieldBody = buildEventBatch(workspace.projectId, [{ ...base }]) as unknown as {
      project_id: string;
      events: Array<Record<string, unknown>>;
    };
    unknownFieldBody.events[0].unknown_field = 'SELECT token_hash FROM auth_tokens';
    const unknownField = await postEvents(app, { token: workspace.token, body: unknownFieldBody });
    assert.equal(unknownField.statusCode, 400, unknownField.body);
    assertErrorResponse(schemas.errorResponseSchema, unknownField, 'invalid_request', 'events unknown field');

    const unauthorized = await postEvents(app, { token: null, body: buildEventBatch(workspace.projectId, [base]) });
    assert.equal(unauthorized.statusCode, 401, unauthorized.body);
    assertErrorResponse(schemas.errorResponseSchema, unauthorized, 'unauthorized', 'events 未認証');

    const foreignCompanyId = await insertCompany(pool, 'contract-foreign-company');
    const foreignProjectId = await insertProject(pool, foreignCompanyId, 'contract-foreign-repo');
    const forbidden = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(foreignProjectId, [base]),
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    assertErrorResponse(schemas.errorResponseSchema, forbidden, 'forbidden', 'events 別会社project');

    const first = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [base]) });
    assert.equal(first.statusCode, 202, first.body);
    const conflict = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, [{ ...base, text: '内容が異なる再送' }]),
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assertErrorResponse(schemas.errorResponseSchema, conflict, 'conflict', 'events 内容違い再送');

    const oversized = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, [
        buildEventInput({ idempotency_key: 'contract-events-large', text: 'x'.repeat(MAX_EVENT_BODY_BYTES + 1) }),
      ]),
    });
    assert.equal(oversized.statusCode, 413, oversized.body);
    assertErrorResponse(schemas.errorResponseSchema, oversized, 'payload_too_large', 'events body上限超過');

    assert.ok(!unknownField.body.includes('SELECT') && !conflict.body.includes('内容が異なる再送'), 'error本文へ原文・SQLが漏れている');
  });

  it('POST /v1/searchesの200/202応答と400/404/409を区別する', async () => {
    const schemas = await responseSchemas();
    const input = await ingestUserInput('検索対象の入力');
    const body = buildSearchBody({ messageId: input.messageId, query: '入力とは異なる質問', idempotencyKey: 'contract-search-1' });

    const created = await postSearch(app, { token: workspace.token, body });
    assert.equal(created.statusCode, 202, created.body);
    const createdBody = created.json<{ request_id: string }>();
    assert.deepEqual(parseWith(schemas.searchAcceptedResponseSchema, createdBody, 'POST /v1/searches 202'), createdBody);
    assertUuidV7(createdBody.request_id, 'request_id');

    const reused = await postSearch(app, { token: workspace.token, body });
    assert.equal(reused.statusCode, 200, reused.body);
    const reusedBody = reused.json<{ request_id: string }>();
    assert.deepEqual(parseWith(schemas.searchAcceptedResponseSchema, reusedBody, 'POST /v1/searches 200'), reusedBody);
    assert.equal(reusedBody.request_id, createdBody.request_id);

    const conflict = await postSearch(app, { token: workspace.token, body: { ...body, query: '同じキーで別の質問' } });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assertErrorResponse(schemas.errorResponseSchema, conflict, 'conflict', 'searches 冪等キーconflict');

    const notFound = await postSearch(app, {
      token: workspace.token,
      body: buildSearchBody({ messageId: uuidv7(), query: '存在しない入力' }),
    });
    assert.equal(notFound.statusCode, 404, notFound.body);
    assertErrorResponse(schemas.errorResponseSchema, notFound, 'not_found', 'searches 対象なし');

    const invalid = await postSearch(app, { token: workspace.token, body: { ...body, query: '' } });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assertErrorResponse(schemas.errorResponseSchema, invalid, 'invalid_request', 'searches 入力不正');
  });

  it('GET /v1/searches/:idのpending/running/failed/expiredをstatusとして区別する', async () => {
    const schemas = await responseSchemas();
    const input = await ingestUserInput('状態区別の入力');

    await updateSearchRequest(pool, input.requestId, { status: 'pending', outcome: null });
    const pendingResponse = await getSearchById(app, { token: workspace.token, id: input.requestId });
    assert.equal(pendingResponse.statusCode, 200, pendingResponse.body);
    const pendingBody = pendingResponse.json<Record<string, unknown>>();
    const pending = parseWith<SearchViewBody>(schemas.searchViewResponseSchema, pendingBody, 'pending view');
    assert.deepEqual(pending, pendingBody, 'schemaが公開fieldを欠落・変形している');
    assert.equal(pending.status, 'pending');
    assert.equal(pending.outcome, null);
    assert.deepEqual(Object.keys(pendingBody).sort(), BASE_VIEW_KEYS);

    await updateSearchRequest(pool, input.requestId, { status: 'running', outcome: null });
    const runningResponse = await getSearchById(app, { token: workspace.token, id: input.requestId });
    assert.equal(runningResponse.statusCode, 200, runningResponse.body);
    const running = parseWith<SearchViewBody>(schemas.searchViewResponseSchema, runningResponse.json(), 'running view');
    assert.equal(running.status, 'running');
    assert.equal(running.outcome, null);

    await updateSearchRequest(pool, input.requestId, { status: 'failed', outcome: null, errorCode: 'provider_error' });
    const failedResponse = await getSearchById(app, { token: workspace.token, id: input.requestId });
    assert.equal(failedResponse.statusCode, 200, failedResponse.body);
    const failed = parseWith<SearchViewBody>(schemas.searchViewResponseSchema, failedResponse.json(), 'failed view');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.outcome, null, 'failedをno_matchへ変換している');
    assert.equal(failed.error_code, 'provider_error');

    await updateSearchRequest(pool, input.requestId, { status: 'expired', outcome: null, errorCode: 'input_revision_stale' });
    const expiredResponse = await getSearchById(app, { token: workspace.token, id: input.requestId });
    assert.equal(expiredResponse.statusCode, 200, expiredResponse.body);
    const expired = parseWith<SearchViewBody>(schemas.searchViewResponseSchema, expiredResponse.json(), 'expired view');
    assert.equal(expired.status, 'expired');
    assert.equal(expired.outcome, null, 'expiredをno_matchへ変換している');
    assert.equal(expired.error_code, 'input_revision_stale');

    assert.equal(schemas.searchViewResponseSchema.safeParse({ ...pendingBody, status: 'cancelled' }).success, false, '未知のstatusを許容している');
    assert.equal(
      schemas.searchViewResponseSchema.safeParse({ ...pendingBody, outcome: 'not_received' }).success,
      false,
      'not_receivedを検索outcomeとして許容している',
    );
  });

  it('GET /v1/searches/:idのcompletedでmatched/no_match/skippedを区別し、matchedの根拠原文を保持する', async () => {
    const schemas = await responseSchemas();
    const input = await ingestUserInput('matched根拠の原文');

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
        evidence: [
          {
            messageId: input.messageId,
            revision: 1,
            employeeId: workspace.employeeId,
            role: 'user',
            occurredAt: '2026-09-21T01:00:00.000Z',
            text: input.text,
          },
        ],
      }),
    });
    const matchedResponse = await getSearchById(app, { token: workspace.token, id: input.requestId });
    assert.equal(matchedResponse.statusCode, 200, matchedResponse.body);
    const matchedBody = matchedResponse.json<SearchViewBody>();
    const matched = parseWith<SearchViewBody>(schemas.searchViewResponseSchema, matchedBody, 'matched view');
    assert.deepEqual(matched, matchedBody, 'schemaがmatchedの公開fieldを欠落・変形している');
    assert.equal(matched.status, 'completed');
    assert.equal(matched.outcome, 'matched');
    const evidence = matched.matches[0]?.evidence[0];
    assert.ok(evidence, 'matchedの根拠evidenceがない');
    assert.equal(evidence.message_id, input.messageId);
    assert.equal(evidence.revision, 1);
    assert.equal(evidence.employee_id, workspace.employeeId);
    assert.equal(evidence.role, 'user');
    assert.equal(evidence.occurred_at, '2026-09-21T01:00:00.000Z');
    assert.equal(evidence.text, input.text);
    assert.ok(typeof matched.index_status === 'object' && matched.index_status !== null, 'index_statusがschemaで保持されていない');

    const broken = structuredClone(matchedBody);
    delete (broken.matches[0]?.evidence[0] as Record<string, unknown> | undefined)?.text;
    assert.equal(schemas.searchViewResponseSchema.safeParse(broken).success, false, 'evidence原文fieldを必須にしていない');

    await updateSearchRequest(pool, input.requestId, { outcome: 'no_match', result: null, stage: 'completed' });
    const noMatchResponse = await getSearchById(app, { token: workspace.token, id: input.requestId });
    assert.equal(noMatchResponse.statusCode, 200, noMatchResponse.body);
    const noMatch = parseWith<SearchViewBody>(schemas.searchViewResponseSchema, noMatchResponse.json(), 'no_match view');
    assert.equal(noMatch.status, 'completed');
    assert.equal(noMatch.outcome, 'no_match');
    assert.deepEqual(noMatch.matches, []);

    await updateSearchRequest(pool, input.requestId, { outcome: 'skipped', searchAction: 'skip', result: null });
    const skippedResponse = await getSearchById(app, { token: workspace.token, id: input.requestId });
    assert.equal(skippedResponse.statusCode, 200, skippedResponse.body);
    const skipped = parseWith<SearchViewBody>(schemas.searchViewResponseSchema, skippedResponse.json(), 'skipped view');
    assert.equal(skipped.status, 'completed');
    assert.equal(skipped.outcome, 'skipped');
    assert.equal(skipped.search_action, 'skip');
  });

  it('GET /v1/searches/by-inputのfound/not_receivedをresponse schemaで区別する', async () => {
    const schemas = await responseSchemas();
    const input = await ingestUserInput('by-input照合の入力');

    const foundResponse = await getSearchByInput(app, {
      token: workspace.token,
      query: { project_id: workspace.projectId, input_id: input.messageId, input_revision: 1 },
    });
    assert.equal(foundResponse.statusCode, 200, foundResponse.body);
    const foundBody = foundResponse.json<SearchLookupBody>();
    const found = parseWith<SearchLookupBody>(schemas.searchLookupResponseSchema, foundBody, 'by-input found');
    assert.deepEqual(found, foundBody, 'schemaがfoundの公開fieldを欠落・変形している');
    assert.equal(found.lookup_status, 'found');
    assert.equal(found.request_id, input.requestId);
    assert.equal(found.status, 'pending');

    const notReceivedResponse = await getSearchByInput(app, {
      token: workspace.token,
      query: { project_id: workspace.projectId, input_id: uuidv7(), input_revision: 1 },
    });
    assert.equal(notReceivedResponse.statusCode, 200, notReceivedResponse.body);
    const notReceivedBody = notReceivedResponse.json<Record<string, unknown>>();
    assert.deepEqual(parseWith(schemas.notReceivedResponseSchema, notReceivedBody, 'by-input not_received'), notReceivedBody);
    assert.deepEqual(notReceivedBody, {
      lookup_status: 'not_received',
      request_id: null,
      input_id: null,
      input_revision: null,
      trigger: null,
      status: null,
      outcome: null,
    });
    assert.equal(schemas.searchViewResponseSchema.safeParse(notReceivedBody).success, false, 'not_receivedを検索viewとして許容している');
    assert.equal(schemas.notReceivedResponseSchema.safeParse(foundBody).success, false, 'foundをnot_receivedとして許容している');
    assert.ok(!JSON.stringify(notReceivedBody).includes('no_match'), 'not_receivedをno_matchへ変換している');
  });

  it('GET /v1/evidence/:message_idの200/400/404がresponse schemaへ適合する', async () => {
    const schemas = await responseSchemas();
    const input = await ingestUserInput('証拠として返す原文');

    const found = await app.inject({
      method: 'GET',
      url: `/v1/evidence/${input.messageId}?project_id=${workspace.projectId}&revision=1`,
      headers: { authorization: `Bearer ${workspace.token}` },
    });
    assert.equal(found.statusCode, 200, found.body);
    const body = found.json<EvidenceBody>();
    const parsed = parseWith<EvidenceBody>(schemas.evidenceResponseSchema, body, 'GET /v1/evidence 200');
    assert.deepEqual(parsed, body, 'schemaがevidenceの公開fieldを欠落・変形している');
    assert.deepEqual(Object.keys(body).sort(), ['employee_id', 'message_id', 'occurred_at', 'revision', 'role', 'text']);
    assert.equal(body.message_id, input.messageId);
    assert.equal(body.revision, 1);
    assert.equal(body.employee_id, workspace.employeeId);
    assert.equal(body.role, 'user');
    assert.match(body.occurred_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.text, input.text);

    const missingRevision = await app.inject({
      method: 'GET',
      url: `/v1/evidence/${input.messageId}?project_id=${workspace.projectId}&revision=2`,
      headers: { authorization: `Bearer ${workspace.token}` },
    });
    assert.equal(missingRevision.statusCode, 404, missingRevision.body);
    assertErrorResponse(schemas.errorResponseSchema, missingRevision, 'not_found', 'evidence revision欠落');

    const unknownMessage = await app.inject({
      method: 'GET',
      url: `/v1/evidence/${uuidv7()}?project_id=${workspace.projectId}&revision=1`,
      headers: { authorization: `Bearer ${workspace.token}` },
    });
    assert.equal(unknownMessage.statusCode, 404, unknownMessage.body);
    assertErrorResponse(schemas.errorResponseSchema, unknownMessage, 'not_found', 'evidence message欠落');

    const invalidRevision = await app.inject({
      method: 'GET',
      url: `/v1/evidence/${input.messageId}?project_id=${workspace.projectId}&revision=0`,
      headers: { authorization: `Bearer ${workspace.token}` },
    });
    assert.equal(invalidRevision.statusCode, 400, invalidRevision.body);
    assertErrorResponse(schemas.errorResponseSchema, invalidRevision, 'invalid_request', 'evidence revision不正');
  });

  it('POST /v1/session-linksの201/200応答がschemaへ適合し、404を区別する', async () => {
    const schemas = await responseSchemas();
    const from = await ingestUserInput('引き継ぎ元の入力', { sessionId: 'contract-link-from', sourceMessageId: 'contract-link-from-msg' });
    const to = await ingestUserInput('引き継ぎ先の入力', { sessionId: 'contract-link-to', sourceMessageId: 'contract-link-to-msg' });
    const body = buildSessionLinkBody({ idempotencyKey: 'contract-link-1', from, to });

    const created = await postSessionLink(body);
    assert.equal(created.statusCode, 201, created.body);
    const createdBody = created.json<Record<string, unknown>>();
    const createdParsed = parseWith(schemas.sessionLinkResponseSchema, createdBody, 'POST /v1/session-links 201');
    assert.deepEqual(createdParsed, createdBody, 'schemaがlinkの公開fieldを欠落・変形している');
    assert.deepEqual(Object.keys(createdBody).sort(), [
      'evidence_message_id',
      'evidence_revision',
      'from_session_id',
      'link_id',
      'project_id',
      'status',
      'to_session_id',
    ]);
    assert.equal(createdBody.status, 'active');
    assert.equal(createdBody.project_id, workspace.projectId);
    assert.equal(createdBody.evidence_revision, 1);
    assertUuidV7(createdBody.link_id, 'link_id');

    const replay = await postSessionLink(body);
    assert.equal(replay.statusCode, 200, replay.body);
    const replayBody = replay.json<Record<string, unknown>>();
    assert.deepEqual(parseWith(schemas.sessionLinkResponseSchema, replayBody, 'POST /v1/session-links 200'), replayBody);
    assert.equal(replayBody.link_id, createdBody.link_id);

    const missing = await postSessionLink(
      buildSessionLinkBody({
        idempotencyKey: 'contract-link-missing',
        from,
        to: { ...to, sourceSessionId: 'contract-link-missing-session' },
      }),
    );
    assert.equal(missing.statusCode, 404, missing.body);
    assertErrorResponse(schemas.errorResponseSchema, missing, 'not_found', 'session-links 引き継ぎ先なし');
  });

  it('error response schemaはcodeだけを許可し、DB障害のSQL・tokenを漏らさない', async () => {
    const schemas = await responseSchemas();

    assert.equal(schemas.errorResponseSchema.safeParse({ error: { code: 'invalid_request' } }).success, true);
    assert.equal(
      schemas.errorResponseSchema.safeParse({ error: { code: 'invalid_request', message: 'SELECT token_hash FROM auth_tokens' } }).success,
      false,
      'error本文のmessageを許容している',
    );
    assert.equal(schemas.errorResponseSchema.safeParse({ error: { code: 'unknown_code' } }).success, false, '未知のerror codeを許容している');
    assert.equal(
      schemas.errorResponseSchema.safeParse({ error: { code: 'invalid_request' }, detail: '内部詳細' }).success,
      false,
      'error本文の追加fieldを許容している',
    );

    const failing = buildApp({
      pool: failingPool("SELECT token_hash FROM auth_tokens WHERE token_hash = 'yori_secret_token'"),
    });
    try {
      const response = await postEvents(failing, {
        token: 'yori_secret_token',
        body: buildEventBatch(workspace.projectId, [buildEventInput({ text: 'errorへ漏らしてはいけない原文' })]),
      });
      assert.equal(response.statusCode, 500, response.body);
      assertErrorResponse(schemas.errorResponseSchema, response, 'internal_error', 'DB障害');
      assert.ok(
        !response.body.includes('yori_secret_token') && !response.body.includes('errorへ漏らしてはいけない原文'),
        'error本文へtoken・原文が漏れている',
      );
    } finally {
      await failing.close();
    }
  });
});
