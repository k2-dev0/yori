import type { Tokenizer } from '@huggingface/tokenizers';
import type { Pool, PoolClient } from 'pg';
import type { EventRole } from '../api/contract.js';
import { hasActiveProviderApproval } from './approvals.js';
import type { WorkerConfig } from './config.js';
import {
  CANDIDATE_RELEVANCE_CRITERIA,
  JEV_PROVIDER,
  WORKER_POLICY_VERSION,
  type JevChoiceQuestion,
  type JevRequest,
  type JevState,
} from './contract.js';
import type { JobTarget } from './context.js';
import { PolicyBlockedError } from './errors.js';
import {
  JevCallError,
  buildRequest,
  callJev,
  extractJevResponseModel,
  extractJevUsage,
  serializeRequest,
  validateJevResponse,
} from './jev.js';
import { recordJevUsage } from './usage.js';

// M7の周辺・継続探索。代表候補のsource messageをprimary evidenceとして、同一sessionの前後、
// 後続の訂正・撤回、activeな明示session link、限定的な推定候補を集める。
// 外部Jev待ちの間はDB transaction/row lockを持たず、保存TXで再検証する前提の下書きだけを返す。

const SESSION_LIMIT = 10;
const HOP_LIMIT = 3;
const NEIGHBOR_RADIUS = 2;
const CONTEXT_WINDOW = 5;
const TOKEN_BUDGET = 6_000;
// 明示Issue／PR entity。file/functionは継続候補の根拠に使わない。
const CONTINUITY_ENTITY_TYPES = ['issue', 'pull_request'];
const POSITIVE_CHOICES = new Set(['useful', 'direct']);

export interface SearchWarning {
  code: string;
  [key: string]: unknown;
}

export type RelatedSourceKind = 'neighbor' | 'correction' | 'explicit_session_link' | 'inferred_session_link';

export interface RelatedEvidenceDraft {
  messageId: string;
  revision: number;
  sessionId: string;
  employeeId: string;
  role: string;
  occurredAt: Date;
  text: string;
  sourceKind: RelatedSourceKind;
  relation?: string;
  relatedToMessageId?: string;
  relatedToRevision?: number;
  linkId?: string;
  relationSourceRevision?: number;
}

export interface ExplorationResult {
  primaryKey: string;
  related: RelatedEvidenceDraft[];
  warnings: SearchWarning[];
  truncated: boolean;
}

export interface PrimarySource {
  message_id: string;
  message_revision: number;
  sequence_no: number;
  session_id: string;
  employee_id: string;
  role: string;
  occurred_at: Date;
  text: string;
}

export interface ExplorationInput {
  pool: Pool;
  target: JobTarget;
  config: WorkerConfig;
  tokenizer: Tokenizer;
  generationId: string;
  primaryKey: string;
  primaryDocumentId: string;
  primaryDocumentRevision: number;
  primaryEvidence: readonly PrimarySource[];
  question: string;
  jobKind: string;
}

interface MessageRow {
  message_id: string;
  revision: number;
  sequence_no: number;
  session_id: string;
  employee_id: string;
  role: string;
  occurred_at: Date;
  text: string;
}

interface LinkRow {
  id: string;
  from_session_id: string;
  to_session_id: string;
  evidence_message_id: string;
  evidence_revision: number;
}

interface CorrectionRow {
  source_message_id: string;
  source_revision: number;
  relation: string;
  message_id: string;
  revision: number;
  sequence_no: number;
  session_id: string;
  employee_id: string;
  role: string;
  occurred_at: Date;
  text: string;
}

const MESSAGE_COLUMNS = `
  m.id AS message_id, m.current_revision AS revision, m.sequence_no, m.session_id,
  s.employee_id, m.role, m.occurred_at, r.text`;

const MESSAGE_JOINS = `
  FROM messages m
  JOIN sessions s ON s.id = m.session_id
  JOIN projects p ON p.id = s.project_id
  JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision`;

function draftOf(row: MessageRow, sourceKind: RelatedSourceKind, extra: Partial<RelatedEvidenceDraft> = {}): RelatedEvidenceDraft {
  return {
    messageId: row.message_id,
    revision: row.revision,
    sessionId: row.session_id,
    employeeId: row.employee_id,
    role: row.role,
    occurredAt: row.occurred_at,
    text: row.text,
    sourceKind,
    ...extra,
  };
}

// primary evidenceと同じsessionのsequence前後2発言。現在input以降と別案件は返さない。
async function loadNeighbors(input: ExplorationInput): Promise<RelatedEvidenceDraft[]> {
  const drafts: RelatedEvidenceDraft[] = [];
  for (const primary of input.primaryEvidence) {
    const rows = await input.pool.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       ${MESSAGE_JOINS}
      WHERE m.session_id = $1
        AND m.sequence_no BETWEEN $2 AND $3
        AND m.id <> $4
        AND (m.session_id <> $8 OR m.sequence_no < $5)
        AND s.project_id = $6 AND p.company_id = $7
      ORDER BY m.sequence_no`,
      [
        primary.session_id,
        primary.sequence_no - NEIGHBOR_RADIUS,
        primary.sequence_no + NEIGHBOR_RADIUS,
        primary.message_id,
        input.target.sequenceNo,
        input.target.projectId,
        input.target.companyId,
        input.target.sessionId,
      ],
    );
    for (const row of rows.rows) {
      drafts.push(draftOf(row, 'neighbor'));
    }
  }
  return drafts;
}

// message_relationsは source=後続の訂正・撤回、target=元根拠。target->source方向へ最大3 hop辿る。
async function loadCorrections(input: ExplorationInput): Promise<RelatedEvidenceDraft[]> {
  const drafts: RelatedEvidenceDraft[] = [];
  const visited = new Set(input.primaryEvidence.map((source) => `${source.message_id}:${source.message_revision}`));
  let frontier = input.primaryEvidence.map((source) => ({ messageId: source.message_id, revision: source.message_revision }));
  for (let hop = 1; hop <= HOP_LIMIT && frontier.length > 0; hop += 1) {
    const next: Array<{ messageId: string; revision: number }> = [];
    for (const parent of frontier) {
      const rows = await input.pool.query<CorrectionRow>(
        `SELECT r.source_message_id, r.source_revision, r.relation,
                m.id AS message_id, m.current_revision AS revision, m.sequence_no, m.session_id,
                s.employee_id, m.role, m.occurred_at, rev.text
           FROM message_relations r
           JOIN messages m ON m.id = r.source_message_id
           JOIN sessions s ON s.id = m.session_id
           JOIN projects p ON p.id = s.project_id
           JOIN message_revisions rev ON rev.message_id = r.source_message_id AND rev.revision = r.source_revision
          WHERE r.target_message_id = $1 AND r.target_revision = $2
            AND r.relation IN ('change', 'revoke')
            AND m.current_revision = r.source_revision
            AND s.project_id = $3 AND p.company_id = $4
            AND (m.session_id <> $5 OR m.sequence_no < $6)
          ORDER BY r.created_at, r.id`,
        [
          parent.messageId,
          parent.revision,
          input.target.projectId,
          input.target.companyId,
          input.target.sessionId,
          input.target.sequenceNo,
        ],
      );
      for (const row of rows.rows) {
        const key = `${row.source_message_id}:${row.source_revision}`;
        if (visited.has(key)) {
          continue;
        }
        visited.add(key);
        drafts.push(
          draftOf(row, 'correction', {
            relation: row.relation,
            relatedToMessageId: parent.messageId,
            relatedToRevision: parent.revision,
            relationSourceRevision: row.source_revision,
          }),
        );
        next.push({ messageId: row.source_message_id, revision: row.source_revision });
      }
    }
    frontier = next;
  }
  return drafts;
}

async function loadSessionScope(
  input: ExplorationInput,
  sessionId: string,
): Promise<{ employeeId: string } | null> {
  const result = await input.pool.query<{ employee_id: string }>(
    `SELECT s.employee_id
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
      WHERE s.id = $1 AND s.project_id = $2 AND p.company_id = $3`,
    [sessionId, input.target.projectId, input.target.companyId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { employeeId: row.employee_id };
}

// link先に根拠messageが属すればその前後2発言、属しなければ順方向は先頭5・逆方向は末尾5発言。
async function loadLinkContext(input: ExplorationInput, link: LinkRow, currentSessionId: string, discoveredSessionId: string): Promise<RelatedEvidenceDraft[]> {
  // endpoint所属と、保存したevidence_revision == current revisionを確認する。
  // 改訂済み・endpoint外のlinkはstaleとして辿らない（先頭/末尾windowも作らない）。
  const evidence = await input.pool.query<{ session_id: string; current_revision: number }>(
    'SELECT session_id, current_revision FROM messages WHERE id = $1',
    [link.evidence_message_id],
  );
  const evidenceRow = evidence.rows[0];
  if (
    evidenceRow === undefined ||
    evidenceRow.current_revision !== link.evidence_revision ||
    (evidenceRow.session_id !== link.from_session_id && evidenceRow.session_id !== link.to_session_id)
  ) {
    return [];
  }
  let rows: MessageRow[];
  if (evidenceRow.session_id === discoveredSessionId) {
    const around = await input.pool.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       ${MESSAGE_JOINS}
       JOIN messages e ON e.id = $1 AND e.session_id = $2
      WHERE m.session_id = $2
        AND m.sequence_no BETWEEN e.sequence_no - $3 AND e.sequence_no + $3
        AND (m.session_id <> $6 OR m.sequence_no < $7)
        AND s.project_id = $4 AND p.company_id = $5
      ORDER BY m.sequence_no`,
      [
        link.evidence_message_id,
        discoveredSessionId,
        NEIGHBOR_RADIUS,
        input.target.projectId,
        input.target.companyId,
        input.target.sessionId,
        input.target.sequenceNo,
      ],
    );
    rows = around.rows;
  } else if (link.from_session_id === currentSessionId) {
    const first = await input.pool.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       ${MESSAGE_JOINS}
      WHERE m.session_id = $1 AND s.project_id = $2 AND p.company_id = $3
        AND (m.session_id <> $4 OR m.sequence_no < $5)
      ORDER BY m.sequence_no
      LIMIT ${CONTEXT_WINDOW}`,
      [discoveredSessionId, input.target.projectId, input.target.companyId, input.target.sessionId, input.target.sequenceNo],
    );
    rows = first.rows;
  } else {
    const last = await input.pool.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       ${MESSAGE_JOINS}
      WHERE m.session_id = $1 AND s.project_id = $2 AND p.company_id = $3
        AND (m.session_id <> $4 OR m.sequence_no < $5)
      ORDER BY m.sequence_no DESC
      LIMIT ${CONTEXT_WINDOW}`,
      [discoveredSessionId, input.target.projectId, input.target.companyId, input.target.sessionId, input.target.sequenceNo],
    );
    rows = [...last.rows].reverse();
  }
  return rows.map((row) => draftOf(row, 'explicit_session_link', { linkId: link.id }));
}

// primary evidenceのsession情報。推定隣接のemployee/project/started_atの基準にする。
interface PrimarySessionInfo {
  sessionId: string;
  employeeId: string;
  startedAt: Date;
}

async function loadPrimarySessions(input: ExplorationInput, sessionIds: readonly string[]): Promise<PrimarySessionInfo[]> {
  if (sessionIds.length === 0) {
    return [];
  }
  const result = await input.pool.query<{ id: string; employee_id: string; started_at: Date }>(
    `SELECT s.id, s.employee_id, s.started_at
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
      WHERE s.id = ANY($1::uuid[]) AND s.project_id = $2 AND p.company_id = $3`,
    [sessionIds, input.target.projectId, input.target.companyId],
  );
  return result.rows.map((row) => ({ sessionId: row.id, employeeId: row.employee_id, startedAt: row.started_at }));
}

// 各primary sessionの同社員・同案件の前後各3sessionと、代表文書と共通Issue/PR entityを持つsession。
// 既出sessionと明示link（active/revoked）でつながるsessionは推定候補として再浮上させない。
async function loadInferredSessions(
  input: ExplorationInput,
  primaries: readonly PrimarySessionInfo[],
  excludedSessions: ReadonlySet<string>,
): Promise<string[]> {
  const excluded = [...excludedSessions];
  const ids: string[] = [];
  const linkGuard = `
        AND NOT EXISTS (
          SELECT 1 FROM session_links l
           WHERE l.company_id = $2 AND l.project_id = $1
             AND (l.from_session_id = ANY($7::uuid[]) OR l.to_session_id = ANY($7::uuid[]))
             AND (l.from_session_id = s.id OR l.to_session_id = s.id)
        )`;
  for (const primary of primaries) {
    const adjacencyParams = [
      input.target.projectId,
      input.target.companyId,
      primary.employeeId,
      input.target.sessionId,
      primary.startedAt,
      excluded,
      excluded,
    ];
    const before = await input.pool.query<{ id: string }>(
      `SELECT s.id FROM sessions s
         JOIN projects p ON p.id = s.project_id
        WHERE s.project_id = $1 AND p.company_id = $2 AND s.employee_id = $3
          AND s.id <> $4 AND s.started_at <= $5 AND s.id <> ALL($6::uuid[])
          ${linkGuard}
        ORDER BY s.started_at DESC, s.id DESC
        LIMIT 3`,
      adjacencyParams,
    );
    const after = await input.pool.query<{ id: string }>(
      `SELECT s.id FROM sessions s
         JOIN projects p ON p.id = s.project_id
        WHERE s.project_id = $1 AND p.company_id = $2 AND s.employee_id = $3
          AND s.id <> $4 AND s.started_at >= $5 AND s.id <> ALL($6::uuid[])
          ${linkGuard}
        ORDER BY s.started_at ASC, s.id ASC
        LIMIT 3`,
      adjacencyParams,
    );
    ids.push(...before.rows.map((row) => row.id), ...after.rows.map((row) => row.id));
  }
  // 代表文書と同じIssue/PR entityを持つsessionは、他社員でも継続候補にする。
  const entity = await input.pool.query<{ session_id: string }>(
    `SELECT DISTINCT d.session_id
       FROM document_entities e
       JOIN search_documents d ON d.id = e.document_id
       JOIN search_document_revisions r ON r.document_id = e.document_id AND r.revision = e.revision AND r.status = 'ready'
       JOIN document_publications pub ON pub.document_id = e.document_id AND pub.generation_id = $8 AND pub.revision = e.revision
      WHERE e.company_id = $1 AND e.project_id = $2 AND d.company_id = $1 AND d.project_id = $2 AND d.is_searchable
        AND d.session_id <> $3 AND d.session_id <> ALL($4::uuid[])
        AND e.entity_type = ANY($5::text[])
        AND (e.entity_type, e.entity_key) IN (
          SELECT pe.entity_type, pe.entity_key
            FROM document_entities pe
           WHERE pe.document_id = $6 AND pe.revision = $7 AND pe.entity_type = ANY($5::text[])
        )
        AND NOT EXISTS (
          SELECT 1 FROM session_links l
           WHERE l.company_id = $1 AND l.project_id = $2
             AND (l.from_session_id = ANY($4::uuid[]) OR l.to_session_id = ANY($4::uuid[]))
             AND (l.from_session_id = d.session_id OR l.to_session_id = d.session_id)
        )`,
    [
      input.target.companyId,
      input.target.projectId,
      input.target.sessionId,
      excluded,
      CONTINUITY_ENTITY_TYPES,
      input.primaryDocumentId,
      input.primaryDocumentRevision,
      input.generationId,
    ],
  );
  ids.push(...entity.rows.map((row) => row.session_id));
  return [...new Set(ids)];
}

async function loadInferredContext(input: ExplorationInput, sessionId: string): Promise<MessageRow[]> {
  const result = await input.pool.query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS}
     ${MESSAGE_JOINS}
    WHERE m.session_id = $1 AND s.project_id = $2 AND p.company_id = $3
    ORDER BY m.sequence_no
    LIMIT ${CONTEXT_WINDOW}`,
    [sessionId, input.target.projectId, input.target.companyId],
  );
  return result.rows;
}

// 推定候補のJev判定。現在質問への関連性と継続元との連続性を独立Choiceで聞き、両方positiveだけ採用する。
async function evaluateInferredSession(
  input: ExplorationInput,
  sessionId: string,
  context: readonly MessageRow[],
): Promise<'adopted' | 'rejected' | 'failed'> {
  const approved = await hasActiveProviderApproval(input.pool, {
    companyId: input.target.companyId,
    provider: JEV_PROVIDER,
    accountRef: input.config.accountRef,
    endpoint: input.config.apiUrl,
  });
  if (!approved) {
    throw new PolicyBlockedError('Jevの送信承認がありません');
  }
  const continuation = input.primaryEvidence.slice(0, 6).map((source) => ({
    message_id: source.message_id,
    revision: source.message_revision,
    role: source.role as EventRole,
    occurred_at: source.occurred_at.toISOString(),
    text: source.text,
  }));
  const state: JevState = {
    policy_version: WORKER_POLICY_VERSION,
    current: {
      message_id: input.target.messageId,
      revision: input.target.targetRevision,
      role: input.target.role,
      occurred_at: input.target.occurredAt,
      parts: [{ offset: 0, length: input.question.length, text: input.question }],
    },
    prior_messages: continuation,
    prior_search: null,
    truncation: { omitted_prior_messages: 0, split_current: false, prior_search_omitted: false },
  };
  const candidateContext = context.map((row) => row.text).join('\n');
  const relevanceId = `m7_context_relevance:${sessionId}#0`;
  const continuityId = `m7_context_continuity:${sessionId}#0`;
  const contextLabel = `継続候補session ${sessionId} の文脈:\n${candidateContext}`;
  const questions: Record<string, JevChoiceQuestion> = {
    [relevanceId]: {
      type: 'choice',
      instructions: `${contextLabel}\nこの候補文脈が現在の質問の参考になるかrelevanceを選ぶ。`,
      criteria: { ...CANDIDATE_RELEVANCE_CRITERIA },
    },
    [continuityId]: {
      type: 'choice',
      instructions: `${contextLabel}\nこの候補文脈が代表根拠の作業と連続しているかcontinuityを選ぶ。`,
      criteria: { ...CANDIDATE_RELEVANCE_CRITERIA },
    },
  };
  const request: JevRequest = buildRequest(input.config.model, state, questions);
  const bodyText = serializeRequest(request);
  const started = Date.now();
  let json: unknown;
  let durationMs: number;
  try {
    const called = await callJev(input.config, bodyText);
    json = called.json;
    durationMs = called.durationMs;
  } catch (error) {
    const jevError = error instanceof JevCallError ? error : new JevCallError('provider_unavailable', true);
    await recordJevUsage(
      input.pool,
      { companyId: input.target.companyId, config: input.config, jobKind: input.jobKind },
      false,
      Date.now() - started,
      jevError.code,
      { input_tokens: null, output_tokens: null },
      null,
    );
    return 'failed';
  }
  let validated;
  try {
    validated = validateJevResponse(json, questions);
  } catch (error) {
    const code = error instanceof JevCallError ? error.code : 'provider_contract_invalid';
    await recordJevUsage(
      input.pool,
      { companyId: input.target.companyId, config: input.config, jobKind: input.jobKind },
      false,
      durationMs,
      code,
      extractJevUsage(json),
      extractJevResponseModel(json),
    );
    return 'failed';
  }
  await recordJevUsage(
    input.pool,
    { companyId: input.target.companyId, config: input.config, jobKind: input.jobKind },
    true,
    durationMs,
    null,
    validated.usage,
    validated.model,
  );
  const useful = POSITIVE_CHOICES.has(validated.answers[relevanceId]?.choice);
  const continuous = POSITIVE_CHOICES.has(validated.answers[continuityId]?.choice);
  return useful && continuous ? 'adopted' : 'rejected';
}

export async function exploreSearchContext(input: ExplorationInput): Promise<ExplorationResult> {
  const warnings: SearchWarning[] = [];
  let truncated = false;
  const related: RelatedEvidenceDraft[] = [];
  // primary evidenceのmessageはmatches.evidence側にあり、related_evidenceへ重複追加しない。
  const seenMessages = new Set(input.primaryEvidence.map((source) => source.message_id));
  const relatedSessions = new Set<string>();
  const add = (draft: RelatedEvidenceDraft): void => {
    if (seenMessages.has(draft.messageId)) {
      return;
    }
    seenMessages.add(draft.messageId);
    relatedSessions.add(draft.sessionId);
    related.push(draft);
  };

  for (const draft of await loadNeighbors(input)) {
    add(draft);
  }
  for (const draft of await loadCorrections(input)) {
    add(draft);
  }

  // 探索起点はprimary evidenceの一意なsession群。訪問済みsession上限にもこの群を含める。
  const originSessionIds = [...new Set(input.primaryEvidence.map((source) => source.session_id))];
  const visitedSessions = new Set([...originSessionIds, ...relatedSessions]);
  let sessionLimitReached = false;
  let frontier: Array<{ sessionId: string; hop: number }> = originSessionIds.map((sessionId) => ({ sessionId, hop: 0 }));
  while (frontier.length > 0 && !sessionLimitReached) {
    const next: Array<{ sessionId: string; hop: number }> = [];
    for (const current of frontier) {
      if (current.hop >= HOP_LIMIT) {
        // 3 hopで打ち切った先に未訪問sessionがある場合は、探索が未完であることをwarningで示す。
        const beyond = await input.pool.query<LinkRow>(
          `SELECT l.id, l.from_session_id, l.to_session_id, l.evidence_message_id, l.evidence_revision
             FROM session_links l
             JOIN messages em ON em.id = l.evidence_message_id
             JOIN sessions es ON es.id = em.session_id
             JOIN projects ep ON ep.id = es.project_id
            WHERE l.status = 'active' AND l.company_id = $2 AND l.project_id = $3
              AND (l.from_session_id = $1 OR l.to_session_id = $1)
              AND (em.session_id = l.from_session_id OR em.session_id = l.to_session_id)
              AND em.current_revision = l.evidence_revision
              AND es.project_id = l.project_id AND ep.company_id = l.company_id
            ORDER BY l.created_at, l.id`,
          [current.sessionId, input.target.companyId, input.target.projectId],
        );
        const hasUnvisited = beyond.rows.some((link) => {
          const other = link.from_session_id === current.sessionId ? link.to_session_id : link.from_session_id;
          return !visitedSessions.has(other);
        });
        if (hasUnvisited) {
          truncated = true;
          warnings.push({ code: 'context_hop_limit_exceeded', hop_limit: HOP_LIMIT });
        }
        continue;
      }
      const links = await input.pool.query<LinkRow>(
        `SELECT l.id, l.from_session_id, l.to_session_id, l.evidence_message_id, l.evidence_revision
           FROM session_links l
           JOIN messages em ON em.id = l.evidence_message_id
           JOIN sessions es ON es.id = em.session_id
           JOIN projects ep ON ep.id = es.project_id
          WHERE l.status = 'active' AND l.company_id = $2 AND l.project_id = $3
            AND (l.from_session_id = $1 OR l.to_session_id = $1)
            AND (em.session_id = l.from_session_id OR em.session_id = l.to_session_id)
            AND em.current_revision = l.evidence_revision
            AND es.project_id = l.project_id AND ep.company_id = l.company_id
          ORDER BY l.created_at, l.id`,
        [current.sessionId, input.target.companyId, input.target.projectId],
      );
      for (const link of links.rows) {
        const other = link.from_session_id === current.sessionId ? link.to_session_id : link.from_session_id;
        if (visitedSessions.has(other)) {
          continue;
        }
        if (visitedSessions.size >= SESSION_LIMIT) {
          truncated = true;
          warnings.push({ code: 'context_session_limit_exceeded', session_limit: SESSION_LIMIT });
          sessionLimitReached = true;
          break;
        }
        if ((await loadSessionScope(input, other)) === null) {
          continue;
        }
        visitedSessions.add(other);
        next.push({ sessionId: other, hop: current.hop + 1 });
        for (const draft of await loadLinkContext(input, link, current.sessionId, other)) {
          add(draft);
        }
      }
      if (sessionLimitReached) {
        break;
      }
    }
    frontier = next;
  }

  let primaryOversized = false;
  const countedPrimaryMessages = new Set<string>();
  let primaryTokens = 0;
  for (const source of input.primaryEvidence) {
    if (countedPrimaryMessages.has(source.message_id)) {
      continue;
    }
    countedPrimaryMessages.add(source.message_id);
    primaryTokens += input.tokenizer.encode(source.text).ids.length;
  }
  if (primaryTokens > TOKEN_BUDGET) {
    primaryOversized = true;
    truncated = true;
  }

  if (!sessionLimitReached) {
    // 現在inputのsessionは推定候補にしない。他はvisited/related経由の既出sessionを除く。
    const excluded = new Set([...visitedSessions, ...relatedSessions, input.target.sessionId]);
    const primaries = await loadPrimarySessions(input, originSessionIds);
    const candidates = await loadInferredSessions(input, primaries, excluded);
    if (candidates.length > 0) {
      for (const sessionId of candidates) {
        if (visitedSessions.size >= SESSION_LIMIT) {
          truncated = true;
          warnings.push({ code: 'context_session_limit_exceeded', session_limit: SESSION_LIMIT });
          break;
        }
        visitedSessions.add(sessionId);
        const context = await loadInferredContext(input, sessionId);
        if (context.length === 0) {
          continue;
        }
        const outcome = await evaluateInferredSession(input, sessionId, context);
        if (outcome === 'failed') {
          // 推定探索だけを打ち切り、代表matchをno_matchやfailedへ変えない。
          truncated = true;
          warnings.push({ code: 'context_expansion_failed' });
          break;
        }
        if (outcome === 'adopted') {
          for (const row of context) {
            add(draftOf(row, 'inferred_session_link'));
          }
        }
      }
    }
  }

  const kept: RelatedEvidenceDraft[] = [];
  let totalTokens = 0;
  let excludedTokens = 0;
  for (const draft of related) {
    const tokens = input.tokenizer.encode(draft.text).ids.length;
    if (totalTokens + tokens > TOKEN_BUDGET) {
      excludedTokens += 1;
      truncated = true;
      continue;
    }
    totalTokens += tokens;
    kept.push(draft);
  }
  if (primaryOversized || excludedTokens > 0) {
    warnings.push({
      code: 'context_token_budget_exceeded',
      excluded_count: excludedTokens,
      selected_tokens: totalTokens,
      budget_tokens: TOKEN_BUDGET,
      primary_tokens: primaryTokens,
    });
  }
  return { primaryKey: input.primaryKey, related: kept, warnings, truncated };
}

interface RevalidatedMessageRow {
  current_revision: number;
  sequence_no: number;
  session_id: string;
  employee_id: string;
  project_id: string;
  company_id: string;
  role: string;
  occurred_at: Date;
  text: string;
}

// 保存TX内で、current revision・案件所属・現在input境界・relation/linkの有効状態を再検証する。
export async function revalidateRelatedEvidence(
  client: PoolClient,
  target: JobTarget,
  drafts: readonly RelatedEvidenceDraft[],
): Promise<RelatedEvidenceDraft[]> {
  const valid: RelatedEvidenceDraft[] = [];
  for (const draft of drafts) {
    const result = await client.query<RevalidatedMessageRow>(
      `SELECT m.current_revision, m.sequence_no, m.session_id, s.employee_id, s.project_id, p.company_id,
              m.role, m.occurred_at, r.text
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         JOIN projects p ON p.id = s.project_id
         JOIN message_revisions r ON r.message_id = m.id AND r.revision = $2
        WHERE m.id = $1
        FOR SHARE OF m`,
      [draft.messageId, draft.revision],
    );
    const row = result.rows[0];
    if (row === undefined || row.current_revision !== draft.revision) {
      continue;
    }
    if (row.project_id !== target.projectId || row.company_id !== target.companyId) {
      continue;
    }
    if (row.session_id === target.sessionId && row.sequence_no >= target.sequenceNo) {
      continue;
    }
    if (draft.linkId !== undefined) {
      const link = await client.query(
        `SELECT 1
           FROM session_links l
           JOIN messages em ON em.id = l.evidence_message_id
           JOIN sessions es ON es.id = em.session_id
           JOIN projects ep ON ep.id = es.project_id
          WHERE l.id = $1 AND l.status = 'active' AND l.company_id = $2 AND l.project_id = $3
            AND (em.session_id = l.from_session_id OR em.session_id = l.to_session_id)
            AND em.current_revision = l.evidence_revision
            AND es.project_id = l.project_id AND ep.company_id = l.company_id
          FOR SHARE OF l, em`,
        [draft.linkId, target.companyId, target.projectId],
      );
      if (link.rows.length === 0) {
        continue;
      }
    }
    if (
      draft.relation !== undefined &&
      draft.relatedToMessageId !== undefined &&
      draft.relatedToRevision !== undefined &&
      draft.relationSourceRevision !== undefined
    ) {
      const relation = await client.query(
        `SELECT 1 FROM message_relations
          WHERE source_message_id = $1 AND source_revision = $2
            AND target_message_id = $3 AND target_revision = $4 AND relation = $5
          FOR SHARE`,
        [draft.messageId, draft.relationSourceRevision, draft.relatedToMessageId, draft.relatedToRevision, draft.relation],
      );
      if (relation.rows.length === 0) {
        continue;
      }
    }
    valid.push({
      ...draft,
      employeeId: row.employee_id,
      role: row.role,
      occurredAt: row.occurred_at,
      text: row.text,
    });
  }
  return valid;
}
