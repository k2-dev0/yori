// Codex/Claude Codeの各アダプターが返す共通レコード。収集pipelineはログ形式を知らずに扱う。
export interface TranscriptSessionRecord {
  kind: 'session';
  source_session_id: string;
  transcript_version: string;
}

export interface TranscriptMessageRecord {
  kind: 'message';
  source_session_id: string;
  // Claude Codeは1行ごとにversionを持つ。Codexはsession_metaからpipeline側が補うためnull。
  transcript_version: string | null;
  source_message_id: string;
  occurred_at: string;
  role: 'user' | 'assistant';
  text: string;
}

// ignoredは既知だが収集対象外、unknownは解釈できないレコード、invalidはJSONとして壊れた行。
export type TranscriptRecord =
  | TranscriptSessionRecord
  | TranscriptMessageRecord
  | { kind: 'ignored' }
  | { kind: 'invalid' }
  | { kind: 'unknown' };
