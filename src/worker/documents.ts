import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { ClaimedJob } from '../jobs/queue.js';
import { completeJob } from '../jobs/queue.js';
import {
  CHUNK_MAX_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_TARGET_TOKENS,
  DOCUMENT_CHUNKER_VERSION,
  VOYAGE_DOCUMENT_PREFIX_TOKEN_RESERVE,
  WORKER_POLICY_VERSION,
} from './contract.js';
import type { JobTarget } from './context.js';
import { LeaseLostError, StaleApplyError } from './errors.js';
import type { EmbeddingGeneration } from './embedding.js';
import { loadVoyageTokenizer } from './tokenizer.js';

// 文書生成はsessionの現行message revisionと現在policyのanalysisだけをsequence順に使う。
export interface SessionMessage {
  messageId: string;
  revision: number;
  text: string;
}

export interface PlannedSource {
  messageId: string;
  messageRevision: number;
  startOffset: number;
  endOffset: number;
  sourceKind: 'original' | 'overlap';
}

export interface PlannedChunk {
  documentKey: string;
  content: string;
  contentHash: Buffer;
  chunkerVersion: string;
  sources: PlannedSource[];
}

interface Segment {
  start: number;
  end: number;
}

interface Atom extends Segment {
  messageId: string;
  messageRevision: number;
  messageText: string;
  tokens: number;
}

interface Part {
  messageId: string;
  messageRevision: number;
  startOffset: number;
  endOffset: number;
  text: string;
  tokens: number;
  sourceKind: 'original' | 'overlap';
}

const TARGET_LOCAL = CHUNK_TARGET_TOKENS - VOYAGE_DOCUMENT_PREFIX_TOKEN_RESERVE;
const MAX_LOCAL = CHUNK_MAX_TOKENS - VOYAGE_DOCUMENT_PREFIX_TOKEN_RESERVE;
// 次chunkは直前chunk末尾のCHUNK_OVERLAP_TOKENS分と区切り1トークンを引き継ぐ。
// atom単体をこの上限に抑え、overlap windowを破棄せずMAX_LOCAL内へ収める。
const MAX_ATOM_LOCAL = MAX_LOCAL - CHUNK_OVERLAP_TOKENS - 1;

// 文書計画の入力。snapshotは計画時点のsession全messageと現行policyのanalysis状態のfingerprint。
export interface SessionPlanInput {
  messages: SessionMessage[];
  snapshot: Buffer;
}

interface SessionStateRow {
  message_id: string;
  current_revision: number;
  text: string | null;
  analysis_revision: number | null;
  policy_version: string | null;
  state_hash: Buffer | null;
  is_searchable: boolean | null;
  retention: string | null;
  invalidating_relations: [string, string, number, number][];
}

// session全messageと、その現行revisionに対する現行policyのanalysis・有効revoke/change relationをsequence順に読む。
// relationは同一案件（会社）内のmessage間に限定し、source/targetとも現行revision・現行policyの時だけ有効とする。
// searchableな発言の抽出とsnapshot作成を同じ結果から行う。
const SESSION_STATE_SQL = `
  SELECT m.id AS message_id, m.current_revision, r.text,
         a.revision AS analysis_revision, a.policy_version, a.state_hash, a.is_searchable, a.retention,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_array(mr.relation, mr.source_message_id, mr.source_revision, mr.target_revision)
                            ORDER BY mr.source_message_id, mr.source_revision, mr.relation, mr.target_revision)
             FROM message_relations mr
             JOIN messages sm ON sm.id = mr.source_message_id
             JOIN sessions ss ON ss.id = sm.session_id
             JOIN sessions ts ON ts.id = m.session_id
            WHERE mr.target_message_id = m.id
              AND mr.target_revision = m.current_revision
              AND mr.policy_version = $2
              AND mr.relation IN ('revoke', 'change')
              AND sm.current_revision = mr.source_revision
              AND ss.project_id = ts.project_id
         ), '[]'::jsonb) AS invalidating_relations
    FROM messages m
    LEFT JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
    LEFT JOIN message_analysis a ON a.message_id = m.id AND a.revision = m.current_revision AND a.policy_version = $2
   WHERE m.session_id = $1
   ORDER BY m.sequence_no, m.id
`;

async function loadSessionState(client: PoolClient, sessionId: string): Promise<SessionStateRow[]> {
  const result = await client.query<SessionStateRow>(SESSION_STATE_SQL, [sessionId, WORKER_POLICY_VERSION]);
  return result.rows;
}

// 新規message追加・原文revision・analysisの再分類・有効revoke/change relationの追加/変更の
// どれでも変化する決定的fingerprint。textは含めず、同じ計画前提ならbuildと適用直前の再確認で同じ値になる。
function snapshotSessionState(rows: readonly SessionStateRow[]): Buffer {
  const state = rows.map((row) => ({
    message_id: row.message_id,
    current_revision: row.current_revision,
    analysis_revision: row.analysis_revision,
    policy_version: row.policy_version,
    state_hash: row.state_hash === null ? null : row.state_hash.toString('hex'),
    is_searchable: row.is_searchable,
    retention: row.retention,
    invalidating_relations: row.invalidating_relations,
  }));
  return createHash('sha256').update(JSON.stringify(state), 'utf8').digest();
}

// 現行revisionのsearchableな発言だけをsequence順に読む。progress_only/is_searchable=falseと
// 現行policyで有効なrevoke/change relationのtargetは除外する。原文・relationは保持する。
export async function loadSessionMessages(pool: Pool, sessionId: string): Promise<SessionPlanInput> {
  const client = await pool.connect();
  try {
    const rows = await loadSessionState(client, sessionId);
    const messages: SessionMessage[] = [];
    for (const row of rows) {
      if (
        row.text !== null &&
        row.text.length > 0 &&
        row.is_searchable === true &&
        row.retention !== 'progress_only' &&
        row.invalidating_relations.length === 0
      ) {
        messages.push({ messageId: row.message_id, revision: row.current_revision, text: row.text });
      }
    }
    return { messages, snapshot: snapshotSessionState(rows) };
  } finally {
    client.release();
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

// UTF-16境界がサロゲートペアの内側なら、ペアを割らない位置へ寄せる。
function adjustBoundary(text: string, start: number, boundary: number, end: number): number {
  if (boundary <= start || boundary >= end) {
    return boundary;
  }
  if (isHighSurrogate(text.charCodeAt(boundary - 1)) && isLowSurrogate(text.charCodeAt(boundary))) {
    return boundary - 1 > start ? boundary - 1 : Math.min(boundary + 1, end);
  }
  return boundary;
}

function lineSpans(text: string, from: number, to: number): Segment[] {
  const lines: Segment[] = [];
  let start = from;
  while (start < to) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 || newline >= to ? to : newline + 1;
    lines.push({ start, end });
    start = end;
  }
  return lines;
}

function segmentTokens(tokenizer: { encode: (text: string) => { ids: number[] } }, text: string, segment: Segment): number {
  return tokenizer.encode(text.slice(segment.start, segment.end)).ids.length;
}

// message本文を、fenceブロック→段落の優先順の境界へ分ける。全ての区間を欠落なく覆う。
function structuralSegments(text: string): Segment[] {
  const lines = lineSpans(text, 0, text.length);
  const segments: Segment[] = [];
  let paragraphStart = -1;
  let fenceStart = -1;
  let pendingBlank = false;
  const closeParagraph = (end: number): void => {
    if (paragraphStart >= 0 && end > paragraphStart) {
      segments.push({ start: paragraphStart, end });
    }
    paragraphStart = -1;
    pendingBlank = false;
  };
  for (const line of lines) {
    const raw = text.slice(line.start, line.end).replace(/[\r\n]+$/, '');
    const trimmed = raw.trimStart();
    if (fenceStart >= 0) {
      if (trimmed.startsWith('```')) {
        segments.push({ start: fenceStart, end: line.end });
        fenceStart = -1;
      }
      continue;
    }
    if (trimmed.startsWith('```')) {
      closeParagraph(line.start);
      fenceStart = line.start;
      continue;
    }
    if (raw.trim().length === 0) {
      if (paragraphStart >= 0) {
        pendingBlank = true;
      } else {
        // 直前がfence等で閉じている場合も、空行を次の段落へ含めて全文を欠落なく覆う。
        paragraphStart = line.start;
      }
      continue;
    }
    if (paragraphStart < 0) {
      paragraphStart = line.start;
    } else if (pendingBlank) {
      // 空行の直後から新しい段落。空行は直前の段落へ含めて境界をparagraph間へ置く。
      closeParagraph(line.start);
      paragraphStart = line.start;
    }
    pendingBlank = false;
  }
  if (fenceStart >= 0) {
    segments.push({ start: fenceStart, end: text.length });
  }
  closeParagraph(text.length);
  return segments;
}

// targetを超える区間は行単位のatomへ分ける。単一の長大行だけをcode point境界で分割し、欠落させない。
function splitSegmentLines(
  tokenizer: { encode: (text: string) => { ids: number[] } },
  text: string,
  segment: Segment,
): Segment[] {
  const pieces: Segment[] = [];
  for (const line of lineSpans(text, segment.start, segment.end)) {
    if (segmentTokens(tokenizer, text, line) <= MAX_ATOM_LOCAL) {
      pieces.push(line);
      continue;
    }
    let cursor = line.start;
    while (cursor < line.end) {
      // code point境界で上限に収まる最大の位置を二分探索する。
      let low = cursor + 1;
      let high = line.end;
      let best = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const boundary = adjustBoundary(text, cursor, middle, line.end);
        if (boundary <= cursor) {
          low = middle + 1;
          continue;
        }
        if (segmentTokens(tokenizer, text, { start: cursor, end: boundary }) <= MAX_ATOM_LOCAL) {
          best = boundary;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      const boundary = best > cursor ? best : Math.min(line.end, cursor + 2);
      pieces.push({ start: cursor, end: boundary });
      cursor = boundary;
    }
  }
  return pieces;
}

async function buildAtoms(messages: readonly SessionMessage[]): Promise<Atom[]> {
  const tokenizer = await loadVoyageTokenizer();
  const atoms: Atom[] = [];
  for (const message of messages) {
    for (const segment of structuralSegments(message.text)) {
      const pieces =
        segmentTokens(tokenizer, message.text, segment) <= TARGET_LOCAL
          ? [segment]
          : splitSegmentLines(tokenizer, message.text, segment);
      for (const piece of pieces) {
        atoms.push({
          ...piece,
          messageId: message.messageId,
          messageRevision: message.revision,
          messageText: message.text,
          tokens: segmentTokens(tokenizer, message.text, piece),
        });
      }
    }
  }
  return atoms;
}

function toPart(atom: Atom, sourceKind: 'original' | 'overlap'): Part {
  return {
    messageId: atom.messageId,
    messageRevision: atom.messageRevision,
    startOffset: atom.start,
    endOffset: atom.end,
    text: atom.messageText.slice(atom.start, atom.end),
    tokens: atom.tokens,
    sourceKind,
  };
}

function partsBudget(parts: readonly Part[]): number {
  return parts.reduce((sum, part) => sum + part.tokens, 0) + Math.max(0, parts.length - 1);
}

// 末尾からbudgetトークンに収まる最大のsuffixを探す。サロゲートペアは割らない。
function trailingTokenSlice(
  tokenizer: { encode: (text: string) => { ids: number[] } },
  text: string,
  budget: number,
): { offset: number; text: string; tokens: number } | null {
  const total = tokenizer.encode(text).ids.length;
  if (total <= budget) {
    return { offset: 0, text, tokens: total };
  }
  let low = 0;
  let high = text.length - 1;
  let best = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const start = middle < text.length && isLowSurrogate(text.charCodeAt(middle)) ? middle + 1 : middle;
    const suffix = text.slice(start);
    const count = suffix.length > 0 ? tokenizer.encode(suffix).ids.length : 0;
    if (suffix.length > 0 && count <= budget) {
      best = start;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  if (best < 0) {
    return null;
  }
  const suffix = text.slice(best);
  return { offset: best, text: suffix, tokens: tokenizer.encode(suffix).ids.length };
}

// 直前chunkの末尾から重複window（100トークン以内）を作る。partが大きい場合はtoken境界で部分区間を取る。
// partsBudgetはpart間separatorを1トークンとして数えるため、構築予算にも同じseparatorを含め、
// 戻り値のpartsBudget(overlap) <= CHUNK_OVERLAP_TOKENSを保証する。
function overlapParts(
  tokenizer: { encode: (text: string) => { ids: number[] } },
  parts: readonly Part[],
): Part[] {
  const overlap: Part[] = [];
  let tokens = 0;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    // 現在のoverlapの先頭へ追加すると、既存part数と同じ数のseparatorが新たに増える。
    const separatorTokens = overlap.length;
    if (tokens + part.tokens + separatorTokens <= CHUNK_OVERLAP_TOKENS) {
      overlap.unshift({ ...part, sourceKind: 'overlap' });
      tokens += part.tokens;
      continue;
    }
    const remaining = CHUNK_OVERLAP_TOKENS - tokens - separatorTokens;
    const slice = remaining > 0 ? trailingTokenSlice(tokenizer, part.text, remaining) : null;
    if (slice !== null) {
      overlap.unshift({
        ...part,
        startOffset: part.startOffset + slice.offset,
        text: slice.text,
        tokens: slice.tokens,
        sourceKind: 'overlap',
      });
    }
    break;
  }
  return overlap;
}

function partsContent(parts: readonly Part[]): string {
  let content = '';
  let previousMessageId: string | null = null;
  for (const part of parts) {
    if (previousMessageId !== null && previousMessageId !== part.messageId) {
      content += '\n';
    }
    content += part.text;
    previousMessageId = part.messageId;
  }
  return content;
}

// overlapは前chunkから複製された範囲なので文書identityに使わず、chunk固有の先頭original sourceをanchorにする。
// anchor messageのrevision番号はkeyに含めず、同じ位置の原文編集は同じ文書の新revisionにする。
function documentKey(sessionId: string, anchor: PlannedSource, chunkerVersion: string): string {
  return createHash('sha256')
    .update([sessionId, anchor.messageId, String(anchor.startOffset), chunkerVersion].join('\u0000'), 'utf8')
    .digest('hex');
}

// 決定的なchunk列を作る。同一session・同一原文・同一chunker版なら同一のkey/本文/rangeになる。
export async function planDocumentChunks(sessionId: string, messages: readonly SessionMessage[]): Promise<PlannedChunk[]> {
  const tokenizer = await loadVoyageTokenizer();
  const atoms = await buildAtoms(messages);
  const chunks: { parts: Part[] }[] = [];
  let current: Part[] = [];
  let overlapSeeded = false;

  while (atoms.length > 0) {
    const atom = atoms[0];
    if (current.length === 0) {
      current.push(toPart(atom, 'original'));
      atoms.shift();
      overlapSeeded = false;
      continue;
    }
    if (overlapSeeded && current.every((part) => part.sourceKind === 'overlap')) {
      // 重複windowだけのchunkは確定しない。overlapPartsはpartsBudget(overlap) <= CHUNK_OVERLAP_TOKENSを保証し、
      // atomはMAX_ATOM_LOCAL以下なので、window + separator + atomは必ずMAX_LOCAL内に入る。
      current.push(toPart(atom, 'original'));
      atoms.shift();
      overlapSeeded = false;
      continue;
    }
    const budget = partsBudget(current) + atom.tokens + 1;
    if (budget <= TARGET_LOCAL) {
      current.push(toPart(atom, 'original'));
      atoms.shift();
      overlapSeeded = false;
      continue;
    }
    // current全体がoverlap予算以下なら、ここで確定すると次chunkへ全文複製される。
    // provider上限に収まる場合はtargetを超えても次atomと結合し、短いchunkの重複保存を避ける。
    if (partsBudget(current) <= CHUNK_OVERLAP_TOKENS && budget <= MAX_LOCAL) {
      current.push(toPart(atom, 'original'));
      atoms.shift();
      overlapSeeded = false;
      continue;
    }
    chunks.push({ parts: current });
    current = overlapParts(tokenizer, current);
    overlapSeeded = current.length > 0;
  }
  if (current.length > 0) {
    chunks.push({ parts: current });
  }

  return chunks.map((chunk) => {
    const content = partsContent(chunk.parts);
    const sources: PlannedSource[] = chunk.parts.map((part) => ({
      messageId: part.messageId,
      messageRevision: part.messageRevision,
      startOffset: part.startOffset,
      endOffset: part.endOffset,
      sourceKind: part.sourceKind,
    }));
    const anchor = sources.find((source) => source.sourceKind === 'original');
    if (anchor === undefined) {
      throw new Error('original sourceがない文書chunkは生成しない');
    }
    return {
      documentKey: documentKey(sessionId, anchor, DOCUMENT_CHUNKER_VERSION),
      content,
      contentHash: createHash('sha256').update(content, 'utf8').digest(),
      chunkerVersion: DOCUMENT_CHUNKER_VERSION,
      sources,
    };
  });
}

export interface PendingRevision {
  documentId: string;
  revision: number;
  content: string;
  contentHash: Buffer;
}

interface ExistingDocumentRow {
  id: string;
  document_key: string;
  desired_revision: number;
  is_searchable: boolean;
}

interface LatestRevisionRow {
  revision: number;
  content: string;
  content_hash: Buffer;
  status: string;
}

interface SourceRow {
  message_id: string;
  message_revision: number;
  start_offset: number;
  end_offset: number;
  source_kind: string;
}

function sameBuffer(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}

function sameSources(rows: readonly SourceRow[], planned: readonly PlannedSource[]): boolean {
  if (rows.length !== planned.length) {
    return false;
  }
  return rows.every((row, index) => {
    const source = planned[index];
    return (
      row.message_id === source.messageId &&
      row.message_revision === source.messageRevision &&
      row.start_offset === source.startOffset &&
      row.end_offset === source.endOffset &&
      row.source_kind === source.sourceKind
    );
  });
}

async function loadSources(client: PoolClient, documentId: string, revision: number): Promise<SourceRow[]> {
  const result = await client.query<SourceRow>(
    `SELECT message_id, message_revision, start_offset, end_offset, source_kind
       FROM search_document_sources
      WHERE document_id = $1 AND revision = $2
      ORDER BY display_order`,
    [documentId, revision],
  );
  return result.rows;
}

// 新しいdesired revisionが未公開の間、末尾追加で内容が保持される既存公開revisionをstale=trueで警告付き利用にする。
async function markPublicationStale(client: PoolClient, documentId: string): Promise<void> {
  await client.query(
    `UPDATE document_publications SET stale = true, updated_at = now()
      WHERE document_id = $1 AND stale = false`,
    [documentId],
  );
}

function sourceMatches(row: SourceRow, source: PlannedSource): boolean {
  return (
    row.message_id === source.messageId &&
    row.message_revision === source.messageRevision &&
    row.start_offset === source.startOffset &&
    row.end_offset === source.endOffset &&
    row.source_kind === source.sourceKind
  );
}

// 旧公開revisionの全source identityが新計画の先頭にそのまま残る末尾追加だけ、旧公開をstaleで残す。
// source消失・message revision変更・UTF-16 range変更を含む制限的変更では公開行を削除して即時検索不能にする。
// 埋め込み成功時はapplyDocumentEmbeddingsが新しい公開行を作り直す。
async function reconcilePublications(
  client: PoolClient,
  documentId: string,
  sources: readonly PlannedSource[],
): Promise<void> {
  const publications = await client.query<{ revision: number }>(
    'SELECT revision FROM document_publications WHERE document_id = $1 FOR UPDATE',
    [documentId],
  );
  let appendOnly = publications.rows.length > 0;
  for (const publication of publications.rows) {
    const published = await loadSources(client, documentId, publication.revision);
    if (published.length > sources.length || !published.every((row, index) => sourceMatches(row, sources[index]))) {
      appendOnly = false;
      break;
    }
  }
  if (!appendOnly) {
    await client.query('DELETE FROM document_publications WHERE document_id = $1', [documentId]);
    return;
  }
  await markPublicationStale(client, documentId);
}

async function replaceSources(client: PoolClient, documentId: string, revision: number, sources: readonly PlannedSource[]): Promise<void> {
  await client.query('DELETE FROM search_document_sources WHERE document_id = $1 AND revision = $2', [documentId, revision]);
  let displayOrder = 0;
  for (const source of sources) {
    await client.query(
      `INSERT INTO search_document_sources
         (id, document_id, revision, message_id, message_revision, start_offset, end_offset, display_order, source_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        uuidv7(),
        documentId,
        revision,
        source.messageId,
        source.messageRevision,
        source.startOffset,
        source.endOffset,
        displayOrder,
        source.sourceKind,
      ],
    );
    displayOrder += 1;
  }
}

const SESSION_BUILD_LOCK_NAMESPACE = 20260926;

// chunk計画をDBへ反映し、埋め込み待ちのrevisionを返す。外部HTTPの前にTXを完了する。
// 停止・回収済みの旧workerが後から計画を書き込まないよう、書込前にjob所有とsession前提をDBで再確認する。
export async function applyDocumentPlan(
  pool: Pool,
  job: ClaimedJob,
  input: { companyId: string; projectId: string; sessionId: string },
  snapshot: Buffer,
  chunks: readonly PlannedChunk[],
): Promise<PendingRevision[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [
      SESSION_BUILD_LOCK_NAMESPACE,
      input.sessionId,
    ]);
    const leased = await client.query(
      `SELECT 1 FROM jobs
        WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_expires_at > now()
          AND target_revision IS NOT DISTINCT FROM $3
        FOR UPDATE`,
      [job.id, job.leaseToken, job.targetRevision],
    );
    if (leased.rows.length === 0) {
      throw new LeaseLostError('jobのlease所有を確認できません');
    }
    if (!snapshot.equals(snapshotSessionState(await loadSessionState(client, input.sessionId)))) {
      throw new StaleApplyError('sessionの状態が変化しました');
    }

    const existing = await client.query<ExistingDocumentRow>(
      `SELECT id, document_key, desired_revision, is_searchable
         FROM search_documents
        WHERE project_id = $1 AND session_id = $2
        FOR UPDATE`,
      [input.projectId, input.sessionId],
    );
    const byKey = new Map(existing.rows.map((row) => [row.document_key, row]));
    const plannedKeys = new Set(chunks.map((chunk) => chunk.documentKey));

    for (const chunk of chunks) {
      const document = byKey.get(chunk.documentKey);
      if (document === undefined) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO search_documents (id, company_id, project_id, session_id, document_key, desired_revision, is_searchable)
           VALUES ($1, $2, $3, $4, $5, 1, true)
           ON CONFLICT (project_id, document_key) DO NOTHING
           RETURNING id`,
          [uuidv7(), input.companyId, input.projectId, input.sessionId, chunk.documentKey],
        );
        const documentId =
          inserted.rows[0]?.id ??
          (
            await client.query<{ id: string }>('SELECT id FROM search_documents WHERE project_id = $1 AND document_key = $2 FOR UPDATE', [
              input.projectId,
              chunk.documentKey,
            ])
          ).rows[0]?.id;
        if (documentId === undefined) {
          throw new StaleApplyError('文書を作成できません');
        }
        await client.query(
          `INSERT INTO search_document_revisions (document_id, revision, content, content_hash, chunker_version, status)
           VALUES ($1, 1, $2, $3, $4, 'pending')`,
          [documentId, chunk.content, chunk.contentHash, chunk.chunkerVersion],
        );
        await replaceSources(client, documentId, 1, chunk.sources);
        continue;
      }

      const latestResult = await client.query<LatestRevisionRow>(
        `SELECT revision, content, content_hash, status
           FROM search_document_revisions
          WHERE document_id = $1
          ORDER BY revision DESC
          LIMIT 1
          FOR UPDATE`,
        [document.id],
      );
      const latest = latestResult.rows[0];
      if (latest === undefined) {
        throw new StaleApplyError('文書revisionがありません');
      }
      const latestSources = await loadSources(client, document.id, latest.revision);
      const unchanged = sameBuffer(latest.content_hash, chunk.contentHash) && sameSources(latestSources, chunk.sources);

      if (unchanged && latest.status === 'failed') {
        // 明示retry後の再処理: 同じ内容のfailed revisionをpendingへ戻して実際に再埋め込みする。
        await client.query(
          `UPDATE search_document_revisions SET status = 'pending', updated_at = now() WHERE document_id = $1 AND revision = $2`,
          [document.id, latest.revision],
        );
        await reconcilePublications(client, document.id, chunk.sources);
        continue;
      }
      if (unchanged && document.is_searchable) {
        continue;
      }
      if (unchanged && !document.is_searchable) {
        // 再び検索対象になった文書は新しいrevisionで再公開する。
        const nextRevision = latest.revision + 1;
        await client.query(
          `INSERT INTO search_document_revisions (document_id, revision, content, content_hash, chunker_version, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')`,
          [document.id, nextRevision, chunk.content, chunk.contentHash, chunk.chunkerVersion],
        );
        await replaceSources(client, document.id, nextRevision, chunk.sources);
        await client.query('UPDATE search_documents SET desired_revision = $2, is_searchable = true, updated_at = now() WHERE id = $1', [
          document.id,
          nextRevision,
        ]);
        await reconcilePublications(client, document.id, chunk.sources);
        continue;
      }

      const replaceable = latest.status === 'pending' || latest.status === 'embedding' || latest.status === 'failed';
      if (replaceable) {
        // 未公開の最新revisionは同じrevision番号のまま作り直し、revisionを増殖させない。
        await client.query(
          `UPDATE search_document_revisions
              SET content = $3, content_hash = $4, chunker_version = $5, status = 'pending', updated_at = now()
            WHERE document_id = $1 AND revision = $2`,
          [document.id, latest.revision, chunk.content, chunk.contentHash, chunk.chunkerVersion],
        );
        await replaceSources(client, document.id, latest.revision, chunk.sources);
        await client.query('UPDATE search_documents SET desired_revision = $2, is_searchable = true, updated_at = now() WHERE id = $1', [
          document.id,
          latest.revision,
        ]);
        await reconcilePublications(client, document.id, chunk.sources);
        continue;
      }

      const nextRevision = latest.revision + 1;
      await client.query(
        `INSERT INTO search_document_revisions (document_id, revision, content, content_hash, chunker_version, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [document.id, nextRevision, chunk.content, chunk.contentHash, chunk.chunkerVersion],
      );
      await replaceSources(client, document.id, nextRevision, chunk.sources);
      await client.query('UPDATE search_documents SET desired_revision = $2, is_searchable = true, updated_at = now() WHERE id = $1', [
        document.id,
        nextRevision,
      ]);
      await reconcilePublications(client, document.id, chunk.sources);
    }

    for (const document of existing.rows) {
      if (plannedKeys.has(document.document_key)) {
        continue;
      }
      await client.query('UPDATE search_documents SET is_searchable = false, updated_at = now() WHERE id = $1', [document.id]);
      // 計画から消えた文書は旧sourceが新計画に残らない制限的変更なので、公開行を削除して即時検索不能にする。
      await client.query('DELETE FROM document_publications WHERE document_id = $1', [document.id]);
      await client.query(
        `UPDATE search_document_revisions
            SET status = 'excluded', updated_at = now()
          WHERE document_id = $1 AND revision = $2 AND status <> 'excluded'`,
        [document.id, document.desired_revision],
      );
    }

    const pending = await client.query<{ document_id: string; revision: number; content: string; content_hash: Buffer }>(
      `SELECT d.id AS document_id, r.revision, r.content, r.content_hash
         FROM search_documents d
         JOIN search_document_revisions r ON r.document_id = d.id AND r.revision = d.desired_revision
        WHERE d.session_id = $1 AND d.is_searchable AND r.status IN ('pending', 'embedding')
        ORDER BY d.document_key`,
      [input.sessionId],
    );
    await client.query('COMMIT');
    return pending.rows.map((row) => ({
      documentId: row.document_id,
      revision: row.revision,
      content: row.content,
      contentHash: row.content_hash,
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// 恒久providerエラー時だけ、processBuildが保持するpending revisionをfailedへ限定更新する。
// job lease・desired_revision・content_hashが一致しない場合は別jobのrevisionを巻き込まず、
// lease不一致だけLeaseLostErrorで何も変更しない。
export async function markPendingRevisionsFailed(
  pool: Pool,
  job: ClaimedJob,
  pending: readonly PendingRevision[],
): Promise<void> {
  if (pending.length === 0) {
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const leased = await client.query(
      `SELECT 1 FROM jobs
        WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_expires_at > now()
          AND target_revision IS NOT DISTINCT FROM $3
        FOR UPDATE`,
      [job.id, job.leaseToken, job.targetRevision],
    );
    if (leased.rows.length === 0) {
      throw new LeaseLostError('jobのlease所有を確認できません');
    }
    for (const item of pending) {
      await client.query(
        // content_hashまで一致する場合だけfailedにする。別jobが同じrevision番号のcontent/sourceを
        // 新hashへ置換した後に旧HTTPが恒久失敗しても、新hash revisionを巻き込まない。
        `UPDATE search_document_revisions r
            SET status = 'failed', updated_at = now()
           FROM search_documents d
          WHERE d.id = r.document_id AND r.document_id = $1 AND r.revision = $2
            AND r.status IN ('pending', 'embedding')
            AND d.desired_revision = $2
            AND r.content_hash = $3`,
        [item.documentId, item.revision, item.contentHash],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function vectorText(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

// 応答適用TX。原文revision・desired_revision・世代・入力hash・leaseを全再検証し、
// 一致時だけembedding保存・publication更新・revision ready・job完了を同一TXで行う。
export async function applyDocumentEmbeddings(
  pool: Pool,
  job: ClaimedJob,
  target: JobTarget,
  generation: EmbeddingGeneration,
  pending: readonly PendingRevision[],
  vectors: readonly number[][],
): Promise<void> {
  if (pending.length !== vectors.length) {
    throw new StaleApplyError('埋め込み件数と待機revisionが一致しません');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const leased = await client.query(
      `SELECT 1 FROM jobs
        WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_expires_at > now()
          AND target_revision IS NOT DISTINCT FROM $3
        FOR UPDATE`,
      [job.id, job.leaseToken, job.targetRevision],
    );
    if (leased.rows.length === 0) {
      throw new LeaseLostError('jobのlease所有を確認できません');
    }
    const project = await client.query<{ active_generation_id: string | null }>(
      'SELECT active_generation_id FROM projects WHERE id = $1 FOR SHARE',
      [target.projectId],
    );
    if (project.rows[0]?.active_generation_id !== generation.id) {
      throw new StaleApplyError('active generationが変化しました');
    }

    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      const vector = vectors[index];
      const document = await client.query<{ desired_revision: number; is_searchable: boolean }>(
        'SELECT desired_revision, is_searchable FROM search_documents WHERE id = $1 FOR UPDATE',
        [item.documentId],
      );
      const documentRow = document.rows[0];
      if (documentRow === undefined || documentRow.desired_revision !== item.revision || !documentRow.is_searchable) {
        throw new StaleApplyError('desired_revisionが変化しました');
      }
      const revision = await client.query<{ content: string; content_hash: Buffer; status: string }>(
        'SELECT content, content_hash, status FROM search_document_revisions WHERE document_id = $1 AND revision = $2 FOR UPDATE',
        [item.documentId, item.revision],
      );
      const revisionRow = revision.rows[0];
      if (revisionRow === undefined || !sameBuffer(revisionRow.content_hash, item.contentHash)) {
        throw new StaleApplyError('revisionのcontent_hashが変化しました');
      }
      const currentHash = createHash('sha256').update(revisionRow.content, 'utf8').digest();
      if (!sameBuffer(currentHash, item.contentHash)) {
        throw new StaleApplyError('revisionの入力hashが変化しました');
      }
      const sources = await client.query<{ message_id: string; message_revision: number }>(
        `SELECT message_id, message_revision
           FROM search_document_sources
          WHERE document_id = $1 AND revision = $2
          ORDER BY display_order`,
        [item.documentId, item.revision],
      );
      const messageIds = [...new Set(sources.rows.map((row) => row.message_id))];
      const messages = await client.query<{ id: string; current_revision: number }>(
        'SELECT id, current_revision FROM messages WHERE id = ANY($1::uuid[]) FOR SHARE',
        [messageIds],
      );
      const currentById = new Map(messages.rows.map((row) => [row.id, row.current_revision]));
      for (const source of sources.rows) {
        if (currentById.get(source.message_id) !== source.message_revision) {
          throw new StaleApplyError('出典message revisionが変化しました');
        }
      }

      await client.query(
        `INSERT INTO document_embeddings (document_id, revision, generation_id, embedding, input_hash)
         VALUES ($1, $2, $3, $4::vector, $5)
         ON CONFLICT (document_id, revision, generation_id)
         DO UPDATE SET embedding = EXCLUDED.embedding, input_hash = EXCLUDED.input_hash`,
        [item.documentId, item.revision, generation.id, vectorText(vector), item.contentHash],
      );
      await client.query(
        `UPDATE search_document_revisions SET status = 'ready', updated_at = now() WHERE document_id = $1 AND revision = $2`,
        [item.documentId, item.revision],
      );
      // 新revisionの公開時に、それ以前のready revisionはsupersededにする。
      await client.query(
        `UPDATE search_document_revisions
            SET status = 'superseded', updated_at = now()
          WHERE document_id = $1 AND revision <> $2 AND status = 'ready'`,
        [item.documentId, item.revision],
      );
      await client.query(
        `INSERT INTO document_publications (document_id, generation_id, revision, stale)
         VALUES ($1, $2, $3, false)
         ON CONFLICT (document_id, generation_id)
         DO UPDATE SET revision = EXCLUDED.revision, stale = false, updated_at = now()`,
        [item.documentId, generation.id, item.revision],
      );
    }

    const completed = await completeJob(client, {
      jobId: job.id,
      leaseToken: job.leaseToken,
      targetRevision: job.targetRevision,
    });
    if (!completed) {
      throw new LeaseLostError('jobを完了できません');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
