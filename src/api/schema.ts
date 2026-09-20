import { z } from 'zod';
import { EVENT_ROLES, EVENT_SOURCES, MAX_BATCH_SIZE, MAX_TEXT_LENGTH, MIN_BATCH_SIZE } from './contract.js';

// 受信イベント1件の契約。company_id/employee_id等のunknown fieldは境界を偽装できないよう拒否する。
const eventSchema = z.strictObject({
  idempotency_key: z.string().min(1).max(512),
  source: z.enum(EVENT_SOURCES),
  source_scope: z.string().min(1).max(1024),
  source_session_id: z.string().min(1).max(1024),
  source_message_id: z.string().min(1).max(1024),
  sequence_no: z.int().min(1).max(2_147_483_647),
  revision: z.int().min(1).max(2_147_483_647),
  role: z.enum(EVENT_ROLES),
  occurred_at: z.iso.datetime({ offset: true }),
  // textの上限はUTF-16長ではなくUnicodeコードポイント数で判定する。
  text: z
    .string()
    .min(1)
    .refine((text) => [...text].length <= MAX_TEXT_LENGTH, {
      message: `textは${MAX_TEXT_LENGTH}コードポイント以内にしてください`,
    }),
});

// バッチ受付の契約。1..100件・UUID形式のproject_idだけを受理する。
export const eventsRequestSchema = z.strictObject({
  project_id: z.uuid(),
  events: z.array(eventSchema).min(MIN_BATCH_SIZE).max(MAX_BATCH_SIZE),
});

export type ParsedEvent = z.infer<typeof eventSchema>;
export type EventsRequest = z.infer<typeof eventsRequestSchema>;
