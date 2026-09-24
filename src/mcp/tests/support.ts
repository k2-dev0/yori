import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// M6 MCPのRedテスト用support。production exportには依存せず、stdio child processとloopback HTTP fixtureだけを使う。
//
// テストが要求する起動契約（Greenで実装するMCPアダプターの最小形）:
// - 実行entrypoint: リポジトリrootからの src/mcp/server.ts を `node --import tsx` で起動する
// - 設定ファイルpath: 環境変数 YORI_MCP_CONFIG
// - 設定JSON: { "api_url_env": "...", "api_token_env": "..." } としてAPI URLとtokenを保持する環境変数名だけを持つ
// - 実値は child process の環境変数（上の名前）で渡し、token本文は設定ファイルへ書かない
//
// 起動できない・toolを公開しない・外部HTTPの失敗をno_matchへ変換する場合は、missing executable／
// 未実装tool／失敗区別の欠落としてRedになる。

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const MCP_SERVER_PATH = 'src/mcp/server.ts';
export const MCP_CONFIG_ENV = 'YORI_MCP_CONFIG';
export const MCP_API_URL_ENV = 'YORI_TEST_API_URL';
export const MCP_API_TOKEN_ENV = 'YORI_TEST_API_TOKEN';

export interface JsonRpcError {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

export interface McpToolDefinition {
  name: string;
  inputSchema?: unknown;
}

export interface McpToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export class McpSession {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutBuffer = '';
  private stdoutTextValue = '';
  private exited = false;
  private exitDescription: string | null = null;
  readonly stdoutRawLines: string[] = [];
  readonly pollutedStdoutLines: string[] = [];
  readonly stderrChunks: string[] = [];

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly configDir: string,
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.onStdoutChunk(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.stderrChunks.push(chunk.toString('utf8')));
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      this.markExited(`spawn error: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      this.markExited(`code=${code ?? 'null'}, signal=${signal ?? 'null'}`);
    });
  }

  // 設定ファイルと環境変数を用意してstdio serverを起動する（initialize前）。
  static async launch(options: { apiUrl: string; token: string; extraEnv?: Record<string, string> }): Promise<McpSession> {
    // 未実装の間は起動失敗ではなくmissing executableとして明示し、非loopback制約testが
    // 「起動しないから通る」空振りにならないようにする。
    if (!existsSync(path.join(REPO_ROOT, MCP_SERVER_PATH))) {
      throw new Error(`MCP executable ${MCP_SERVER_PATH} が存在しません（M6未実装）`);
    }
    const configDir = await mkdtemp(path.join(tmpdir(), 'yori-mcp-'));
    const configPath = path.join(configDir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ api_url_env: MCP_API_URL_ENV, api_token_env: MCP_API_TOKEN_ENV }),
      'utf8',
    );
    const child = spawn(process.execPath, ['--import', 'tsx', MCP_SERVER_PATH], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        [MCP_CONFIG_ENV]: configPath,
        [MCP_API_URL_ENV]: options.apiUrl,
        [MCP_API_TOKEN_ENV]: options.token,
        ...options.extraEnv,
      },
    });
    return new McpSession(child, configDir);
  }

  // 起動してMCP initializeまで完了したsessionを返す。
  static async start(options: { apiUrl: string; token: string; extraEnv?: Record<string, string> }): Promise<McpSession> {
    const session = await McpSession.launch(options);
    try {
      await session.initialize();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  async initialize(timeoutMs = 8_000): Promise<Record<string, unknown>> {
    const result = await this.request(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'yori-m6-tests', version: '0.0.0' },
      },
      timeoutMs,
    );
    this.notify('notifications/initialized', {});
    return (result ?? {}) as Record<string, unknown>;
  }

  async listTools(timeoutMs = 8_000): Promise<McpToolDefinition[]> {
    const result = await this.request('tools/list', {}, timeoutMs);
    const tools = (result as { tools?: Array<{ name?: unknown; inputSchema?: unknown }> } | undefined)?.tools ?? [];
    return tools.map((tool) => ({
      name: typeof tool.name === 'string' ? tool.name : '',
      inputSchema: tool.inputSchema,
    }));
  }

  // tool callのJSON-RPC resultを返す。tool-level errorはrejectせずisErrorとして返す。
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<McpToolCallResult> {
    const result = await this.request('tools/call', { name, arguments: args }, options.timeoutMs ?? 12_000);
    return (result ?? {}) as McpToolCallResult;
  }

  get stdoutText(): string {
    return this.stdoutTextValue;
  }

  get stderrText(): string {
    return this.stderrChunks.join('');
  }

  get hasExited(): boolean {
    return this.exited;
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(new Error(`MCP serverは起動していません: ${this.exitDescription ?? '不明'}`));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP応答がtimeoutしました: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.exited) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private onStdoutChunk(chunk: Buffer): void {
    const text = chunk.toString('utf8');
    this.stdoutTextValue += text;
    this.stdoutBuffer += text;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) {
        this.handleStdoutLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleStdoutLine(line: string): void {
    this.stdoutRawLines.push(line);
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.pollutedStdoutLines.push(line);
      return;
    }
    if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0') {
      this.pollutedStdoutLines.push(line);
      return;
    }
    if (message.id === undefined || message.id === null) {
      return;
    }
    const pending = this.pending.get(Number(message.id));
    if (!pending) {
      return;
    }
    this.pending.delete(Number(message.id));
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`MCP JSON-RPC error: ${JSON.stringify(message.error)}`));
      return;
    }
    pending.resolve(message.result);
  }

  private markExited(description: string): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.exitDescription = description;
    const stderrTail = this.stderrText.slice(-600);
    const detail = stderrTail.length > 0 ? ` / stderr: ${stderrTail}` : '';
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP serverが終了しました (${description})${detail}`));
      this.pending.delete(id);
    }
  }

  async close(): Promise<void> {
    if (!this.exited) {
      this.child.kill('SIGTERM');
      const exited = await waitForExit(this.child, 3_000);
      if (!exited) {
        this.child.kill('SIGKILL');
        await waitForExit(this.child, 2_000);
      }
    }
    this.child.stdin.destroy();
    await rm(this.configDir, { recursive: true, force: true });
  }
}

export interface RecordedCentralRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  rawBody: string;
  body: unknown;
}

export interface FakeCentralReply {
  status?: number;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
  // 応答を返さず接続を保持し、通信timeoutの検出に使う。
  hang?: boolean;
}

export type FakeCentralResponder = (request: RecordedCentralRequest) => FakeCentralReply | Promise<FakeCentralReply>;

export interface FakeCentralApi {
  baseUrl: string;
  host: string;
  port: number;
  requests: RecordedCentralRequest[];
  setResponder(responder: FakeCentralResponder): void;
  close(): Promise<void>;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return rawBody;
  }
}

// 中央HTTP APIの応答をtestごとに差し替えられるloopback fixture。0.0.0.0 bindは非loopback制約の検証に使う。
export async function startFakeCentralApi(options: {
  responder: FakeCentralResponder;
  host?: string;
}): Promise<FakeCentralApi> {
  let responder = options.responder;
  const requests: RecordedCentralRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const rawBody = await readRequestBody(request);
      const recorded: RecordedCentralRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        rawBody,
        body: parseJsonBody(rawBody),
      };
      requests.push(recorded);
      const reply = await responder(recorded);
      if (reply.hang) {
        return;
      }
      if (reply.delayMs !== undefined) {
        await sleep(reply.delayMs);
      }
      response.statusCode = reply.status ?? 200;
      response.setHeader('content-type', 'application/json');
      response.end(reply.rawBody ?? JSON.stringify(reply.body ?? {}));
    })().catch(() => {
      response.destroy();
    });
    request.on('error', () => undefined);
    response.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const displayHost = address.address === '0.0.0.0' || address.address === '::' ? '127.0.0.1' : address.address;
  return {
    baseUrl: `http://${displayHost}:${address.port}`,
    host: address.address,
    port: address.port,
    requests,
    setResponder: (nextResponder) => {
      responder = nextResponder;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function requestUrl(request: RecordedCentralRequest): URL {
  return new URL(request.url, 'http://central.test');
}

// Docker/ホストの非loopback IPv4を1つ返す。非loopback HTTP制約の検証に使う。
export function findNonLoopbackIpv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

