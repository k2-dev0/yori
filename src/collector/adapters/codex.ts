import { readFileSync } from 'node:fs';
import type { TranscriptRecord } from '../transcript.js';

// ローカルCodex Desktopの確認済み対応版allowlist。先頭が旧確認版、末尾が最新確認版。
// 外部CLI版0.156.1とは別物として扱う。
export const SUPPORTED_CODEX_CLI_VERSIONS: readonly string[] = ['0.155.0-alpha.9.2', '0.155.0-alpha.16.4'];

export function codexTurnMessageId(turnId: string, role: 'user' | 'assistant'): string {
  return `turn:${turnId}:${role}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// turn_context行が持つ、そのturnの回答を生成したmodelと思考量。
export interface CodexTurnContext {
  model_id: string;
  reasoning_effort?: string;
}

// contentの指定block typeを持つtextだけを順に連結する。ツール出力等は再帰的に拾わない。
function extractText(content: unknown, blockType: string): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const texts = content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === blockType && typeof block.text === 'string')
    .map((block) => block.text as string);
  return texts.length > 0 ? texts.join('') : null;
}

// 会話ログ全体からturn_idごとのmodelと思考量を引く。turn_contextはturnの最初に書かれ、回答行とは離れているため、
// hook経路と会話ログ経路の両方がこの表を使い、同じ発言へ同じ値を付ける。読めないfileは空の表にする。
export function readCodexTurnContexts(transcriptPath: string): Map<string, CodexTurnContext> {
  const contexts = new Map<string, CodexTurnContext>();
  let content: string;
  try {
    content = readFileSync(transcriptPath, 'utf8');
  } catch {
    return contexts;
  }
  for (const line of content.split('\n')) {
    // 行の大半はtool出力などの大きな無関係行なので、JSONとして読む前に文字列で絞る。
    let value: unknown = null;
    try {
      value = line.includes('"turn_context"') ? JSON.parse(line) : null;
    } catch {
      value = null;
    }
    const payload = isRecord(value) && value.type === 'turn_context' ? value.payload : null;
    if (isRecord(payload) && typeof payload.turn_id === 'string' && typeof payload.model === 'string') {
      const effort = typeof payload.effort === 'string' ? { reasoning_effort: payload.effort } : {};
      contexts.set(payload.turn_id, { model_id: payload.model, ...effort });
    }
  }
  return contexts;
}

function buildMessage(
  sessionId: string,
  messageId: string,
  occurredAt: string,
  role: 'user' | 'assistant',
  text: string,
  turnContext?: CodexTurnContext,
): TranscriptRecord {
  return {
    kind: 'message',
    ...turnContext,
    source_session_id: sessionId,
    transcript_version: null,
    source_message_id: messageId,
    occurred_at: occurredAt,
    role,
    text,
  };
}

// Codex transcriptの1行を共通レコードへ変換する。未確認形式から本文を取り込まない。
// turnContextsOfを渡すと、回答行にそのturnのmodelと思考量を付ける。表は回答行が出た時にだけ引く。
export function parseCodexTranscriptLine(line: string, turnContextsOf?: () => ReadonlyMap<string, CodexTurnContext>): TranscriptRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    return { kind: 'unknown' };
  }
  // 既知の非会話top-level recordはpayload本文を読まずに無視する。未知top-level一般だけを診断対象にする。
  if (
    value.type === 'response_item' ||
    value.type === 'turn_context' ||
    value.type === 'token_usage_record' ||
    value.type === 'world_state' ||
    value.type === 'compacted'
  ) {
    return { kind: 'ignored' };
  }
  if (value.type === 'session_meta') {
    const payload = value.payload;
    if (!isRecord(payload) || typeof payload.id !== 'string' || typeof payload.cli_version !== 'string') {
      return { kind: 'unknown' };
    }
    return { kind: 'session', source_session_id: payload.id, transcript_version: payload.cli_version };
  }
  if (value.type !== 'event_msg') {
    return { kind: 'unknown' };
  }
  const payload = value.payload;
  if (!isRecord(payload)) {
    return { kind: 'unknown' };
  }
  if (payload.type !== 'item_completed') {
    return { kind: 'ignored' };
  }
  const item = payload.item;
  if (
    !isRecord(item) ||
    typeof payload.thread_id !== 'string' ||
    typeof item.id !== 'string' ||
    typeof value.timestamp !== 'string' ||
    typeof item.type !== 'string'
  ) {
    return { kind: 'unknown' };
  }
  if (item.type === 'UserMessage') {
    const text = extractText(item.content, 'text');
    const messageId = typeof payload.turn_id === 'string' ? codexTurnMessageId(payload.turn_id, 'user') : item.id;
    return text === null ? { kind: 'ignored' } : buildMessage(payload.thread_id, messageId, value.timestamp, 'user', text);
  }
  if (item.type === 'AgentMessage') {
    if (item.phase !== 'final_answer') {
      return { kind: 'ignored' };
    }
    const text = extractText(item.content, 'Text');
    const messageId = typeof payload.turn_id === 'string' ? codexTurnMessageId(payload.turn_id, 'assistant') : item.id;
    if (text === null) {
      return { kind: 'ignored' };
    }
    const turnContext = typeof payload.turn_id === 'string' ? turnContextsOf?.().get(payload.turn_id) : undefined;
    return buildMessage(payload.thread_id, messageId, value.timestamp, 'assistant', text, turnContext);
  }
  return { kind: 'ignored' };
}
