import type { ErrorBody, ErrorCode, EventResult, EventsResponse } from './response-schema.js';

// M1で確定したイベント受付の契約。API実装とテストで共有する。
export const MAX_EVENT_BODY_BYTES = 1_048_576;
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 100;
export const MAX_TEXT_LENGTH = 65_536;
export const MAX_SOURCE_IDENTIFIER_BYTES = 1024;
// business伏せ字はfields＋terms合算100件。termは512 code points、fieldは128 code points。
export const MAX_BUSINESS_REDACTION_RULES = 100;
export const MAX_BUSINESS_TERM_CODE_POINTS = 512;
export const MAX_BUSINESS_FIELD_CODE_POINTS = 128;
export const BUSINESS_FIELD_PLACEHOLDER = '[REDACTED:business_value]';
export const BUSINESS_TERM_PLACEHOLDER = '[REDACTED:business_term]';
// known secretはcollector processだけが受け取るlocal input。値そのものは保持先に応じて使い分ける。
export const KNOWN_SECRET_PLACEHOLDER = '[REDACTED:known_secret]';
export const KNOWN_SECRETS_ENV = 'YORI_KNOWN_SECRETS_JSON';
export const MAX_KNOWN_SECRETS = 100;
export const MIN_KNOWN_SECRET_CODE_POINTS = 8;
export const MAX_KNOWN_SECRET_CODE_POINTS = 4096;
// suspected-secret gateの固定code/detector版。候補値や周辺文字列はcodeへ含めない。
export const SUSPECTED_SECRET_CODE = 'suspected_secret';
export const SUSPECTED_SECRET_OBSERVED = 'suspected_secret_observed';
export const SUSPECTED_SECRET_DETECTOR_VERSION = 'initial-v1';
export const AUTO_SEARCH_POLICY_VERSION = 'initial-v1';

// 同一社員のイベント保存と再利用確定を直列化するtransaction advisory lockの名前空間。
export const EVENT_WRITE_LOCK_NAMESPACE = 20260922;

export const EVENT_SOURCES = ['codex', 'claude_code'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_ROLES = ['user', 'assistant', 'agent_report'] as const;
export type EventRole = (typeof EVENT_ROLES)[number];

export interface EventInput {
  idempotency_key: string;
  source: EventSource;
  source_scope: string;
  source_session_id: string;
  source_message_id: string;
  sequence_no: number;
  revision: number;
  role: EventRole;
  occurred_at: string;
  text: string;
}

export interface EventsRequestBody {
  project_id: string;
  events: EventInput[];
}

// 公開応答の型はresponse-schema.tsのZod schemaを正本にし、既存import名だけを維持する。
export type { ErrorBody, ErrorCode, EventResult, EventsResponse };

// event_receipts.request_hash のcanonical JSONはこのキー順で固定する。
// occurred_at は受信したISO文字列をそのまま使う。
export const RECEIPT_PAYLOAD_KEYS = [
  'company_id',
  'employee_id',
  'project_id',
  'idempotency_key',
  'source',
  'source_scope',
  'source_session_id',
  'source_message_id',
  'sequence_no',
  'revision',
  'role',
  'occurred_at',
  'text',
] as const;
