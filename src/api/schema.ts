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

// M6の明示検索受付。質問・入力revision・冪等キー・force_refreshを必須にし、unknown fieldを拒否する。
const searchQueryText = storableString.refine((text) => [...text].length <= MAX_TEXT_LENGTH, {
  message: `queryは${MAX_TEXT_LENGTH}コードポイント以内にしてください`,
});

export const searchRequestSchema = z.strictObject({
  project_id: z.uuid().transform((projectId) => projectId.toLowerCase()),
  input_id: z.uuid().transform((inputId) => inputId.toLowerCase()),
  input_revision: z.int().min(1).max(2_147_483_647),
  query: searchQueryText,
  idempotency_key: storableString.max(512),
  force_refresh: z.boolean(),
});

export type ParsedSearchRequest = z.infer<typeof searchRequestSchema>;

// wait_msはquery文字列として渡る。0〜5000の10進整数だけを受理する。
const waitMsParam = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform((value) => Number(value))
  .refine((value) => value <= 5000, { message: 'wait_msは0〜5000の整数です' });

export const searchDetailQuerySchema = z.strictObject({
  wait_ms: waitMsParam.optional(),
});

// input revision等のquery paramは文字列から整数へ変換し、1以上だけを受理する。
const revisionParam = z.coerce.number().int().min(1).max(2_147_483_647);

// by-inputは内部input_idか、イベント受付と同じ取り込み元identityのどちらか一方だけを受理する。
const byInputInternalQuerySchema = z.strictObject({
  project_id: z.uuid().transform((projectId) => projectId.toLowerCase()),
  input_id: z.uuid().transform((inputId) => inputId.toLowerCase()),
  input_revision: revisionParam,
  wait_ms: waitMsParam.optional(),
});

const byInputExternalQuerySchema = z.strictObject({
  project_id: z.uuid().transform((projectId) => projectId.toLowerCase()),
  source: z.enum(EVENT_SOURCES),
  source_scope: sourceIdentifier,
  source_session_id: sourceIdentifier,
  source_message_id: sourceIdentifier,
  revision: revisionParam,
  wait_ms: waitMsParam.optional(),
});

export const searchByInputQuerySchema = z.union([byInputInternalQuerySchema, byInputExternalQuerySchema]);

export type ParsedSearchByInputQuery = z.infer<typeof searchByInputQuerySchema>;

// M7の明示session link。取り込み元identityと根拠発言revisionをstrictに受け、unknown fieldを拒否する。
const sessionIdentitySchema = z.strictObject({
  source: z.enum(EVENT_SOURCES),
  source_scope: sourceIdentifier,
  source_session_id: sourceIdentifier,
});

export const sessionLinkRequestSchema = z.strictObject({
  project_id: z.uuid().transform((projectId) => projectId.toLowerCase()),
  idempotency_key: storableString.max(512),
  from: sessionIdentitySchema,
  to: sessionIdentitySchema,
  evidence: sessionIdentitySchema.extend({
    source_message_id: sourceIdentifier,
    revision: z.int().min(1).max(2_147_483_647),
  }),
});

export type ParsedSessionLinkRequest = z.infer<typeof sessionLinkRequestSchema>;

// 原文取得は案件とrevisionを必須にし、unknown fieldを拒否する。
export const evidenceQuerySchema = z.strictObject({
  project_id: z.uuid().transform((projectId) => projectId.toLowerCase()),
  revision: revisionParam,
});
