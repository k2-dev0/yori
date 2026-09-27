import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { MAX_TEXT_LENGTH } from '../api/contract.js';
import { buildCaseReportText, caseReportWarnings } from './case-report.js';
import { CentralApiClient, CentralApiError } from './central.js';
import { loadMcpConfig, type McpConfig } from './config.js';
import {
  getEvidenceInputSchema,
  getEvidenceToolOutputSchema,
  getSearchResultInputSchema,
  getSearchResultToolOutputSchema,
  linkSessionInputSchema,
  linkSessionToolOutputSchema,
  recordCaseInputSchema,
  recordCaseToolOutputSchema,
  searchHistoryInputSchema,
  searchHistoryToolOutputSchema,
} from './schema.js';

// M6のstdio MCPアダプター。stdoutはprotocol専用にし、診断はstderrだけへ出す。
// 中央HTTP APIの結果をstructured contentとtextで返し、4xx/5xx・timeout・応答不正はtool errorにして
// 空結果やno_matchへ変換しない。tokenはAuthorization以外へ出さない。

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

// 最終値をtool出力schemaへ通してからstructured contentとtextで同値に返す。失敗は固定文言だけのtool errorにする。
async function runTool<T>(outputSchema: z.ZodType<T>, action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = outputSchema.parse(await action());
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
    { description: '現在の入力ID・revisionを条件に保存済み会話を検索する', inputSchema: searchHistoryInputSchema },
    async (args) => runTool(searchHistoryToolOutputSchema, () => client.searchHistory(args)),
  );
  server.registerTool(
    'get_search_result',
    {
      description: 'request_idまたは現在入力のidentityで検索受付の状態と結果を取得する',
      inputSchema: getSearchResultInputSchema,
    },
    async (args) => runTool(getSearchResultToolOutputSchema, () => client.getSearchResult(args)),
  );
  server.registerTool(
    'get_evidence',
    { description: '保存済みの原文revisionを出典IDから取得する', inputSchema: getEvidenceInputSchema },
    async (args) => runTool(getEvidenceToolOutputSchema, () => client.getEvidence(args)),
  );
  server.registerTool(
    'link_session',
    {
      description: '認証社員本人のsessionへの明示的な引き継ぎリンクを根拠発言付きで登録する',
      inputSchema: linkSessionInputSchema,
    },
    async (args) => runTool(linkSessionToolOutputSchema, () => client.linkSession(args)),
  );
  server.registerTool(
    'record_case',
    { description: '問題・対応・確認状態を含む短い対応記録をagent_reportとして保存する', inputSchema: recordCaseInputSchema },
    async (args) => {
      const text = buildCaseReportText(args);
      // 600文字超はwarningで受理するが、既存イベント本文上限を超える本文は中央APIへ送らずtool errorにする。
      if ([...text].length > MAX_TEXT_LENGTH) {
        return toolError(`対応記録が本文上限${MAX_TEXT_LENGTH}文字を超えています`);
      }
      const warnings = caseReportWarnings(text);
      return runTool(recordCaseToolOutputSchema, async () => {
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
