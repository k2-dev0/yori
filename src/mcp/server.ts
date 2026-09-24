import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { EVENT_SOURCES, MAX_TEXT_LENGTH } from '../api/contract.js';
import { buildCaseReportText, caseReportWarnings } from './case-report.js';
import { CentralApiClient, CentralApiError } from './central.js';
import { loadMcpConfig, type McpConfig } from './config.js';

// M6のstdio MCPアダプター。stdoutはprotocol専用にし、診断はstderrだけへ出す。
// 中央HTTP APIの結果をstructured contentとtextで返し、4xx/5xx・timeout・応答不正はtool errorにして
// 空結果やno_matchへ変換しない。tokenはAuthorization以外へ出さない。

const searchHistorySchema = z.strictObject({
  project_id: z.uuid(),
  input_id: z.uuid(),
  input_revision: z.int().min(1).max(2_147_483_647),
  query: z.string().min(1).max(65_536),
  idempotency_key: z.string().min(1).max(512),
  force_refresh: z.boolean(),
});

const getSearchResultSchema = z
  .strictObject({
    project_id: z.uuid(),
    request_id: z.uuid().optional(),
    wait_ms: z.int().min(0).max(5000).optional(),
    input_id: z.uuid().optional(),
    input_revision: z.int().min(1).max(2_147_483_647).optional(),
    source: z.enum(EVENT_SOURCES).optional(),
    source_scope: z.string().min(1).max(1024).optional(),
    source_session_id: z.string().min(1).max(1024).optional(),
    source_message_id: z.string().min(1).max(1024).optional(),
    revision: z.int().min(1).max(2_147_483_647).optional(),
  })
  .refine(
    (value) => {
      const branchCount = [value.request_id, value.input_id, value.source].filter((item) => item !== undefined).length;
      if (branchCount !== 1) {
        return false;
      }
      if (value.request_id !== undefined) {
        return value.input_id === undefined && value.input_revision === undefined && value.source === undefined;
      }
      if (value.input_id !== undefined) {
        return value.input_revision !== undefined && value.source === undefined;
      }
      return (
        value.source_scope !== undefined &&
        value.source_session_id !== undefined &&
        value.source_message_id !== undefined &&
        value.revision !== undefined
      );
    },
    { message: 'request_id、input_id+input_revision、外部identityのどれか1つだけを指定してください' },
  );

const getEvidenceSchema = z.strictObject({
  project_id: z.uuid(),
  message_id: z.uuid(),
  revision: z.int().min(1).max(2_147_483_647),
});

const recordCaseSchema = z.strictObject({
  project_id: z.uuid(),
  idempotency_key: z.string().min(1).max(512),
  source: z.enum(EVENT_SOURCES),
  source_scope: z.string().min(1).max(1024),
  source_session_id: z.string().min(1).max(1024),
  source_message_id: z.string().min(1).max(1024),
  sequence_no: z.int().min(1).max(2_147_483_647),
  revision: z.int().min(1).max(2_147_483_647),
  occurred_at: z.iso.datetime({ offset: true }),
  problem: z.string().min(1).max(65_536),
  cause: z.string().min(1).max(65_536).optional(),
  investigation_steps: z.array(z.string().min(1).max(65_536)).max(50).optional(),
  action: z.string().min(1).max(65_536),
  failed_attempts: z.array(z.string().min(1).max(65_536)).max(50).optional(),
  confirmation_status: z.string().min(1).max(65_536),
  constraints: z.array(z.string().min(1).max(65_536)).max(50).optional(),
  related_files_or_prs: z.array(z.string().min(1).max(65_536)).max(50).optional(),
});

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

// 成功は応答をそのままstructured contentとtextで返す。失敗は固定文言だけのtool errorにする。
async function runTool(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await action();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      structuredContent: value as Record<string, unknown>,
    };
  } catch (error) {
    return toolError(error instanceof CentralApiError ? error.message : 'tool処理に失敗しました');
  }
}

function createServer(config: McpConfig): McpServer {
  const server = new McpServer({ name: 'yori', version: '0.1.0' }, { capabilities: { tools: {} } });
  const client = new CentralApiClient({ apiUrl: config.apiUrl, token: config.token });

  server.registerTool(
    'search_history',
    { description: '現在の入力ID・revisionを条件に保存済み会話を検索する', inputSchema: searchHistorySchema },
    async (args) => runTool(() => client.searchHistory(args)),
  );
  server.registerTool(
    'get_search_result',
    {
      description: 'request_idまたは現在入力のidentityで検索受付の状態と結果を取得する',
      inputSchema: getSearchResultSchema,
    },
    async (args) => runTool(() => client.getSearchResult(args)),
  );
  server.registerTool(
    'get_evidence',
    { description: '保存済みの原文revisionを出典IDから取得する', inputSchema: getEvidenceSchema },
    async (args) => runTool(() => client.getEvidence(args)),
  );
  server.registerTool(
    'record_case',
    { description: '問題・対応・確認状態を含む短い対応記録をagent_reportとして保存する', inputSchema: recordCaseSchema },
    async (args) => {
      const text = buildCaseReportText(args);
      // 600文字超はwarningで受理するが、既存イベント本文上限を超える本文は中央APIへ送らずtool errorにする。
      if ([...text].length > MAX_TEXT_LENGTH) {
        return toolError(`対応記録が本文上限${MAX_TEXT_LENGTH}文字を超えています`);
      }
      const warnings = caseReportWarnings(text);
      return runTool(async () => {
        const response = await client.recordCase(args.project_id, {
          idempotency_key: args.idempotency_key,
          source: args.source,
          source_scope: args.source_scope,
          source_session_id: args.source_session_id,
          source_message_id: args.source_message_id,
          sequence_no: args.sequence_no,
          revision: args.revision,
          occurred_at: args.occurred_at,
          role: 'agent_report',
          text,
        });
        return warnings.length === 0 ? response : { ...(response as Record<string, unknown>), warnings };
      });
    },
  );

  return server;
}

function loadConfigOrExit(): McpConfig {
  try {
    return loadMcpConfig(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'MCP設定を読み込めません');
    process.exit(1);
  }
}

const config = loadConfigOrExit();
serveStdio(() => createServer(config));
