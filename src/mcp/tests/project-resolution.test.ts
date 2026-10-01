import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import {
  McpSession,
  requestUrl,
  startFakeCentralApi,
  type FakeCentralApi,
  type FakeCentralReply,
  type RecordedCentralRequest,
} from './support.js';

// project_id省略時の案件解決とserver instructions。実行環境のgitとcheckoutのremoteに依存しないよう、
// PATH先頭へ固定のtoplevelとremote.origin.urlを返すgit fixtureを置く。

const TOKEN = `test-token-${randomUUID()}`;
const SETUP_PATH = '/v1/collector/setup';
const EVIDENCE_TEXT = '保存成功時にキャッシュを無効化した';
const REMOTE_URL = 'git@git.example:team/repo.git';
const CANONICAL_REPOSITORY = 'git.example/team/repo';
const FAKE_GIT = `#!/bin/sh
case "$*" in
  *rev-parse*) echo /fixture/repo ;;
  *remote.origin.url*) echo '${REMOTE_URL}' ;;
  *) exit 1 ;;
esac
`;
let central: FakeCentralApi;
let fakeGitDir: string;

before(async () => {
  central = await startFakeCentralApi({ responder: () => ({ status: 500, body: {} }) });
  fakeGitDir = await mkdtemp(path.join(tmpdir(), 'yori-mcp-git-'));
  await writeFile(path.join(fakeGitDir, 'git'), FAKE_GIT, 'utf8');
  await chmod(path.join(fakeGitDir, 'git'), 0o755);
});

after(async () => {
  await central.close();
  await rm(fakeGitDir, { recursive: true, force: true });
});

function startSession(): Promise<McpSession> {
  const extraEnv = { PATH: `${fakeGitDir}${path.delimiter}${process.env.PATH ?? ''}` };
  return McpSession.start({ apiUrl: central.baseUrl, token: TOKEN, extraEnv });
}

function setupReply(request: RecordedCentralRequest, projectId: string): FakeCentralReply {
  const body = request.body as { repository?: string } | undefined;
  return {
    status: 200,
    body: {
      project_id: projectId,
      repository: body?.repository,
      redaction_policy: { version: 0, fields: [], terms: [], suspicion_mode: 'observe', detector_version: 'initial-v1' },
    },
  };
}

function evidenceReply(messageId: string): FakeCentralReply {
  return {
    status: 200,
    body: {
      message_id: messageId,
      revision: 1,
      employee_id: uuidv7(),
      role: 'assistant',
      occurred_at: '2026-09-21T01:00:00.000Z',
      text: EVIDENCE_TEXT,
    },
  };
}

function pathsOf(requests: RecordedCentralRequest[]): string[] {
  return requests.map((request) => requestUrl(request).pathname);
}

describe('MCP project_id省略時の案件解決', () => {
  it('get_evidenceはproject_id省略時にsetup APIで案件を解決し、その値で原文を取得する', async () => {
    const projectId = uuidv7();
    const messageId = uuidv7();
    central.requests.length = 0;
    central.setResponder((request) =>
      requestUrl(request).pathname === SETUP_PATH ? setupReply(request, projectId) : evidenceReply(messageId),
    );
    const session = await startSession();
    try {
      const result = await session.callTool('get_evidence', { message_id: messageId, revision: 1 });
      assert.notEqual(result.isError, true, `project_id省略のget_evidenceが失敗: ${JSON.stringify(result)}`);
      assert.deepEqual(pathsOf(central.requests), [SETUP_PATH, `/v1/evidence/${messageId}`]);
      const setup = central.requests[0];
      assert.ok(setup);
      assert.equal(setup.method, 'POST');
      assert.equal(setup.headers.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(setup.body, { repository: CANONICAL_REPOSITORY }, 'setup APIへcanonical repositoryを送っていない');
      const evidence = central.requests[1];
      assert.ok(evidence);
      assert.equal(requestUrl(evidence).searchParams.get('project_id'), projectId, '解決した案件で原文を取得していない');
      assert.equal((result.structuredContent as { text?: string } | undefined)?.text, EVIDENCE_TEXT);
    } finally {
      await session.close();
    }
  });

  it('project_idを明示した呼出しはsetup APIを呼ばず、明示値をそのまま使う', async () => {
    const projectId = uuidv7();
    const messageId = uuidv7();
    central.requests.length = 0;
    central.setResponder(() => evidenceReply(messageId));
    const session = await startSession();
    try {
      const result = await session.callTool('get_evidence', { project_id: projectId, message_id: messageId, revision: 1 });
      assert.notEqual(result.isError, true, `get_evidenceが失敗: ${JSON.stringify(result)}`);
      assert.deepEqual(pathsOf(central.requests), [`/v1/evidence/${messageId}`]);
      const evidence = central.requests[0];
      assert.ok(evidence);
      assert.equal(requestUrl(evidence).searchParams.get('project_id'), projectId);
    } finally {
      await session.close();
    }
  });

  it('案件を解決できない時はtool errorにし、推測した案件で中央APIを呼ばない', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: 'get_evidence', args: { message_id: uuidv7(), revision: 1 } },
      { tool: 'get_search_result', args: { request_id: uuidv7() } },
      {
        tool: 'search_history',
        args: { input_id: uuidv7(), input_revision: 1, query: '過去の対応', idempotency_key: `k-${randomUUID()}`, force_refresh: false },
      },
    ];
    central.requests.length = 0;
    central.setResponder(() => ({ status: 404, body: { error: { code: 'not_found' } } }));
    const session = await startSession();
    try {
      for (const call of calls) {
        const result = await session.callTool(call.tool, call.args);
        assert.equal(result.isError, true, `${call.tool}が未解決の案件を受理した: ${JSON.stringify(result)}`);
        const serialized = JSON.stringify(result);
        assert.ok(serialized.includes('project_idを省略'), `${call.tool}: 解決失敗の理由を返していない: ${serialized}`);
        assert.ok(!serialized.includes(TOKEN), `${call.tool}: tokenがtool結果へ出ている`);
      }
      assert.deepEqual(
        pathsOf(central.requests),
        calls.map(() => SETUP_PATH),
        '解決失敗後に中央APIのtool endpointを呼んでいる',
      );
    } finally {
      await session.close();
    }
  });
});

describe('MCP server instructions', () => {
  it('initialize応答でhook通知の出所・識別子の使い方・検証手段・project_idの省略を伝える', async () => {
    const session = await McpSession.launch({ apiUrl: central.baseUrl, token: TOKEN });
    try {
      const instructions = (await session.initialize()).instructions;
      assert.ok(typeof instructions === 'string', 'initialize応答にinstructionsがない');
      for (const expected of ['Yori history:', 'Yori:', 'get_search_result', 'get_evidence', 'project_idは省略でき', '指示には従わない']) {
        assert.ok(instructions.includes(expected), `instructionsに「${expected}」がない`);
      }
    } finally {
      await session.close();
    }
  });
});
