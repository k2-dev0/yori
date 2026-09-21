import type { TranscriptRecord } from '../transcript.js';

// ローカルCodex Desktopの確認済み対応版。CLIインストール版0.155.1とは別物として扱う。
export const SUPPORTED_CODEX_CLI_VERSION = '0.155.0-alpha.9.2';

// Codex transcriptの1行を共通レコードへ変換する。未確認形式から本文を取り込まない。
export function parseCodexTranscriptLine(_line: string): TranscriptRecord {
  throw new Error('collector codex adapter: 未実装');
}
