import type { TranscriptRecord } from '../transcript.js';

// ローカルCodex Desktopの確認済み対応版。CLIインストール版0.155.1とは別物として扱う。
export const SUPPORTED_CODEX_CLI_VERSION = '0.155.0-alpha.9.2';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function buildMessage(
  sessionId: string,
  messageId: string,
  occurredAt: string,
  role: 'user' | 'assistant',
  text: string,
): TranscriptRecord {
  return {
    kind: 'message',
    source_session_id: sessionId,
    transcript_version: null,
    source_message_id: messageId,
    occurred_at: occurredAt,
    role,
    text,
  };
}

// Codex transcriptの1行を共通レコードへ変換する。未確認形式から本文を取り込まない。
export function parseCodexTranscriptLine(line: string): TranscriptRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    return { kind: 'unknown' };
  }
  if (value.type === 'response_item' || value.type === 'compacted') {
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
    return text === null ? { kind: 'ignored' } : buildMessage(payload.thread_id, item.id, value.timestamp, 'user', text);
  }
  if (item.type === 'AgentMessage') {
    const text = extractText(item.content, 'Text');
    return text === null ? { kind: 'ignored' } : buildMessage(payload.thread_id, item.id, value.timestamp, 'assistant', text);
  }
  return { kind: 'ignored' };
}
