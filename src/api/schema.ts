import { z } from 'zod';
import { EVENT_ROLES, EVENT_SOURCES, MAX_BATCH_SIZE, MAX_SOURCE_IDENTIFIER_BYTES, MAX_TEXT_LENGTH, MIN_BATCH_SIZE } from './contract.js';

// Unicodeモードでは有効なペアを1コードポイントとして扱い、単独サロゲートだけを拒否する。
const storableString = z.string().min(1).refine(
  (value) => !value.includes('\u0000') && !/[\uD800-\uDFFF]/u.test(value),
  { message: 'NULおよび単独サロゲートは指定できません' },
);

// sessionの複合索引にはscopeとsession IDの両方が入る。名前空間の接頭辞を含めても
// 配布PostgreSQLのB-tree索引に収まるよう、各識別子をUTF-8で1024バイトまでに制限する。
const sourceIdentifier = storableString.refine(
  (value) => Buffer.byteLength(value, 'utf8') <= MAX_SOURCE_IDENTIFIER_BYTES,
  { message: '取り込み元の識別子はUTF-8で1024バイト以内にしてください' },
);

// 受信イベント1件の契約。company_id/employee_id等のunknown fieldは境界を偽装できないよう拒否する。
const eventSchema = z.strictObject({
  idempotency_key: storableString.max(512),
  source: z.enum(EVENT_SOURCES),
  source_scope: sourceIdentifier,
  source_session_id: sourceIdentifier,
  source_message_id: sourceIdentifier,
  sequence_no: z.int().min(1).max(2_147_483_647),
  revision: z.int().min(1).max(2_147_483_647),
  role: z.enum(EVENT_ROLES),
  occurred_at: z.iso.datetime({ offset: true }),
  // textの上限はUTF-16長ではなくUnicodeコードポイント数で判定する。NUL・不正UTF-16は保存しない。
  text: storableString
    .refine((text) => [...text].length <= MAX_TEXT_LENGTH, {
      message: `textは${MAX_TEXT_LENGTH}コードポイント以内にしてください`,
    }),
});

// バッチ受付の契約。1..100件・UUID形式のproject_idだけを受理し、UUIDは小文字の正規形へ揃える。
export const eventsRequestSchema = z.strictObject({
  project_id: z.uuid().transform((projectId) => projectId.toLowerCase()),
  events: z.array(eventSchema).min(MIN_BATCH_SIZE).max(MAX_BATCH_SIZE),
});

export type ParsedEvent = z.infer<typeof eventSchema>;
export type EventsRequest = z.infer<typeof eventsRequestSchema>;
