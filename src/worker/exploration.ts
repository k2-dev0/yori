import type { Tokenizer } from '@huggingface/tokenizers';
import type { Pool, PoolClient } from 'pg';
import type { WorkerConfig } from './config.js';
import { WORKER_POLICY_VERSION } from './contract.js';
import type { JobTarget } from './context.js';

// M7の周辺・継続探索。代表候補のsource messageをprimary evidenceとして、同一sessionの前後、
// 後続の訂正・撤回、activeな明示session link、推定の継続sessionを集める。
// 外部HTTPは呼ばない（推定継続はバックグラウンド判定済みの結果と埋め込みの近さで決める）。
// 保存TXで再検証する前提の下書きだけを返す。

const SESSION_LIMIT = 10;
const HOP_LIMIT = 3;
const NEIGHBOR_RADIUS = 2;
const CONTEXT_WINDOW = 5;
const TOKEN_BUDGET = 6_000;
// 推定継続sessionから付ける文書。質問との埋め込みの近さで選び、絶対・相対の両しきい値を満たすものだけにする。
// 相対しきい値は代表文書の類似度に対する比で、埋め込みmodelの類似度の尺度に依存しにくくする。
const INFERRED_DOCUMENTS_PER_SESSION = 2;
const INFERRED_SCAN_DOCUMENTS_PER_SESSION = 200;
const INFERRED_MIN_SIMILARITY = 0.3;
const INFERRED_RELATIVE_SIMILARITY = 0.8;

export interface SearchWarning {
  code: string;
  [key: string]: unknown;
}

export type RelatedSourceKind = 'neighbor' | 'correction' | 'explicit_session_link' | 'inferred_session_link';

// 同じ訂正・撤回message/revisionが複数targetを持つ場合のrelation 1件。
export interface RelatedRelation {
  relation: string;
  relatedToMessageId: string;
  relatedToRevision: number;
  relationSourceRevision: number;
}

export interface RelatedEvidenceDraft {
  messageId: string;
  revision: number;
  sessionId: string;
  employeeId: string;
  role: string;
  occurredAt: Date;
  text: string;
  sourceKind: RelatedSourceKind;
  // correctionはrelation全件を保持する。related evidence自体はmessage単位で1件に固定する。
  relations?: RelatedRelation[];
  // 起点primary sessionからこのitemのsessionまでの明示link ID経路（1辺以上）。
  linkIds?: string[];
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
  // 推定継続sessionの文書を選ぶための質問の埋め込み（検索時に作成済みのもの）。
  queryVector: readonly number[];
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
  from_message_id: string;
  from_message_revision: number;
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
  const bySource = new Map<string, RelatedEvidenceDraft>();
  // 訪問済みmessage ID+revisionで循環を検出し、同じ原文を再探索しない。
  const visited = new Set(input.primaryEvidence.map((source) => `${source.message_id}:${source.message_revision}`));
  let frontier = input.primaryEvidence.map((source) => ({ messageId: source.message_id, revision: source.message_revision }));
  for (let hop = 1; hop <= HOP_LIMIT && frontier.length > 0; hop += 1) {
    const next: Array<{ messageId: string; revision: number }> = [];
    for (const parent of frontier) {
      const rows = await input.pool.query<CorrectionRow>(
        `SELECT r.from_message_id, r.from_message_revision, r.relation,
                m.id AS message_id, m.current_revision AS revision, m.sequence_no, m.session_id,
                s.employee_id, m.role, m.occurred_at, rev.text
           FROM message_relations r
           JOIN messages m ON m.id = r.from_message_id
           JOIN sessions s ON s.id = m.session_id
           JOIN projects p ON p.id = s.project_id
           JOIN message_revisions rev ON rev.message_id = r.from_message_id AND rev.revision = r.from_message_revision
          WHERE r.to_message_id = $1 AND r.to_message_revision = $2
            AND r.relation IN ('change', 'revoke')
            AND m.current_revision = r.from_message_revision
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
        const key = `${row.from_message_id}:${row.from_message_revision}`;
        const relation: RelatedRelation = {
          relation: row.relation,
          relatedToMessageId: parent.messageId,
          relatedToRevision: parent.revision,
          relationSourceRevision: row.from_message_revision,
        };
        let draft = bySource.get(key);
        if (draft === undefined) {
          if (visited.has(key)) {
            // 元根拠自身への循環relationはrelatedへ追加しない。
            continue;
          }
          visited.add(key);
          draft = draftOf(row, 'correction', { relations: [] });
          bySource.set(key, draft);
          drafts.push(draft);
          next.push({ messageId: row.from_message_id, revision: row.from_message_revision });
        }
        const relations = draft.relations as RelatedRelation[];
        if (
          !relations.some(
            (existing) =>
              existing.relation === relation.relation &&
              existing.relatedToMessageId === relation.relatedToMessageId &&
              existing.relatedToRevision === relation.relatedToRevision,
          )
        ) {
          relations.push(relation);
        }
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
async function loadLinkContext(
  input: ExplorationInput,
  link: LinkRow,
  currentSessionId: string,
  discoveredSessionId: string,
  linkIds: readonly string[],
): Promise<RelatedEvidenceDraft[]> {
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
  return rows.map((row) => draftOf(row, 'explicit_session_link', { linkIds: [...linkIds] }));
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

// バックグラウンド判定で継続と判定されたsession（どちら向きでも）。既出sessionと、明示link（active/revoked）で
// primaryとつながるsessionは推定として再浮上させない。開始時刻順に返す。
async function loadContinuationSessions(
  input: ExplorationInput,
  originSessionIds: readonly string[],
  excludedSessions: ReadonlySet<string>,
): Promise<string[]> {
  if (originSessionIds.length === 0) {
    return [];
  }
  const result = await input.pool.query<{ id: string }>(
    `SELECT o.id, min(o.started_at) AS started_at
       FROM session_continuity_judgments c
       JOIN sessions o
         ON o.id = CASE WHEN c.session_id = ANY($1::uuid[]) THEN c.candidate_session_id ELSE c.session_id END
       JOIN projects p ON p.id = o.project_id
      WHERE c.continuous AND c.policy_version = $2
        AND (c.session_id = ANY($1::uuid[]) OR c.candidate_session_id = ANY($1::uuid[]))
        AND c.company_id = $3 AND c.project_id = $4 AND o.project_id = $4 AND p.company_id = $3
        AND o.id <> ALL($5::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM session_links l
           WHERE l.company_id = $3 AND l.project_id = $4
             AND (l.from_session_id = ANY($1::uuid[]) OR l.to_session_id = ANY($1::uuid[]))
             AND (l.from_session_id = o.id OR l.to_session_id = o.id)
        )
      GROUP BY o.id
      ORDER BY min(o.started_at), o.id`,
    [originSessionIds, WORKER_POLICY_VERSION, input.target.companyId, input.target.projectId, [...excludedSessions]],
  );
  return result.rows.map((row) => row.id);
}

// 推定継続sessionの公開文書のうち、質問に近いものを各session最大2件選び、そのsource messageを返す。
// 各sessionは最新200文書だけを比べ、計算量をsessionの長さで頭打ちにする。
async function loadContinuationContext(input: ExplorationInput, sessionIds: readonly string[]): Promise<MessageRow[]> {
  if (sessionIds.length === 0) {
    return [];
  }
  const query = vectorLiteral(input.queryVector);
  const primary = await input.pool.query<{ similarity: number }>(
    `SELECT 1 - (embedding <=> $1::vector) AS similarity
       FROM document_embeddings WHERE document_id = $2 AND revision = $3 AND generation_id = $4`,
    [query, input.primaryDocumentId, input.primaryDocumentRevision, input.generationId],
  );
  const primarySimilarity = primary.rows[0]?.similarity ?? 1;
  const threshold = Math.max(INFERRED_MIN_SIMILARITY, primarySimilarity * INFERRED_RELATIVE_SIMILARITY);
  const documents = await input.pool.query<{ document_id: string; revision: number }>(
    `SELECT x.document_id, x.revision
       FROM unnest($1::uuid[]) AS cs(session_id)
       CROSS JOIN LATERAL (
         SELECT e.document_id, e.revision, 1 - (e.embedding <=> $2::vector) AS similarity
           FROM (
             SELECT d.id FROM search_documents d
              WHERE d.session_id = cs.session_id AND d.company_id = $3 AND d.project_id = $4 AND d.is_searchable
              ORDER BY d.created_at DESC, d.id DESC
              LIMIT ${INFERRED_SCAN_DOCUMENTS_PER_SESSION}
           ) recent
           JOIN document_publications pub ON pub.document_id = recent.id AND pub.generation_id = $5
           JOIN search_document_revisions r
             ON r.document_id = pub.document_id AND r.revision = pub.revision AND r.status IN ('ready', 'superseded')
           JOIN document_embeddings e ON e.document_id = pub.document_id AND e.revision = pub.revision AND e.generation_id = $5
          ORDER BY e.embedding <=> $2::vector ASC, e.document_id ASC
          LIMIT ${INFERRED_DOCUMENTS_PER_SESSION}
       ) x
      WHERE x.similarity >= $6`,
    [sessionIds, query, input.target.companyId, input.target.projectId, input.generationId, threshold],
  );
  if (documents.rows.length === 0) {
    return [];
  }
  const rows = await input.pool.query<MessageRow>(
    `SELECT DISTINCT ${MESSAGE_COLUMNS}
     ${MESSAGE_JOINS}
       JOIN search_document_sources sx ON sx.message_id = m.id AND sx.message_revision = m.current_revision
      WHERE (sx.document_id, sx.document_revision) IN (SELECT * FROM unnest($1::uuid[], $2::int[]))
        AND s.project_id = $3 AND p.company_id = $4
        AND (m.session_id <> $5 OR m.sequence_no < $6)`,
    [
      documents.rows.map((row) => row.document_id),
      documents.rows.map((row) => row.revision),
      input.target.projectId,
      input.target.companyId,
      input.target.sessionId,
      input.target.sequenceNo,
    ],
  );
  const order = new Map(sessionIds.map((sessionId, index) => [sessionId, index]));
  return [...rows.rows].sort(
    (left, right) =>
      (order.get(left.session_id) ?? 0) - (order.get(right.session_id) ?? 0) || left.sequence_no - right.sequence_no,
  );
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

  // change/revoke発言は前後2発言に含まれてもcorrection metadataを保持する。
  // correctionを先に確定してneighbor集合から除外し、その後にneighbor→correctionの順で追加する。
  const corrections = await loadCorrections(input);
  const correctionMessageIds = new Set(corrections.map((draft) => draft.messageId));
  for (const draft of await loadNeighbors(input)) {
    if (correctionMessageIds.has(draft.messageId)) {
      continue;
    }
    add(draft);
  }
  for (const draft of corrections) {
    add(draft);
  }

  // 探索起点はprimary evidenceの一意なsession群。訪問済みsession上限にもこの群を含める。
  const originSessionIds = [...new Set(input.primaryEvidence.map((source) => source.session_id))];
  const visitedSessions = new Set([...originSessionIds, ...relatedSessions]);
  let sessionLimitReached = false;
  let frontier: Array<{ sessionId: string; hop: number; linkIds: string[] }> = originSessionIds.map((sessionId) => ({
    sessionId,
    hop: 0,
    linkIds: [],
  }));
  while (frontier.length > 0 && !sessionLimitReached) {
    const next: Array<{ sessionId: string; hop: number; linkIds: string[] }> = [];
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
        const linkIds = [...current.linkIds, link.id];
        next.push({ sessionId: other, hop: current.hop + 1, linkIds });
        for (const draft of await loadLinkContext(input, link, current.sessionId, other, linkIds)) {
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
    const continuation: string[] = [];
    for (const sessionId of await loadContinuationSessions(input, originSessionIds, excluded)) {
      if (visitedSessions.size >= SESSION_LIMIT) {
        truncated = true;
        warnings.push({ code: 'context_session_limit_exceeded', session_limit: SESSION_LIMIT });
        break;
      }
      visitedSessions.add(sessionId);
      continuation.push(sessionId);
    }
    for (const row of await loadContinuationContext(input, continuation)) {
      add(draftOf(row, 'inferred_session_link'));
    }
  }

  // token予算の採用順はcorrectionを最優先にし、その後neighbor→explicit→inferred。
  // 各group内は元の安定順、出力順は既存契約（neighbor→correction→explicit→inferred）を維持する。
  const selected = new Set<RelatedEvidenceDraft>();
  let totalTokens = 0;
  let excludedTokens = 0;
  for (const kind of ['correction', 'neighbor', 'explicit_session_link', 'inferred_session_link'] as const) {
    for (const draft of related) {
      if (draft.sourceKind !== kind) {
        continue;
      }
      const tokens = input.tokenizer.encode(draft.text).ids.length;
      if (totalTokens + tokens > TOKEN_BUDGET) {
        excludedTokens += 1;
        truncated = true;
        continue;
      }
      totalTokens += tokens;
      selected.add(draft);
    }
  }
  const kept = related.filter((draft) => selected.has(draft));
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
    // 起点からの全link経路を検証し、1辺でも無効ならこのrelated itemを落とす。
    if (draft.sourceKind === 'explicit_session_link') {
      if (draft.linkIds === undefined || draft.linkIds.length === 0) {
        continue;
      }
      let linksValid = true;
      for (const linkId of draft.linkIds) {
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
          [linkId, target.companyId, target.projectId],
        );
        if (link.rows.length === 0) {
          linksValid = false;
          break;
        }
      }
      if (!linksValid) {
        continue;
      }
    }
    let current = draft;
    if (draft.sourceKind === 'correction') {
      if (draft.relations === undefined || draft.relations.length === 0) {
        continue;
      }
      // 無効relationだけを落とす。1件でもcurrentなrelationが残ればitemは保持する。
      const validRelations: RelatedRelation[] = [];
      for (const relation of draft.relations) {
        const found = await client.query(
          `SELECT 1 FROM message_relations
            WHERE from_message_id = $1 AND from_message_revision = $2
              AND to_message_id = $3 AND to_message_revision = $4 AND relation = $5
            FOR SHARE`,
          [
            draft.messageId,
            relation.relationSourceRevision,
            relation.relatedToMessageId,
            relation.relatedToRevision,
            relation.relation,
          ],
        );
        if (found.rows.length > 0) {
          validRelations.push(relation);
        }
      }
      if (validRelations.length === 0) {
        continue;
      }
      current = { ...draft, relations: validRelations };
    }
    valid.push({
      ...current,
      employeeId: row.employee_id,
      role: row.role,
      occurredAt: row.occurred_at,
      text: row.text,
    });
  }
  return valid;
}
