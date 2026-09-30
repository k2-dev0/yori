import { z } from 'zod';
import {
  EVENT_ROLES,
  EVENT_SOURCES,
  MAX_BATCH_SIZE,
  MAX_MODEL_IDENTIFIER_BYTES,
  MAX_SOURCE_IDENTIFIER_BYTES,
  MAX_TEXT_LENGTH,
  MIN_BATCH_SIZE,
} from './contract.js';

// HTTPとMCPの入力境界で共有するprimitive。上限値の実体を1箇所に置き、片側だけdriftしないようにする。

// DBのinteger境界。revision・sequence_no等の正数上限として共有する。
export const MAX_REVISION = 2_147_483_647;

// wait_msの上限。HTTP queryとMCP入力で同じ値を使う。
export const MAX_WAIT_MS = 5000;

// Unicodeモードでは有効なペアを1コードポイントとして扱い、単独サロゲートだけを拒否する。
export const storableString = z.string().min(1).refine(
  (value) => !value.includes('\u0000') && !/[\uD800-\uDFFF]/u.test(value),
  { message: 'NULおよび単独サロゲートは指定できません' },
);

// sessionの複合索引にはscopeとsession IDの両方が入る。名前空間の接頭辞を含めても
// 配布PostgreSQLのB-tree索引に収まるよう、各識別子をUTF-8で1024バイトまでに制限する。
// UTF-8 byte上限はJSON Schema標準keywordで表せないため、descriptionとx-yori拡張へ同じ定数から出す。
export const sourceIdentifier = storableString
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_SOURCE_IDENTIFIER_BYTES, {
    message: `取り込み元の識別子はUTF-8で${MAX_SOURCE_IDENTIFIER_BYTES}バイト以内にしてください`,
  })
  .meta({
    description: `取り込み元identifierはUTF-8で${MAX_SOURCE_IDENTIFIER_BYTES}バイト以内`,
    'x-yori-max-utf8-bytes': MAX_SOURCE_IDENTIFIER_BYTES,
  });

// provider非依存のmodel ID。Cursorが返す任意slugを固定enumへ閉じず、保存可能な識別子だけを受理する。
export const modelIdentifier = storableString
  .max(MAX_MODEL_IDENTIFIER_BYTES)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_MODEL_IDENTIFIER_BYTES, {
    message: `model IDはUTF-8で${MAX_MODEL_IDENTIFIER_BYTES}バイト以内にしてください`,
  })
  .meta({
    maxLength: MAX_MODEL_IDENTIFIER_BYTES,
    description: `model IDはUTF-8で${MAX_MODEL_IDENTIFIER_BYTES}バイト以内`,
    'x-yori-max-utf8-bytes': MAX_MODEL_IDENTIFIER_BYTES,
  });

// UUIDは比較・保存の前に小文字の正規形へ揃える。HTTP body/queryとMCP入力を同じ規則にする。
export const normalizedUuid = z.uuid().transform((value) => value.toLowerCase());

// 正数IDの上限。message revision・sequence_no・input_revisionで共有する。
export const revisionSchema = z.int().min(1).max(MAX_REVISION);

// 冪等キーの上限。POST /v1/events・/v1/searches・/v1/session-linksとMCP入力を共有する。
export const idempotencyKeySchema = storableString.max(512);

// 本文の上限はUTF-16長ではなくUnicodeコードポイント数で判定する。NUL・不正UTF-16も保存しない。
// Unicodeコードポイント上限はJSON Schemaへ直接変換できないため、descriptionとx-yori拡張へ同じ定数から出す。
export const conversationText = storableString
  .refine((text) => [...text].length <= MAX_TEXT_LENGTH, {
    message: `本文は${MAX_TEXT_LENGTH}コードポイント以内にしてください`,
  })
  .meta({
    // JSON Schema 2020-12のmaxLengthはUnicodeコードポイント数なので、標準keywordでも同じ上限を表す。
    maxLength: MAX_TEXT_LENGTH,
    description: `本文はUnicodeコードポイントで${MAX_TEXT_LENGTH}以内`,
    'x-yori-max-code-points': MAX_TEXT_LENGTH,
  });

// 受信時刻はoffset付きISO文字列に限定する。HTTP入力とMCP入力を共有する。
export const occurredAtSchema = z.iso.datetime({ offset: true });

// MCPのwait_msは0〜5000の整数そのものとして受ける。
export const waitMsValueSchema = z.int().min(0).max(MAX_WAIT_MS);

// 受信イベント1件の契約。company_id/employee_id等のunknown fieldは境界を偽装できないよう拒否する。
const eventSchema = z.strictObject({
  idempotency_key: idempotencyKeySchema,
  source: z.enum(EVENT_SOURCES),
  source_scope: sourceIdentifier,
  source_session_id: sourceIdentifier,
  source_message_id: sourceIdentifier,
  sequence_no: revisionSchema,
  revision: revisionSchema,
  role: z.enum(EVENT_ROLES),
  occurred_at: occurredAtSchema,
  model_id: modelIdentifier.optional(),
  text: conversationText,
});

// バッチ受付の契約。1..100件・UUID形式のproject_idだけを受理し、UUIDは小文字の正規形へ揃える。
export const eventsRequestSchema = z.strictObject({
  project_id: normalizedUuid,
  events: z.array(eventSchema).min(MIN_BATCH_SIZE).max(MAX_BATCH_SIZE),
});

export type ParsedEvent = z.infer<typeof eventSchema>;
export type EventsRequest = z.infer<typeof eventsRequestSchema>;

// M6の明示検索受付。質問・入力revision・冪等キー・force_refreshを必須にし、unknown fieldを拒否する。
export const searchRequestSchema = z.strictObject({
  project_id: normalizedUuid,
  input_id: normalizedUuid,
  input_revision: revisionSchema,
  query: conversationText,
  idempotency_key: idempotencyKeySchema,
  force_refresh: z.boolean(),
});

export type ParsedSearchRequest = z.infer<typeof searchRequestSchema>;

// wait_msはquery文字列として渡る。0〜5000の10進整数だけを受理し、数値上限はMCPと共有する。
export const waitMsParam = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform((value) => Number(value))
  .refine((value) => waitMsValueSchema.safeParse(value).success, { message: `wait_msは0〜${MAX_WAIT_MS}の整数です` });

export const searchDetailQuerySchema = z.strictObject({
  wait_ms: waitMsParam.optional(),
});

// input revision等のquery paramは文字列から整数へ変換し、1以上だけを受理する。
export const revisionQueryParamSchema = z.coerce.number().int().min(1).max(MAX_REVISION);

// by-inputは内部input_idか、イベント受付と同じ取り込み元identityのどちらか一方だけを受理する。
export const byInputInternalQuerySchema = z.strictObject({
  project_id: normalizedUuid,
  input_id: normalizedUuid,
  input_revision: revisionQueryParamSchema,
  wait_ms: waitMsParam.optional(),
});

export const byInputExternalQuerySchema = z.strictObject({
  project_id: normalizedUuid,
  source: z.enum(EVENT_SOURCES),
  source_scope: sourceIdentifier,
  source_session_id: sourceIdentifier,
  source_message_id: sourceIdentifier,
  revision: revisionQueryParamSchema,
  wait_ms: waitMsParam.optional(),
});

export const searchByInputQuerySchema = z.union([byInputInternalQuerySchema, byInputExternalQuerySchema]);

// by-inputの排他的branch。OpenAPIのparameter列挙とx-yori-input-branchesをZod schemaから生成する。
export const searchByInputBranchSchemas = {
  internal: byInputInternalQuerySchema,
  external: byInputExternalQuerySchema,
} as const;

export type ParsedSearchByInputQuery = z.infer<typeof searchByInputQuerySchema>;

// M7の明示session link。取り込み元identityと根拠発言revisionをstrictに受け、unknown fieldを拒否する。
const sessionIdentitySchema = z.strictObject({
  source: z.enum(EVENT_SOURCES),
  source_scope: sourceIdentifier,
  source_session_id: sourceIdentifier,
});

export const sessionLinkRequestSchema = z.strictObject({
  project_id: normalizedUuid,
  idempotency_key: idempotencyKeySchema,
  from: sessionIdentitySchema,
  to: sessionIdentitySchema,
  evidence: sessionIdentitySchema.extend({
    source_message_id: sourceIdentifier,
    revision: revisionSchema,
  }),
});

export type ParsedSessionLinkRequest = z.infer<typeof sessionLinkRequestSchema>;

// 原文取得は案件とrevisionを必須にし、unknown fieldを拒否する。
export const evidenceQuerySchema = z.strictObject({
  project_id: normalizedUuid,
  revision: revisionQueryParamSchema,
});

// collector setupはcollectorが正規化したcanonical host/pathだけを受理し、URL・local path・空白は400にする。
export const canonicalRepository = storableString
  .refine((value) => /^[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?\/[^\s]+$/.test(value), {
    message: 'repositoryはcanonical host/pathで指定してください',
  })
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_SOURCE_IDENTIFIER_BYTES, {
    message: `repositoryはUTF-8で${MAX_SOURCE_IDENTIFIER_BYTES}バイト以内にしてください`,
  })
  .meta({
    description: `canonical repositoryはUTF-8で${MAX_SOURCE_IDENTIFIER_BYTES}バイト以内のhost/path`,
    'x-yori-max-utf8-bytes': MAX_SOURCE_IDENTIFIER_BYTES,
  });

export const collectorSetupRequestSchema = z.strictObject({
  repository: canonicalRepository,
});

export type ParsedCollectorSetupRequest = z.infer<typeof collectorSetupRequestSchema>;
