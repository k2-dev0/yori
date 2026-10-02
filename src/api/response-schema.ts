import { z } from 'zod';
import { MAX_BUSINESS_FIELD_CODE_POINTS, MAX_BUSINESS_REDACTION_RULES, MAX_BUSINESS_TERM_CODE_POINTS } from './contract.js';
import { canonicalRepository, occurredAtSchema, revisionSchema, storableString } from './schema.js';

// HTTP公開応答の実行時正本。サーバーが返す形はstrictに固定し、
// OpenAPI生成・contract test・MCP consumerの公開型はここから導出する。

const errorCodeSchema = z.enum([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'repository_conflict',
  'payload_too_large',
  'internal_error',
  'suspected_secret',
]);

export const healthLiveResponseSchema = z.strictObject({ status: z.literal('ok') });

const releaseMetadataShape = {
  release_sha: z.string().regex(/^[0-9a-f]{40}$/),
  api_contract_version: z.literal(1),
};

// readyは受付可否と配布識別子だけを返す。依存障害でも内部情報を追加しない。
export const healthReadyResponseSchema = z.union([
  z.strictObject({ status: z.literal('ready'), ...releaseMetadataShape }),
  z.strictObject({ status: z.literal('unavailable'), ...releaseMetadataShape }),
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

export const projectRegistrationResponseSchema = z.strictObject({
  status: z.enum(['done', 'already']),
  project_id: z.uuid(),
  repository: canonicalRepository,
});

export const projectRemovalResponseSchema = z.strictObject({ status: z.literal('done'), project_id: z.uuid() });

const companySummaryResponseSchema = z.strictObject({
  company_id: z.uuid(),
  name: storableString,
});

const employeeSummaryResponseSchema = z.strictObject({
  employee_id: z.uuid(),
  display_name: storableString,
  created_at: occurredAtSchema,
});

const projectSummaryResponseSchema = z.strictObject({
  project_id: z.uuid(),
  repository: storableString,
  created_at: occurredAtSchema,
});

const tokenMetadataResponseSchema = z.strictObject({
  token_id: z.uuid(),
  employee_id: z.uuid(),
  scope: z.enum(['employee', 'company_admin']),
  created_at: occurredAtSchema,
  revoked_at: occurredAtSchema.nullable(),
});

export const meResponseSchema = z.strictObject({
  company: companySummaryResponseSchema,
  employee: employeeSummaryResponseSchema,
  token: tokenMetadataResponseSchema.omit({ employee_id: true }),
  projects: z.array(projectSummaryResponseSchema),
});

export const companyResponseSchema = z.strictObject({
  company: companySummaryResponseSchema,
  employees: z.array(employeeSummaryResponseSchema),
  projects: z.array(projectSummaryResponseSchema),
  tokens: z.array(tokenMetadataResponseSchema),
});

export const employeeCreateResponseSchema = z.strictObject({
  status: z.literal('done'),
  employee_id: z.uuid(),
  display_name: storableString,
  created_at: occurredAtSchema,
});

export const employeeRenameResponseSchema = z.strictObject({
  status: z.literal('done'),
  employee_id: z.uuid(),
  display_name: storableString,
});

export const tokenIssueResponseSchema = z.strictObject({
  status: z.literal('done'),
  token_id: z.uuid(),
  employee_id: z.uuid(),
  scope: z.enum(['employee', 'company_admin']),
  token: z.string().regex(/^yori_[A-Za-z0-9_-]+$/),
});

export const tokenRevokeResponseSchema = z.strictObject({
  status: z.enum(['done', 'already']),
  token_id: z.uuid(),
});

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
  // 候補を見つけた検索経路（vector / entity / strategy）。strategyだけなら対象・用語が違う同型設計の類推候補。
  retrieval_kinds: z.array(z.string()).optional(),
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

// 発言を生成したmodelと思考量は、明示の原文取得だけが返す。検索結果の根拠には載せず、自動注入へ流さない。
export const evidenceResponseSchema = z.strictObject({
  ...evidenceItemResponseSchema.shape,
  model_id: z.string().optional(),
  reasoning_effort: z.string().optional(),
});

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
export type ProjectRegistrationResponse = z.infer<typeof projectRegistrationResponseSchema>;
export type ProjectRemovalResponse = z.infer<typeof projectRemovalResponseSchema>;
export type MeResponse =z.infer<typeof meResponseSchema>;
export type CompanyResponse = z.infer<typeof companyResponseSchema>;
export type EmployeeCreateResponse = z.infer<typeof employeeCreateResponseSchema>;
export type EmployeeRenameResponse = z.infer<typeof employeeRenameResponseSchema>;
export type TokenIssueResponse = z.infer<typeof tokenIssueResponseSchema>;
export type TokenRevokeResponse = z.infer<typeof tokenRevokeResponseSchema>;
export type SearchView = z.infer<typeof searchViewResponseSchema>;
export type NotReceivedView = z.infer<typeof notReceivedResponseSchema>;
export type SearchLookupView = z.infer<typeof searchLookupResponseSchema>;
export type EvidenceView = z.infer<typeof evidenceResponseSchema>;
export type SessionLinkResponse = z.infer<typeof sessionLinkResponseSchema>;

// business fieldはidentifier長、termは一致文字列長の上限を公開schemaでも固定する。
const businessFieldSchema = storableString
  .refine((value) => [...value].length <= MAX_BUSINESS_FIELD_CODE_POINTS, {
    message: `fieldは${MAX_BUSINESS_FIELD_CODE_POINTS}コードポイント以内にしてください`,
  })
  .meta({ maxLength: MAX_BUSINESS_FIELD_CODE_POINTS });

const businessTermSchema = storableString
  .refine((value) => [...value].length <= MAX_BUSINESS_TERM_CODE_POINTS, {
    message: `termは${MAX_BUSINESS_TERM_CODE_POINTS}コードポイント以内にしてください`,
  })
  .meta({ maxLength: MAX_BUSINESS_TERM_CODE_POINTS });

// collector setupは自社projectとcurrent policyのversion/fields/terms/suspicion_mode/detector_versionだけを返し、
// 他社・token・known secretを含めない。
export const redactionPolicyResponseSchema = z.strictObject({
  version: z.int().min(0),
  fields: z.array(businessFieldSchema).max(MAX_BUSINESS_REDACTION_RULES),
  terms: z.array(businessTermSchema).max(MAX_BUSINESS_REDACTION_RULES),
  suspicion_mode: z.enum(['observe', 'block']),
  detector_version: z.literal('initial-v1'),
});

export const collectorSetupResponseSchema = z.strictObject({
  project_id: z.uuid(),
  repository: storableString,
  redaction_policy: redactionPolicyResponseSchema,
});

export type RedactionPolicyView = z.infer<typeof redactionPolicyResponseSchema>;
export type CollectorSetupResponse = z.infer<typeof collectorSetupResponseSchema>;
