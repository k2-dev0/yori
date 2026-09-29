import { z } from 'zod';
import { MAX_CUSTOM_REDACTION_ASSIGNMENT_KEY_CODE_POINTS, MAX_CUSTOM_REDACTION_LITERAL_CODE_POINTS, MAX_CUSTOM_REDACTION_RULES } from './contract.js';
import { occurredAtSchema, revisionSchema, storableString } from './schema.js';

// HTTP公開応答の実行時正本。サーバーが返す形はstrictに固定し、
// OpenAPI生成・contract test・MCP consumerの公開型はここから導出する。

const errorCodeSchema = z.enum([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'internal_error',
]);

export const healthLiveResponseSchema = z.strictObject({ status: z.literal('ok') });

// readyは受付可否だけを返す。依存障害でも内部情報を追加しない。
export const healthReadyResponseSchema = z.union([
  z.strictObject({ status: z.literal('ready') }),
  z.strictObject({ status: z.literal('unavailable') }),
]);

// 応答のエラー本文はcodeだけにし、説明文やDB errorを契約へ追加しない。
export const errorResponseSchema = z.strictObject({
  error: z.strictObject({ code: errorCodeSchema }),
});

const eventResultSchema = z.strictObject({
  idempotency_key: storableString.max(512),
  message_id: z.uuid(),
  revision: revisionSchema,
  request_id: z.uuid().nullable(),
});

export const eventsResponseSchema = z.strictObject({ results: z.array(eventResultSchema).min(1) });

export const searchAcceptedResponseSchema = z.strictObject({ request_id: z.uuid() });

const searchStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'expired']);
const searchOutcomeSchema = z.enum(['matched', 'no_match', 'skipped']);

const evidenceItemResponseSchema = z.strictObject({
  message_id: z.uuid(),
  revision: revisionSchema,
  employee_id: z.uuid(),
  role: z.string(),
  occurred_at: occurredAtSchema,
  text: z.string(),
});

const relationTupleResponseSchema = z.strictObject({
  relation: z.string(),
  related_to_message_id: z.uuid(),
  related_to_revision: revisionSchema,
});

// related evidenceは訂正・撤回のrelationを任意で持つ。内部検証metadataはAPI組立時に除去済み。
const relatedEvidenceItemResponseSchema = z.looseObject({
  ...evidenceItemResponseSchema.shape,
  source_kind: z.string(),
  relation: z.string().optional(),
  related_to_message_id: z.uuid().optional(),
  related_to_revision: revisionSchema.optional(),
  relations: z.array(relationTupleResponseSchema).optional(),
});

const searchMatchResponseSchema = z.strictObject({
  case_or_document_id: z.uuid(),
  // 候補評価の生値はworker保存JSONの内部表現であり、公開契約ではoptionalのまま保持する。
  relevance: z.unknown().optional(),
  relevance_kind: z.array(z.string()),
  statement_status: z.unknown().optional(),
  claim_status: z.enum(['agent_reported', 'not_reported']),
  evidence: z.array(evidenceItemResponseSchema).min(1),
  related_evidence: z.array(relatedEvidenceItemResponseSchema).optional(),
  related_evidence_ids: z.array(z.uuid()),
  truncated: z.boolean(),
});

// warningはcodeを必須にし、集計用の追加fieldは保持する。
const searchWarningResponseSchema = z.looseObject({ code: z.string() });

const indexStatusResponseSchema = z.strictObject({
  pending_documents: z.int().min(0),
  failed_documents: z.int().min(0),
  embedding_generation_id: z.uuid().nullable(),
  search_mode: z.string(),
});

export const searchViewResponseSchema = z.strictObject({
  request_id: z.uuid(),
  input_id: z.uuid(),
  input_revision: revisionSchema,
  trigger: z.enum(['auto', 'manual']),
  search_action: z.string().nullable(),
  reused_from_request_id: z.uuid().nullable(),
  status: searchStatusSchema,
  outcome: searchOutcomeSchema.nullable(),
  error_code: z.string().nullable(),
  project_id: z.uuid(),
  matches: z.array(searchMatchResponseSchema),
  warnings: z.array(searchWarningResponseSchema),
  index_status: indexStatusResponseSchema.optional(),
});

// 未受付はno_matchと区別し、検索viewのfieldを持たない独立した形にする。
export const notReceivedResponseSchema = z.strictObject({
  lookup_status: z.literal('not_received'),
  request_id: z.null(),
  input_id: z.null(),
  input_revision: z.null(),
  trigger: z.null(),
  status: z.null(),
  outcome: z.null(),
});

const foundSearchResponseSchema = z.strictObject({
  lookup_status: z.literal('found'),
  ...searchViewResponseSchema.shape,
});

export const searchLookupResponseSchema = z.union([notReceivedResponseSchema, foundSearchResponseSchema]);

export const evidenceResponseSchema = evidenceItemResponseSchema;

export const sessionLinkResponseSchema = z.strictObject({
  link_id: z.uuid(),
  project_id: z.uuid(),
  from_session_id: z.uuid(),
  to_session_id: z.uuid(),
  evidence_message_id: z.uuid(),
  evidence_revision: revisionSchema,
  status: z.literal('active'),
});

export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ErrorBody = z.infer<typeof errorResponseSchema>;
export type EventResult = z.infer<typeof eventResultSchema>;
export type EventsResponse = z.infer<typeof eventsResponseSchema>;
export type SearchView = z.infer<typeof searchViewResponseSchema>;
export type NotReceivedView = z.infer<typeof notReceivedResponseSchema>;
export type SearchLookupView = z.infer<typeof searchLookupResponseSchema>;
export type EvidenceView = z.infer<typeof evidenceResponseSchema>;
export type SessionLinkResponse = z.infer<typeof sessionLinkResponseSchema>;

// custom ruleはliteral/assignment_keyのdiscriminated unionで公開し、typeごとの上限を固定する。
export const redactionRuleResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('literal'),
    value: storableString
      .refine((value) => [...value].length <= MAX_CUSTOM_REDACTION_LITERAL_CODE_POINTS, {
        message: `literalは${MAX_CUSTOM_REDACTION_LITERAL_CODE_POINTS}コードポイント以内にしてください`,
      })
      .meta({ maxLength: MAX_CUSTOM_REDACTION_LITERAL_CODE_POINTS }),
  }),
  z.strictObject({
    type: z.literal('assignment_key'),
    value: storableString
      .refine((value) => [...value].length <= MAX_CUSTOM_REDACTION_ASSIGNMENT_KEY_CODE_POINTS, {
        message: `assignment_keyは${MAX_CUSTOM_REDACTION_ASSIGNMENT_KEY_CODE_POINTS}コードポイント以内にしてください`,
      })
      .meta({ maxLength: MAX_CUSTOM_REDACTION_ASSIGNMENT_KEY_CODE_POINTS }),
  }),
]);

// collector setupは自社projectとcurrent policyのversion/rulesだけを返し、他社・tokenは含めない。
export const redactionPolicyResponseSchema = z.strictObject({
  version: z.int().min(0),
  rules: z.array(redactionRuleResponseSchema).max(MAX_CUSTOM_REDACTION_RULES),
});

export const collectorSetupResponseSchema = z.strictObject({
  project_id: z.uuid(),
  repository: storableString,
  redaction_policy: redactionPolicyResponseSchema,
});

export type RedactionRuleView = z.infer<typeof redactionRuleResponseSchema>;
export type RedactionPolicyView = z.infer<typeof redactionPolicyResponseSchema>;
export type CollectorSetupResponse = z.infer<typeof collectorSetupResponseSchema>;
