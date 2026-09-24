import {
  JEV_PART_SEPARATOR,
  JEV_RELATION_EXPLICIT_QUESTION_ID,
  JEV_SAME_CONDITIONS_QUESTION_ID,
  RELATION_ACTIONS,
  RETENTIONS,
  jevQuestionId,
  jevTechnicalLabelQuestionId,
  TECHNICAL_LABELS,
  type JevAnswer,
  type JevStatePart,
  type RelationAction,
  type Retention,
} from './contract.js';

export interface PartEvaluation {
  part: JevStatePart;
  answers: Record<string, JevAnswer>;
  candidates: Array<{ messageId: string; revision: number }>;
  responseModel: string;
}

export interface StoredPartResult {
  offset: number;
  length: number;
  retention: string;
  primary_intent: string;
  technical_labels: string[];
  decision_action: string;
  continuity: string;
  statement_status: string;
  search_action: string;
  model_version: string;
}

export interface RelationLink {
  targetMessageId: string;
  targetRevision: number;
  relation: RelationAction;
  isExplicit: boolean;
  evidenceRanges: Array<{ offset: number; length: number }>;
}

export interface AggregatedEvaluation {
  retention: Retention;
  primaryIntent: string;
  technicalLabels: string[];
  decisionAction: string;
  continuity: string;
  statementStatus: string;
  searchAction: string;
  isSearchable: boolean;
  sameConditions: boolean;
  modelVersion: string;
  parts: StoredPartResult[];
  relations: RelationLink[];
}

// 高信頼の回答だけを採用する。閾値未満はunknownとして扱い、原文を保持する。
function highChoice(part: PartEvaluation, questionId: string, threshold: number): string | undefined {
  const answer = part.answers[questionId];
  if (!answer || answer.confidence < threshold) {
    return undefined;
  }
  return answer.choice;
}

function adoptedOrUnknown(parts: readonly PartEvaluation[], questionId: string, threshold: number): string {
  const values = parts.map((part) => highChoice(part, questionId, threshold) ?? 'unknown');
  const first = values[0];
  return first !== undefined && values.every((value) => value === first) ? first : 'unknown';
}

// retentionはsubstantive→decision_signal→unknown→progress_onlyの順で保守的に統合する。
function aggregateRetention(parts: readonly PartEvaluation[], threshold: number): Retention {
  const priority: Record<Retention, number> = { substantive: 0, decision_signal: 1, unknown: 2, progress_only: 3 };
  let selected: Retention | undefined;
  for (const part of parts) {
    const choice = highChoice(part, jevQuestionId('retention', 0), threshold);
    const value: Retention = choice !== undefined && (RETENTIONS as readonly string[]).includes(choice) ? (choice as Retention) : 'unknown';
    if (selected === undefined || priority[value] < priority[selected]) {
      selected = value;
    }
  }
  return selected ?? 'unknown';
}

function adoptedRelations(parts: readonly PartEvaluation[], threshold: number): RelationLink[] {
  const relations = new Map<string, RelationLink>();
  for (const part of parts) {
    const action = highChoice(part, jevQuestionId('decision_action', 0), threshold);
    if (action === undefined || !(RELATION_ACTIONS as readonly string[]).includes(action)) {
      continue;
    }
    const target = highChoice(part, jevQuestionId('relation_target', 0), threshold);
    const candidate = part.candidates.find((item) => item.messageId === target);
    if (target === undefined || candidate === undefined) {
      continue;
    }
    const explicitChoice = highChoice(part, `${JEV_RELATION_EXPLICIT_QUESTION_ID}${JEV_PART_SEPARATOR}0`, threshold);
    if (explicitChoice === undefined) {
      continue;
    }
    const key = `${candidate.messageId}:${candidate.revision}:${action}`;
    if (relations.has(key)) {
      continue;
    }
    relations.set(key, {
      targetMessageId: candidate.messageId,
      targetRevision: candidate.revision,
      relation: action as RelationAction,
      isExplicit: explicitChoice === 'explicit',
      evidenceRanges: [{ offset: part.part.offset, length: part.part.length }],
    });
  }
  return [...relations.values()];
}

// 全partの応答modelが同一ならその値、混在は重複除去した出現順の配列をJSON文字列にする。
function aggregateModelVersion(parts: readonly PartEvaluation[]): string {
  const models = [...new Set(parts.map((part) => part.responseModel))];
  const first = models[0];
  if (first === undefined) {
    return '';
  }
  return models.length === 1 ? first : JSON.stringify(models);
}

// partごとの高信頼回答を設計の優先順位で統合し、analysis/relation/search_actionを決める。
export function aggregateEvaluations(parts: readonly PartEvaluation[], threshold: number): AggregatedEvaluation {
  const retention = aggregateRetention(parts, threshold);
  const primaryIntent = adoptedOrUnknown(parts, jevQuestionId('primary_intent', 0), threshold);
  const decisionAction = adoptedOrUnknown(parts, jevQuestionId('decision_action', 0), threshold);
  const continuity = adoptedOrUnknown(parts, jevQuestionId('continuity', 0), threshold);
  const statementStatus = adoptedOrUnknown(parts, jevQuestionId('statement_status', 0), threshold);
  const searchValues = parts.map((part) => highChoice(part, jevQuestionId('search_action', 0), threshold) ?? 'unknown');
  const searchAction = searchValues.every((value) => value === searchValues[0]) ? searchValues[0] ?? 'unknown' : 'unknown';
  const sameConditions =
    parts.length > 0 &&
    parts.every(
      (part) => highChoice(part, `${JEV_SAME_CONDITIONS_QUESTION_ID}${JEV_PART_SEPARATOR}0`, threshold) === 'yes',
    );
  const technicalLabels = new Set<string>();
  for (const part of parts) {
    for (const label of TECHNICAL_LABELS) {
      if (highChoice(part, jevTechnicalLabelQuestionId(label, 0), threshold) === 'yes') {
        technicalLabels.add(label);
      }
    }
  }
  return {
    retention,
    primaryIntent,
    technicalLabels: [...technicalLabels],
    decisionAction,
    continuity,
    statementStatus,
    searchAction: searchAction === 'reuse' || searchAction === 'skip' ? searchAction : 'new_search',
    isSearchable: retention !== 'progress_only',
    sameConditions,
    modelVersion: aggregateModelVersion(parts),
    parts: parts.map((part) => ({
      offset: part.part.offset,
      length: part.part.length,
      retention: aggregateRetention([part], threshold),
      primary_intent: adoptedOrUnknown([part], jevQuestionId('primary_intent', 0), threshold),
      technical_labels: TECHNICAL_LABELS.filter(
        (label) => highChoice(part, jevTechnicalLabelQuestionId(label, 0), threshold) === 'yes',
      ),
      decision_action: adoptedOrUnknown([part], jevQuestionId('decision_action', 0), threshold),
      continuity: adoptedOrUnknown([part], jevQuestionId('continuity', 0), threshold),
      statement_status: adoptedOrUnknown([part], jevQuestionId('statement_status', 0), threshold),
      search_action: highChoice(part, jevQuestionId('search_action', 0), threshold) ?? 'unknown',
      model_version: part.responseModel,
    })),
    relations: adoptedRelations(parts, threshold),
  };
}
