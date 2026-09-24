import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { searchByInputQuerySchema, searchDetailQuerySchema } from '../../api/schema.js';
import {
  findNonLoopbackIpv4,
  McpSession,
  requestUrl,
  startFakeCentralApi,
  type FakeCentralApi,
  type FakeCentralReply,
  type McpToolCallResult,
  type RecordedCentralRequest,
} from './support.js';

// M6採用シナリオ6・7: 公式SDK v2のstdio MCPアダプターの公開tool、strict入力、stdout非汚染、
// HTTPS/loopback制約、中央APIの401/403/404/5xx/timeoutをno_matchへ変換しない失敗区別。
// production未実装の間はsrc/mcp/server.tsが起動できず、missing executableとして各itがRedになる。
// 起動・設定契約はsupport.tsのコメント（YORI_MCP_CONFIG、api_url_env/api_token_env）に従う。

const TOKEN = `test-token-${randomUUID()}`;
let central: FakeCentralApi;

before(async () => {
  central = await startFakeCentralApi({
    responder: () => ({ status: 500, body: { error: { code: 'internal_error' } } }),
  });
});

after(async () => {
  await central.close();
});

function startSession(options: { apiUrl?: string; token?: string } = {}): Promise<McpSession> {
  return McpSession.start({ apiUrl: options.apiUrl ?? central.baseUrl, token: options.token ?? TOKEN });
}

function validSearchArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: uuidv7(),
    input_id: uuidv7(),
    input_revision: 1,
    query: '過去の類似対応と調査手順を検索',
    idempotency_key: `mcp-search-${randomUUID()}`,
    force_refresh: false,
    ...overrides,
  };
}

function validRecordArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: uuidv7(),
    idempotency_key: `mcp-case-${randomUUID()}`,
    source: 'codex',
    source_scope: 'scope-a',
    source_session_id: 'session-a',
    source_message_id: `message-${randomUUID()}`,
    sequence_no: 1,
    revision: 1,
    occurred_at: '2026-09-21T01:00:00.000Z',
    problem: '保存後に画面へ変更が反映されない',
    action: '保存成功時にキャッシュを無効化した',
    confirmation_status: '関連テストのみ成功。実画面は未確認',
    ...overrides,
  };
}

function withoutKey(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...args };
  delete copy[key];
  return copy;
}

// 中央APIのevents応答は受付した冪等キーをそのまま返す。record_caseは要求eventとの一致を検証する。
function recordCaseReply(request: RecordedCentralRequest): FakeCentralReply {
  const body = request.body as { events?: Array<{ idempotency_key?: string }> } | undefined;
  return {
    status: 202,
    body: {
      results: [
        {
          idempotency_key: body?.events?.[0]?.idempotency_key,
          message_id: uuidv7(),
          revision: 1,
          request_id: null,
        },
      ],
    },
  };
}

// 中央APIの失敗・timeoutがtool errorとして返り、no_matchや空結果へ変換されていないことを確認する。
function assertToolError(result: McpToolCallResult, label: string): void {
  assert.equal(result.isError, true, `${label}: tool errorになっていない: ${JSON.stringify(result)}`);
  assert.ok(!JSON.stringify(result).includes('no_match'), `${label}: no_matchへ変換している`);
  assert.ok(!JSON.stringify(result).includes(TOKEN), `${label}: tokenがtool結果へ出ている`);
}

describe('M6 MCP stdio serverとstrict入力', () => {
  it('stdio serverを起動し、search_history/get_search_result/get_evidence/record_caseをstrict schema付きで公開する', async () => {
    const session = await startSession();
    try {
      const tools = await session.listTools();
      const names = tools.map((tool) => tool.name);
      for (const expected of ['search_history', 'get_search_result', 'get_evidence', 'record_case']) {
        assert.ok(names.includes(expected), `${expected}が公開されていない: ${names.join(',')}`);
      }
      assert.ok(!names.includes('link_session'), 'M7のlink_sessionを公開している');
      for (const tool of tools) {
        assert.ok(
          typeof tool.inputSchema === 'object' && tool.inputSchema !== null,
          `${tool.name}にstrictな入力schemaがない`,
        );
      }
    } finally {
      await session.close();
    }
  });

  it('stdoutはJSON-RPCだけを出力し、tokenを混ぜない', async () => {
    central.requests.length = 0;
    central.setResponder(() => ({ status: 202, body: { request_id: uuidv7(), trigger: 'manual', status: 'pending' } }));
    const session = await startSession();
    try {
      const result = await session.callTool('search_history', validSearchArgs());
      assert.notEqual(result.isError, true, `正常なsearch_historyがtool error: ${JSON.stringify(result)}`);
      assert.ok(session.stdoutRawLines.length > 0, 'stdout出力がない');
      assert.deepEqual(session.pollutedStdoutLines, [], `stdoutへJSON-RPC以外を出力している: ${session.pollutedStdoutLines.join(' | ')}`);
      assert.ok(!session.stdoutText.includes(TOKEN), 'stdoutへtokenを出力している');
    } finally {
      await session.close();
    }
  });

  it('各toolのstrict schemaはunknown field・型不正・必須欠落をtool errorにし、中央APIへ送らない', async () => {
    central.requests.length = 0;
    central.setResponder(() => ({ status: 500, body: { error: { code: 'internal_error' } } }));
    const session = await startSession();
    try {
      const invalidCalls: Array<{ tool: string; args: Record<string, unknown> }> = [
        { tool: 'search_history', args: { ...validSearchArgs(), unknown_field: 'x' } },
        { tool: 'search_history', args: { ...validSearchArgs(), input_revision: '1' } },
        { tool: 'search_history', args: withoutKey(validSearchArgs(), 'query') },
        { tool: 'get_search_result', args: { project_id: uuidv7(), request_id: uuidv7(), wait_ms: 5001 } },
        { tool: 'get_search_result', args: { project_id: uuidv7(), unknown_field: 'x' } },
        { tool: 'get_evidence', args: { project_id: uuidv7(), message_id: uuidv7(), revision: 0 } },
        { tool: 'get_evidence', args: { project_id: uuidv7(), message_id: 'not-a-uuid', revision: 1 } },
        { tool: 'record_case', args: { ...validRecordArgs(), unknown_field: 'x' } },
        { tool: 'record_case', args: withoutKey(validRecordArgs(), 'problem') },
        { tool: 'record_case', args: { ...validRecordArgs(), sequence_no: '1' } },
      ];

      for (const call of invalidCalls) {
        const result = await session.callTool(call.tool, call.args);
        assert.equal(
          result.isError,
          true,
          `${call.tool}の不正入力 ${JSON.stringify(call.args)} を受理した: ${JSON.stringify(result)}`,
        );
      }
      assert.equal(central.requests.length, 0, '不正入力を中央APIへ送っている');
    } finally {
      await session.close();
    }
  });
});

describe('M6 MCP toolから中央APIへの契約', () => {
  it('search_historyはPOST /v1/searchesへBearerと条件を送り、structured contentとtextでrequest_idを返す', async () => {
    const requestId = uuidv7();
    central.requests.length = 0;
    central.setResponder(() => ({ status: 202, body: { request_id: requestId, trigger: 'manual', status: 'pending' } }));
    const session = await startSession();
    try {
      const args = validSearchArgs({ input_revision: 2, force_refresh: true });
      const result = await session.callTool('search_history', args);
      assert.notEqual(result.isError, true, `search_historyが失敗: ${JSON.stringify(result)}`);
      assert.equal(central.requests.length, 1, '中央API呼出しが1回ではない');
      const request = central.requests[0];
      assert.ok(request);
      assert.equal(request.method, 'POST');
      assert.equal(requestUrl(request).pathname, '/v1/searches');
      assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(request.body, args);
      const structured = result.structuredContent as { request_id?: string } | undefined;
      assert.equal(structured?.request_id, requestId, 'structured contentへrequest_idを返していない');
      assert.ok(
        (result.content ?? []).some((item) => item.type === 'text' && item.text?.includes(requestId)),
        'text contentへrequest_idを返していない',
      );
      assert.ok(!JSON.stringify(result).includes(TOKEN), 'tool結果へtokenを出している');
    } finally {
      await session.close();
    }
  });

  it('get_search_resultはrequest_idでGET /v1/searches/:idへwait_msを渡し、処理状態を返す', async () => {
    const requestId = uuidv7();
    const projectId = uuidv7();
    central.requests.length = 0;
    central.setResponder(() => ({
      status: 200,
      body: {
        request_id: requestId,
        input_id: uuidv7(),
        input_revision: 1,
        trigger: 'auto',
        search_action: 'new_search',
        reused_from_request_id: null,
        status: 'running',
        outcome: null,
        project_id: projectId,
        matches: [],
        warnings: [],
      },
    }));
    const session = await startSession();
    try {
      const result = await session.callTool('get_search_result', {
        project_id: projectId,
        request_id: requestId,
        wait_ms: 1000,
      });
      assert.notEqual(result.isError, true, `get_search_resultが失敗: ${JSON.stringify(result)}`);
      const request = central.requests[0];
      assert.ok(request);
      const url = requestUrl(request);
      assert.equal(request.method, 'GET');
      assert.equal(url.pathname, `/v1/searches/${requestId}`);
      assert.equal(url.searchParams.get('wait_ms'), '1000');
      assert.equal(url.searchParams.has('project_id'), false, 'request_id branchへproject_idを送っている');
      assert.equal(
        searchDetailQuerySchema.safeParse(Object.fromEntries(url.searchParams)).success,
        true,
        `request_id branchのqueryが中央API schemaと不一致: ${url.search}`,
      );
      const structured = result.structuredContent as { status?: string; outcome?: string | null } | undefined;
      assert.equal(structured?.status, 'running');
      assert.equal(structured?.outcome ?? null, null);
    } finally {
      await session.close();
    }
  });

  it('get_search_resultはrequest_id応答のproject_idが入力と不一致ならtool errorにする', async () => {
    const requestId = uuidv7();
    const responseProjectId = uuidv7();
    central.requests.length = 0;
    central.setResponder(() => ({
      status: 200,
      body: {
        request_id: requestId,
        input_id: uuidv7(),
        input_revision: 1,
        trigger: 'auto',
        search_action: 'new_search',
        reused_from_request_id: null,
        status: 'completed',
        outcome: 'matched',
        project_id: responseProjectId,
        matches: [],
        warnings: [],
      },
    }));
    const session = await startSession();
    try {
      const result = await session.callTool('get_search_result', {
        project_id: uuidv7(),
        request_id: requestId,
        wait_ms: 0,
      });
      assert.equal(result.isError, true, `別案件のproject_idを受理した: ${JSON.stringify(result)}`);
      assert.ok(!JSON.stringify(result).includes(TOKEN), 'tokenがtool結果へ出ている');
      assert.ok(!JSON.stringify(result).includes(responseProjectId), '応答のproject_idをtool結果へ出している');
    } finally {
      await session.close();
    }
  });

  it('get_search_resultは外部入力IDでby-inputを照合し、not_receivedをno_matchと区別する', async () => {
    central.requests.length = 0;
    central.setResponder(() => ({ status: 200, body: { lookup_status: 'not_received' } }));
    const session = await startSession();
    try {
      const projectId = uuidv7();
      const args = {
        project_id: projectId,
        source: 'codex',
        source_scope: 'scope-a',
        source_session_id: 'session-a',
        source_message_id: 'message-a',
        revision: 1,
      };
      const result = await session.callTool('get_search_result', args);
      assert.notEqual(result.isError, true, `by-input照合が失敗: ${JSON.stringify(result)}`);
      const request = central.requests[0];
      assert.ok(request);
      const url = requestUrl(request);
      assert.equal(request.method, 'GET');
      assert.equal(url.pathname, '/v1/searches/by-input');
      assert.equal(url.searchParams.get('project_id'), projectId);
      assert.equal(url.searchParams.get('source'), 'codex');
      assert.equal(url.searchParams.get('source_scope'), 'scope-a');
      assert.equal(url.searchParams.get('source_session_id'), 'session-a');
      assert.equal(url.searchParams.get('source_message_id'), 'message-a');
      assert.equal(url.searchParams.get('revision'), '1');
      const structured = result.structuredContent as { lookup_status?: string } | undefined;
      assert.equal(structured?.lookup_status, 'not_received');
      assert.ok(!JSON.stringify(result).includes('no_match'), 'not_receivedをno_matchへ変換している');
    } finally {
      await session.close();
    }
  });

  it('get_search_resultは外部入力IDでもwait_msをby-inputへ渡し、API schemaに適合するSearchViewを返す', async () => {
    const requestId = uuidv7();
    central.requests.length = 0;
    central.setResponder(() => ({
      status: 200,
      body: {
        lookup_status: 'found',
        request_id: requestId,
        input_id: uuidv7(),
        input_revision: 1,
        trigger: 'auto',
        status: 'completed',
        outcome: 'matched',
        project_id: uuidv7(),
        matches: [],
        warnings: [],
      },
    }));
    const session = await startSession();
    try {
      const result = await session.callTool('get_search_result', {
        project_id: uuidv7(),
        source: 'codex',
        source_scope: 'scope-a',
        source_session_id: 'session-a',
        source_message_id: 'message-a',
        revision: 1,
        wait_ms: 1000,
      });
      assert.notEqual(result.isError, true, `by-inputのget_search_resultが失敗: ${JSON.stringify(result)}`);
      const request = central.requests[0];
      assert.ok(request);
      const url = requestUrl(request);
      assert.equal(request.method, 'GET');
      assert.equal(url.pathname, '/v1/searches/by-input');
      assert.equal(url.searchParams.get('wait_ms'), '1000', 'by-inputへwait_msを渡していない');
      assert.equal(
        searchByInputQuerySchema.safeParse(Object.fromEntries(url.searchParams)).success,
        true,
        `by-input branchのqueryが中央API schemaと不一致: ${url.search}`,
      );
      const structured = result.structuredContent as { lookup_status?: string; status?: string; outcome?: string | null } | undefined;
      assert.equal(structured?.lookup_status, 'found');
      assert.equal(structured?.status, 'completed');
      assert.equal(structured?.outcome, 'matched');
    } finally {
      await session.close();
    }
  });

  it('get_evidenceはrevision付きで原文APIを呼び、identityとtextを返す', async () => {
    const messageId = uuidv7();
    const projectId = uuidv7();
    central.requests.length = 0;
    central.setResponder(() => ({
      status: 200,
      body: {
        message_id: messageId,
        revision: 1,
        employee_id: uuidv7(),
        role: 'assistant',
        occurred_at: '2026-09-21T01:00:00.000Z',
        text: '保存成功時にキャッシュを無効化した',
      },
    }));
    const session = await startSession();
    try {
      const result = await session.callTool('get_evidence', { project_id: projectId, message_id: messageId, revision: 1 });
      assert.notEqual(result.isError, true, `get_evidenceが失敗: ${JSON.stringify(result)}`);
      const request = central.requests[0];
      assert.ok(request);
      const url = requestUrl(request);
      assert.equal(request.method, 'GET');
      assert.equal(url.pathname, `/v1/evidence/${messageId}`);
      assert.equal(url.searchParams.get('project_id'), projectId);
      assert.equal(url.searchParams.get('revision'), '1');
      const structured = result.structuredContent as { text?: string; message_id?: string; revision?: number } | undefined;
      assert.equal(structured?.message_id, messageId);
      assert.equal(structured?.revision, 1);
      assert.equal(structured?.text, '保存成功時にキャッシュを無効化した');
    } finally {
      await session.close();
    }
  });

  it('record_caseは既存events APIへagent_reportとして固定順に送り、検索APIを呼ばない', async () => {
    central.requests.length = 0;
    central.setResponder(recordCaseReply);
    const session = await startSession();
    try {
      const values = {
        problem: '保存後に画面へ反映されない問題',
        cause: 'キャッシュ更新漏れ',
        investigation: 'API応答、DB保存、画面更新の順に確認',
        action: '保存成功時にキャッシュを無効化',
        failedAttempt: '再起動では解消しなかった',
        confirmation: '関連テスト成功。実画面は未確認',
        constraint: '本番データは未使用',
        related: 'src/cache.ts, PR #123',
      };
      const args = validRecordArgs({
        problem: values.problem,
        cause: values.cause,
        investigation_steps: [values.investigation],
        action: values.action,
        failed_attempts: [values.failedAttempt],
        confirmation_status: values.confirmation,
        constraints: [values.constraint],
        related_files_or_prs: [values.related],
      });
      const result = await session.callTool('record_case', args);
      assert.notEqual(result.isError, true, `record_caseが失敗: ${JSON.stringify(result)}`);
      assert.equal(central.requests.length, 1, '中央API呼出しが1回ではない');
      const request = central.requests[0];
      assert.ok(request);
      assert.equal(request.method, 'POST');
      assert.equal(requestUrl(request).pathname, '/v1/events');
      assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);

      const body = request.body as { project_id?: string; events?: Array<Record<string, unknown>> };
      assert.equal(body.project_id, args.project_id);
      const event = body.events?.[0];
      assert.ok(event, 'events[0]がない');
      assert.equal(event.role, 'agent_report');
      assert.equal(event.idempotency_key, args.idempotency_key);
      assert.equal(event.source, args.source);
      assert.equal(event.source_session_id, args.source_session_id);
      assert.equal(event.source_message_id, args.source_message_id);
      assert.equal(event.sequence_no, args.sequence_no);
      assert.equal(event.revision, args.revision);
      assert.equal(event.occurred_at, args.occurred_at);

      const text = String(event.text);
      const orderedValues = [
        values.problem,
        values.cause,
        values.investigation,
        values.action,
        values.failedAttempt,
        values.confirmation,
        values.constraint,
        values.related,
      ];
      const positions = orderedValues.map((value) => text.indexOf(value));
      for (const [index, position] of positions.entries()) {
        assert.ok(position >= 0, `本文に項目値${index}がない: ${text}`);
      }
      for (let index = 1; index < positions.length; index += 1) {
        assert.ok((positions[index] ?? -1) > (positions[index - 1] ?? -1), `本文の項目順が固定でない: ${text}`);
      }
      assert.ok(!central.requests.some((recorded) => requestUrl(recorded).pathname === '/v1/searches'), 'record_caseが検索APIを呼んでいる');
    } finally {
      await session.close();
    }
  });

  it('record_caseは600文字超でwarningを返して受理し、600文字以内ではwarningを返さない', async () => {
    central.requests.length = 0;
    central.setResponder(recordCaseReply);
    const session = await startSession();
    try {
      const shortResult = await session.callTool(
        'record_case',
        validRecordArgs({ problem: '短い問題', action: '短い対応', confirmation_status: '未確認' }),
      );
      assert.notEqual(shortResult.isError, true, `600文字以内のrecord_caseが失敗: ${JSON.stringify(shortResult)}`);
      assert.ok(!JSON.stringify(shortResult).includes('600'), '600文字以内なのにwarningを返している');

      const longResult = await session.callTool(
        'record_case',
        validRecordArgs({
          problem: `問題：${'再現手順を確認する。'.repeat(40)}`,
          action: `対応：${'キャッシュを無効化する。'.repeat(40)}`,
          confirmation_status: '未確認',
        }),
      );
      assert.notEqual(longResult.isError, true, `600文字超を拒否している: ${JSON.stringify(longResult)}`);
      assert.ok(JSON.stringify(longResult).includes('600'), '600文字超のwarningを返していない');
      assert.equal(central.requests.length, 2, '600文字超の記録が中央APIへ送られていない');
    } finally {
      await session.close();
    }
  });

  it('record_caseは要求eventと異なるidempotency_keyの応答を成功扱いしない', async () => {
    central.requests.length = 0;
    central.setResponder(() => ({
      status: 202,
      body: { results: [{ idempotency_key: 'different-key', message_id: uuidv7(), revision: 1, request_id: null }] },
    }));
    const session = await startSession();
    try {
      const result = await session.callTool('record_case', validRecordArgs());
      assert.equal(result.isError, true, `異なるidempotency_keyの応答を成功扱いした: ${JSON.stringify(result)}`);
      assert.ok(!JSON.stringify(result).includes(TOKEN), 'tokenがtool結果へ出ている');
      assert.equal(central.requests.length, 1, '中央API呼出しが1回ではない');
    } finally {
      await session.close();
    }
  });

  it('中央APIの応答schemaが不正ならtool errorにし、token・外部error本文を出さない', async () => {
    const session = await startSession();
    const secret = 'external-secret-body';
    const cases: Array<{ tool: string; args: Record<string, unknown>; body: Record<string, unknown> }> = [
      { tool: 'search_history', args: validSearchArgs(), body: { trigger: 'manual', error: secret } },
      {
        tool: 'get_search_result',
        args: { project_id: uuidv7(), request_id: uuidv7(), wait_ms: 0 },
        body: { status: 'running', error: secret },
      },
      {
        tool: 'get_evidence',
        args: { project_id: uuidv7(), message_id: uuidv7(), revision: 1 },
        body: { message_id: 'not-a-uuid', revision: 1, employee_id: uuidv7(), role: 'user', occurred_at: '2026-09-21T01:00:00.000Z', text: secret },
      },
      { tool: 'record_case', args: validRecordArgs(), body: { results: [], error: secret } },
      {
        tool: 'record_case',
        args: validRecordArgs(),
        body: { results: [{ idempotency_key: 123, message_id: uuidv7(), revision: 1, request_id: null }] },
      },
    ];
    try {
      for (const item of cases) {
        central.requests.length = 0;
        central.setResponder(() => ({ status: 200, body: item.body }));
        const result = await session.callTool(item.tool, item.args);
        assert.equal(result.isError, true, `${item.tool}: 不正な応答schemaを受理した: ${JSON.stringify(result)}`);
        assert.ok(!JSON.stringify(result).includes(TOKEN), `${item.tool}: tokenがtool結果へ出ている`);
        assert.ok(!JSON.stringify(result).includes(secret), `${item.tool}: 外部error本文がtool結果へ出ている`);
      }
    } finally {
      await session.close();
    }
  });

  it('record_caseは本文上限超を中央APIへ送らず、配列件数上限も境界で拒否する', async () => {
    central.requests.length = 0;
    central.setResponder(recordCaseReply);
    const session = await startSession();
    try {
      const oversized = await session.callTool(
        'record_case',
        validRecordArgs({
          problem: `問題：${'あ'.repeat(40_000)}`,
          action: `対応：${'い'.repeat(40_000)}`,
          confirmation_status: '未確認',
        }),
        { timeoutMs: 20_000 },
      );
      assert.equal(oversized.isError, true, `本文上限超を受理した: ${JSON.stringify(oversized)}`);
      assert.equal(central.requests.length, 0, '本文上限超を中央APIへ送っている');

      const tooMany = await session.callTool(
        'record_case',
        validRecordArgs({ investigation_steps: Array.from({ length: 51 }, () => '手順') }),
      );
      assert.equal(tooMany.isError, true, `配列件数上限超を受理した: ${JSON.stringify(tooMany)}`);
      assert.equal(central.requests.length, 0, '配列件数上限超を中央APIへ送っている');
    } finally {
      await session.close();
    }
  });
});

describe('M6 MCPの失敗区別と接続先制約', () => {
  it('中央APIの5xx/429/401/403/404/timeoutはtool errorにし、no_matchや空結果へ変換しない', async () => {
    const session = await startSession();
    try {
      for (const status of [401, 403, 404, 429, 500]) {
        central.requests.length = 0;
        central.setResponder(() => ({
          status,
          body: { error: { code: 'central_error', message: 'other-project-should-not-leak' } },
        }));
        const result = await session.callTool('search_history', validSearchArgs());
        assertToolError(result, `HTTP ${status}`);
      }

      central.requests.length = 0;
      central.setResponder(() => ({ status: 404, body: { error: { code: 'not_found' } } }));
      const notFound = await session.callTool('get_search_result', {
        project_id: uuidv7(),
        request_id: uuidv7(),
        wait_ms: 0,
      });
      assertToolError(notFound, 'GET search 404');

      central.requests.length = 0;
      central.setResponder(() => ({ hang: true }));
      const timeoutResult = await session.callTool('search_history', validSearchArgs(), { timeoutMs: 12000 });
      assertToolError(timeoutResult, 'central timeout');
    } finally {
      await session.close();
    }
  });

  it('HTTP接続先はHTTPSまたはloopbackだけを許可し、非loopback HTTPへ送信しない', async () => {
    const nonLoopback = findNonLoopbackIpv4();
    assert.ok(nonLoopback, '非loopback IPv4 addressを取得できない');
    const probe = await startFakeCentralApi({
      host: '0.0.0.0',
      responder: () => ({ status: 202, body: { request_id: uuidv7() } }),
    });
    // executable不存在でlaunchが失敗してもprobeを必ず閉じ、test processを残さない。
    try {
      const session = await McpSession.launch({
        apiUrl: `http://${nonLoopback}:${probe.port}`,
        token: TOKEN,
      });
      try {
        let rejected = false;
        try {
          await session.initialize(8000);
        } catch {
          rejected = true;
        }
        if (!rejected) {
          try {
            const result = await session.callTool('search_history', validSearchArgs(), { timeoutMs: 8000 });
            rejected = result.isError === true;
          } catch {
            rejected = true;
          }
        }
        assert.equal(rejected, true, '非loopback HTTPの接続先を受理してtoolを実行した');
        assert.equal(probe.requests.length, 0, '非loopback HTTPへリクエストを送信した');
        assert.ok(!session.stdoutText.includes(TOKEN), 'stdoutへtokenを出力している');
      } finally {
        await session.close();
      }
    } finally {
      await probe.close();
    }
  });

  it('MCP設定URLは資格情報・query・fragmentを拒否する', async () => {
    const invalidUrls = [
      'http://user:pass@127.0.0.1:1',
      'http://127.0.0.1:1/?x=1',
      'http://127.0.0.1:1/#frag',
    ];
    for (const apiUrl of invalidUrls) {
      const session = await McpSession.launch({ apiUrl, token: TOKEN });
      try {
        let rejected = false;
        try {
          await session.initialize(4000);
        } catch {
          rejected = true;
        }
        assert.equal(rejected, true, `${apiUrl} を受理した`);
        assert.ok(!session.stdoutText.includes(TOKEN), `${apiUrl}: stdoutへtokenを出力している`);
      } finally {
        await session.close();
      }
    }
  });
});
