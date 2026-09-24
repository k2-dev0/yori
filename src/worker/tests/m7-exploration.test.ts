import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import {
  addProjectMember,
  insertEmployee,
  insertSession,
  resetDatabase,
  seedWorkspace,
  type WorkspaceFixture,
} from '../../db/tests/fixtures.js';
import { ensureActiveGeneration } from '../embedding.js';
import { loadVoyageTokenizer } from '../tokenizer.js';
import { advanceRevision, jevReply, readSearchRequest, seedMessage, seedRelation, seedSession } from './support.js';
import {
  allJevRawBody,
  basisVector,
  m7ChoiceSelector,
  runExecuteSearch,
  seedExecuteSearch,
  seedReadyDocument,
  similarityVector,
  startM7Providers,
  type M7ProviderOptions,
  type M7Providers,
} from './m7-support.js';

// M7採用シナリオ2〜7のRedテスト（docs/m7-design.md 9.4/10.3/12/13）。
// 既存のprocessJob・実PostgreSQL・loopback Jev/Voyage fixtureだけを使い、未実装の前後・明示/推定
// セッション継続・撤回訂正・token予算・保存時再検証を検出する。実Jev・実Voyage・実会話は送らない。

const pool = createPool(requireDatabaseUrl());
let workspace: WorkspaceFixture;
const openServers: Array<{ close(): Promise<void> }> = [];

before(async () => {
  await runMigrations(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
  workspace = await seedWorkspace(pool);
});

afterEach(async () => {
  const closing = openServers.splice(0);
  await Promise.all(closing.map((server) => server.close()));
});

after(async () => {
  await pool.end();
});

async function startProviders(options: M7ProviderOptions = {}): Promise<M7Providers> {
  const providers = await startM7Providers(pool, workspace.companyId, options);
  openServers.push(providers.jev, providers.voyage);
  return providers;
}

interface M7Evidence {
  message_id: string;
  revision: number;
  employee_id?: string;
  role?: string;
  occurred_at?: string;
  text: string;
  relation?: string;
  related_to_message_id?: string;
  related_to_revision?: number;
  source_kind?: string;
}

interface M7Match {
  case_or_document_id?: string;
  evidence?: M7Evidence[];
  related_evidence?: M7Evidence[];
  related_evidence_ids?: string[];
  truncated?: boolean;
}

interface M7SearchResult {
  request_id?: string;
  input_id?: string;
  input_revision?: number;
  status?: string;
  outcome?: string;
  matches?: M7Match[];
  warnings?: Array<string | { code?: string }>;
}

async function readStoredResult(requestId: string): Promise<M7SearchResult> {
  const request = await readSearchRequest(pool, requestId);
  assert.ok(request.result !== null && typeof request.result === 'object', 'search_request.resultが保存されていない');
  return request.result as M7SearchResult;
}

function primaryMatch(result: M7SearchResult): M7Match {
  const match = result.matches?.[0];
  assert.ok(match, 'matchedなのにmatchesがない');
  return match;
}

function relatedEvidence(match: M7Match): M7Evidence[] {
  return match.related_evidence ?? [];
}

function relatedWithText(match: M7Match, marker: string): M7Evidence | undefined {
  return relatedEvidence(match).find((item) => item.text.includes(marker));
}

function evidenceTexts(items: readonly M7Evidence[]): string[] {
  return items.map((item) => item.text);
}

function warningCodes(result: M7SearchResult): string[] {
  return (result.warnings ?? []).map((warning) => (typeof warning === 'string' ? warning : warning.code ?? ''));
}

// M7 session_links fixture。Redではtable不在のDBエラーで失敗し、migration要求を示す。
async function insertActiveSessionLink(input: { fromSessionId: string; toSessionId: string; evidenceMessageId: string }): Promise<void> {
  await pool.query(
    `INSERT INTO session_links
       (id, company_id, project_id, from_session_id, to_session_id, evidence_message_id, evidence_revision,
        is_explicit, status, created_by_employee_id, idempotency_key, condition_hash)
     VALUES ($1, $2, $3, $4, $5, $6, 1, true, 'active', $7, $8, $9)`,
    [
      uuidv7(),
      workspace.companyId,
      workspace.projectId,
      input.fromSessionId,
      input.toSessionId,
      input.evidenceMessageId,
      workspace.employeeId,
      `m7-link-${uuidv7()}`,
      'm7-condition',
    ],
  );
}

async function insertIssueEntity(documentId: string, entityKey = '#777'): Promise<void> {
  await pool.query(
    `INSERT INTO document_entities (id, document_id, revision, company_id, project_id, entity_type, entity_key)
     VALUES ($1, $2, 1, $3, $4, 'issue', $5)`,
    [uuidv7(), documentId, workspace.companyId, workspace.projectId, entityKey],
  );
}

// m4-documents/m5-searchと同じ合成base。token数を1刻みで作れる長さへ反復する。
const TOKEN_FIXTURE_BASE = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu '.repeat(500);

// Voyage tokenizerで正確にtarget tokenになる文字列を作る。予算境界のfixture専用。
function exactTokenText(tokenizer: { encode: (text: string) => { ids: number[] } }, target: number): string {
  let low = 1;
  let high = TOKEN_FIXTURE_BASE.length;
  let best = 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (tokenizer.encode(TOKEN_FIXTURE_BASE.slice(0, middle)).ids.length <= target) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const text = TOKEN_FIXTURE_BASE.slice(0, best);
  assert.equal(tokenizer.encode(text).ids.length, target, `token数${target}のfixture文字列を作れない`);
  return text;
}

describe('M7 代表根拠の前後2発言', () => {
  it('同一sessionのevidence前後2発言をcurrent revisionで返し、現在入力以降・旧revision・別案件を含めない', async () => {
    const { config } = await startProviders();
    const generation = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const startedAt = new Date('2026-09-21T00:00:00.000Z');
    const sessionId = await seedSession(pool, workspace, { sourceSessionId: 'm7-neighbor-session' });
    await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [sessionId, startedAt]);

    await seedMessage(pool, { sessionId, sequenceNo: 1, text: 'NEIGHBOR-BEFORE-2' });
    const before1 = await seedMessage(pool, { sessionId, sequenceNo: 2, text: 'NEIGHBOR-BEFORE-1-OLD' });
    await advanceRevision(pool, before1.messageId, 'NEIGHBOR-BEFORE-1-CURRENT');
    const primaryText = 'PRIMARY-MARKER-ANSWER 保存後の不具合と修正手順';
    const primary = await seedMessage(pool, { sessionId, sequenceNo: 3, role: 'assistant', text: primaryText });
    await seedMessage(pool, { sessionId, sequenceNo: 4, text: 'NEIGHBOR-AFTER-1' });
    await seedMessage(pool, { sessionId, sequenceNo: 5, text: 'NEIGHBOR-AFTER-2' });
    const input = await seedExecuteSearch(pool, {
      workspace,
      sessionId,
      sequenceNo: 6,
      text: 'QUERY-M7-NEIGHBOR 前後も確認する',
    });
    await seedMessage(pool, { sessionId, sequenceNo: 7, text: 'AFTER-INPUT-NOT-ALLOWED' });

    // 別案件の同sequence発言。session所属projectの境界をevidenceで確認する。
    const otherWorkspace = await seedWorkspace(pool, { name: 'company-other', repositoryIdentifier: 'repo-other' });
    const otherSession = await insertSession(pool, {
      projectId: otherWorkspace.projectId,
      employeeId: otherWorkspace.employeeId,
      sourceSessionId: 'm7-other-project',
      startedAt,
    });
    await seedMessage(pool, { sessionId: otherSession, sequenceNo: 2, text: 'OTHER-PROJECT-NEIGHBOR' });

    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId,
      documentKey: 'm7-neighbor-primary',
      content: primaryText,
      generationId: generation.id,
      embedding: basisVector(0, 1),
      sources: [{ messageId: primary.messageId, messageRevision: 1, startOffset: 0, endOffset: primaryText.length }],
    });
    await runExecuteSearch(pool, { jobId: input.jobId, config });

    const request = await readSearchRequest(pool, input.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const result = await readStoredResult(input.requestId);
    const match = primaryMatch(result);
    assert.ok(
      (match.evidence ?? []).some((item) => item.message_id === primary.messageId && item.text === primaryText),
      '代表根拠がmatches.evidenceにない',
    );

    const related = relatedEvidence(match);
    assert.ok(relatedWithText(match, 'NEIGHBOR-BEFORE-2'), `前2発言がない: ${JSON.stringify(evidenceTexts(related))}`);
    const currentBefore1 = relatedWithText(match, 'NEIGHBOR-BEFORE-1-CURRENT');
    assert.ok(currentBefore1, `前1発言のcurrent revisionがない: ${JSON.stringify(evidenceTexts(related))}`);
    assert.equal(currentBefore1.revision, 2, '前1発言が旧revisionを返している');
    assert.ok(relatedWithText(match, 'NEIGHBOR-AFTER-1'), '後1発言がない');
    assert.ok(relatedWithText(match, 'NEIGHBOR-AFTER-2'), '後2発言がない');
    const allTexts = evidenceTexts(related).join('\n');
    assert.ok(!allTexts.includes('NEIGHBOR-BEFORE-1-OLD'), '旧revisionの原文を返している');
    assert.ok(!allTexts.includes('QUERY-M7-NEIGHBOR'), '現在input自身を周辺発言として返している');
    assert.ok(!allTexts.includes('AFTER-INPUT-NOT-ALLOWED'), '現在input以降の同session発言を返している');
    assert.ok(!allTexts.includes('OTHER-PROJECT-NEIGHBOR'), '別案件の発言を返している');
    for (const item of related) {
      assert.equal(item.source_kind, 'neighbor', `周辺発言のsource_kindがneighborではない: ${JSON.stringify(item)}`);
    }
  });
});

describe('M7 明示session linkの探索', () => {
  it('両方向のactive linkを明示優先で探索し、3 hop・合計セッション・循環の上限を守る', async () => {
    const { config } = await startProviders();
    const generation = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const startedAt = new Date('2026-09-21T00:00:00.000Z');
    const primarySession = await seedSession(pool, workspace, { sourceSessionId: 'm7-link-primary' });
    await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [primarySession, startedAt]);
    const primaryText = 'PRIMARY-LINK-ANSWER';
    const primary = await seedMessage(pool, { sessionId: primarySession, sequenceNo: 1, role: 'assistant', text: primaryText });
    const input = await seedExecuteSearch(pool, { workspace, sessionId: primarySession, sequenceNo: 4, text: 'QUERY-M7-LINK' });

    const forwardSessions: string[] = [];
    for (let hop = 1; hop <= 4; hop += 1) {
      const sessionId = await seedSession(pool, workspace, { sourceSessionId: `m7-forward-${hop}` });
      await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [sessionId, new Date(startedAt.getTime() + hop * 60_000)]);
      await seedMessage(pool, { sessionId, sequenceNo: 1, text: `EXPLICIT-F${hop}` });
      forwardSessions.push(sessionId);
    }
    const reverseSession = await seedSession(pool, workspace, { sourceSessionId: 'm7-reverse' });
    await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [reverseSession, new Date(startedAt.getTime() - 60_000)]);
    await seedMessage(pool, { sessionId: reverseSession, sequenceNo: 1, text: 'EXPLICIT-R1' });

    // 推定候補との優先順位を比較するため、同社員の時刻隣接sessionも1件置く。
    const inferredSession = await seedSession(pool, workspace, { sourceSessionId: 'm7-inferred-order' });
    await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [inferredSession, new Date(startedAt.getTime() + 2 * 60_000)]);
    await seedMessage(pool, { sessionId: inferredSession, sequenceNo: 1, text: 'INFERRED-AFTER-EXPLICIT' });

    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: primarySession,
      documentKey: 'm7-link-primary-doc',
      content: primaryText,
      generationId: generation.id,
      embedding: basisVector(0, 1),
      sources: [{ messageId: primary.messageId, messageRevision: 1, startOffset: 0, endOffset: primaryText.length }],
    });
    await insertActiveSessionLink({ fromSessionId: primarySession, toSessionId: forwardSessions[0], evidenceMessageId: primary.messageId });
    for (let hop = 0; hop < forwardSessions.length - 1; hop += 1) {
      const evidence = await pool.query<{ id: string }>('SELECT id FROM messages WHERE session_id = $1 ORDER BY sequence_no LIMIT 1', [
        forwardSessions[hop],
      ]);
      await insertActiveSessionLink({
        fromSessionId: forwardSessions[hop],
        toSessionId: forwardSessions[hop + 1],
        evidenceMessageId: evidence.rows[0]?.id as string,
      });
    }
    const reverseEvidence = await pool.query<{ id: string }>('SELECT id FROM messages WHERE session_id = $1 LIMIT 1', [reverseSession]);
    await insertActiveSessionLink({
      fromSessionId: reverseSession,
      toSessionId: primarySession,
      evidenceMessageId: reverseEvidence.rows[0]?.id as string,
    });
    // F1 -> primary の逆方向linkで循環を作る。visited sessionは再追加しない。
    const f1Evidence = await pool.query<{ id: string }>('SELECT id FROM messages WHERE session_id = $1 LIMIT 1', [forwardSessions[0]]);
    await insertActiveSessionLink({
      fromSessionId: forwardSessions[0],
      toSessionId: primarySession,
      evidenceMessageId: f1Evidence.rows[0]?.id as string,
    });

    await runExecuteSearch(pool, { jobId: input.jobId, config });
    const request = await readSearchRequest(pool, input.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const match = primaryMatch(await readStoredResult(input.requestId));
    const related = relatedEvidence(match);

    for (const marker of ['EXPLICIT-R1', 'EXPLICIT-F1', 'EXPLICIT-F2', 'EXPLICIT-F3']) {
      const item = relatedWithText(match, marker);
      assert.ok(item, `明示linkの${marker}がない: ${JSON.stringify(evidenceTexts(related))}`);
      assert.equal(item.source_kind, 'explicit_session_link', `${marker}のsource_kindがexplicit_session_linkではない`);
    }
    assert.ok(!relatedWithText(match, 'EXPLICIT-F4'), '3 hopを超えたlink先を返している');
    const explicitMarker = relatedWithText(match, 'EXPLICIT-F1');
    const inferredMarker = relatedWithText(match, 'INFERRED-AFTER-EXPLICIT');
    assert.ok(inferredMarker, '推定候補がJev肯定時に採用されていない');
    assert.ok(
      related.indexOf(explicitMarker as M7Evidence) < related.indexOf(inferredMarker),
      '明示linkが推定候補より後ろに並んでいる',
    );

    // 循環時に同じ原文を再追加しない。visited message IDの重複がないことも確認する。
    const ids = related.map((item) => item.message_id);
    assert.equal(new Set(ids).size, ids.length, `related_evidenceに重複messageがある: ${JSON.stringify(ids)}`);
    assert.deepEqual(match.related_evidence_ids, [...new Set(ids)], 'related_evidence_idsが初出順の重複除去になっていない');
  });

  it('primaryを含む合計10セッションで探索を打ち切り、truncatedとwarningを返す', async () => {
    const { config } = await startProviders();
    const generation = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const startedAt = new Date('2026-09-21T00:00:00.000Z');
    const primarySession = await seedSession(pool, workspace, { sourceSessionId: 'm7-cap-primary' });
    await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [primarySession, startedAt]);
    const primaryText = 'PRIMARY-CAP-ANSWER';
    const primary = await seedMessage(pool, { sessionId: primarySession, sequenceNo: 1, role: 'assistant', text: primaryText });
    const input = await seedExecuteSearch(pool, { workspace, sessionId: primarySession, sequenceNo: 3, text: 'QUERY-M7-CAP' });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: primarySession,
      documentKey: 'm7-cap-primary-doc',
      content: primaryText,
      generationId: generation.id,
      embedding: basisVector(0, 1),
      sources: [{ messageId: primary.messageId, messageRevision: 1, startOffset: 0, endOffset: primaryText.length }],
    });

    // primary + 明示link先10件。合計session上限はprimaryを含む10なので、探索できるlink先は最大9件になる。
    const markers: string[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const sessionId = await seedSession(pool, workspace, { sourceSessionId: `m7-cap-${index}` });
      await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [sessionId, new Date(startedAt.getTime() + index * 60_000)]);
      const marker = `CAP-F${index}`;
      await seedMessage(pool, { sessionId, sequenceNo: 1, text: marker });
      markers.push(marker);
      await insertActiveSessionLink({ fromSessionId: primarySession, toSessionId: sessionId, evidenceMessageId: primary.messageId });
    }

    await runExecuteSearch(pool, { jobId: input.jobId, config });
    const request = await readSearchRequest(pool, input.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const result = await readStoredResult(input.requestId);
    const match = primaryMatch(result);
    assert.equal(match.truncated, true, 'session上限で打ち切ったのにtruncated=trueを返していない');
    assert.ok(warningCodes(result).some((code) => code.length > 0), `session上限の機械可読warningがない: ${JSON.stringify(result.warnings)}`);
    const present = markers.filter((marker) => relatedWithText(match, marker) !== undefined);
    assert.ok(present.length >= 1, `明示link先が1件も探索されていない: ${JSON.stringify(evidenceTexts(relatedEvidence(match)))}`);
    assert.ok(present.length <= 9, `primaryを含む10セッション上限を超えて${present.length}件の明示link先を返している`);
  });
});

describe('M7 evidence revision固定の明示link', () => {
  it('link作成後に根拠messageが改訂されたactive linkは辿らない', async () => {
    const { config } = await startProviders();
    const generation = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const primarySession = await seedSession(pool, workspace, { sourceSessionId: 'm7-stale-link-primary' });
    const primaryText = 'PRIMARY-STALE-LINK-ANSWER';
    const primary = await seedMessage(pool, { sessionId: primarySession, sequenceNo: 1, role: 'assistant', text: primaryText });
    // linkの根拠は代表根拠とは別messageにし、linkだけをstaleにする。
    const linkEvidence = await seedMessage(pool, { sessionId: primarySession, sequenceNo: 9, role: 'assistant', text: 'STALE-LINK-EVIDENCE' });
    const linkedSession = await seedSession(pool, workspace, { sourceSessionId: 'm7-stale-link-target' });
    await seedMessage(pool, { sessionId: linkedSession, sequenceNo: 1, text: 'STALE-LINK-CONTEXT' });
    await insertActiveSessionLink({ fromSessionId: primarySession, toSessionId: linkedSession, evidenceMessageId: linkEvidence.messageId });

    const input = await seedExecuteSearch(pool, { workspace, sessionId: primarySession, sequenceNo: 3, text: 'QUERY-M7-STALE-LINK' });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: primarySession,
      documentKey: 'm7-stale-link-primary-doc',
      content: primaryText,
      generationId: generation.id,
      embedding: basisVector(0, 1),
      sources: [{ messageId: primary.messageId, messageRevision: 1, startOffset: 0, endOffset: primaryText.length }],
    });
    // link作成後（保存後）に根拠messageだけを改訂する。
    await advanceRevision(pool, linkEvidence.messageId, 'STALE-LINK-EVIDENCE-REVISED');

    await runExecuteSearch(pool, { jobId: input.jobId, config });
    const request = await readSearchRequest(pool, input.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const match = primaryMatch(await readStoredResult(input.requestId));
    assert.ok(!relatedWithText(match, 'STALE-LINK-CONTEXT'), 'stale evidence linkの文脈を返している');
    assert.ok(
      !relatedEvidence(match).some((item) => item.source_kind === 'explicit_session_link'),
      `stale evidence linkのrelatedが残っている: ${JSON.stringify(evidenceTexts(relatedEvidence(match)))}`,
    );
  });
});

describe('M7 推定session候補', () => {
  it('同社員の前後各3sessionと共通Issue entityだけを候補にし、他社員の時間隣接を除外する', async () => {
    const { jev, config } = await startProviders();
    const generation = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const base = new Date('2026-09-21T00:00:00.000Z');
    const primarySession = await seedSession(pool, workspace, { sourceSessionId: 'm7-infer-primary' });
    await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [primarySession, base]);
    const primaryText = 'PRIMARY-INFER-MARKER Issue #777 の修正';
    const primary = await seedMessage(pool, { sessionId: primarySession, sequenceNo: 3, role: 'assistant', text: primaryText });
    const primaryDocumentId = await seedReadyDocument(pool, {
      id: uuidv7(),
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: primarySession,
      documentKey: 'm7-infer-primary-doc',
      content: primaryText,
      generationId: generation.id,
      embedding: basisVector(0, 1),
      sources: [{ messageId: primary.messageId, messageRevision: 1, startOffset: 0, endOffset: primaryText.length }],
    });
    await insertIssueEntity(primaryDocumentId);
    const input = await seedExecuteSearch(pool, { workspace, sessionId: primarySession, sequenceNo: 5, text: 'QUERY-M7-INFER' });

    const adjacent: Array<{ marker: string; offsetMinutes: number }> = [
      { marker: 'INFER-B3', offsetMinutes: -180 },
      { marker: 'INFER-B2', offsetMinutes: -120 },
      { marker: 'INFER-B1', offsetMinutes: -60 },
      { marker: 'INFER-C1', offsetMinutes: 60 },
      { marker: 'INFER-C2', offsetMinutes: 120 },
      { marker: 'INFER-C3', offsetMinutes: 180 },
      { marker: 'INFER-B4', offsetMinutes: -240 },
      { marker: 'INFER-C4', offsetMinutes: 240 },
    ];
    for (const candidate of adjacent) {
      const sessionId = await seedSession(pool, workspace, { sourceSessionId: `m7-${candidate.marker}` });
      await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [sessionId, new Date(base.getTime() + candidate.offsetMinutes * 60_000)]);
      await seedMessage(pool, { sessionId, sequenceNo: 1, text: candidate.marker });
    }

    const otherEmployee = await insertEmployee(pool, workspace.companyId, 'employee-other');
    await addProjectMember(pool, workspace.projectId, otherEmployee);
    const otherEmployeeSession = await insertSession(pool, {
      projectId: workspace.projectId,
      employeeId: otherEmployee,
      sourceSessionId: 'm7-other-employee',
      startedAt: new Date(base.getTime() - 30 * 60_000),
    });
    await seedMessage(pool, { sessionId: otherEmployeeSession, sequenceNo: 1, text: 'INFER-OTHER-EMPLOYEE' });

    // 他社員でも代表根拠と共通のIssue entityを持つsessionは候補にする。
    const entitySession = await insertSession(pool, {
      projectId: workspace.projectId,
      employeeId: otherEmployee,
      sourceSessionId: 'm7-common-entity',
      startedAt: new Date(base.getTime() + 5 * 60 * 60_000),
    });
    const entityText = 'INFER-COMMON-ENTITY Issue #777 の対応';
    const entityMessage = await seedMessage(pool, { sessionId: entitySession, sequenceNo: 1, role: 'assistant', text: entityText });
    const entityDocumentId = await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: entitySession,
      documentKey: 'm7-common-entity-doc',
      content: entityText,
      generationId: generation.id,
      embedding: similarityVector(1),
      sources: [{ messageId: entityMessage.messageId, messageRevision: 1, startOffset: 0, endOffset: entityText.length }],
    });
    await insertIssueEntity(entityDocumentId);

    await runExecuteSearch(pool, { jobId: input.jobId, config });
    const request = await readSearchRequest(pool, input.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const match = primaryMatch(await readStoredResult(input.requestId));
    const related = relatedEvidence(match);

    for (const marker of ['INFER-B1', 'INFER-B2', 'INFER-B3', 'INFER-C1', 'INFER-C2', 'INFER-C3', 'INFER-COMMON-ENTITY']) {
      const item = relatedWithText(match, marker);
      assert.ok(item, `推定候補${marker}がない: ${JSON.stringify(evidenceTexts(related))}`);
      assert.equal(item.source_kind, 'inferred_session_link', `${marker}のsource_kindがinferred_session_linkではない`);
    }
    for (const marker of ['INFER-B4', 'INFER-C4', 'INFER-OTHER-EMPLOYEE']) {
      assert.ok(!relatedWithText(match, marker), `候補外の${marker}を返している: ${JSON.stringify(evidenceTexts(related))}`);
    }

    // 候補外のsessionはJevへ渡さず、候補は双方の判定材料として渡す。
    const jevBody = allJevRawBody(jev);
    for (const marker of ['INFER-B1', 'INFER-C1', 'INFER-COMMON-ENTITY']) {
      assert.ok(jevBody.includes(marker), `推定候補${marker}がJev判定に渡っていない`);
    }
    for (const marker of ['INFER-B4', 'INFER-C4', 'INFER-OTHER-EMPLOYEE']) {
      assert.ok(!jevBody.includes(marker), `候補外の${marker}をJevへ渡している`);
    }
  });

  it('Jevで現在質問・継続元の双方がpositiveでない推定候補は採用せず、明示linkは維持する', async () => {
    const primaryDocumentId = uuidv7();
    const { config } = await startProviders({ jevMode: 'primary-only', primaryDocumentId });
    const generation = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const base = new Date('2026-09-21T00:00:00.000Z');
    const primarySession = await seedSession(pool, workspace, { sourceSessionId: 'm7-primary-only' });
    await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [primarySession, base]);
    const primaryText = 'PRIMARY-ONLY-MARKER';
    const primary = await seedMessage(pool, { sessionId: primarySession, sequenceNo: 1, role: 'assistant', text: primaryText });
    await seedReadyDocument(pool, {
      id: primaryDocumentId,
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: primarySession,
      documentKey: 'm7-primary-only-doc',
      content: primaryText,
      generationId: generation.id,
      embedding: basisVector(0, 1),
      sources: [{ messageId: primary.messageId, messageRevision: 1, startOffset: 0, endOffset: primaryText.length }],
    });
    const input = await seedExecuteSearch(pool, { workspace, sessionId: primarySession, sequenceNo: 4, text: 'QUERY-M7-PRIMARY-ONLY' });

    const explicitSession = await seedSession(pool, workspace, { sourceSessionId: 'm7-explicit-kept' });
    await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [explicitSession, new Date(base.getTime() + 60_000)]);
    await seedMessage(pool, { sessionId: explicitSession, sequenceNo: 1, text: 'EXPLICIT-KEPT' });
    await insertActiveSessionLink({ fromSessionId: primarySession, toSessionId: explicitSession, evidenceMessageId: primary.messageId });

    const adjacentSession = await seedSession(pool, workspace, { sourceSessionId: 'm7-inferred-dropped' });
    await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [adjacentSession, new Date(base.getTime() + 120_000)]);
    await seedMessage(pool, { sessionId: adjacentSession, sequenceNo: 1, text: 'INFERRED-DROPPED' });

    await runExecuteSearch(pool, { jobId: input.jobId, config });
    const request = await readSearchRequest(pool, input.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const match = primaryMatch(await readStoredResult(input.requestId));
    assert.ok(relatedWithText(match, 'EXPLICIT-KEPT'), 'Jev否定的な推定候補と同じ探索で明示linkまで落としている');
    assert.ok(!relatedWithText(match, 'INFERRED-DROPPED'), 'Jevがpositiveでない推定候補を採用している');
  });
});

describe('M7 revoke・changeの後続探索', () => {
  it('後続関係を最大3 hop追跡し、元根拠を残して循環を重複させない', async () => {
    const { config } = await startProviders();
    const generation = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const primarySession = await seedSession(pool, workspace, { sourceSessionId: 'm7-correction-primary' });
    const primaryText = 'PRIMARY-CORRECTION-ANSWER 旧手順';
    const primary = await seedMessage(pool, { sessionId: primarySession, sequenceNo: 3, role: 'assistant', text: primaryText });
    const input = await seedExecuteSearch(pool, { workspace, sessionId: primarySession, sequenceNo: 6, text: 'QUERY-M7-CORRECTION' });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: primarySession,
      documentKey: 'm7-correction-primary-doc',
      content: primaryText,
      generationId: generation.id,
      embedding: basisVector(0, 1),
      sources: [{ messageId: primary.messageId, messageRevision: 1, startOffset: 0, endOffset: primaryText.length }],
    });

    // 訂正・撤回は別sessionに置き、代表根拠と現在inputのsession境界を混ぜない。
    const correctionSession = await seedSession(pool, workspace, { sourceSessionId: 'm7-corrections' });
    const c1 = await seedMessage(pool, { sessionId: correctionSession, sequenceNo: 1, text: 'CORRECTION-1' });
    const c2 = await seedMessage(pool, { sessionId: correctionSession, sequenceNo: 2, text: 'CORRECTION-2' });
    const c3 = await seedMessage(pool, { sessionId: correctionSession, sequenceNo: 3, text: 'CORRECTION-3' });
    const c4 = await seedMessage(pool, { sessionId: correctionSession, sequenceNo: 4, text: 'CORRECTION-4' });
    void c4;
    await seedRelation(pool, { sourceMessageId: c1.messageId, sourceRevision: 1, targetMessageId: primary.messageId, targetRevision: 1, relation: 'change' });
    await seedRelation(pool, { sourceMessageId: c2.messageId, sourceRevision: 1, targetMessageId: c1.messageId, targetRevision: 1, relation: 'revoke' });
    await seedRelation(pool, { sourceMessageId: c3.messageId, sourceRevision: 1, targetMessageId: c2.messageId, targetRevision: 1, relation: 'change' });
    await seedRelation(pool, { sourceMessageId: c4.messageId, sourceRevision: 1, targetMessageId: c3.messageId, targetRevision: 1, relation: 'change' });
    // primary -> C3 の関係を置き、C3の後続としてprimaryへ戻る循環を作る。
    await seedRelation(pool, { sourceMessageId: primary.messageId, sourceRevision: 1, targetMessageId: c3.messageId, targetRevision: 1, relation: 'change' });

    await runExecuteSearch(pool, { jobId: input.jobId, config });
    const request = await readSearchRequest(pool, input.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const match = primaryMatch(await readStoredResult(input.requestId));
    assert.ok(
      (match.evidence ?? []).some((item) => item.message_id === primary.messageId),
      '元根拠がmatches.evidenceから消えている',
    );
    const related = relatedEvidence(match);
    const expected = [
      { marker: 'CORRECTION-1', relation: 'change', relatedTo: primary.messageId },
      { marker: 'CORRECTION-2', relation: 'revoke', relatedTo: c1.messageId },
      { marker: 'CORRECTION-3', relation: 'change', relatedTo: c2.messageId },
    ];
    for (const item of expected) {
      const found = relatedWithText(match, item.marker);
      assert.ok(found, `訂正chainの${item.marker}がない: ${JSON.stringify(evidenceTexts(related))}`);
      assert.equal(found.relation, item.relation, `${item.marker}のrelation`);
      assert.equal(found.related_to_message_id, item.relatedTo, `${item.marker}のrelated_to_message_id`);
      assert.equal(found.related_to_revision, 1, `${item.marker}のrelated_to_revision`);
      assert.equal(found.source_kind, 'correction', `${item.marker}のsource_kind`);
    }
    assert.ok(!relatedWithText(match, 'CORRECTION-4'), '3 hopを超えた訂正を返している');
    assert.equal(
      related.filter((item) => item.message_id === primary.messageId).length,
      0,
      '循環時に元根拠をrelated_evidenceへ重複させている',
    );
    const ids = related.map((item) => item.message_id);
    assert.equal(new Set(ids).size, ids.length, 'related_evidenceに重複messageがある');
    assert.deepEqual(match.related_evidence_ids, [...new Set(ids)], 'related_evidence_idsが初出順の重複除去になっていない');
  });
});

describe('M7 最終コンテキストのtoken予算', () => {
  it('約6,000 tokenの優先順を守り、primary原文を切り詰めず、打切りをtruncatedとwarningで返す', async () => {
    const tokenizer = await loadVoyageTokenizer();
    const primaryBody = exactTokenText(tokenizer, 400);
    const primaryText = `${primaryBody} PRIMARY-TOKEN-ANCHOR`;
    const { config } = await startProviders();
    const generation = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const primarySession = await seedSession(pool, workspace, { sourceSessionId: 'm7-budget-primary' });
    const primary = await seedMessage(pool, { sessionId: primarySession, sequenceNo: 3, role: 'assistant', text: primaryText });
    await seedMessage(pool, { sessionId: primarySession, sequenceNo: 4, text: 'BUDGET-NEIGHBOR-SMALL' });
    const input = await seedExecuteSearch(pool, { workspace, sessionId: primarySession, sequenceNo: 6, text: 'QUERY-M7-BUDGET' });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: primarySession,
      documentKey: 'm7-budget-primary-doc',
      content: primaryText,
      generationId: generation.id,
      embedding: basisVector(0, 1),
      sources: [{ messageId: primary.messageId, messageRevision: 1, startOffset: 0, endOffset: primaryText.length }],
    });

    const correctionSession = await seedSession(pool, workspace, { sourceSessionId: 'm7-budget-correction' });
    const correctionText = `${exactTokenText(tokenizer, 2_000)} CORRECTION-BIG`;
    const correction = await seedMessage(pool, { sessionId: correctionSession, sequenceNo: 1, text: correctionText });
    await seedRelation(pool, { sourceMessageId: correction.messageId, sourceRevision: 1, targetMessageId: primary.messageId, targetRevision: 1, relation: 'change' });

    const explicitSession = await seedSession(pool, workspace, { sourceSessionId: 'm7-budget-explicit' });
    const explicitText = `${exactTokenText(tokenizer, 2_500)} EXPLICIT-BIG`;
    const explicitMessage = await seedMessage(pool, { sessionId: explicitSession, sequenceNo: 1, text: explicitText });
    await insertActiveSessionLink({ fromSessionId: primarySession, toSessionId: explicitSession, evidenceMessageId: explicitMessage.messageId });

    const inferredSession = await seedSession(pool, workspace, { sourceSessionId: 'm7-budget-inferred' });
    await pool.query("UPDATE sessions SET started_at = $2 WHERE id = $1", [inferredSession, new Date('2026-09-21T01:00:00.000Z')]);
    const inferredText = `${exactTokenText(tokenizer, 3_000)} INFERRED-BIG`;
    await seedMessage(pool, { sessionId: inferredSession, sequenceNo: 1, text: inferredText });

    await runExecuteSearch(pool, { jobId: input.jobId, config });
    const request = await readSearchRequest(pool, input.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const result = await readStoredResult(input.requestId);
    const match = primaryMatch(result);
    const related = relatedEvidence(match);

    const primaryEvidence = (match.evidence ?? []).find((item) => item.message_id === primary.messageId);
    assert.ok(primaryEvidence, '代表根拠がない');
    assert.equal(primaryEvidence.text, primaryText, '代表根拠の原文を切り詰めている');
    assert.ok(relatedWithText(match, 'CORRECTION-BIG'), '優先度の高い訂正を予算内で採用していない');
    assert.ok(relatedWithText(match, 'EXPLICIT-BIG'), '明示linkを推定候補より優先していない');
    assert.ok(!relatedWithText(match, 'INFERRED-BIG'), '優先度の低い推定候補を予算超過で採用している');

    const additionalTokens = related.reduce((total, item) => total + tokenizer.encode(item.text).ids.length, 0);
    assert.ok(additionalTokens <= 6_000, `追加候補が6,000 tokenを超えている: ${additionalTokens}`);
    assert.equal(match.truncated, true, '打切り時にtruncated=trueを返していない');
    assert.ok(warningCodes(result).includes('context_token_budget_exceeded'), `warningにcontext_token_budget_exceededがない: ${JSON.stringify(result.warnings)}`);

    const rank: Record<string, number> = { neighbor: 0, correction: 1, explicit_session_link: 2, inferred_session_link: 3 };
    let previous = 0;
    for (const item of related) {
      const current = rank[item.source_kind ?? ''] ?? 0;
      assert.ok(current >= previous, `優先順が逆転している: ${JSON.stringify(related.map((entry) => entry.source_kind))}`);
      previous = current;
    }
  });

  it('primary単独が6,000 tokenを超えても原文を切り詰めず、truncatedとwarningを返す', async () => {
    const tokenizer = await loadVoyageTokenizer();
    const primaryText = exactTokenText(tokenizer, 6_500);
    const { config } = await startProviders();
    const generation = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const primarySession = await seedSession(pool, workspace, { sourceSessionId: 'm7-oversized-primary' });
    const primary = await seedMessage(pool, { sessionId: primarySession, sequenceNo: 1, role: 'assistant', text: primaryText });
    const input = await seedExecuteSearch(pool, { workspace, sessionId: primarySession, sequenceNo: 3, text: 'QUERY-M7-OVERSIZED' });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: primarySession,
      documentKey: 'm7-oversized-primary-doc',
      content: primaryText,
      generationId: generation.id,
      embedding: basisVector(0, 1),
      sources: [{ messageId: primary.messageId, messageRevision: 1, startOffset: 0, endOffset: primaryText.length }],
    });

    await runExecuteSearch(pool, { jobId: input.jobId, config });
    const request = await readSearchRequest(pool, input.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const result = await readStoredResult(input.requestId);
    const match = primaryMatch(result);
    const primaryEvidence = (match.evidence ?? []).find((item) => item.message_id === primary.messageId);
    assert.ok(primaryEvidence, '代表根拠がない');
    assert.equal(primaryEvidence.text, primaryText, '代表根拠の原文を切り詰めている');
    assert.equal(match.truncated, true, '代表根拠が6,000 tokenを超えたのにtruncated=trueを返していない');
    assert.ok(
      warningCodes(result).includes('context_token_budget_exceeded'),
      `warningにcontext_token_budget_exceededがない: ${JSON.stringify(result.warnings)}`,
    );
  });
});

describe('M7 保存直前の再検証', () => {
  it('候補判定中のlink revokeを反映し、is_explicitなactive linkの原文だけを返す', async () => {
    const gate = createExternalGate();
    gate.armed = true;
    const { config } = await startProviders({
      jevResponder: async (request) => {
        if (gate.armed) {
          gate.armed = false;
          gate.enter();
          await gate.waitRelease();
        }
        return { body: jevReply(request, m7ChoiceSelector('positive')) };
      },
    });
    const generation = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const primarySession = await seedSession(pool, workspace, { sourceSessionId: 'm7-revalidate-primary' });
    const primaryText = 'PRIMARY-REVALIDATE-ANSWER';
    const primary = await seedMessage(pool, { sessionId: primarySession, sequenceNo: 3, role: 'assistant', text: primaryText });
    const input = await seedExecuteSearch(pool, { workspace, sessionId: primarySession, sequenceNo: 6, text: 'QUERY-M7-REVALIDATE' });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: primarySession,
      documentKey: 'm7-revalidate-primary-doc',
      content: primaryText,
      generationId: generation.id,
      embedding: basisVector(0, 1),
      sources: [{ messageId: primary.messageId, messageRevision: 1, startOffset: 0, endOffset: primaryText.length }],
    });

    const linkedSession = await seedSession(pool, workspace, { sourceSessionId: 'm7-revalidate-linked' });
    const linked = await seedMessage(pool, { sessionId: linkedSession, sequenceNo: 1, text: 'EXPLICIT-REVOKED' });
    await insertActiveSessionLink({ fromSessionId: primarySession, toSessionId: linkedSession, evidenceMessageId: linked.messageId });

    const processing = runExecuteSearch(pool, { jobId: input.jobId, config });
    const entered = await gate.waitForEntry(5_000);
    assert.ok(entered, 'Jev呼出し前に処理が終了した');
    await pool.query("UPDATE session_links SET status = 'revoked', updated_at = now() WHERE to_session_id = $1", [linkedSession]);
    gate.release();
    await processing;

    const request = await readSearchRequest(pool, input.requestId);
    assert.equal(request.status, 'completed');
    const match = primaryMatch(await readStoredResult(input.requestId));
    assert.ok(!relatedWithText(match, 'EXPLICIT-REVOKED'), '保存直前にrevokeされたlinkの原文を返している');
  });
});

describe('M7 別session代表根拠の周辺・継続探索', () => {
  it('primary evidenceが別sessionでもneighbor/correction/link/inferredを取得し、input境界は現在sessionだけに適用する', async () => {
    const { config } = await startProviders();
    const generation = await ensureActiveGeneration(
      pool,
      { companyId: workspace.companyId, projectId: workspace.projectId },
      config,
    );
    const base = new Date('2026-09-21T00:00:00.000Z');

    // 現在inputのsession。input以降の同session発言はrelatedへ含めない。
    const inputSession = await seedSession(pool, workspace, { sourceSessionId: 'm7-cross-input' });
    const input = await seedExecuteSearch(pool, { workspace, sessionId: inputSession, sequenceNo: 1, text: 'QUERY-M7-CROSS' });
    await seedMessage(pool, { sessionId: inputSession, sequenceNo: 2, text: 'CROSS-AFTER-INPUT' });

    // 代表候補のsession（現在inputとは別session）。
    const primarySession = await seedSession(pool, workspace, { sourceSessionId: 'm7-cross-primary' });
    await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [primarySession, base]);
    await seedMessage(pool, { sessionId: primarySession, sequenceNo: 1, text: 'CROSS-NEIGHBOR-1' });
    const primaryText = 'CROSS-PRIMARY-ANSWER';
    const primary = await seedMessage(pool, { sessionId: primarySession, sequenceNo: 2, role: 'assistant', text: primaryText });
    await seedMessage(pool, { sessionId: primarySession, sequenceNo: 3, text: 'CROSS-NEIGHBOR-2' });
    await seedReadyDocument(pool, {
      companyId: workspace.companyId,
      projectId: workspace.projectId,
      sessionId: primarySession,
      documentKey: 'm7-cross-primary-doc',
      content: primaryText,
      generationId: generation.id,
      embedding: basisVector(0, 1),
      sources: [{ messageId: primary.messageId, messageRevision: 1, startOffset: 0, endOffset: primaryText.length }],
    });

    // 後続の訂正。
    const correctionSession = await seedSession(pool, workspace, { sourceSessionId: 'm7-cross-correction' });
    await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [correctionSession, new Date(base.getTime() + 4 * 60_000)]);
    const correction = await seedMessage(pool, { sessionId: correctionSession, sequenceNo: 1, text: 'CROSS-CORRECTION' });
    await seedRelation(pool, {
      sourceMessageId: correction.messageId,
      sourceRevision: 1,
      targetMessageId: primary.messageId,
      targetRevision: 1,
      relation: 'change',
    });

    // 明示link先。
    const linkedSession = await seedSession(pool, workspace, { sourceSessionId: 'm7-cross-linked' });
    await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [linkedSession, new Date(base.getTime() + 5 * 60_000)]);
    await seedMessage(pool, { sessionId: linkedSession, sequenceNo: 1, text: 'CROSS-EXPLICIT' });
    await insertActiveSessionLink({ fromSessionId: primarySession, toSessionId: linkedSession, evidenceMessageId: primary.messageId });

    // 同社員の隣接session（推定候補）。
    const inferredSession = await seedSession(pool, workspace, { sourceSessionId: 'm7-cross-inferred' });
    await pool.query('UPDATE sessions SET started_at = $2 WHERE id = $1', [inferredSession, new Date(base.getTime() + 60_000)]);
    await seedMessage(pool, { sessionId: inferredSession, sequenceNo: 1, text: 'CROSS-INFERRED' });

    await runExecuteSearch(pool, { jobId: input.jobId, config });
    const request = await readSearchRequest(pool, input.requestId);
    assert.equal(request.status, 'completed');
    assert.equal(request.outcome, 'matched');
    const match = primaryMatch(await readStoredResult(input.requestId));
    assert.ok(
      (match.evidence ?? []).some((item) => item.message_id === primary.messageId),
      '別session代表根拠がmatches.evidenceにない',
    );

    for (const marker of ['CROSS-NEIGHBOR-1', 'CROSS-NEIGHBOR-2']) {
      const item = relatedWithText(match, marker);
      assert.ok(item, `別session代表の周辺${marker}がない: ${JSON.stringify(evidenceTexts(relatedEvidence(match)))}`);
      assert.equal(item.source_kind, 'neighbor', `${marker}のsource_kind`);
    }
    const correctionItem = relatedWithText(match, 'CROSS-CORRECTION');
    assert.ok(correctionItem, '別session代表の訂正がない');
    assert.equal(correctionItem.source_kind, 'correction');
    assert.equal(correctionItem.related_to_message_id, primary.messageId);
    const explicitItem = relatedWithText(match, 'CROSS-EXPLICIT');
    assert.ok(explicitItem, '別session代表の明示link文脈がない');
    assert.equal(explicitItem.source_kind, 'explicit_session_link');
    const inferredItem = relatedWithText(match, 'CROSS-INFERRED');
    assert.ok(inferredItem, '別session代表の推定候補がない');
    assert.equal(inferredItem.source_kind, 'inferred_session_link');
    assert.ok(!relatedWithText(match, 'CROSS-AFTER-INPUT'), '現在input以降の同session発言をrelatedへ含めている');
  });
});

// 外部待機中にlink状態を変更するための、Jev fixture側の合図。
interface ExternalGate {
  armed: boolean;
  enter(): void;
  waitForEntry(timeoutMs: number): Promise<boolean>;
  release(): void;
  waitRelease(): Promise<void>;
}

function createExternalGate(): ExternalGate {
  let entered = false;
  let resolveEntered: (() => void) | undefined;
  const enteredPromise = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  let resolveRelease: (() => void) | undefined;
  const releasePromise = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  return {
    armed: false,
    enter() {
      entered = true;
      resolveEntered?.();
    },
    async waitForEntry(timeoutMs: number): Promise<boolean> {
      if (entered) {
        return true;
      }
      await Promise.race([enteredPromise, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
      return entered;
    },
    release() {
      resolveRelease?.();
    },
    waitRelease() {
      return releasePromise;
    },
  };
}
