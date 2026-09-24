import { AUTO_SEARCH_POLICY_VERSION, type EventRole } from '../api/contract.js';

// M3 workerの判定契約。policy版は既存の自動検索受付・分類jobと同じ値を使う。
export const WORKER_POLICY_VERSION = AUTO_SEARCH_POLICY_VERSION;
export const JEV_API_PATH = '/v1/systemone';
export const DEFAULT_JEV_API_URL = `https://api.typesafe.ai${JEV_API_PATH}`;
export const DEFAULT_JEV_MODEL = 'jev-latest';
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;
export const DEFAULT_INPUT_BUDGET_BYTES = 8_000;
export const CONTEXT_MESSAGE_LIMIT = 6;
export const JEV_PROVIDER = 'jev';
// 同一呼出し内の質問IDを一意にするための区切り。JevはIDの意味を前提にしない。
export const JEV_PART_SEPARATOR = '#';

export const RETENTIONS = ['substantive', 'decision_signal', 'progress_only', 'unknown'] as const;
export type Retention = (typeof RETENTIONS)[number];

export const PRIMARY_INTENTS = [
  'requirements',
  'design',
  'implementation',
  'explanation',
  'investigation',
  'bugfix',
  'review',
  'test',
  'refactor',
  'operation',
  'handoff',
  'other',
  'unknown',
] as const;
export type PrimaryIntent = (typeof PRIMARY_INTENTS)[number];

export const TECHNICAL_LABELS = [
  'frontend',
  'backend',
  'database',
  'infrastructure',
  'cicd',
  'security',
  'mobile',
  'data_ml',
  'devtools',
  'other',
] as const;
export type TechnicalLabel = (typeof TECHNICAL_LABELS)[number];

export const DECISION_ACTIONS = ['propose', 'accept', 'reject', 'revoke', 'change', 'none', 'unknown'] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export const CONTINUITIES = ['same_topic', 'new_topic', 'multiple_topics', 'unknown'] as const;
export type Continuity = (typeof CONTINUITIES)[number];

export const SEARCH_ACTIONS = ['new_search', 'reuse', 'skip'] as const;
export type SearchAction = (typeof SEARCH_ACTIONS)[number];

export const STATEMENT_STATUSES = [
  'request',
  'proposal',
  'approval',
  'reported_completed',
  'reported_verified',
  'unknown',
] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

export const SAME_CONDITION_VALUES = ['yes', 'no', 'unknown'] as const;
export type SameCondition = (typeof SAME_CONDITION_VALUES)[number];
export const JEV_SAME_CONDITIONS_QUESTION_ID = 'same_conditions';

// relationの明示/推定を判定するChoice質問。既存fixtureはcriteria先頭を選ぶためexplicitを先頭にする。
export const JEV_RELATION_EXPLICIT_QUESTION_ID = 'relation_explicit';
export const RELATION_ACTIONS = ['accept', 'reject', 'revoke', 'change'] as const;
export type RelationAction = (typeof RELATION_ACTIONS)[number];

// 質問文・criteriaを変えた時に古いキャッシュを再利用しないための版。
export const JEV_QUESTIONS_VERSION = 'm3-1';

// partごとに独立して質問するfield。検索振り分けもpart単位で確認して集約する。
export const JEV_PART_FIELDS = [
  'retention',
  'primary_intent',
  'decision_action',
  'continuity',
  'statement_status',
  'search_action',
  'relation_target',
] as const;
export type JevPartField = (typeof JEV_PART_FIELDS)[number];

// 質問IDは呼出し内の識別にだけ使い、fieldの意味はinstructionsで示す。
export function jevQuestionId(field: JevPartField, partIndex?: number): string {
  return partIndex === undefined ? field : `${field}${JEV_PART_SEPARATOR}${partIndex}`;
}

export function jevTechnicalLabelQuestionId(label: TechnicalLabel, partIndex: number): string {
  return `technical_label:${label}${JEV_PART_SEPARATOR}${partIndex}`;
}

// 公式契約のQuestion本体はIDを持たず、request.questionsのmap keyが質問IDになる。
export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

// 現在発言は原文UTF-16 offset付きの連続範囲（part）へ分割し、本文を欠かさず送る。
export interface JevStatePart {
  offset: number;
  length: number;
  text: string;
}

export interface JevStateMessage {
  message_id: string;
  revision: number;
  role: EventRole;
  occurred_at: string;
  text: string;
}

export interface JevCurrentMessage {
  message_id: string;
  revision: number;
  role: EventRole;
  occurred_at: string;
  parts: JevStatePart[];
}

// 直近の先行検索の比較対象。条件同一の判定に必要な固定的なidentityと元入力だけをstateへ入れる。
// 受付status/outcomeのような可変値は、route/classifyでstateとcache keyが揺れないよう含めない。
export interface JevPriorSearch {
  request_id: string;
  input_id: string;
  input_revision: number;
  input_sequence_no: number;
  input_text: string;
}

export interface JevState {
  policy_version: string;
  current: JevCurrentMessage;
  // 対象sequenceより前の同session発言だけを新しい順に最大6件入れる。
  prior_messages: JevStateMessage[];
  // 直近の先行検索。予算に入らない場合はnullにし、reuseしない（same_conditionsはunknown扱い）。
  prior_search: JevPriorSearch | null;
  truncation: {
    omitted_prior_messages: number;
    split_current: boolean;
    prior_search_omitted: boolean;
  };
}

export interface JevUsage {
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface JevAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
}

export interface JevRequest {
  model: string;
  state: JevState;
  // Jevの公式契約では配列でなくmapで送る。keyが質問ID、answersも同じkeyで返る。
  questions: Record<string, JevChoiceQuestion>;
}
