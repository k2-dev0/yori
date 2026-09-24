import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import {
  McpSession,
  requestUrl,
  startFakeCentralApi,
  type FakeCentralApi,
  type FakeCentralReply,
  type McpToolCallResult,
  type RecordedCentralRequest,
} from './support.js';

// M7採用シナリオ1・MCP契約: link_sessionの公開、HTTP APIと同じstrict入力、POST /v1/session-linksへの写像、
// 成功応答のschema検証、4xx/5xx/timeoutのtool error化、stdout/token非漏えいのRedテスト（docs/m7-design.md）。
// 未実装の間はtoolが公開されずJSON-RPC errorまたは未公開assertで失敗する。

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

function startSession(): Promise<McpSession> {
  return McpSession.start({ apiUrl: central.baseUrl, token: TOKEN });
}

function linkIdentity(source: 'codex' | 'claude_code', sessionId: string): Record<string, string> {
  return { source, source_scope: 'github.example/team/repository', source_session_id: sessionId };
}

function validLinkArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: uuidv7(),
    idempotency_key: `mcp-link-${randomUUID()}`,
    from: linkIdentity('codex', `from-${randomUUID()}`),
    to: linkIdentity('claude_code', `to-${randomUUID()}`),
    evidence: {
      ...linkIdentity('claude_code', `evidence-${randomUUID()}`),
      source_message_id: `message-${randomUUID()}`,
      revision: 1,
    },
    ...overrides,
  };
}

function withoutKey(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...args };
  delete copy[key];
  return copy;
}

interface LinkResponse {
  link_id: string;
  project_id: string;
  from_session_id: string;
  to_session_id: string;
  evidence_message_id: string;
  evidence_revision: number;
  status: string;
}

// 中央APIの成功応答を組み立てる。link_sessionは入力の外部identityと応答の内部IDを区別する。
function successLinkReply(request: RecordedCentralRequest): FakeCentralReply {
  const body = request.body as Record<string, unknown>;
  return {
    status: 201,
    body: {
      link_id: uuidv7(),
      project_id: body.project_id as string,
      from_session_id: uuidv7(),
      to_session_id: uuidv7(),
      evidence_message_id: uuidv7(),
      evidence_revision: 1,
      status: 'active',
    } satisfies LinkResponse,
  };
}

function assertToolError(result: McpToolCallResult, label: string): void {
  assert.equal(result.isError, true, `${label}: tool errorになっていない: ${JSON.stringify(result)}`);
  assert.ok(!JSON.stringify(result).includes('no_match'), `${label}: no_matchへ変換している`);
  assert.ok(!JSON.stringify(result).includes(TOKEN), `${label}: tokenがtool結果へ出ている`);
}

describe('M7 MCP link_session', () => {
  it('link_sessionをstrict schema付きで公開する', async () => {
    const session = await startSession();
    try {
      const tools = await session.listTools();
      const tool = tools.find((candidate) => candidate.name === 'link_session');
      assert.ok(tool, `link_sessionが公開されていない: ${tools.map((item) => item.name).join(',')}`);
      assert.ok(typeof tool.inputSchema === 'object' && tool.inputSchema !== null, 'link_sessionに入力schemaがない');
    } finally {
      await session.close();
    }
  });

  it('strict入力をtool errorにし、中央APIへ送らない', async () => {
    central.requests.length = 0;
    central.setResponder(() => successLinkReply(central.requests[0] as RecordedCentralRequest));
    const session = await startSession();
    try {
      const valid = validLinkArgs();
      const invalidCalls: Array<{ label: string; args: Record<string, unknown> }> = [
        { label: 'unknown top-level', args: { ...valid, unknown_field: 'x' } },
        {
          label: 'unknown nested',
          args: { ...valid, to: { ...(valid.to as Record<string, unknown>), unknown_field: 'x' } },
        },
        { label: 'missing project_id', args: withoutKey(valid, 'project_id') },
        { label: 'missing idempotency_key', args: withoutKey(valid, 'idempotency_key') },
        {
          label: 'invalid source',
          args: { ...valid, from: { ...(valid.from as Record<string, unknown>), source: 'other_agent' } },
        },
        {
          label: 'evidence revision 0',
          args: { ...valid, evidence: { ...(valid.evidence as Record<string, unknown>), revision: 0 } },
        },
        { label: 'project_id not uuid', args: { ...valid, project_id: 'not-a-uuid' } },
      ];

      for (const invalid of invalidCalls) {
        const result = await session.callTool('link_session', invalid.args);
        assert.equal(result.isError, true, `${invalid.label}を受理した: ${JSON.stringify(result)}`);
      }
      assert.equal(central.requests.length, 0, '不正入力を中央APIへ送っている');
    } finally {
      await session.close();
    }
  });

  it('POST /v1/session-linksへBearerとstrict bodyを送り、成功応答をstructured contentとtextで返す', async () => {
    central.requests.length = 0;
    central.setResponder((request) => successLinkReply(request));
    const session = await startSession();
    try {
      const args = validLinkArgs();
      const result = await session.callTool('link_session', args);
      assert.notEqual(result.isError, true, `link_sessionが失敗: ${JSON.stringify(result)}`);
      assert.equal(central.requests.length, 1, '中央API呼出しが1回ではない');
      const request = central.requests[0];
      assert.ok(request);
      assert.equal(request.method, 'POST');
      assert.equal(requestUrl(request).pathname, '/v1/session-links');
      assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(request.body, args, 'MCP入力がHTTP bodyへそのまま写像されていない');

      const structured = result.structuredContent as Partial<LinkResponse> | undefined;
      assert.ok(typeof structured?.link_id === 'string', 'structured contentにlink_idがない');
      assert.equal(structured?.project_id, args.project_id);
      assert.equal(structured?.status, 'active');
      assert.equal(structured?.evidence_revision, 1);
      assert.ok(
        (result.content ?? []).some((item) => item.type === 'text' && item.text?.includes(structured?.link_id as string)),
        'text contentにlink_idがない',
      );
      assert.ok(!JSON.stringify(result).includes(TOKEN), 'tool結果へtokenを出している');
      assert.deepEqual(session.pollutedStdoutLines, [], `stdoutへJSON-RPC以外を出力している: ${session.pollutedStdoutLines.join(' | ')}`);
      assert.ok(!session.stdoutText.includes(TOKEN), 'stdoutへtokenを出力している');
    } finally {
      await session.close();
    }
  });

  it('中央APIの成功応答schemaを検証し、link_id欠落・status不正・project_id不一致をtool errorにする', async () => {
    const responses: Array<{ label: string; reply: FakeCentralReply; secret: string }> = [];
    const argsProjectId = uuidv7();
    responses.push({
      label: 'missing link_id',
      reply: { status: 201, body: { project_id: argsProjectId, from_session_id: uuidv7(), to_session_id: uuidv7(), evidence_message_id: uuidv7(), evidence_revision: 1, status: 'active' } },
      secret: 'CENTRAL-RESPONSE-SECRET-1',
    });
    responses.push({
      label: 'invalid status',
      reply: { status: 201, body: { link_id: uuidv7(), project_id: argsProjectId, from_session_id: uuidv7(), to_session_id: uuidv7(), evidence_message_id: uuidv7(), evidence_revision: 1, status: 'pending' } },
      secret: 'CENTRAL-RESPONSE-SECRET-2',
    });
    const mismatchedProjectId = uuidv7();
    responses.push({
      label: 'project_id mismatch',
      reply: { status: 201, body: { link_id: uuidv7(), project_id: mismatchedProjectId, from_session_id: uuidv7(), to_session_id: uuidv7(), evidence_message_id: uuidv7(), evidence_revision: 1, status: 'active' } },
      secret: mismatchedProjectId,
    });

    for (const testCase of responses) {
      central.requests.length = 0;
      central.setResponder(() => testCase.reply);
      const session = await startSession();
      try {
        const result = await session.callTool('link_session', validLinkArgs({ project_id: argsProjectId }));
        assertToolError(result, testCase.label);
        assert.ok(!JSON.stringify(result).includes(testCase.secret), `${testCase.label}: 中央API応答の値をtool結果へ出している`);
      } finally {
        await session.close();
      }
    }
  });

  it('中央APIの4xx/5xx/timeoutをtool errorにし、外部error bodyやtokenを漏らさない', async () => {
    const failures: Array<{ label: string; reply: FakeCentralReply }> = [
      { label: '400', reply: { status: 400, body: { error: { code: 'invalid_request', message: 'CENTRAL-ERROR-SECRET' } } } },
      { label: '409', reply: { status: 409, body: { error: { code: 'conflict', message: 'CENTRAL-ERROR-SECRET' } } } },
      { label: '500', reply: { status: 500, rawBody: 'CENTRAL-ERROR-SECRET' } },
    ];

    for (const failure of failures) {
      central.requests.length = 0;
      central.setResponder(() => failure.reply);
      const session = await startSession();
      try {
        const result = await session.callTool('link_session', validLinkArgs(), { timeoutMs: 15_000 });
        assertToolError(result, failure.label);
        assert.ok(!JSON.stringify(result).includes('CENTRAL-ERROR-SECRET'), `${failure.label}: 外部error bodyをtool結果へ出している`);
        assert.ok(!JSON.stringify(result).includes('no_match'), `${failure.label}: no_matchへ変換している`);
      } finally {
        await session.close();
      }
    }

    central.requests.length = 0;
    central.setResponder(() => ({ hang: true }));
    const session = await startSession();
    try {
      const result = await session.callTool('link_session', validLinkArgs(), { timeoutMs: 15_000 });
      assertToolError(result, 'timeout');
    } finally {
      await session.close();
    }
  });
});
