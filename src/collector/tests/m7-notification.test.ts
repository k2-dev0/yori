import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import {
  assertStateDoesNotContain,
  buildCollectorConfig,
  buildHook,
  codexMessageLine,
  codexSessionLine,
  createCollectorFixture,
  runCollectorCli,
  writeTranscript,
  type CollectorFixture,
} from './support.js';

// M7補助通知（docs/m7-design.md 補助通知）のRedテスト。
// 正本は通知用command名を固定していないため、最小の新command名 `notify` を要求する。
// collect処理の実行後に、その呼出しで確定した最新user message identityでGET /v1/searches/by-inputを
// 呼び、完了結果だけをstdoutの追加contextにする。not_received/pending/running/timeoutは無出力、
// failedはno_matchにしない。実ユーザーのhook設定やtokenは変更・出力しない。

interface RecordedHttpRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
  receivedAt: number;
}

interface FakeReply {
  status?: number;
  body?: unknown;
  rawBody?: string;
  hang?: boolean;
}

interface FakeCentral {
  baseUrl: string;
  requests: RecordedHttpRequest[];
  byInputRequests: RecordedHttpRequest[];
  close(): Promise<void>;
}

type ByInputResponder = (request: RecordedHttpRequest, index: number) => FakeReply | Promise<FakeReply>;

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// 実HTTPを起こさず、collectのPOST /v1/eventsへ既存ack形式を返し、by-inputだけをtestごとに差し替える。
async function startFakeCentral(byInput: ByInputResponder): Promise<FakeCentral> {
  const requests: RecordedHttpRequest[] = [];
  let byInputIndex = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const rawBody = await readRequestBody(request);
      const recorded: RecordedHttpRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: rawBody,
        receivedAt: Date.now(),
      };
      requests.push(recorded);
      if (request.method === 'POST' && request.url === '/v1/events') {
        const body = JSON.parse(rawBody) as { events?: Array<{ idempotency_key?: string; revision?: number }> };
        const events = body.events ?? [];
        response.statusCode = 202;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            results: events.map((event) => ({
              idempotency_key: event.idempotency_key,
              message_id: uuidv7(),
              revision: event.revision,
              request_id: null,
            })),
          }),
        );
        return;
      }
      if (request.method === 'GET' && request.url?.startsWith('/v1/searches/by-input')) {
        const reply = await byInput(recorded, byInputIndex);
        byInputIndex += 1;
        if (reply.hang) {
          return;
        }
        response.statusCode = reply.status ?? 200;
        response.setHeader('content-type', 'application/json');
        response.end(reply.rawBody ?? JSON.stringify(reply.body ?? {}));
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    })().catch(() => {
      response.destroy();
    });
    request.on('error', () => undefined);
    response.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    // 呼出しで配列が伸びるため、生成時点のfilter結果ではなく現在のrequestsから都度導出する。
    get byInputRequests(): RecordedHttpRequest[] {
      return requests.filter((request) => request.method === 'GET' && request.url?.startsWith('/v1/searches/by-input'));
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

interface NotificationFixture {
  fixture: CollectorFixture;
  configPath: string;
  transcriptPath: string;
  hook: ReturnType<typeof buildHook>;
  projectId: string;
  cleanup(): Promise<void>;
}

// UserPromptSubmit hookと同じ引数・stdinで通知CLIを起動できる最小環境を作る。
async function createNotificationFixture(
  central: FakeCentral,
  options: { userMessage?: boolean; prompt?: string } = {},
): Promise<NotificationFixture> {
  const fixture = await createCollectorFixture({
    remoteUrl: 'https://github.com/Org/Repo.git',
    binding: { repository: 'github.com/Org/Repo', project_id: uuidv7() },
  });
  const projectId = fixture.config.projects[0]?.project_id as string;
  const transcriptPath = path.join(fixture.root, 'codex.jsonl');
  const lines = [codexSessionLine('session-1')];
  if (options.userMessage ?? true) {
    lines.push(codexMessageLine({ sessionId: 'session-1', messageId: 'item-user-1', role: 'user', text: '通知対象の質問本文' }));
  }
  lines.push(codexMessageLine({ sessionId: 'session-1', messageId: 'item-assistant-1', role: 'assistant', text: '回答本文' }));
  await writeTranscript(transcriptPath, lines);

  const configPath = path.join(fixture.root, 'collector.json');
  const config = buildCollectorConfig({
    state_dir: fixture.stateDir,
    projects: fixture.config.projects,
    api_url: central.baseUrl,
  });
  await writeFile(configPath, JSON.stringify(config), 'utf8');

  const hook = buildHook({
    session_id: 'session-1',
    transcript_path: transcriptPath,
    cwd: fixture.repoDir,
    extra: {
      hook_event_name: 'UserPromptSubmit',
      // prompt本文に見える別IDを発明しないことを検証する。
      prompt: options.prompt ?? 'PROMPT-INVENTED-ID を含むprompt',
      turn_id: 'turn-1',
    },
  });
  return {
    fixture,
    configPath,
    transcriptPath,
    hook,
    projectId,
    cleanup: () => fixture.cleanup(),
  };
}

function searchView(
  overrides: Record<string, unknown> = {},
  relatedEvidence: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  const view: Record<string, unknown> = {
    lookup_status: 'found',
    request_id: uuidv7(),
    input_id: uuidv7(),
    input_revision: 1,
    trigger: 'auto',
    search_action: 'new_search',
    reused_from_request_id: null,
    status: 'completed',
    outcome: 'matched',
    project_id: uuidv7(),
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
            role: 'assistant',
            occurred_at: '2026-09-21T01:00:00.000Z',
            text: 'M7-EVIDENCE-TEXT 過去の対応記録',
          },
        ],
        ...(relatedEvidence.length === 0 ? {} : { related_evidence: relatedEvidence }),
        related_evidence_ids: relatedEvidence.map((item) => item.message_id),
        truncated: false,
      },
    ],
    warnings: [],
    ...overrides,
  };
  return view;
}

function queryParams(request: RecordedHttpRequest): URLSearchParams {
  return new URL(request.url, 'http://central.test').searchParams;
}

// 成功通知はUserPromptSubmit hookの1行JSON。containsだけで済ませず全文をparseしcontextを取り出す。
function hookContext(stdout: string): string {
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, `stdoutが1行JSONではない: ${stdout}`);
  const parsed = JSON.parse(lines[0] as string) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  assert.equal(parsed.hookSpecificOutput?.hookEventName, 'UserPromptSubmit', 'hookEventNameが違う');
  const context = parsed.hookSpecificOutput?.additionalContext;
  assert.equal(typeof context, 'string', 'additionalContextがない');
  return context as string;
}

async function withCentral<T>(byInput: ByInputResponder, fn: (central: FakeCentral) => Promise<T>): Promise<T> {
  const central = await startFakeCentral(byInput);
  try {
    return await fn(central);
  } finally {
    await central.close();
  }
}

async function withFixture<T>(
  central: FakeCentral,
  options: { userMessage?: boolean; prompt?: string },
  fn: (fixture: NotificationFixture) => Promise<T>,
): Promise<T> {
  const fixture = await createNotificationFixture(central, options);
  try {
    return await fn(fixture);
  } finally {
    await fixture.cleanup();
  }
}

async function runNotify(fixture: NotificationFixture, options: { token?: string; homeDir?: string } = {}) {
  return runCollectorCli(['notify', '--source', 'codex', '--config', fixture.configPath], {
    stdin: JSON.stringify(fixture.hook),
    env: {
      YORI_TEST_TOKEN: options.token ?? 'token-a',
      ...(options.homeDir === undefined ? {} : { HOME: options.homeDir }),
    },
  });
}

describe('M7 collector補助通知', () => {
  it('collect後に最新user message identityでby-inputを呼び、完了結果を追加contextとして返す', async () => {
    const token = `TOKEN-${randomUUID()}`;
    const homeDir = await mkdtemp(path.join(tmpdir(), 'yori-m7-home-'));
    try {
      await withCentral(
        () => ({ status: 200, body: searchView() }),
        async (central) => {
          await withFixture(central, { prompt: 'PROMPT-INVENTED-ID' }, async (fixture) => {
            const configBefore = await readFile(fixture.configPath, 'utf8');
            const result = await runNotify(fixture, { token, homeDir });
            assert.equal(result.code, 0, `notifyが失敗した: ${result.stderr}`);
            assert.ok(result.stdout.trim().length > 0, '完了結果がstdoutへ出力されていない');
            const context = hookContext(result.stdout);
            assert.ok(context.includes('matched'), '追加contextにoutcomeがない');
            assert.ok(context.includes('M7-EVIDENCE-TEXT'), '追加contextに根拠原文がない');
            assert.ok(/過去|履歴/.test(context), '過去履歴の資料であることが追加contextにない');
            assert.ok(/命令|指示/.test(context), '現在の命令ではないことが追加contextにない');
            assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token), 'tokenを出力している');
            await assertStateDoesNotContain(fixture.fixture.stateDir, token);
            assert.equal(await readFile(fixture.configPath, 'utf8'), configBefore, 'collector設定を書き換えている');
            assert.ok(!existsSync(path.join(homeDir, '.codex', 'hooks.json')), 'ユーザーのhook設定を作成している');
            assert.ok(!existsSync(path.join(homeDir, '.claude', 'settings.json')), 'ユーザーのhook設定を作成している');

            const eventsRequest = central.requests.find((request) => request.method === 'POST' && request.url === '/v1/events');
            assert.ok(eventsRequest, 'collect処理が実行されていない');
            assert.equal(central.byInputRequests.length, 1, `by-input呼出しが1回ではない: ${central.byInputRequests.length}`);
            const byInput = central.byInputRequests[0] as RecordedHttpRequest;
            const params = queryParams(byInput);
            assert.equal(params.get('project_id'), fixture.projectId);
            assert.equal(params.get('source'), 'codex');
            assert.equal(params.get('source_scope'), 'github.com/Org/Repo');
            assert.equal(params.get('source_session_id'), 'session-1');
            assert.equal(params.get('source_message_id'), 'item-user-1', 'promptからIDを発明している');
            assert.equal(params.get('revision'), '1');
            const waitMs = Number(params.get('wait_ms'));
            assert.ok(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 5_000, `wait_msが1回5秒を超えている: ${params.get('wait_ms')}`);
            assert.ok(!JSON.stringify(central.requests).includes('PROMPT-INVENTED-ID'), 'prompt本文のIDを通知へ使っている');
          });
        },
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('not_received・pending・runningは追加contextを出力せずに終了する', async () => {
    const replies: FakeReply[] = [
      { status: 200, body: { lookup_status: 'not_received' } },
      { status: 200, body: searchView({ status: 'pending', outcome: null, matches: [] }) },
      { status: 200, body: searchView({ status: 'running', outcome: null, matches: [] }) },
    ];
    await withCentral(
      (_request, index) => replies[Math.min(index, replies.length - 1)] as FakeReply,
      async (central) => {
        // 各呼出しで新規user inputが確定する状態を作り、by-inputの1回ずつの応答を検証する。
        for (const _reply of replies) {
          await withFixture(central, {}, async (fixture) => {
            const result = await runNotify(fixture);
            assert.equal(result.code, 0, `notifyが失敗した: ${result.stderr}`);
            assert.equal(result.stdout.trim(), '', `処理中・未受付で追加contextを出力している: ${result.stdout}`);
          });
        }
        assert.equal(central.byInputRequests.length, replies.length, 'by-inputの呼出し回数が想定と違う');
      },
    );
  });

  it('今回collectで新規・更新されたuser inputがない場合はby-inputを呼ばず無出力で終了する', async () => {
    await withCentral(
      () => ({ status: 200, body: searchView() }),
      async (central) => {
        await withFixture(central, {}, async (fixture) => {
          const first = await runNotify(fixture);
          assert.equal(first.code, 0, `notifyが失敗した: ${first.stderr}`);
          assert.ok(hookContext(first.stdout).includes('matched'), '初回の追加contextがない');
          assert.equal(central.byInputRequests.length, 1, '初回のby-input呼出しがない');
          const second = await runNotify(fixture);
          assert.equal(second.code, 0, `notifyが失敗した: ${second.stderr}`);
          assert.equal(second.stdout.trim(), '', '新規user inputがないのに追加contextを出力している');
          assert.equal(central.byInputRequests.length, 1, '新規user inputがないのにby-inputを呼んでいる');
        });
      },
    );
  });

  it('同じuser messageのrevision更新を今回の入力として通知する', async () => {
    await withCentral(
      () => ({ status: 200, body: searchView() }),
      async (central) => {
        await withFixture(central, {}, async (fixture) => {
          const first = await runNotify(fixture);
          assert.equal(first.code, 0, `notifyが失敗した: ${first.stderr}`);
          assert.equal(central.byInputRequests.length, 1, '初回のby-input呼出しがない');
          assert.equal(queryParams(central.byInputRequests[0] as RecordedHttpRequest).get('revision'), '1');

          // 同じmessage IDの本文を変更し、collector stateへrevision 2として再取込させる。
          await writeTranscript(fixture.transcriptPath, [
            codexSessionLine('session-1'),
            codexMessageLine({ sessionId: 'session-1', messageId: 'item-user-1', role: 'user', text: '更新された質問本文' }),
            codexMessageLine({ sessionId: 'session-1', messageId: 'item-assistant-1', role: 'assistant', text: '回答本文' }),
          ]);
          const second = await runNotify(fixture);
          assert.equal(second.code, 0, `notifyが失敗した: ${second.stderr}`);
          assert.equal(central.byInputRequests.length, 2, 'revision更新でby-inputを呼んでいない');
          const params = queryParams(central.byInputRequests[1] as RecordedHttpRequest);
          assert.equal(params.get('source_message_id'), 'item-user-1');
          assert.equal(params.get('revision'), '2', '更新後revisionでby-inputを呼んでいない');
          assert.ok(hookContext(second.stdout).includes('matched'), 'revision更新の追加contextがない');
        });
      },
    );
  });

  it('status=failedをno_matchへ変換せず、statusとerror_codeを追加contextに含める', async () => {
    await withCentral(
      () => ({
        status: 200,
        body: searchView({ status: 'failed', outcome: null, error_code: 'provider_unavailable', matches: [] }),
      }),
      async (central) => {
        await withFixture(central, {}, async (fixture) => {
          const result = await runNotify(fixture);
          assert.equal(result.code, 0, `notifyが失敗した: ${result.stderr}`);
          const context = hookContext(result.stdout);
          assert.ok(context.includes('failed'), `status failedが追加contextにない: ${context}`);
          assert.ok(context.includes('provider_unavailable'), `error_codeが追加contextにない: ${context}`);
          assert.ok(!context.includes('no_match'), 'failedをno_matchとして出力している');
          assert.ok(!central.byInputRequests.some((request) => request.url?.includes('no_match')));
        });
      },
    );
  });

  it('現在入力を特定できない場合はby-inputを呼ばず、無出力で終了する', async () => {
    await withCentral(
      () => ({ status: 200, body: searchView() }),
      async (central) => {
        await withFixture(central, { userMessage: false, prompt: 'source_message_id=invented-user-message' }, async (fixture) => {
          const result = await runNotify(fixture);
          assert.equal(result.code, 0, `notifyが失敗した: ${result.stderr}`);
          assert.equal(result.stdout.trim(), '', 'identity不明なのに追加contextを出力している');
          assert.equal(central.byInputRequests.length, 0, 'identity不明なのにby-inputを呼んでいる');
          assert.ok(!JSON.stringify(central.requests).includes('invented-user-message'), 'promptからmessage IDを発明している');
        });
      },
    );
  });

  it('matched通知のadditionalContextへ訂正relatedの本文とrelationを含める', async () => {
    await withCentral(
      () => ({
        status: 200,
        body: searchView({}, [
          {
            message_id: uuidv7(),
            revision: 1,
            employee_id: uuidv7(),
            role: 'assistant',
            occurred_at: '2026-09-21T01:01:00.000Z',
            text: 'M7-CORRECTION-TEXT 訂正本文',
            source_kind: 'correction',
            relation: 'change',
            related_to_message_id: uuidv7(),
            related_to_revision: 1,
          },
          {
            message_id: uuidv7(),
            revision: 1,
            employee_id: uuidv7(),
            role: 'assistant',
            occurred_at: '2026-09-21T01:02:00.000Z',
            text: 'M7-RELATED-NEIGHBOR 周辺本文',
            source_kind: 'neighbor',
          },
        ]),
      }),
      async (central) => {
        await withFixture(central, {}, async (fixture) => {
          const result = await runNotify(fixture);
          assert.equal(result.code, 0, `notifyが失敗した: ${result.stderr}`);
          const context = hookContext(result.stdout);
          assert.ok(context.includes('M7-EVIDENCE-TEXT'), '元根拠textがadditionalContextにない');
          assert.ok(context.includes('M7-CORRECTION-TEXT'), '訂正文がadditionalContextにない');
          assert.ok(context.includes('change'), 'correctionのrelationがadditionalContextにない');
          assert.ok(context.includes('M7-RELATED-NEIGHBOR'), 'related_evidenceがadditionalContextにない');
          assert.ok(!result.stdout.includes('token-a'), 'tokenを出力している');
        });
      },
    );
  });

  it('by-inputのtimeoutは最大5秒×2・累計10秒で打ち切り、無出力で終了する', async () => {
    await withCentral(
      () => ({ hang: true }),
      async (central) => {
        await withFixture(central, {}, async (fixture) => {
          const started = Date.now();
          const result = await runNotify(fixture);
          const elapsed = Date.now() - started;
          assert.equal(result.code, 0, `notifyが失敗した: ${result.stderr}`);
          assert.equal(result.stdout.trim(), '', 'timeoutで追加contextを出力している');
          assert.ok(central.byInputRequests.length <= 2, `by-inputを3回以上呼んでいる: ${central.byInputRequests.length}`);
          assert.ok(elapsed <= 14_000, `累計10秒を大きく超えて待機している: ${elapsed}ms`);
          if (central.byInputRequests.length === 2) {
            const second = central.byInputRequests[1] as RecordedHttpRequest;
            const first = central.byInputRequests[0] as RecordedHttpRequest;
            assert.ok(second.receivedAt - first.receivedAt >= 4_000, '1回5秒の待機前に再試行している');
          }
        });
      },
    );
  });
});
