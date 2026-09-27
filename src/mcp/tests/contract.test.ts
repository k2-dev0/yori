import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v7 as uuidv7 } from 'uuid';
import { MAX_SOURCE_IDENTIFIER_BYTES, MAX_TEXT_LENGTH } from '../../api/contract.js';
import {
  McpSession,
  requestUrl,
  startFakeCentralApi,
  type FakeCentralApi,
  type FakeCentralReply,
  type McpToolCallResult,
  type McpToolDefinition,
  type RecordedCentralRequest,
} from './support.js';

// API契約実装計画の採用シナリオ4・5・6をstdio MCPの公開境界で確認するRedテスト。
// 実装される契約:
// - 5 toolのname/description/input schemaを固定し、UUID正規化・UTF-8 byte上限・本文長・wait_ms・
//   排他的branchをHTTPと同じ共有schemaで検証する
// - 中央API応答を出力Zod schemaで検証してから返し、structuredContentとtext JSONを同値にし、
//   追加fieldを保持し、不正応答をtool errorにしてno_matchへ変換しない
// - SDK 2.1.0のoutputSchema制約とMCP出力契約をdocs/mcp.mdへ文書化する
// 出力検証・共有上限が未実装の間は、該当itがtool結果の相違としてRedになる。

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MCP_DOCS_PATH = path.join(REPO_ROOT, 'docs/mcp.md');
const TOKEN = `contract-token-${randomUUID()}`;

const TOOL_EXPECTATIONS = [
  {
    name: 'search_history',
    description: '現在の入力ID・revisionを条件に保存済み会話を検索する',
    required: ['project_id', 'input_id', 'input_revision', 'query', 'idempotency_key', 'force_refresh'],
  },
  {
    name: 'get_search_result',
    description: 'request_idまたは現在入力のidentityで検索受付の状態と結果を取得する',
    required: ['project_id'],
  },
  {
    name: 'get_evidence',
    description: '保存済みの原文revisionを出典IDから取得する',
    required: ['project_id', 'message_id', 'revision'],
  },
  {
    name: 'link_session',
    description: '認証社員本人のsessionへの明示的な引き継ぎリンクを根拠発言付きで登録する',
    required: ['project_id', 'idempotency_key', 'from', 'to', 'evidence'],
  },
  {
    name: 'record_case',
    description: '問題・対応・確認状態を含む短い対応記録をagent_reportとして保存する',
    required: [
      'project_id',
      'idempotency_key',
      'source',
      'source_scope',
      'source_session_id',
      'source_message_id',
      'sequence_no',
      'revision',
      'occurred_at',
      'problem',
      'action',
      'confirmation_status',
    ],
  },
] as const;

interface ToolInputSchema {
  type?: unknown;
  additionalProperties?: unknown;
  required?: unknown;
  properties?: Record<string, Record<string, unknown>>;
}

let central: FakeCentralApi;
let session: McpSession;
let toolsCache: McpToolDefinition[] | undefined;

before(async () => {
  central = await startFakeCentralApi({
    responder: () => ({ status: 500, body: { error: { code: 'internal_error' } } }),
  });
  session = await McpSession.start({ apiUrl: central.baseUrl, token: TOKEN });
});

after(async () => {
  await session.close();
  await central.close();
});

function requiredNames(schema: { required?: unknown }): string[] {
  const required = schema.required;
  return Array.isArray(required) ? required.filter((value): value is string => typeof value === 'string') : [];
}

// tools/listは公開契約なので、同じ実行の結果をそのまま固定対象にする。
async function listTools(): Promise<McpToolDefinition[]> {
  toolsCache ??= await session.listTools();
  return toolsCache;
}

function inputSchemaOf(tools: McpToolDefinition[], name: string): ToolInputSchema {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name}が公開されていない`);
  assert.ok(typeof tool.inputSchema === 'object' && tool.inputSchema !== null, `${name}に入力schemaがない`);
  return tool.inputSchema as ToolInputSchema;
}

function validSearchArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: uuidv7(),
    input_id: uuidv7(),
    input_revision: 1,
    query: '過去の類似対応と調査手順を検索',
    idempotency_key: `contract-search-${randomUUID()}`,
    force_refresh: false,
    ...overrides,
  };
}

function validRequestIdArgs(projectId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { project_id: projectId, request_id: uuidv7(), ...overrides };
}

function validByInputArgs(projectId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: projectId,
    source: 'codex',
    source_scope: 'scope-a',
    source_session_id: 'session-a',
    source_message_id: 'message-a',
    revision: 1,
    ...overrides,
  };
}

function validRecordArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: uuidv7(),
    idempotency_key: `contract-case-${randomUUID()}`,
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

function validLinkArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const from = { source: 'codex', source_scope: 'scope-a', source_session_id: 'session-a' };
  const to = { source: 'codex', source_scope: 'scope-a', source_session_id: 'session-b' };
  return {
    project_id: uuidv7(),
    idempotency_key: `contract-link-${randomUUID()}`,
    from,
    to,
    evidence: { ...from, source_message_id: 'message-a', revision: 1 },
    ...overrides,
  };
}

// 出力schemaが受理すべき検索viewの正常形。HTTP testと同じfield構成にする。
function searchViewBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: uuidv7(),
    input_id: uuidv7(),
    input_revision: 1,
    trigger: 'manual',
    search_action: 'new_search',
    reused_from_request_id: null,
    status: 'pending',
    outcome: null,
    error_code: null,
    project_id: uuidv7(),
    matches: [],
    warnings: [],
    ...overrides,
  };
}

function notReceivedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lookup_status: 'not_received',
    request_id: null,
    input_id: null,
    input_revision: null,
    trigger: null,
    status: null,
    outcome: null,
    ...overrides,
  };
}

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

function linkSessionReply(request: RecordedCentralRequest): FakeCentralReply {
  const body = request.body as { project_id?: string } | undefined;
  return {
    status: 201,
    body: {
      link_id: uuidv7(),
      project_id: body?.project_id,
      from_session_id: uuidv7(),
      to_session_id: uuidv7(),
      evidence_message_id: uuidv7(),
      evidence_revision: 1,
      status: 'active',
    },
  };
}

// 不正な中央API応答がtool errorのまま返り、no_matchや空結果へ変換されていないことを確認する。
function assertToolError(result: McpToolCallResult, label: string): void {
  assert.equal(result.isError, true, `${label}: tool errorになっていない: ${JSON.stringify(result)}`);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('no_match'), `${label}: no_matchへ変換している`);
  assert.ok(!serialized.includes(TOKEN), `${label}: tokenがtool結果へ出ている`);
}

describe('MCP 5 toolの入力契約', () => {
  it('5 toolのname・description・input schemaの必須fieldを固定する', async () => {
    const tools = await listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      TOOL_EXPECTATIONS.map((expectation) => expectation.name).sort(),
      '公開toolの集合が固定契約と一致しない',
    );
    for (const expectation of TOOL_EXPECTATIONS) {
      const tool = tools.find((candidate) => candidate.name === expectation.name);
      assert.ok(tool, `${expectation.name}が公開されていない`);
      assert.equal(tool.description, expectation.description, `${expectation.name}のdescriptionが固定契約と異なる`);
      const schema = inputSchemaOf(tools, expectation.name);
      assert.equal(schema.type, 'object', `${expectation.name}のinput schemaがobjectでない`);
      assert.equal(schema.additionalProperties, false, `${expectation.name}がunknown fieldを拒否しない`);
      assert.deepEqual(requiredNames(schema).sort(), [...expectation.required].sort(), `${expectation.name}の必須fieldが異なる`);
    }
  });

  it('UUID・revision・wait_msの境界がHTTP契約と同じZod制約で公開される', async () => {
    const tools = await listTools();
    const search = inputSchemaOf(tools, 'search_history');
    assert.equal(search.properties?.project_id?.format, 'uuid', 'project_idがUUID契約でない');
    assert.equal(search.properties?.input_id?.format, 'uuid', 'input_idがUUID契約でない');
    assert.equal(search.properties?.input_revision?.minimum, 1);
    assert.equal(search.properties?.input_revision?.maximum, 2_147_483_647);
    assert.equal(search.properties?.idempotency_key?.maxLength, 512);

    const result = inputSchemaOf(tools, 'get_search_result');
    assert.equal(result.properties?.wait_ms?.minimum, 0, 'wait_ms下限がHTTP契約と異なる');
    assert.equal(result.properties?.wait_ms?.maximum, 5000, 'wait_ms上限がHTTP契約と異なる');
    assert.deepEqual(result.properties?.source?.enum, ['codex', 'claude_code']);
    assert.equal(result.properties?.input_id?.format, 'uuid');

    const evidence = inputSchemaOf(tools, 'get_evidence');
    assert.equal(evidence.properties?.message_id?.format, 'uuid');
    assert.equal(evidence.properties?.revision?.minimum, 1);

    const link = inputSchemaOf(tools, 'link_session');
    const evidenceIdentity = link.properties?.evidence as { required?: unknown } | undefined;
    assert.ok(evidenceIdentity, 'link_session.evidenceのschemaがない');
    assert.deepEqual(requiredNames(evidenceIdentity).sort(), [
      'revision',
      'source',
      'source_message_id',
      'source_scope',
      'source_session_id',
    ]);

    const record = inputSchemaOf(tools, 'record_case');
    assert.equal(record.properties?.occurred_at?.format, 'date-time');
    assert.equal(record.properties?.sequence_no?.minimum, 1);
    assert.equal(record.properties?.revision?.minimum, 1);
  });

  it('get_search_resultの排他的branchを維持し、不正な組み合わせを中央APIへ送らない', async () => {
    central.requests.length = 0;
    central.setResponder(() => ({ status: 200, body: notReceivedBody() }));
    const invalidCalls: Array<Record<string, unknown>> = [
      { ...validRequestIdArgs(uuidv7()), input_id: uuidv7(), input_revision: 1 },
      { project_id: uuidv7() },
      { project_id: uuidv7(), input_id: uuidv7() },
      { project_id: uuidv7(), source: 'codex' },
      { project_id: uuidv7(), source: 'codex', source_scope: 'scope-a', source_session_id: 'session-a', source_message_id: 'message-a' },
      // 他branchの既知fieldを1つでも併記した入力を拒否する。
      { ...validRequestIdArgs(uuidv7()), source_scope: 'scope-a' },
      { ...validRequestIdArgs(uuidv7()), revision: 1 },
      { project_id: uuidv7(), input_id: uuidv7(), input_revision: 1, revision: 1 },
      {
        project_id: uuidv7(),
        source: 'codex',
        source_scope: 'scope-a',
        source_session_id: 'session-a',
        source_message_id: 'message-a',
        revision: 1,
        input_revision: 1,
      },
    ];
    for (const args of invalidCalls) {
      const result = await session.callTool('get_search_result', args);
      assert.equal(result.isError, true, `排他的branch違反 ${JSON.stringify(args)} を受理した: ${JSON.stringify(result)}`);
    }
    assert.equal(central.requests.length, 0, 'branch違反入力を中央APIへ送っている');
  });

  it('wait_msはHTTPと同じ0〜5000ミリ秒で、境界値が中央APIのqueryへ渡る', async () => {
    central.requests.length = 0;
    const projectId = uuidv7();
    central.setResponder(() => ({ status: 200, body: searchViewBody({ project_id: projectId }) }));

    const accepted = await session.callTool('get_search_result', validRequestIdArgs(projectId, { wait_ms: 5000 }));
    assert.notEqual(accepted.isError, true, `上限内wait_msを拒否した: ${JSON.stringify(accepted)}`);
    assert.equal(central.requests.length, 1, 'wait_ms付きrequestが中央APIへ1回だけ届いていない');
    const firstRequest = central.requests[0];
    assert.ok(firstRequest, '中央APIのrequest記録がない');
    assert.equal(requestUrl(firstRequest).searchParams.get('wait_ms'), '5000');

    const overLimit = await session.callTool('get_search_result', validRequestIdArgs(projectId, { wait_ms: 5001 }));
    assert.equal(overLimit.isError, true, '5001msを受理している');
    assert.equal(central.requests.length, 1, '上限超過wait_msを中央APIへ送っている');

    const nonInteger = await session.callTool('get_search_result', validRequestIdArgs(projectId, { wait_ms: '500' }));
    assert.equal(nonInteger.isError, true, '文字列wait_msを受理している');
    assert.equal(central.requests.length, 1, '不正wait_msを中央APIへ送っている');
  });

  it('HTTPと同じUUID正規化を共有し、大文字UUIDを小文字で中央APIへ送る', async () => {
    central.requests.length = 0;
    central.setResponder(() => ({ status: 202, body: { request_id: uuidv7() } }));
    const projectId = uuidv7().toUpperCase();
    const inputId = uuidv7().toUpperCase();

    const result = await session.callTool('search_history', validSearchArgs({ project_id: projectId, input_id: inputId }));
    assert.notEqual(result.isError, true, `HTTPが受理する大文字UUIDをMCPが拒否した: ${JSON.stringify(result)}`);
    const request = central.requests[0];
    assert.ok(request, '中央APIへ到達していない');
    const body = request.body as { project_id?: unknown; input_id?: unknown };
    assert.equal(body.project_id, projectId.toLowerCase(), 'project_idを小文字へ正規化していない');
    assert.equal(body.input_id, inputId.toLowerCase(), 'input_idを小文字へ正規化していない');
  });

  it('取り込み元identifierのUTF-8 1024バイト上限をHTTPと共有する', async () => {
    central.requests.length = 0;
    // 342文字はUTF-16長では1024以下だが、UTF-8では1026バイトになり上限を超える。
    const overBytes = 'あ'.repeat(Math.floor(MAX_SOURCE_IDENTIFIER_BYTES / 3) + 1);
    assert.ok(overBytes.length <= MAX_SOURCE_IDENTIFIER_BYTES, 'code-unit長では上限内に収まる必要がある');
    assert.ok(Buffer.byteLength(overBytes, 'utf8') > MAX_SOURCE_IDENTIFIER_BYTES, 'UTF-8 byte長が上限を超える必要がある');

    central.setResponder((request) => recordCaseReply(request));
    const recordResult = await session.callTool('record_case', validRecordArgs({ source_scope: overBytes }));
    assert.equal(
      recordResult.isError,
      true,
      `UTF-8 ${Buffer.byteLength(overBytes, 'utf8')}バイトのsource_scopeを受理している: ${JSON.stringify(recordResult)}`,
    );
    assert.equal(central.requests.length, 0, 'UTF-8上限超過のsource_scopeを中央APIへ送っている');

    central.setResponder((request) => linkSessionReply(request));
    const linkResult = await session.callTool(
      'link_session',
      validLinkArgs({ from: { source: 'codex', source_scope: 'scope-a', source_session_id: overBytes } }),
    );
    assert.equal(linkResult.isError, true, 'UTF-8上限超過のsource_session_idを受理している');
    assert.equal(central.requests.length, 0, 'UTF-8上限超過のidentifierを中央APIへ送っている');
  });

  it('本文長はHTTPと同じUnicodeコードポイント上限で判定する', async () => {
    central.requests.length = 0;
    central.setResponder(() => ({ status: 202, body: { request_id: uuidv7() } }));
    const query = '😀'.repeat(40_000);
    assert.ok([...query].length <= MAX_TEXT_LENGTH && query.length > MAX_TEXT_LENGTH, 'テスト入力がHTTP側のコードポイント上限内である必要がある');

    const accepted = await session.callTool('search_history', validSearchArgs({ query }));
    assert.notEqual(
      accepted.isError,
      true,
      `HTTPが受理する${[...query].length}コードポイントの本文をMCPが拒否した: ${JSON.stringify(accepted)}`,
    );
    const request = central.requests[0];
    assert.ok(request, '中央APIへ到達していない');
    assert.equal((request.body as { query?: unknown }).query, query, '本文を変換・切り詰めている');

    const overLimit = await session.callTool('search_history', validSearchArgs({ query: '😀'.repeat(MAX_TEXT_LENGTH + 1) }));
    assert.equal(overLimit.isError, true, `${MAX_TEXT_LENGTH + 1}コードポイントの本文を受理している`);
    assert.equal(central.requests.length, 1, '上限超過本文を中央APIへ送っている');
  });
});

describe('MCP中央API応答の出力契約', () => {
  it('出力schemaで検証した応答をstructuredContentとtext JSONの同値で返し、追加fieldを保持する', async () => {
    central.requests.length = 0;
    const view = searchViewBody({ future_field: { nested: ['x', 1] } });
    central.setResponder(() => ({ status: 200, body: view }));

    const result = await session.callTool('get_search_result', validRequestIdArgs(view.project_id as string));
    assert.notEqual(result.isError, true, `正常な検索viewをtool errorにした: ${JSON.stringify(result)}`);
    const structured = result.structuredContent as Record<string, unknown>;
    assert.deepEqual(structured, view, '中央APIの追加fieldを破棄している');
    const textValue = result.content?.[0]?.text;
    assert.ok(typeof textValue === 'string', 'text contentがない');
    assert.deepEqual(JSON.parse(textValue), structured, 'structuredContentとtext JSONが同値でない');

    // matched結果もHTTPと同じ公開fieldを持てば出力schemaを通過する。
    const matched = searchViewBody({
      status: 'completed',
      outcome: 'matched',
      index_status: {
        pending_documents: 0,
        failed_documents: 0,
        embedding_generation_id: uuidv7(),
        search_mode: 'exact_vector_and_entity',
      },
      matches: [
        {
          case_or_document_id: uuidv7(),
          relevance_kind: ['similar_symptom'],
          claim_status: 'agent_reported',
          evidence: [
            {
              message_id: uuidv7(),
              revision: 1,
              employee_id: uuidv7(),
              role: 'user',
              occurred_at: '2026-09-21T01:00:00.000Z',
              text: '根拠の原文',
            },
          ],
          related_evidence: [
            {
              message_id: uuidv7(),
              revision: 1,
              employee_id: uuidv7(),
              role: 'assistant',
              occurred_at: '2026-09-21T01:00:00.000Z',
              text: '関連する根拠の原文',
              source_kind: 'correction',
              relation: 'change',
              related_to_message_id: uuidv7(),
              related_to_revision: 1,
              relations: [
                {
                  relation: 'change',
                  related_to_message_id: uuidv7(),
                  related_to_revision: 1,
                  future_relation_field: 'kept',
                },
              ],
              future_related_field: 'kept',
            },
          ],
          related_evidence_ids: [],
          truncated: false,
          future_match_field: 'kept',
        },
      ],
    });
    central.setResponder(() => ({ status: 200, body: matched }));
    const matchedResult = await session.callTool('get_search_result', validRequestIdArgs(matched.project_id as string));
    assert.notEqual(matchedResult.isError, true, `正常なmatched応答をtool errorにした: ${JSON.stringify(matchedResult)}`);
    assert.deepEqual(matchedResult.structuredContent, matched, 'matchedの公開fieldを欠落させている');

    central.setResponder(() => ({ status: 200, body: notReceivedBody({ future_field: 'kept' }) }));
    const notReceivedResult = await session.callTool('get_search_result', validByInputArgs(uuidv7()));
    assert.notEqual(notReceivedResult.isError, true, `正常なnot_receivedをtool errorにした: ${JSON.stringify(notReceivedResult)}`);
    assert.deepEqual(notReceivedResult.structuredContent, notReceivedBody({ future_field: 'kept' }), 'not_receivedの追加fieldを破棄している');
  });

  it('中央APIの検索view不正応答をtool errorにし、no_matchへ変換しない', async () => {
    central.requests.length = 0;
    const projectId = uuidv7();
    central.setResponder(() => ({
      status: 200,
      body: { ...searchViewBody({ project_id: projectId }), status: 'completed', outcome: 'matched', matches: 'not-an-array' },
    }));
    const brokenView = await session.callTool('get_search_result', validRequestIdArgs(projectId));
    assertToolError(brokenView, 'matchedのmatches型不正');
  });

  it('完全なsearch view fieldが混在したnot_receivedをtool errorにする', async () => {
    central.requests.length = 0;
    const mixedProjectId = uuidv7();
    central.setResponder(() => ({
      status: 200,
      body: notReceivedBody({
        request_id: uuidv7(),
        input_id: uuidv7(),
        input_revision: 1,
        trigger: 'manual',
        status: 'pending',
        outcome: null,
        project_id: mixedProjectId,
        search_action: 'new_search',
        reused_from_request_id: null,
        error_code: null,
        matches: [],
        warnings: [],
      }),
    }));
    const brokenNotReceived = await session.callTool('get_search_result', validByInputArgs(uuidv7()));
    assertToolError(brokenNotReceived, 'not_receivedとsearch viewの混在');
    assert.ok(!JSON.stringify(brokenNotReceived).includes(mixedProjectId), '検索view fieldをnot_received応答として誤受理している');
  });

  it('related_evidenceの型不正・必須field欠落をtool errorにする', async () => {
    central.requests.length = 0;
    const projectId = uuidv7();
    const matchedView = (relatedEvidence: unknown): Record<string, unknown> => ({
      ...searchViewBody({ project_id: projectId }),
      status: 'completed',
      outcome: 'matched',
      matches: [
        {
          case_or_document_id: uuidv7(),
          relevance_kind: ['similar_symptom'],
          claim_status: 'agent_reported',
          evidence: [
            {
              message_id: uuidv7(),
              revision: 1,
              employee_id: uuidv7(),
              role: 'user',
              occurred_at: '2026-09-21T01:00:00.000Z',
              text: '代表根拠の原文',
            },
          ],
          related_evidence: relatedEvidence,
          related_evidence_ids: [],
          truncated: false,
        },
      ],
    });

    central.setResponder(() => ({ status: 200, body: matchedView('not-an-array') }));
    assertToolError(
      await session.callTool('get_search_result', validRequestIdArgs(projectId)),
      'related_evidenceの文字列',
    );

    central.setResponder(() => ({
      status: 200,
      body: matchedView([{ message_id: uuidv7(), revision: 1, source_kind: 'neighbor' }]),
    }));
    assertToolError(
      await session.callTool('get_search_result', validRequestIdArgs(projectId)),
      'related_evidenceのidentity・原文欠落',
    );

    central.setResponder(() => ({
      status: 200,
      body: matchedView([
        {
          message_id: uuidv7(),
          revision: 1,
          employee_id: uuidv7(),
          role: 'user',
          occurred_at: '2026-09-21T01:00:00.000Z',
          text: '関連根拠',
          source_kind: 'neighbor',
          relation: 1,
        },
      ]),
    }));
    assertToolError(await session.callTool('get_search_result', validRequestIdArgs(projectId)), 'relationの型不正');
  });

  it('中央APIのevidence不正応答をtool errorにし、no_matchへ変換しない', async () => {
    central.requests.length = 0;
    central.setResponder(() => ({
      status: 200,
      body: {
        message_id: uuidv7(),
        revision: 1,
        employee_id: uuidv7(),
        role: 'user',
        occurred_at: '2026-09-21 01:00:00',
        text: '証拠の原文',
      },
    }));
    const brokenEvidence = await session.callTool('get_evidence', { project_id: uuidv7(), message_id: uuidv7(), revision: 1 });
    assertToolError(brokenEvidence, 'evidenceのoccurred_at不正');
  });
});

describe('MCP契約の文書化', () => {
  it('SDK制約とMCP出力契約がdocs/mcp.mdへ文書化されている', async () => {
    let content: string;
    try {
      content = await readFile(MCP_DOCS_PATH, 'utf8');
    } catch {
      assert.fail('docs/mcp.md が未作成です');
    }
    for (const expectation of TOOL_EXPECTATIONS) {
      assert.ok(content.includes(`\`${expectation.name}\``), `docs/mcp.md に ${expectation.name} の記述がない`);
    }
    assert.ok(content.includes('structuredContent'), 'docs/mcp.md にstructuredContentの出力契約がない');
    assert.ok(content.includes('outputSchema'), 'docs/mcp.md にSDK 2.1.0のoutputSchema制約がない');
    assert.ok(content.includes('2.1.0'), 'docs/mcp.md にSDK version制約がない');
  });
});
