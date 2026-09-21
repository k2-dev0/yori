import type { TranscriptRecord } from '../transcript.js';

// ローカルClaude Codeの確認済み対応版。未知版から本文を取り込まない。
export const SUPPORTED_CLAUDE_CODE_VERSION = '2.1.220';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 発言本文だけを抽出する。tool_resultを含むレコードは再帰的にtextを拾わず除外する。
function extractText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.length > 0 ? content : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  if (content.some((block) => isRecord(block) && block.type === 'tool_result')) {
    return null;
  }
  const texts = content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
  return texts.length > 0 ? texts.join('') : null;
}

// Claude Code transcript(JSONL)の1行を共通レコードへ変換する。
export function parseClaudeTranscriptLine(line: string): TranscriptRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    return { kind: 'unknown' };
  }
  if (value.type === 'system' || value.type === 'attachment' || value.type === 'queue-operation') {
    return { kind: 'ignored' };
  }
  if (value.type !== 'user' && value.type !== 'assistant') {
    return { kind: 'unknown' };
  }
  if (!isRecord(value.message)) {
    return { kind: 'unknown' };
  }
  if (
    value.isMeta === true ||
    value.isCompactSummary === true ||
    value.isSidechain === true ||
    value.isApiErrorMessage === true ||
    'toolUseResult' in value ||
    'sourceToolAssistantUUID' in value
  ) {
    return { kind: 'ignored' };
  }
  if (
    typeof value.sessionId !== 'string' ||
    typeof value.uuid !== 'string' ||
    typeof value.timestamp !== 'string' ||
    typeof value.version !== 'string'
  ) {
    return { kind: 'unknown' };
  }
  const text = extractText(value.message.content);
  if (text === null) {
    return { kind: 'ignored' };
  }
  return {
    kind: 'message',
    source_session_id: value.sessionId,
    transcript_version: value.version,
    source_message_id: value.uuid,
    occurred_at: value.timestamp,
    role: value.type,
    text,
  };
}
