import type { TranscriptRecord } from '../transcript.js';

// ローカルClaude Codeの確認済み対応版。未知版から本文を取り込まない。
export const SUPPORTED_CLAUDE_CODE_VERSION = '2.1.220';

// Claude Code transcript(JSONL)の1行を共通レコードへ変換する。
export function parseClaudeTranscriptLine(_line: string): TranscriptRecord {
  throw new Error('collector claude adapter: 未実装');
}
