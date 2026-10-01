import { z } from 'zod';
import { EVENT_SOURCES } from '../api/contract.js';
import {
  conversationText,
  idempotencyKeySchema,
  normalizedUuid,
  occurredAtSchema,
  revisionSchema,
  sourceIdentifier,
  storableString,
  waitMsValueSchema,
} from '../api/schema.js';

// MCP tool入力とstructuredContent出力の実行時正本。
// 入力はHTTPと同じprimitive・UUID正規化・UTF-8 byte上限を共有し、中央API応答は
// consumerの後方互換のためloose validationで追加fieldを保持する。

const linkSessionIdentitySchema = z.strictObject({
  source: z.enum(EVENT_SOURCES),
  source_scope: sourceIdentifier,
  source_session_id: sourceIdentifier,
});

// HTTP POST /v1/searchesと同じstrict入力。queryはHTTP本文と同じコードポイント上限で判定する。
export const searchHistoryInputSchema = z.strictObject({
  project_id: normalizedUuid.optional(),
  input_id: normalizedUuid,
  input_revision: revisionSchema,
  query: conversationText,
  idempotency_key: idempotencyKeySchema,
  force_refresh: z.boolean(),
});

// request_id、input_id+input_revision、外部identityのどれか1つだけを指定する排他的branch。
export const getSearchResultInputSchema = z
  .strictObject({
    project_id: normalizedUuid.optional(),
    request_id: normalizedUuid.optional(),
    wait_ms: waitMsValueSchema.optional(),
    input_id: normalizedUuid.optional(),
    input_revision: revisionSchema.optional(),
    source: z.enum(EVENT_SOURCES).optional(),
    source_scope: sourceIdentifier.optional(),
    source_session_id: sourceIdentifier.optional(),
    source_message_id: sourceIdentifier.optional(),
    revision: revisionSchema.optional(),
  })
  .refine(
    (value) => {
      const branchCount = [value.request_id, value.input_id, value.source].filter((item) => item !== undefined).length;
      if (branchCount !== 1) {
        return false;
      }
      if (value.request_id !== undefined) {
        // request_id branchはrequest_id + project_id + 任意wait_msだけを許可する。
        return (
          value.input_id === undefined &&
          value.input_revision === undefined &&
          value.source === undefined &&
          value.source_scope === undefined &&
          value.source_session_id === undefined &&
          value.source_message_id === undefined &&
          value.revision === undefined
        );
      }
      if (value.input_id !== undefined) {
        // internal branchはinput_id + input_revision + project_id + 任意wait_msだけを許可する。
        return (
          value.input_revision !== undefined &&
          value.source === undefined &&
          value.source_scope === undefined &&
          value.source_session_id === undefined &&
          value.source_message_id === undefined &&
          value.revision === undefined
        );
      }
      // external branchはsource + scope + session + message + revision + project_id + 任意wait_msだけを許可する。
      return (
        value.request_id === undefined &&
        value.input_id === undefined &&
        value.input_revision === undefined &&
        value.source_scope !== undefined &&
        value.source_session_id !== undefined &&
        value.source_message_id !== undefined &&
        value.revision !== undefined
      );
    },
    { message: 'request_id、input_id+input_revision、外部identityのどれか1つだけを指定してください' },
  );

export const getEvidenceInputSchema = z.strictObject({
  project_id: normalizedUuid.optional(),
  message_id: normalizedUuid,
  revision: revisionSchema,
});

// HTTP POST /v1/session-linksと同じstrict入力。identityのbyte上限も共有する。
export const linkSessionInputSchema = z.strictObject({
  project_id: normalizedUuid.optional(),
  idempotency_key: idempotencyKeySchema,
  from: linkSessionIdentitySchema,
  to: linkSessionIdentitySchema,
  evidence: linkSessionIdentitySchema.extend({
    source_message_id: sourceIdentifier,
    revision: revisionSchema,
  }),
});

// record_caseはHTTP POST /v1/eventsのagent_reportと同じ本文上限・識別子上限を使う。
export const recordCaseInputSchema = z.strictObject({
  project_id: normalizedUuid.optional(),
  idempotency_key: idempotencyKeySchema,
  source: z.enum(EVENT_SOURCES),
  source_scope: sourceIdentifier,
  source_session_id: sourceIdentifier,
  source_message_id: sourceIdentifier,
  sequence_no: revisionSchema,
  revision: revisionSchema,
  occurred_at: occurredAtSchema,
  problem: conversationText,
  cause: conversationText.optional(),
  investigation_steps: z.array(conversationText).max(50).optional(),
  action: conversationText,
  failed_attempts: z.array(conversationText).max(50).optional(),
  confirmation_status: conversationText,
  constraints: z.array(conversationText).max(50).optional(),
  related_files_or_prs: z.array(conversationText).max(50).optional(),
});

// 中央APIのPOST /v1/searches応答。request_idだけを必須にし、追加fieldは保持する。
export const searchAcceptedOutputSchema = z.looseObject({ request_id: z.uuid() });

const searchViewStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'expired']);
const searchViewOutcomeSchema = z.enum(['matched', 'no_match', 'skipped']);

const evidenceOutputSchema = z.looseObject({
  message_id: z.uuid(),
  revision: revisionSchema,
  employee_id: z.uuid(),
  role: z.string(),
  occurred_at: occurredAtSchema,
  text: z.string(),
});

// related_evidenceはHTTP公開契約と同じ7 fieldを必須にし、relation系だけを型検証する。将来追加fieldは保持する。
const relatedEvidenceOutputSchema = z.looseObject({
  message_id: z.uuid(),
  revision: revisionSchema,
  employee_id: z.uuid(),
  role: z.string(),
  occurred_at: occurredAtSchema,
  text: z.string(),
  source_kind: z.string(),
  relation: z.string().optional(),
  related_to_message_id: z.uuid().optional(),
  related_to_revision: revisionSchema.optional(),
  relations: z
    .array(
      z.looseObject({
        relation: z.string(),
        related_to_message_id: z.uuid(),
        related_to_revision: revisionSchema,
      }),
    )
    .optional(),
});

const matchOutputSchema = z.looseObject({
  case_or_document_id: z.uuid(),
  relevance_kind: z.array(z.string()),
  claim_status: z.enum(['agent_reported', 'not_reported']),
  evidence: z.array(evidenceOutputSchema).min(1),
  related_evidence: z.array(relatedEvidenceOutputSchema).optional(),
  related_evidence_ids: z.array(z.uuid()),
  truncated: z.boolean(),
});

const indexStatusOutputSchema = z.looseObject({
  pending_documents: z.int().min(0),
  failed_documents: z.int().min(0),
  embedding_generation_id: z.uuid().nullable(),
  search_mode: z.string(),
});

// 検索viewはidentityと分岐判定に必要なfieldだけを必須にする。HTTP追加fieldは保持する。
const searchViewOutputFields = {
  request_id: z.uuid(),
  input_id: z.uuid(),
  input_revision: revisionSchema,
  trigger: z.enum(['auto', 'manual']),
  status: searchViewStatusSchema,
  outcome: searchViewOutcomeSchema.nullable(),
  project_id: z.uuid(),
  search_action: z.string().nullable().optional(),
  reused_from_request_id: z.uuid().nullable().optional(),
  error_code: z.string().nullable().optional(),
  matches: z.array(matchOutputSchema).optional(),
  warnings: z.array(z.looseObject({ code: z.string() })).optional(),
  index_status: indexStatusOutputSchema.optional(),
};

// GET /v1/searches/:id（request_id branch）はlookup_statusを持たない検索viewだけを返す。
// found／not_receivedの追加fieldをrequest_id応答として誤受理しないよう排他にする。
const searchViewOutputBaseSchema = z.looseObject(searchViewOutputFields);
export const requestIdSearchViewOutputSchema = searchViewOutputBaseSchema.refine(
  (value) => value.lookup_status === undefined,
  { message: 'lookup_statusはfound／not_received branchだけが返します' },
);

// 未受付はminimal応答（lookup_statusだけ）を許しつつ、identityが付く場合はnullだけを受理する。
export const notReceivedOutputSchema = z.looseObject({
  lookup_status: z.literal('not_received'),
  request_id: z.null().optional(),
  input_id: z.null().optional(),
  input_revision: z.null().optional(),
  trigger: z.null().optional(),
  status: z.null().optional(),
  outcome: z.null().optional(),
});

const foundSearchOutputSchema = z.looseObject({
  lookup_status: z.literal('found'),
  ...searchViewOutputFields,
});

// GET /v1/searches/by-inputはfoundの完全viewかnot_receivedだけを返す。lookup_statusなしviewは受理しない。
export const byInputSearchLookupOutputSchema = z.union([notReceivedOutputSchema, foundSearchOutputSchema]);

// tool最終出力はrequest_id／by-input両経路の正しい戻り値をunionで受け、foundを先に判定して分岐を保つ。
export const searchResultOutputSchema = z.union([
  notReceivedOutputSchema,
  foundSearchOutputSchema,
  requestIdSearchViewOutputSchema,
]);

export const evidenceResponseOutputSchema = evidenceOutputSchema;

export const linkSessionOutputSchema = z.looseObject({
  link_id: z.uuid(),
  project_id: z.uuid(),
  from_session_id: z.uuid(),
  to_session_id: z.uuid(),
  evidence_message_id: z.uuid(),
  evidence_revision: revisionSchema,
  status: z.literal('active'),
});

export const recordCaseOutputSchema = z.looseObject({
  results: z
    .array(
      z.looseObject({
        idempotency_key: storableString.max(512),
        message_id: z.uuid(),
        revision: revisionSchema,
        request_id: z.uuid().nullable(),
      }),
    )
    .min(1),
});

// toolが最終的にstructuredContentとtextへ返す正本。中央API consumerのloose validationを維持する。
export const searchHistoryToolOutputSchema = searchAcceptedOutputSchema;
export const getSearchResultToolOutputSchema = searchResultOutputSchema;
export const getEvidenceToolOutputSchema = evidenceResponseOutputSchema;
export const linkSessionToolOutputSchema = linkSessionOutputSchema;

// record_caseは検証済みevents応答へ、600文字超の警告（string配列）だけを追加できる。
export const recordCaseToolOutputSchema = z.looseObject({
  ...recordCaseOutputSchema.shape,
  warnings: z.array(z.string()).optional(),
});
