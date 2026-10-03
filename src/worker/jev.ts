import { z } from 'zod';
import {
  CONTINUITIES,
  DECISION_ACTIONS,
  JEV_SAME_CONDITIONS_QUESTION_ID,
  RETENTIONS,
  SAME_CONDITION_VALUES,
  SEARCH_ACTIONS,
  STATEMENT_STATUSES,
  STRATEGY_AXES,
  STRATEGY_AXIS_NAMES,
  jevQuestionId,
  jevRelationExplicitQuestionId,
  jevStrategyQuestionId,
  type JevAnswer,
  type JevChoiceQuestion,
  type JevRequest,
  type JevState,
  type JevStatePart,
  type JevUsage,
} from './contract.js';
import type { WorkerConfig } from './config.js';

// Jev呼出しの失敗カテゴリ。retryableだけをpendingへ戻し、契約不正等はfailedで保持する。
export class JevCallError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    // 応答検証のどの条件で落ちたかを示す固定識別子。原文や応答値は入れない。
    readonly detail?: string,
  ) {
    super(code);
  }
}

interface CriteriaMap {
  [choice: string]: string;
}

function criteriaFrom<T extends string>(values: readonly T[], descriptions: Record<T, string>): CriteriaMap {
  return Object.fromEntries(values.map((value) => [value, descriptions[value]])) as CriteriaMap;
}

const RETENTION_CRITERIA = criteriaFrom(RETENTIONS, {
  substantive: '再利用価値のある実質的な内容',
  decision_signal: '提案・承認・却下・撤回・変更',
  progress_only: '進行・相槌のみ',
  unknown: '判断不能',
});

const DECISION_ACTION_CRITERIA = criteriaFrom(DECISION_ACTIONS, {
  propose: '提案',
  accept: '承認',
  reject: '却下',
  revoke: '撤回',
  change: '変更',
  none: '該当なし',
  unknown: '判断不能',
});

const CONTINUITY_CRITERIA = criteriaFrom(CONTINUITIES, {
  same_topic: '直前と同じ話題',
  new_topic: '新しい話題',
  multiple_topics: '複数の話題',
  unknown: '判断不能',
});

const STATEMENT_STATUS_CRITERIA = criteriaFrom(STATEMENT_STATUSES, {
  request: '依頼',
  proposal: '提案',
  approval: '承認・了承',
  reported_completed: '完了報告',
  reported_verified: '検証済み報告',
  unknown: '判断不能',
});

const SEARCH_ACTION_CRITERIA = criteriaFrom(SEARCH_ACTIONS, {
  new_search: '新しい条件の検索が必要',
  reuse: '同じ条件の直近検索を再利用できる',
  skip: '検索を必要としない',
});

const SAME_CONDITION_CRITERIA = criteriaFrom(SAME_CONDITION_VALUES, {
  yes: '対象・制約が同一',
  no: '対象・制約が変化',
  unknown: '判断不能',
});


// partごとの質問を、fieldの意味と判定基準がinstructionから分かるように組み立てる。
// includeSearchActionは自動検索の振り分けがあるuser発言だけtrueにし、振り分けの無い発言へ検索用の質問を送らない。
export function buildQuestions(
  part: JevStatePart,
  candidateIds: readonly string[],
  includeSameConditions: boolean,
  includeSearchAction: boolean,
): Record<string, JevChoiceQuestion> {
  const partLabel = `現在発言の原文範囲(offset ${part.offset}, ${part.length}文字)`;
  const questions: Record<string, JevChoiceQuestion> = {};
  questions[jevQuestionId('retention', 0)] = {
    type: 'choice',
    instructions: `${partLabel}の保存価値retentionを選ぶ。`,
    criteria: RETENTION_CRITERIA,
  };
  questions[jevQuestionId('decision_action', 0)] = {
    type: 'choice',
    instructions: `${partLabel}が提案・承認・却下・撤回・変更のどれかに当たるかdecision_actionを選ぶ。`,
    criteria: DECISION_ACTION_CRITERIA,
  };
  questions[jevQuestionId('continuity', 0)] = {
    type: 'choice',
    instructions: `${partLabel}が直前の話題を継続しているかcontinuityを選ぶ。`,
    criteria: CONTINUITY_CRITERIA,
  };
  questions[jevQuestionId('statement_status', 0)] = {
    type: 'choice',
    instructions: `${partLabel}の発言状態statement_statusを選ぶ。`,
    criteria: STATEMENT_STATUS_CRITERIA,
  };
  if (includeSearchAction) {
    questions[jevQuestionId('search_action', 0)] = {
      type: 'choice',
      instructions: `${partLabel}で過去履歴の検索を開始・再利用・省略のどれにすべきかsearch_actionを選ぶ。`,
      criteria: SEARCH_ACTION_CRITERIA,
    };
  }
  const relationCriteria: CriteriaMap = {};
  for (const candidateId of candidateIds) {
    relationCriteria[candidateId] = 'stateの直前発言候補';
  }
  relationCriteria.none = '対象なし';
  relationCriteria.unknown = '対象不明';
  questions[jevQuestionId('relation_target', 0)] = {
    type: 'choice',
    instructions: `${partLabel}が対象とする直前発言をrelation_targetから選ぶ。候補がなければnone、判断できなければunknown。`,
    criteria: relationCriteria,
  };
  // 対象名・用語ではなく、設計上の問題構造と採用手段を軸ごとに1つ選ぶ。原文にない方針は推定せずnoneにする。
  for (const axis of STRATEGY_AXIS_NAMES) {
    questions[jevStrategyQuestionId(axis, 0)] = {
      type: 'choice',
      instructions: `${partLabel}の${STRATEGY_AXES[axis].instruction}。対象名に依存しない`,
      criteria: { ...STRATEGY_AXES[axis].criteria },
    };
  }
  if (includeSameConditions) {
    questions[`${JEV_SAME_CONDITIONS_QUESTION_ID}#0`] = {
      type: 'choice',
      instructions: `stateのprior_search元入力と${partLabel}で、検索の対象・制約が同一かsame_conditionsを選ぶ。`,
      criteria: SAME_CONDITION_CRITERIA,
    };
  }
  for (const candidateId of candidateIds) {
    questions[jevRelationExplicitQuestionId(candidateId, 0)] = {
      type: 'choice',
      instructions: `${partLabel}とstateの直前発言候補 ${candidateId} の関係が、原文に明示されているか文脈からの推定かをrelation_explicitで選ぶ。`,
      criteria: { explicit: '原文に明示', inferred: '文脈からの推定' },
    };
  }
  return questions;
}

export function buildRequest(model: string, state: JevState, questions: Record<string, JevChoiceQuestion>): JevRequest {
  return { model, state, questions };
}

// fetchへ渡すbodyはここで一度だけ直列化し、予算判定と実送信で同じ文字列を使う。
export function serializeRequest(request: JevRequest): string {
  return JSON.stringify(request);
}

const rawAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});

const rawResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), rawAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(),
  }),
});

// 応答本文から実応答modelだけを取り出す。検証結果とは独立にusageへ記録する。推測補完はしない。
export function extractJevResponseModel(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const model = (raw as { model?: unknown }).model;
  return typeof model === 'string' && model.length > 0 ? model : null;
}

// 応答本文のusageだけを取り出す。不完全・不正はnullにする。
export function extractJevUsage(raw: unknown): JevUsage {
  if (typeof raw !== 'object' || raw === null) {
    return { input_tokens: null, output_tokens: null };
  }
  const usage = (raw as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) {
    return { input_tokens: null, output_tokens: null };
  }
  const input = (usage as { input_tokens?: unknown }).input_tokens;
  const output = (usage as { output_tokens?: unknown }).output_tokens;
  return {
    input_tokens: typeof input === 'number' && Number.isInteger(input) && input >= 0 ? input : null,
    output_tokens: typeof output === 'number' && Number.isInteger(output) && output >= 0 ? output : null,
  };
}

// Jevは各選択肢の確率を小数2桁へ丸めて返す。
const PROBABILITY_ROUNDING_STEP = 0.01;
// 0.99と1の差が0.01をわずかに超えるような、浮動小数点の誤差で境界の値を弾かないための余裕。
const FLOAT_COMPARISON_MARGIN = 1e-9;

export interface ValidatedJevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
}

// 応答の型・全質問の存在・選択肢・分布key・有限値・範囲・合計・confidenceを検証する。
export function validateJevResponse(raw: unknown, questions: Record<string, JevChoiceQuestion>): ValidatedJevResponse {
  const parsed = rawResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new JevCallError('provider_contract_invalid', false, undefined, 'response_shape');
  }
  const response = parsed.data;
  const questionIds = Object.keys(questions);
  const answerIds = Object.keys(response.answers);
  if (questionIds.length !== answerIds.length || questionIds.some((id) => response.answers[id] === undefined)) {
    throw new JevCallError('provider_contract_invalid', false, undefined, 'answer_ids');
  }
  const answers: Record<string, JevAnswer> = {};
  for (const id of questionIds) {
    const question = questions[id];
    const answer = response.answers[id];
    const criteriaKeys = Object.keys(question.criteria);
    if (!criteriaKeys.includes(answer.choice)) {
      throw new JevCallError('provider_contract_invalid', false, undefined, 'answer_choice');
    }
    const probabilityKeys = Object.keys(answer.probabilities);
    if (probabilityKeys.length !== criteriaKeys.length || criteriaKeys.some((key) => answer.probabilities[key] === undefined)) {
      throw new JevCallError('provider_contract_invalid', false, undefined, 'probability_keys');
    }
    let sum = 0;
    for (const key of criteriaKeys) {
      const probability = answer.probabilities[key];
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new JevCallError('provider_contract_invalid', false, undefined, 'probability_range');
      }
      sum += probability;
    }
    // 丸めた値の合計は、選択肢1つにつき最大で丸め幅の半分ずつ1からずれる。それを超えるずれだけを契約不正にする。
    const sumTolerance = (criteriaKeys.length * PROBABILITY_ROUNDING_STEP) / 2 + FLOAT_COMPARISON_MARGIN;
    if (Math.abs(sum - 1) > sumTolerance) {
      throw new JevCallError('provider_contract_invalid', false, undefined, 'probability_sum');
    }
    if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
      throw new JevCallError('provider_contract_invalid', false, undefined, 'confidence_range');
    }
    answers[id] = {
      type: 'choice',
      choice: answer.choice,
      probabilities: answer.probabilities,
      confidence: answer.confidence,
    };
  }
  return { model: response.model, answers, usage: response.usage };
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.min(seconds * 1_000, 60 * 60 * 1_000);
}

export interface JevCallResult {
  json: unknown;
  durationMs: number;
}

// Jevへ1回POSTする。3xxは追従せず拒否し、資格情報・本文を承認外endpointへ送らない。
export async function callJev(config: WorkerConfig, bodyText: string): Promise<JevCallResult> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: bodyText,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new JevCallError(timedOut ? 'provider_timeout' : 'provider_unavailable', true);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new JevCallError('provider_redirect_rejected', false);
  }
  if (!response.ok) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429 || response.status === 529) {
      throw new JevCallError('provider_rate_limited', true, retryAfterMs);
    }
    if (response.status >= 500) {
      throw new JevCallError('provider_unavailable', true, retryAfterMs);
    }
    throw new JevCallError('provider_rejected', false);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new JevCallError('provider_contract_invalid', false, undefined, 'response_not_json');
  }
  // 所要時間は本文の受信・parseまで含める。Voyageと同じ範囲にし、出力量による待ちも計測へ入れる。
  return { json, durationMs: Date.now() - started };
}
