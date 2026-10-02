import { AUTO_SEARCH_POLICY_VERSION, type EventRole } from '../api/contract.js';

// M3 workerの判定契約。policy版は既存の自動検索受付・分類jobと同じ値を使う。
export const WORKER_POLICY_VERSION = AUTO_SEARCH_POLICY_VERSION;
export const JEV_API_PATH = '/v1/systemone';
export const DEFAULT_JEV_API_URL = `https://api.typesafe.ai${JEV_API_PATH}`;
export const DEFAULT_JEV_MODEL = 'jev-latest';
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;
export const DEFAULT_INPUT_BUDGET_BYTES = 16_000;
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
export const JEV_QUESTIONS_VERSION = 'm3-5';

// ---- M4 Voyage埋め込みの固定契約（計画3.3） ----
export const VOYAGE_PROVIDER = 'voyage_direct';
export const VOYAGE_API_PATH = '/v1/embeddings';
export const DEFAULT_VOYAGE_API_URL = `https://api.voyageai.com${VOYAGE_API_PATH}`;
export const VOYAGE_MODEL = 'voyage-4-lite';
// Voyageはmodelの不変revisionを公開しないため、取得できた識別情報とtokenizer資産のrevisionだけを固定する。
export const VOYAGE_TOKENIZER_VERSION =
  'voyageai/voyage-4-lite@0335ddf7698395712e3220733b4079006951cfef+@huggingface/tokenizers@0.2.0';
export const VOYAGE_DIMENSIONS = 1024;
export const VOYAGE_METRIC = 'cosine';
export const VOYAGE_OUTPUT_DTYPE = 'float';
export const VOYAGE_DOCUMENT_INPUT_TYPE = 'document';
export const VOYAGE_QUERY_INPUT_TYPE = 'query';
// アプリ側で追加の正規化・接頭文を重ねない。input_typeの前処理はproviderへ委ねる。
export const VOYAGE_NORMALIZATION = 'provider_default';
// providerのdocument prefixに充てるtoken数の保守的な予約。target/max/overlapはこの分を含めて数える。
export const VOYAGE_DOCUMENT_PREFIX_TOKEN_RESERVE = 32;

// 決定的な文書分割のcontract（計画8.2）。target 800 / max 1200 / overlap 100 token。
export const CHUNK_TARGET_TOKENS = 800;
export const CHUNK_MAX_TOKENS = 1_200;
export const CHUNK_OVERLAP_TOKENS = 100;
export const DOCUMENT_CHUNKER_VERSION = 'm4-1';

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

// 対象・用語に依存しない設計方針の軸。異なる対象の同型設計を候補へ入れる検索経路に使う。
// 技術領域ラベル（TECHNICAL_LABELS）は検索に使っていないため、この軸の質問に置き換えた。
// noneは該当なし、unknownは判断不能。どちらも検索語にしない。
export const STRATEGY_AXES = {
  state_hazard: {
    instruction: '状態の危険',
    criteria: {
      duplicate_apply: '二重適用',
      stale_write: '古い前提の書込み',
      lost_update: '更新消失',
      out_of_order: '順序逆転',
      partial_failure: '部分失敗',
      none: 'なし',
      unknown: '不明',
    },
  },
  consistency_strategy: {
    instruction: '整合性手段',
    criteria: {
      idempotency: '冪等化',
      optimistic_revalidation: '適用前再検証',
      pessimistic_lock: '排他ロック',
      fencing: 'fencing',
      atomic_transaction: '原子的更新',
      compensation: '補償',
      none: 'なし',
      unknown: '不明',
    },
  },
  lifecycle_strategy: {
    instruction: '更新・切替方式',
    criteria: {
      versioned_state: '版管理',
      append_only: '追記のみ',
      invalidation: '失効',
      rebuild: '再構築',
      dual_run_atomic_cutover: '旧版維持で切替',
      none: 'なし',
      unknown: '不明',
    },
  },
  failure_strategy: {
    instruction: '障害時方針',
    criteria: {
      retry: '再試行',
      fallback: '代替',
      explicit_degraded: '劣化を明示',
      fail_closed: '不確かなら停止',
      backpressure: '流量制御',
      none: 'なし',
      unknown: '不明',
    },
  },
  performance_strategy: {
    instruction: '性能・費用手段',
    criteria: {
      cache: 'cache',
      deduplicate: '重複排除',
      batch: '一括',
      incremental: '差分',
      precompute: '事前計算',
      parallelize: '並列・先行',
      none: 'なし',
      unknown: '不明',
    },
  },
  scope_invariant: {
    instruction: '守る境界',
    criteria: {
      tenant: '会社分離',
      project: '案件分離',
      revision: '版一致',
      generation: '世代一致',
      authorization: '権限',
      none: 'なし',
      unknown: '不明',
    },
  },
  evidence_strategy: {
    instruction: '根拠の示し方',
    criteria: {
      provenance: '出典保持',
      revalidation: '利用時再検証',
      audit: '監査',
      executable_verification: '実行検証',
      none: 'なし',
      unknown: '不明',
    },
  },
} as const satisfies Record<string, { instruction: string; criteria: Record<string, string> }>;
export type StrategyAxis = keyof typeof STRATEGY_AXES;
export const STRATEGY_AXIS_NAMES = Object.keys(STRATEGY_AXES) as StrategyAxis[];
// 検索語にしない値。
export const STRATEGY_NON_TERMS: readonly string[] = ['none', 'unknown'];

export function jevStrategyQuestionId(axis: StrategyAxis, partIndex: number): string {
  return `strategy:${axis}${JEV_PART_SEPARATOR}${partIndex}`;
}

// 設計方針の一致経路の上限と、候補にする最小一致軸数。1軸だけの一致は対象外にして雑音を抑える。
export const SEARCH_STRATEGY_LIMIT = 10;
export const SEARCH_STRATEGY_MIN_MATCHED_TERMS = 2;

// 候補専用のrelation_explicit質問ID。候補message IDとpart indexで呼出し内に一意にし、意味はinstructionsで示す。
export function jevRelationExplicitQuestionId(candidateId: string, partIndex: number): string {
  return `${JEV_RELATION_EXPLICIT_QUESTION_ID}:${candidateId}${JEV_PART_SEPARATOR}${partIndex}`;
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

// M5の候補判定でJevへ渡す検索文書revision。candidate_idは呼出し内で一意なdocument_id:revision。
export interface JevStateCandidate {
  candidate_id: string;
  document_id: string;
  revision: number;
  text: string;
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
  // M5の候補判定だけが入れる。M3の分類・振り分けstateは省略し、cache keyを変えない。
  candidates?: JevStateCandidate[];
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

// ---- M5 検索・候補判定の固定契約（計画9.2.1、9.3、10.3） ----
// vector/識別子の各経路の取得上限と、Jevへ渡す候補上限・本文予算。
export const SEARCH_VECTOR_LIMIT = 20;
// vector経路で実際に取得する件数。内容が重複する候補を除いて別々の内容がSEARCH_VECTOR_LIMIT件そろうところまでを使う。
// 同じ質問への回答の繰り返しが上位を埋めても、別の内容を候補に残すための余裕。
export const SEARCH_VECTOR_FETCH_LIMIT = 60;
export const SEARCH_ENTITY_LIMIT = 20;
// 候補の回答が受け取った検索結果から辿って候補へ加える、元の発言の文書の上限。
export const SEARCH_PROVENANCE_LIMIT = 10;
export const SEARCH_CANDIDATE_LIMIT = 10;
// 候補同士の埋め込みのcosine類似度がこの値以上なら、同じ内容の繰り返しとして1件へ畳む。
// 本番の写しの1質問で、同じ質問への回答の繰り返し同士は0.84以上、別の内容とは0.80以下だった。その間に置いた暫定値。
export const SEARCH_DUPLICATE_SIMILARITY = 0.82;
// 長い検索質問は保存側と同じ大きさ（CHUNK_TARGET_TOKENS）へ区切り、先頭からこの件数までを区切りごとに検索する。
// 候補上限10件に対して1区切りあたり平均2件を残せる件数にする。
export const SEARCH_QUESTION_CHUNK_LIMIT = 5;
export const SEARCH_CANDIDATE_BUDGET_TOKENS = 8_000;
// 候補判定を分割するJev 1リクエストあたりの候補数。上限10件を最大2リクエストへ分け、並列に送って待ち時間を短くする。
export const SEARCH_CANDIDATE_REQUEST_SIZE = 5;
// RRFは各経路の順位rに対して1/(60+r)を加算する。
export const SEARCH_RRF_RANK_CONSTANT = 60;
// 検索候補取得TXのstatement_timeout。空結果へ読み替えず、超過はエラーとして扱う。
export const SEARCH_STATEMENT_TIMEOUT_MS = 5_000;
export const SEARCH_MODE_EXACT_VECTOR_AND_ENTITY = 'exact_vector_and_entity';
export const SEARCH_MODE_EXACT_VECTOR_ENTITY_AND_STRATEGY = 'exact_vector_entity_and_strategy';

// 候補の有用性4段階。useful/directだけを採用する。
export const CANDIDATE_RELEVANCES = ['unrelated', 'peripheral', 'useful', 'direct'] as const;
export type CandidateRelevance = (typeof CANDIDATE_RELEVANCES)[number];
export const CANDIDATE_RELEVANCE_CRITERIA: Record<CandidateRelevance, string> = {
  unrelated: '現在の質問と無関係',
  peripheral: '周辺的で答えの根拠にならない',
  useful: '再利用できる手順・根拠がある',
  direct: '現在の質問へ直接答える',
};

// 候補判定の質問ID接頭辞。candidate_id（document_id:revision）付きで呼出し内に一意にする。
export const CANDIDATE_RELEVANCE_QUESTION_PREFIX = 'candidate_relevance';
export const CANDIDATE_TARGET_MATCH_QUESTION_PREFIX = 'candidate_target_match';
export const CANDIDATE_SIMILAR_SYMPTOM_OR_REQUEST_QUESTION_PREFIX = 'candidate_similar_symptom_or_request';
export const CANDIDATE_SIMILAR_CONSTRAINTS_QUESTION_PREFIX = 'candidate_similar_constraints';
export const CANDIDATE_IMPLEMENTATION_RATIONALE_QUESTION_PREFIX = 'candidate_implementation_rationale';
export const CANDIDATE_REUSABLE_PROCEDURE_QUESTION_PREFIX = 'candidate_reusable_procedure';
export const CANDIDATE_YES_NO_CRITERIA = { yes: '当てはまる', no: '当てはまらない' };

// 計画9.3の独立positive項目。手順有用性はstatement_statusと別fieldで保持する。
export const CANDIDATE_RELEVANCE_KINDS = [
  'target_match',
  'similar_symptom_or_request',
  'similar_constraints',
  'implementation_rationale',
  'reusable_procedure',
] as const;
export type CandidateRelevanceKind = (typeof CANDIDATE_RELEVANCE_KINDS)[number];

export const CANDIDATE_STATEMENT_STATUSES = ['proposal', 'reported_completed', 'reported_verified', 'unknown'] as const;
export type CandidateStatementStatus = (typeof CANDIDATE_STATEMENT_STATUSES)[number];
