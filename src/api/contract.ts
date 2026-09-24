// M1で確定したイベント受付の契約。API実装とテストで共有する。
export const MAX_EVENT_BODY_BYTES = 1_048_576;
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 100;
export const MAX_TEXT_LENGTH = 65_536;
export const MAX_SOURCE_IDENTIFIER_BYTES = 1024;
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

export interface EventResult {
  idempotency_key: string;
  message_id: string;
  revision: number;
  request_id: string | null;
}

export interface EventsResponse {
  results: EventResult[];
}

export interface ErrorBody {
  error: {
    code: string;
    message?: string;
  };
}

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
