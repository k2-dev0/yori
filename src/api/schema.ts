import { z } from 'zod';
import { EVENT_ROLES, EVENT_SOURCES, MAX_BATCH_SIZE, MAX_TEXT_LENGTH, MIN_BATCH_SIZE } from './contract.js';

// DBのTEXTへ保存できるのはNULと単独サロゲート(不正UTF-16)を含まない文字列だけ。
function hasUnstorableCodeUnits(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x0000) {
      return true;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const UNSTORABLE_MESSAGE = 'NULおよび単独サロゲートは指定できません';

// 保存・identityに使う受信文字列を、長さ上限と保存可能な文字種で境界検証する。
function storableString(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => !hasUnstorableCodeUnits(value), { message: UNSTORABLE_MESSAGE });
}

// 受信イベント1件の契約。company_id/employee_id等のunknown fieldは境界を偽装できないよう拒否する。
const eventSchema = z.strictObject({
  idempotency_key: storableString(512),
  source: z.enum(EVENT_SOURCES),
  source_scope: storableString(1024),
  source_session_id: storableString(1024),
  source_message_id: storableString(1024),
  sequence_no: z.int().min(1).max(2_147_483_647),
  revision: z.int().min(1).max(2_147_483_647),
  role: z.enum(EVENT_ROLES),
  occurred_at: z.iso.datetime({ offset: true }),
  // textの上限はUTF-16長ではなくUnicodeコードポイント数で判定する。NUL・不正UTF-16は保存しない。
  text: z
    .string()
    .min(1)
    .refine((text) => !hasUnstorableCodeUnits(text), { message: UNSTORABLE_MESSAGE })
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
