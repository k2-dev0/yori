import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { v7 as uuidv7 } from 'uuid';
import { buildApp } from '../app.js';
import { AUTO_SEARCH_POLICY_VERSION } from '../contract.js';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import {
  insertMessage,
  insertSession,
  resetDatabase,
  seedWorkspace,
  sha256Bytes,
  type WorkspaceFixture,
} from '../../db/tests/fixtures.js';
import { WORKER_POLICY_VERSION } from '../../worker/contract.js';
import { advanceMessageRevision, getSearchById, getSearchByInput } from './m6-support.js';

// M7 scenario 7: 結果取得時の再検証。GET /v1/searches/:id と by-inputのdirect matchedでも
// primary/related/inputのcurrent revision・案件・input境界、relation/linkの有効状態を確認し、
// 無効relatedはitem単位で落とし、primary無効はmatch全体をno_matchへ落とす。
// 内部検証metadata（_link_id）はAPI viewへ出さない。

const pool = createPool(requireDatabaseUrl());
const app = buildApp({ pool });
let workspace: WorkspaceFixture;

before(async () => {
  await runMigrations(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
  workspace = await seedWorkspace(pool);
});

after(async () => {
  await app.close();
  await pool.end();
});

interface RelatedFixture {
  messageId: string;
  revision: number;
  employeeId: string;
  role: string;
  occurredAt: string;
  text: string;
  sourceKind: string;
  relation?: string;
  relatedToMessageId?: string;
  relatedToRevision?: number;
  linkId?: string;
}

function relatedJson(input: RelatedFixture): Record<string, unknown> {
  return {
    message_id: input.messageId,
    revision: input.revision,
    employee_id: input.employeeId,
    role: input.role,
    occurred_at: input.occurredAt,
    text: input.text,
    source_kind: input.sourceKind,
    ...(input.relation === undefined
      ? {}
      : {
          relation: input.relation,
          related_to_message_id: input.relatedToMessageId,
          related_to_revision: input.relatedToRevision,
        }),
    ...(input.linkId === undefined ? {} : { _link_id: input.linkId }),
  };
}

function directResult(input: {
  requestId: string;
  inputId: string;
  inputRevision: number;
  projectId: string;
  evidence: RelatedFixture[];
  related?: RelatedFixture[];
}): Record<string, unknown> {
  const related = input.related === undefined ? undefined : input.related.map(relatedJson);
  return {
    request_id: input.requestId,
    input_id: input.inputId,
    input_revision: input.inputRevision,
    trigger: 'auto',
    search_action: 'new_search',
    reused_from_request_id: null,
    status: 'completed',
    outcome: 'matched',
    project_id: input.projectId,
    index_status: {
      pending_documents: 0,
      failed_documents: 0,
      embedding_generation_id: uuidv7(),
      search_mode: 'exact_vector_and_entity',
    },
    matches: [
      {
        case_or_document_id: uuidv7(),
        relevance: 'direct',
        relevance_kind: ['similar_symptom'],
        claim_status: 'agent_reported',
        evidence: input.evidence.map((item) => ({
          message_id: item.messageId,
          revision: item.revision,
          employee_id: item.employeeId,
          role: item.role,
          occurred_at: item.occurredAt,
          text: item.text,
        })),
        ...(related === undefined
          ? {}
          : {
              related_evidence: related,
              related_evidence_ids: [...new Set(related.map((item) => item.message_id))],
            }),
        truncated: false,
      },
    ],
    warnings: [],
  };
}

interface SeededSession {
  sessionId: string;
  messageId: string;
  sourceMessageId: string;
}

async function seedSessionWithMessage(sourceSessionId: string, sequenceNo: number, text: string, role: 'user' | 'assistant' = 'assistant'): Promise<SeededSession> {
  const sessionId = await insertSession(pool, {
    projectId: workspace.projectId,
    employeeId: workspace.employeeId,
    source: 'codex',
    sourceScope: `v1|${workspace.companyId}|${workspace.employeeId}|scope-a`,
    sourceSessionId,
  });
  const sourceMessageId = `msg-${sourceSessionId}-${sequenceNo}`;
  const message = await insertMessage(pool, { sessionId, sourceMessageId, sequenceNo, role, text });
  return { sessionId, messageId: message.messageId, sourceMessageId };
}

async function insertSearchRequest(input: {
  requestId: string;
  sessionId: string;
  inputMessageId: string;
  inputRevision: number;
  inputSequenceNo: number;
  result: Record<string, unknown>;
}): Promise<string> {
  const requestId = input.requestId;
  await pool.query(
    `INSERT INTO search_requests
       (id, company_id, project_id, employee_id, session_id, input_id, input_revision, input_sequence_no,
        trigger, status, outcome, search_action, policy_version, result, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'auto', 'completed', 'matched', 'new_search', $9, $10::jsonb, now(), now())`,
    [
      requestId,
      workspace.companyId,
      workspace.projectId,
      workspace.employeeId,
      input.sessionId,
      input.inputMessageId,
      input.inputRevision,
      input.inputSequenceNo,
      AUTO_SEARCH_POLICY_VERSION,
      JSON.stringify(input.result),
    ],
  );
  return requestId;
}

async function insertLink(fromSessionId: string, toSessionId: string, evidenceMessageId: string): Promise<string> {
  const linkId = uuidv7();
  await pool.query(
    `INSERT INTO session_links
       (id, company_id, project_id, from_session_id, to_session_id, evidence_message_id, evidence_revision,
        is_explicit, status, created_by_employee_id, idempotency_key, condition_hash)
     VALUES ($1, $2, $3, $4, $5, $6, 1, true, 'active', $7, $8, $9)`,
    [linkId, workspace.companyId, workspace.projectId, fromSessionId, toSessionId, evidenceMessageId, workspace.employeeId, `m7-reval-${uuidv7()}`, sha256Bytes(linkId)],
  );
  return linkId;
}

async function insertRelation(sourceMessageId: string, targetMessageId: string, relation: string): Promise<string> {
  const relationId = uuidv7();
  await pool.query(
    `INSERT INTO message_relations
       (id, source_message_id, source_revision, target_message_id, target_revision, relation, is_explicit, policy_version, evidence_ranges)
     VALUES ($1, $2, 1, $3, 1, $4, true, $5, '[]'::jsonb)`,
    [relationId, sourceMessageId, targetMessageId, relation, WORKER_POLICY_VERSION],
  );
  return relationId;
}

interface DirectMatchBody {
  status?: string;
  outcome?: string | null;
  error_code?: string | null;
  matches?: Array<{
    evidence?: Array<{ message_id?: string; text?: string }>;
    related_evidence?: Array<Record<string, unknown>>;
    related_evidence_ids?: string[];
  }>;
}

interface RevalidationFixture {
  requestId: string;
  primary: SeededSession;
  input: SeededSession;
  linkEvidence: { messageId: string };
  neighbor: RelatedFixture;
  correction: RelatedFixture;
  explicit: RelatedFixture;
  explicitLinkId: string;
  relationId: string;
}

// primary evidence + neighbor/correction/explicit relatedを持つdirect matched受付を作る。
async function seedRevalidationFixture(): Promise<RevalidationFixture> {
  const input = await seedSessionWithMessage('m7-reval-input', 1, 'REVAL-INPUT-QUERY', 'user');
  const primarySession = await seedSessionWithMessage('m7-reval-primary', 2, 'REVAL-PRIMARY-ANSWER');
  const neighborSession = await seedSessionWithMessage('m7-reval-neighbor', 1, 'REVAL-NEIGHBOR');
  const correctionSession = await seedSessionWithMessage('m7-reval-correction', 1, 'REVAL-CORRECTION', 'user');
  const linkedSession = await seedSessionWithMessage('m7-reval-linked', 1, 'REVAL-EXPLICIT', 'user');
  // linkの根拠は代表evidenceとは別messageにし、link evidenceの改訂だけを検証できるようにする。
  const linkEvidence = await insertMessage(pool, {
    sessionId: primarySession.sessionId,
    sourceMessageId: 'msg-m7-reval-link-evidence',
    sequenceNo: 9,
    role: 'assistant',
    text: 'REVAL-LINK-EVIDENCE',
  });
  const linkId = await insertLink(primarySession.sessionId, linkedSession.sessionId, linkEvidence.messageId);
  const relationId = await insertRelation(correctionSession.messageId, primarySession.messageId, 'change');
  const primaryEvidence: RelatedFixture = {
    messageId: primarySession.messageId,
    revision: 1,
    employeeId: workspace.employeeId,
    role: 'assistant',
    occurredAt: '2026-09-21T01:00:00.000Z',
    text: 'REVAL-PRIMARY-ANSWER',
    sourceKind: 'neighbor',
  };
  const neighbor: RelatedFixture = {
    messageId: neighborSession.messageId,
    revision: 1,
    employeeId: workspace.employeeId,
    role: 'assistant',
    occurredAt: '2026-09-21T01:01:00.000Z',
    text: 'REVAL-NEIGHBOR',
    sourceKind: 'neighbor',
  };
  const correction: RelatedFixture = {
    messageId: correctionSession.messageId,
    revision: 1,
    employeeId: workspace.employeeId,
    role: 'user',
    occurredAt: '2026-09-21T01:02:00.000Z',
    text: 'REVAL-CORRECTION',
    sourceKind: 'correction',
    relation: 'change',
    relatedToMessageId: primarySession.messageId,
    relatedToRevision: 1,
  };
  const explicit: RelatedFixture = {
    messageId: linkedSession.messageId,
    revision: 1,
    employeeId: workspace.employeeId,
    role: 'user',
    occurredAt: '2026-09-21T01:03:00.000Z',
    text: 'REVAL-EXPLICIT',
    sourceKind: 'explicit_session_link',
    linkId,
  };
  const requestId = uuidv7();
  await insertSearchRequest({
    requestId,
    sessionId: input.sessionId,
    inputMessageId: input.messageId,
    inputRevision: 1,
    inputSequenceNo: 1,
    result: directResult({
      requestId,
      inputId: input.messageId,
      inputRevision: 1,
      projectId: workspace.projectId,
      evidence: [primaryEvidence],
      related: [neighbor, correction, explicit],
    }),
  });
  return {
    requestId,
    primary: primarySession,
    input,
    linkEvidence: { messageId: linkEvidence.messageId },
    neighbor,
    correction,
    explicit,
    explicitLinkId: linkId,
    relationId,
  };
}

function relatedTexts(body: DirectMatchBody): string[] {
  return (body.matches?.[0]?.related_evidence ?? []).map((item) => String(item.text ?? ''));
}

describe('M7 結果取得時の再検証', () => {
  it('direct matchedはrelated_evidenceを再検証し、内部検証metadataを応答へ出さない', async () => {
    const fixture = await seedRevalidationFixture();
    const response = await getSearchById(app, { token: workspace.token, id: fixture.requestId });
    assert.equal(response.statusCode, 200, `GET失敗: ${response.statusCode} ${response.body}`);
    const body = response.json<DirectMatchBody>();
    assert.equal(body.status, 'completed');
    assert.equal(body.outcome, 'matched');
    assert.ok(body.matches?.[0]?.evidence?.some((item) => item.message_id === fixture.primary.messageId));
    const related = body.matches?.[0]?.related_evidence ?? [];
    assert.equal(related.length, 3, `related_evidence件数: ${JSON.stringify(related)}`);
    assert.ok(!response.body.includes('_link_id'), '内部検証metadataをHTTP応答へ出している');
    assert.ok(!response.body.includes('_relation'), '内部検証metadataをHTTP応答へ出している');
  });

  it('revoke/change対象のprimaryでもcurrentなcorrection relatedが残る場合は元根拠と訂正を同時に返す', async () => {
    const fixture = await seedRevalidationFixture();
    const response = await getSearchById(app, { token: workspace.token, id: fixture.requestId });
    const body = response.json<DirectMatchBody>();
    assert.equal(body.outcome, 'matched');
    assert.ok(body.matches?.[0]?.evidence?.some((item) => item.message_id === fixture.primary.messageId), '元根拠が落ちている');
    assert.ok(relatedTexts(body).includes('REVAL-CORRECTION'), '訂正relatedが同時に返っていない');
  });

  it('旧形式で訂正relatedがないrevoke/change対象は従来どおりmatch全体を無効化する', async () => {
    const fixture = await seedRevalidationFixture();
    // related_evidenceを持たない旧形式resultへ置換する。
    const oldFormat = directResult({
      requestId: fixture.requestId,
      inputId: fixture.input.messageId,
      inputRevision: 1,
      projectId: workspace.projectId,
      evidence: [
        {
          messageId: fixture.primary.messageId,
          revision: 1,
          employeeId: workspace.employeeId,
          role: 'assistant',
          occurredAt: '2026-09-21T01:00:00.000Z',
          text: 'REVAL-PRIMARY-ANSWER',
          sourceKind: 'neighbor',
        },
      ],
    });
    await pool.query('UPDATE search_requests SET result = $2::jsonb WHERE id = $1', [fixture.requestId, JSON.stringify(oldFormat)]);
    const response = await getSearchById(app, { token: workspace.token, id: fixture.requestId });
    const body = response.json<DirectMatchBody>();
    assert.equal(body.outcome, 'no_match', '旧形式のrevoke/changeをmatchedとして返している');
    assert.equal(body.matches?.length ?? 0, 0);
  });

  it('primary evidenceのrevisionが改訂されたらmatch全体をno_matchにする', async () => {
    const fixture = await seedRevalidationFixture();
    await advanceMessageRevision(pool, fixture.primary.messageId, 'REVAL-PRIMARY-REVISED');
    const response = await getSearchById(app, { token: workspace.token, id: fixture.requestId });
    const body = response.json<DirectMatchBody>();
    assert.equal(body.status, 'completed');
    assert.equal(body.outcome, 'no_match', '改訂済みprimaryをmatchedとして返している');
    assert.equal(body.matches?.length ?? 0, 0);
  });

  it('related itemのrevisionが改訂されたらそのitemだけを落とす', async () => {
    const fixture = await seedRevalidationFixture();
    await advanceMessageRevision(pool, fixture.neighbor.messageId, 'REVAL-NEIGHBOR-REVISED');
    const response = await getSearchById(app, { token: workspace.token, id: fixture.requestId });
    const body = response.json<DirectMatchBody>();
    assert.equal(body.outcome, 'matched');
    assert.ok(!relatedTexts(body).includes('REVAL-NEIGHBOR'), '改訂済みrelatedを返している');
    assert.ok(relatedTexts(body).includes('REVAL-CORRECTION'), '有効なrelatedまで落としている');
    assert.ok(relatedTexts(body).includes('REVAL-EXPLICIT'), '有効なrelatedまで落としている');
    const ids = body.matches?.[0]?.related_evidence_ids ?? [];
    assert.ok(!ids.includes(fixture.neighbor.messageId), 'related_evidence_idsへ無効itemが残っている');
  });

  it('explicit linkがrevokeされたらそのrelated itemだけを落とす', async () => {
    const fixture = await seedRevalidationFixture();
    await pool.query("UPDATE session_links SET status = 'revoked', updated_at = now() WHERE id = $1", [fixture.explicitLinkId]);
    const response = await getSearchById(app, { token: workspace.token, id: fixture.requestId });
    const body = response.json<DirectMatchBody>();
    assert.equal(body.outcome, 'matched');
    assert.ok(!relatedTexts(body).includes('REVAL-EXPLICIT'), 'revoke済みlinkのrelatedを返している');
    assert.ok(relatedTexts(body).includes('REVAL-CORRECTION'), '無関係なrelatedまで落としている');
  });

  it('link evidenceのcurrent revisionが改訂されたらexplicit itemだけを落とす', async () => {
    const fixture = await seedRevalidationFixture();
    await advanceMessageRevision(pool, fixture.linkEvidence.messageId, 'REVAL-LINK-EVIDENCE-REVISED');
    const response = await getSearchById(app, { token: workspace.token, id: fixture.requestId });
    const body = response.json<DirectMatchBody>();
    assert.equal(body.outcome, 'matched');
    assert.ok(!relatedTexts(body).includes('REVAL-EXPLICIT'), 'stale evidenceのlink relatedを返している');
    assert.ok(relatedTexts(body).includes('REVAL-NEIGHBOR'), '無関係なrelatedまで落としている');
  });

  it('link evidenceがendpoint session外ならexplicit itemだけを落とす', async () => {
    const fixture = await seedRevalidationFixture();
    const outsider = await seedSessionWithMessage('m7-reval-outsider', 1, 'REVAL-OUTSIDER', 'user');
    await pool.query('UPDATE session_links SET evidence_message_id = $2 WHERE id = $1', [fixture.explicitLinkId, outsider.messageId]);
    const response = await getSearchById(app, { token: workspace.token, id: fixture.requestId });
    const body = response.json<DirectMatchBody>();
    assert.equal(body.outcome, 'matched');
    assert.ok(!relatedTexts(body).includes('REVAL-EXPLICIT'), 'endpoint外evidenceのlink relatedを返している');
    assert.ok(relatedTexts(body).includes('REVAL-CORRECTION'), '無関係なrelatedまで落としている');
  });

  it('correctionのmessage_relationが削除されたらそのrelated itemだけを落とす', async () => {
    const fixture = await seedRevalidationFixture();
    await pool.query('DELETE FROM message_relations WHERE id = $1', [fixture.relationId]);
    const response = await getSearchById(app, { token: workspace.token, id: fixture.requestId });
    const body = response.json<DirectMatchBody>();
    assert.equal(body.outcome, 'matched');
    assert.ok(!relatedTexts(body).includes('REVAL-CORRECTION'), 'relation削除済みcorrectionを返している');
    assert.ok(relatedTexts(body).includes('REVAL-NEIGHBOR'), '無関係なrelatedまで落としている');
  });

  it('現在inputのrevisionが改訂されたらdirectでもexpired input_revision_staleにする', async () => {
    const fixture = await seedRevalidationFixture();
    await advanceMessageRevision(pool, fixture.input.messageId, 'REVAL-INPUT-REVISED');
    const response = await getSearchById(app, { token: workspace.token, id: fixture.requestId });
    const body = response.json<DirectMatchBody>();
    assert.equal(body.status, 'expired', 'input改訂をexpiredとして返していない');
    assert.equal(body.outcome ?? null, null);
    assert.equal(body.error_code, 'input_revision_stale');
    assert.equal(body.matches?.length ?? 0, 0);
  });

  it('by-inputのdirect matchedでもrelated itemを再検証する', async () => {
    const fixture = await seedRevalidationFixture();
    const query = {
      project_id: workspace.projectId,
      source: 'codex',
      source_scope: 'scope-a',
      source_session_id: 'm7-reval-input',
      source_message_id: fixture.input.sourceMessageId,
      revision: 1,
    };
    const first = await getSearchByInput(app, { token: workspace.token, query });
    assert.equal(first.statusCode, 200, `by-input失敗: ${first.statusCode} ${first.body}`);
    const firstBody = first.json<DirectMatchBody & { lookup_status?: string }>();
    assert.equal(firstBody.lookup_status, 'found');
    assert.equal(firstBody.outcome, 'matched');
    assert.ok(relatedTexts(firstBody).includes('REVAL-NEIGHBOR'));

    await advanceMessageRevision(pool, fixture.neighbor.messageId, 'REVAL-NEIGHBOR-REVISED');
    const second = await getSearchByInput(app, { token: workspace.token, query });
    const secondBody = second.json<DirectMatchBody & { lookup_status?: string }>();
    assert.equal(secondBody.outcome, 'matched');
    assert.ok(!relatedTexts(secondBody).includes('REVAL-NEIGHBOR'), 'by-inputで改訂済みrelatedを返している');
  });
});
