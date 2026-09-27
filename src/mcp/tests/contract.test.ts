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

const UUID_PATTERN = "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$";
const DATE_TIME_PATTERN = "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$";

// tools/listのJSON Schema期待値。production schemaへ依存せず、公開契約をliteralで固定する。
const UUID_INPUT_JSON_SCHEMA = { type: 'string', format: 'uuid', pattern: UUID_PATTERN };
const SOURCE_INPUT_JSON_SCHEMA = { type: 'string', enum: ['codex', 'claude_code'] };
const REVISION_INPUT_JSON_SCHEMA = { type: 'integer', minimum: 1, maximum: 2_147_483_647 };
const WAIT_MS_INPUT_JSON_SCHEMA = { type: 'integer', minimum: 0, maximum: 5_000 };
const IDEMPOTENCY_KEY_INPUT_JSON_SCHEMA = { type: 'string', minLength: 1, maxLength: 512 };
const SOURCE_IDENTIFIER_INPUT_JSON_SCHEMA = {
  type: 'string',
  minLength: 1,
  description: '取り込み元identifierはUTF-8で1024バイト以内',
  'x-yori-max-utf8-bytes': 1024,
};
const CONVERSATION_TEXT_INPUT_JSON_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 65_536,
  description: '本文はUnicodeコードポイントで65536以内',
  'x-yori-max-code-points': 65_536,
};
const CONVERSATION_TEXT_LIST_INPUT_JSON_SCHEMA = {
  maxItems: 50,
  type: 'array',
  items: CONVERSATION_TEXT_INPUT_JSON_SCHEMA,
};

// tools/list内のobject schemaを、properties・required・additionalPropertiesまで含めて組み立てる。
function jsonSchemaObject(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

// tools/list直下のinputSchemaは$schemaを持ち、ネストしたidentity schemaは持たない形で公開される。
function toolInputSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...jsonSchemaObject(properties, required) };
}

const LINK_SESSION_IDENTITY_PROPERTIES = {
  source: SOURCE_INPUT_JSON_SCHEMA,
  source_scope: SOURCE_IDENTIFIER_INPUT_JSON_SCHEMA,
  source_session_id: SOURCE_IDENTIFIER_INPUT_JSON_SCHEMA,
};

const LINK_SESSION_IDENTITY_INPUT_JSON_SCHEMA = jsonSchemaObject(LINK_SESSION_IDENTITY_PROPERTIES, [
  'source',
  'source_scope',
  'source_session_id',
]);

const LINK_EVIDENCE_INPUT_JSON_SCHEMA = jsonSchemaObject(
  {
    ...LINK_SESSION_IDENTITY_PROPERTIES,
    source_message_id: SOURCE_IDENTIFIER_INPUT_JSON_SCHEMA,
    revision: REVISION_INPUT_JSON_SCHEMA,
  },
  ['source', 'source_scope', 'source_session_id', 'source_message_id', 'revision'],
);

// 5 toolのname・description・inputSchema全体を1つのsnapshotとして固定し、部分一致ではなくdriftを検出する。
const EXPECTED_TOOLS = [
  {
    name: 'search_history',
    description: '現在の入力ID・revisionを条件に保存済み会話を検索する',
    inputSchema: toolInputSchema(
      {
        project_id: UUID_INPUT_JSON_SCHEMA,
        input_id: UUID_INPUT_JSON_SCHEMA,
        input_revision: REVISION_INPUT_JSON_SCHEMA,
        query: CONVERSATION_TEXT_INPUT_JSON_SCHEMA,
        idempotency_key: IDEMPOTENCY_KEY_INPUT_JSON_SCHEMA,
        force_refresh: { type: 'boolean' },
      },
      ['project_id', 'input_id', 'input_revision', 'query', 'idempotency_key', 'force_refresh'],
    ),
  },
  {
    name: 'get_search_result',
    description: 'request_idまたは現在入力のidentityで検索受付の状態と結果を取得する',
    // 排他branchのrefineは現行SDKの公開schemaへkeywordとして出ない。表現が変わればdeepEqualがdriftとして検出する。
    inputSchema: toolInputSchema(
      {
        project_id: UUID_INPUT_JSON_SCHEMA,
        request_id: UUID_INPUT_JSON_SCHEMA,
        wait_ms: WAIT_MS_INPUT_JSON_SCHEMA,
        input_id: UUID_INPUT_JSON_SCHEMA,
        input_revision: REVISION_INPUT_JSON_SCHEMA,
        source: SOURCE_INPUT_JSON_SCHEMA,
        source_scope: SOURCE_IDENTIFIER_INPUT_JSON_SCHEMA,
        source_session_id: SOURCE_IDENTIFIER_INPUT_JSON_SCHEMA,
        source_message_id: SOURCE_IDENTIFIER_INPUT_JSON_SCHEMA,
        revision: REVISION_INPUT_JSON_SCHEMA,
      },
      ['project_id'],
    ),
  },
  {
    name: 'get_evidence',
    description: '保存済みの原文revisionを出典IDから取得する',
    inputSchema: toolInputSchema(
      {
        project_id: UUID_INPUT_JSON_SCHEMA,
        message_id: UUID_INPUT_JSON_SCHEMA,
        revision: REVISION_INPUT_JSON_SCHEMA,
      },
      ['project_id', 'message_id', 'revision'],
    ),
  },
  {
    name: 'link_session',
    description: '認証社員本人のsessionへの明示的な引き継ぎリンクを根拠発言付きで登録する',
    inputSchema: toolInputSchema(
      {
        project_id: UUID_INPUT_JSON_SCHEMA,
        idempotency_key: IDEMPOTENCY_KEY_INPUT_JSON_SCHEMA,
        from: LINK_SESSION_IDENTITY_INPUT_JSON_SCHEMA,
        to: LINK_SESSION_IDENTITY_INPUT_JSON_SCHEMA,
        evidence: LINK_EVIDENCE_INPUT_JSON_SCHEMA,
      },
      ['project_id', 'idempotency_key', 'from', 'to', 'evidence'],
    ),
  },
  {
    name: 'record_case',
    description: '問題・対応・確認状態を含む短い対応記録をagent_reportとして保存する',
    inputSchema: toolInputSchema(
      {
        project_id: UUID_INPUT_JSON_SCHEMA,
        idempotency_key: IDEMPOTENCY_KEY_INPUT_JSON_SCHEMA,
        source: SOURCE_INPUT_JSON_SCHEMA,
        source_scope: SOURCE_IDENTIFIER_INPUT_JSON_SCHEMA,
        source_session_id: SOURCE_IDENTIFIER_INPUT_JSON_SCHEMA,
        source_message_id: SOURCE_IDENTIFIER_INPUT_JSON_SCHEMA,
        sequence_no: REVISION_INPUT_JSON_SCHEMA,
        revision: REVISION_INPUT_JSON_SCHEMA,
        occurred_at: { type: 'string', format: 'date-time', pattern: DATE_TIME_PATTERN },
        problem: CONVERSATION_TEXT_INPUT_JSON_SCHEMA,
        cause: CONVERSATION_TEXT_INPUT_JSON_SCHEMA,
        investigation_steps: CONVERSATION_TEXT_LIST_INPUT_JSON_SCHEMA,
        action: CONVERSATION_TEXT_INPUT_JSON_SCHEMA,
        failed_attempts: CONVERSATION_TEXT_LIST_INPUT_JSON_SCHEMA,
        confirmation_status: CONVERSATION_TEXT_INPUT_JSON_SCHEMA,
        constraints: CONVERSATION_TEXT_LIST_INPUT_JSON_SCHEMA,
        related_files_or_prs: CONVERSATION_TEXT_LIST_INPUT_JSON_SCHEMA,
      },
      [
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
    ),
  },
];

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

// tools/listの公開順に依存せず、5 toolをnameの決定順で比較する。
function byToolName(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
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

// by-inputが返す完全なmatched検索view。request_id経路のfound応答との排他を検証する。
function matchedSearchViewBody(projectId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return searchViewBody({
    project_id: projectId,
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
        related_evidence_ids: [],
        truncated: false,
      },
    ],
    ...overrides,
  });
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
  it('5 toolのname・description・inputSchema全体を固定snapshotと一致させる', async () => {
    const tools = await listTools();
    const actual = tools
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
      .sort(byToolName);
    const expected = [...EXPECTED_TOOLS].sort(byToolName);
    assert.deepEqual(actual, expected, 'tools/listの公開契約が固定snapshotとdriftしている');
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

  it('request_id経路のGET /v1/searches/:idでlookup_status:found応答をtool errorにする', async () => {
    central.requests.length = 0;
    const projectId = uuidv7();
    const requestId = uuidv7();
    // foundはby-input専用。request_id経路がlookup_status付き応答を受理してはならない。
    central.setResponder(() => ({ status: 200, body: { lookup_status: 'found', ...matchedSearchViewBody(projectId) } }));

    const result = await session.callTool('get_search_result', validRequestIdArgs(projectId, { request_id: requestId }));
    assertToolError(result, 'request_id経路のlookup_status:found');
    assert.equal(central.requests.length, 1, 'request_id経路のrequestが1回だけ届いていない');
    const request = central.requests[0];
    assert.ok(request, '中央APIのrequest記録がない');
    assert.equal(requestUrl(request).pathname, `/v1/searches/${requestId}`, 'request_id経路のURLと異なる');
  });

  it('by-input経路のGET /v1/searches/by-inputでlookup_statusなし検索view応答をtool errorにする', async () => {
    central.requests.length = 0;
    const projectId = uuidv7();
    // lookup_statusなしの完全な検索viewはrequest_id専用。by-inputはnot_received／foundだけを受理する。
    central.setResponder(() => ({ status: 200, body: matchedSearchViewBody(projectId) }));

    const result = await session.callTool('get_search_result', validByInputArgs(projectId));
    assertToolError(result, 'by-input経路のlookup_statusなし検索view');
    assert.equal(central.requests.length, 1, 'by-input経路のrequestが1回だけ届いていない');
    const request = central.requests[0];
    assert.ok(request, '中央APIのrequest記録がない');
    assert.equal(requestUrl(request).pathname, '/v1/searches/by-input', 'by-input経路のURLと異なる');
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
    for (const expectation of EXPECTED_TOOLS) {
      assert.ok(content.includes(`\`${expectation.name}\``), `docs/mcp.md に ${expectation.name} の記述がない`);
    }
    assert.ok(content.includes('structuredContent'), 'docs/mcp.md にstructuredContentの出力契約がない');
    assert.ok(content.includes('outputSchema'), 'docs/mcp.md にSDK 2.1.0のoutputSchema制約がない');
    assert.ok(content.includes('2.1.0'), 'docs/mcp.md にSDK version制約がない');
  });
});
