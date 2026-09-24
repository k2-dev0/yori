import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validate as isUuid } from 'uuid';
import { buildApp } from '../app.js';
import type { ErrorBody } from '../contract.js';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import {
  addProjectMember,
  insertCompany,
  insertEmployee,
  insertMessage,
  insertProject,
  insertSession,
  issueAuthToken,
  resetDatabase,
  seedWorkspace,
  sha256Bytes,
  type WorkspaceFixture,
} from '../../db/tests/fixtures.js';
import { buildEventBatch, buildEventInput, postEvents } from './support.js';
import type { EventsResponse } from '../contract.js';

// M7採用シナリオ1: POST /v1/session-linksのRedテスト（docs/m7-design.md）。
// 新規route未実装の間はFastifyの既定404で失敗し、正常・strict入力・外部identity解決・
// 会社/案件/社員境界・根拠revision・冪等再送・内容違いconflictをit単位で確認する。

const pool = createPool(requireDatabaseUrl());
const app = buildApp({ pool });
let workspace: WorkspaceFixture;

const SCOPE = 'github.example/team/repository';

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

interface SessionIdentity {
  source: 'codex' | 'claude_code';
  source_scope: string;
  source_session_id: string;
}

interface LinkBodyInput {
  projectId?: string;
  idempotencyKey?: string;
  from: SessionIdentity;
  to: SessionIdentity;
  evidence: SessionIdentity & { source_message_id: string; revision: number };
}

function identityJson(input: SessionIdentity): Record<string, string> {
  return {
    source: input.source,
    source_scope: input.source_scope,
    source_session_id: input.source_session_id,
  };
}

function buildLinkBody(input: LinkBodyInput): Record<string, unknown> {
  return {
    project_id: input.projectId ?? workspace.projectId,
    idempotency_key: input.idempotencyKey ?? `link-${randomUUID()}`,
    from: identityJson(input.from),
    to: identityJson(input.to),
    evidence: {
      ...identityJson(input.evidence),
      source_message_id: input.evidence.source_message_id,
      revision: input.evidence.revision,
    },
  };
}

async function postSessionLink(options: { token?: string | null; body?: unknown; payload?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? ''}`;
  }
  return app.inject({
    method: 'POST',
    url: '/v1/session-links',
    headers,
    payload: options.payload ?? JSON.stringify(options.body),
  });
}

// POST /v1/eventsと同じ保存namespace。直接seedする場合もこの形に揃える。
function storedScope(companyId: string, employeeId: string, externalScope = SCOPE): string {
  return `v1|${companyId}|${employeeId}|${externalScope}`;
}

async function seedSessionFor(source: 'codex' | 'claude_code', sourceSessionId: string, options: { projectId?: string; employeeId?: string } = {}): Promise<string> {
  const employeeId = options.employeeId ?? workspace.employeeId;
  return insertSession(pool, {
    projectId: options.projectId ?? workspace.projectId,
    employeeId,
    source,
    sourceScope: storedScope(workspace.companyId, employeeId),
    sourceSessionId,
  });
}

function errorCode(response: { json<T>(): T }): string | undefined {
  return response.json<ErrorBody>().error?.code;
}

function assertUuid(value: unknown, label: string): void {
  assert.equal(typeof value, 'string', `${label}が文字列ではない: ${String(value)}`);
  assert.ok(isUuid(value as string), `${label}がUUID形式ではない: ${String(value)}`);
}

interface LinkResponseBody {
  link_id?: string;
  project_id?: string;
  from_session_id?: string;
  to_session_id?: string;
  evidence_message_id?: string;
  evidence_revision?: number;
  status?: string;
}

interface LinkRow {
  id: string;
  company_id: string;
  project_id: string;
  from_session_id: string;
  to_session_id: string;
  evidence_message_id: string;
  evidence_revision: number;
  is_explicit: boolean;
  status: string;
  created_by_employee_id: string;
  idempotency_key: string;
  condition_hash: string | null;
}

async function readLinkRow(id: string): Promise<LinkRow> {
  const result = await pool.query<LinkRow>('SELECT * FROM session_links WHERE id = $1', [id]);
  const row = result.rows[0];
  assert.ok(row, `session_links ${id} がない`);
  return row;
}

async function countLinks(): Promise<number> {
  const result = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM session_links');
  return Number(result.rows[0]?.count ?? '0');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// evidenceのrevisionを1つ進める。旧revisionの根拠を弾く境界を作る。
async function advanceMessageRevision(messageId: string, nextText: string): Promise<void> {
  const current = await pool.query<{ current_revision: number }>('SELECT current_revision FROM messages WHERE id = $1', [messageId]);
  const next = (current.rows[0]?.current_revision ?? 0) + 1;
  await pool.query(
    `INSERT INTO message_revisions (message_id, revision, text, content_hash) VALUES ($1, $2, $3, $4)`,
    [messageId, next, nextText, sha256Bytes(nextText)],
  );
  await pool.query('UPDATE messages SET current_revision = $2, updated_at = now() WHERE id = $1', [messageId, next]);
}

describe('M7 POST /v1/session-links', () => {
  it('外部identityを内部IDへ解決し、認証社員を登録者とするactive linkを201で保存する', async () => {
    const fromSessionId = await seedSessionFor('codex', 'from-session-1');
    const toSessionId = await seedSessionFor('claude_code', 'to-session-1');
    const evidence = await insertMessage(pool, { sessionId: toSessionId, sourceMessageId: 'handoff-message-1', sequenceNo: 1 });
    const body = buildLinkBody({
      from: { source: 'codex', source_scope: SCOPE, source_session_id: 'from-session-1' },
      to: { source: 'claude_code', source_scope: SCOPE, source_session_id: 'to-session-1' },
      evidence: {
        source: 'claude_code',
        source_scope: SCOPE,
        source_session_id: 'to-session-1',
        source_message_id: 'handoff-message-1',
        revision: 1,
      },
    });

    const response = await postSessionLink({ token: workspace.token, body });
    assert.equal(response.statusCode, 201, `link_sessionが201ではない: ${response.statusCode} ${response.body}`);
    const json = response.json<LinkResponseBody>();
    assertUuid(json.link_id, 'link_id');
    assert.equal(json.project_id, workspace.projectId);
    assert.equal(json.from_session_id, fromSessionId, 'fromの外部identityが内部IDへ解決されていない');
    assert.equal(json.to_session_id, toSessionId, 'toの外部identityが内部IDへ解決されていない');
    assert.equal(json.evidence_message_id, evidence.messageId);
    assert.equal(json.evidence_revision, 1);
    assert.equal(json.status, 'active');

    const row = await readLinkRow(json.link_id as string);
    assert.equal(row.company_id, workspace.companyId);
    assert.equal(row.project_id, workspace.projectId);
    assert.equal(row.from_session_id, fromSessionId);
    assert.equal(row.to_session_id, toSessionId);
    assert.equal(row.evidence_message_id, evidence.messageId);
    assert.equal(row.evidence_revision, 1);
    assert.equal(row.is_explicit, true);
    assert.equal(row.status, 'active');
    assert.equal(row.created_by_employee_id, workspace.employeeId);
    assert.equal(row.idempotency_key, body.idempotency_key);
    assert.ok(row.condition_hash !== null, 'condition_hashが保存されていない');

    // 根拠はfrom側sessionに属してもよい（いずれかのendpoint session）。
    const fromEvidence = await insertMessage(pool, { sessionId: fromSessionId, sourceMessageId: 'handoff-message-2', sequenceNo: 2 });
    const second = await postSessionLink({
      token: workspace.token,
      body: buildLinkBody({
        from: { source: 'codex', source_scope: SCOPE, source_session_id: 'from-session-1' },
        to: { source: 'claude_code', source_scope: SCOPE, source_session_id: 'to-session-1' },
        evidence: {
          source: 'codex',
          source_scope: SCOPE,
          source_session_id: 'from-session-1',
          source_message_id: 'handoff-message-2',
          revision: 1,
        },
      }),
    });
    assert.equal(second.statusCode, 201, `from側の根拠を保存できない: ${second.statusCode} ${second.body}`);
    assert.equal(second.json<LinkResponseBody>().evidence_message_id, fromEvidence.messageId);
  });

  it('strict入力を要求し、unknown field・必須欠落・自己リンクを400にする', async () => {
    const fromSessionId = await seedSessionFor('codex', 'strict-from');
    const toSessionId = await seedSessionFor('claude_code', 'strict-to');
    await insertMessage(pool, { sessionId: toSessionId, sourceMessageId: 'strict-evidence', sequenceNo: 1 });
    const valid = buildLinkBody({
      from: { source: 'codex', source_scope: SCOPE, source_session_id: 'strict-from' },
      to: { source: 'claude_code', source_scope: SCOPE, source_session_id: 'strict-to' },
      evidence: {
        source: 'claude_code',
        source_scope: SCOPE,
        source_session_id: 'strict-to',
        source_message_id: 'strict-evidence',
        revision: 1,
      },
    });

    const invalidBodies: Array<{ label: string; body: Record<string, unknown> }> = [];
    invalidBodies.push({ label: 'unknown top-level field', body: { ...valid, unknown_field: 'x' } });
    invalidBodies.push({
      label: 'unknown nested field',
      body: { ...valid, to: { ...(valid.to as Record<string, unknown>), unknown_field: 'x' } },
    });
    const withoutEvidence = { ...valid };
    delete withoutEvidence.evidence;
    invalidBodies.push({ label: 'missing evidence', body: withoutEvidence });
    invalidBodies.push({
      label: 'evidence revision 0',
      body: { ...valid, evidence: { ...(valid.evidence as Record<string, unknown>), revision: 0 } },
    });
    invalidBodies.push({ label: 'unknown project_id', body: { ...valid, project_id: 'not-a-uuid' } });
    invalidBodies.push({
      label: 'self link',
      body: buildLinkBody({
        from: { source: 'codex', source_scope: SCOPE, source_session_id: 'strict-from' },
        to: { source: 'codex', source_scope: SCOPE, source_session_id: 'strict-from' },
        evidence: {
          source: 'codex',
          source_scope: SCOPE,
          source_session_id: 'strict-from',
          source_message_id: 'strict-evidence',
          revision: 1,
        },
      }),
    });

    for (const invalid of invalidBodies) {
      const response = await postSessionLink({ token: workspace.token, body: invalid.body });
      assert.equal(response.statusCode, 400, `${invalid.label}を400にしない: ${response.statusCode} ${response.body}`);
      assert.equal(errorCode(response), 'invalid_request', `${invalid.label}のerror code`);
    }
    assert.equal(await countLinks(), 0, 'invalid requestでsession_linksが保存されている');
    assert.ok(fromSessionId !== toSessionId);
  });

  it('未存在・別会社・別案件・他社員の引き継ぎ先は404へ統一し、存在を開示しない', async () => {
    await seedSessionFor('codex', 'own-from');
    await seedSessionFor('claude_code', 'own-to');
    const otherProject = await insertProject(pool, workspace.companyId, 'repo-other');
    await insertSession(pool, {
      projectId: otherProject,
      employeeId: workspace.employeeId,
      source: 'claude_code',
      sourceScope: storedScope(workspace.companyId, workspace.employeeId),
      sourceSessionId: 'other-project-to',
    });
    const otherEmployee = await insertEmployee(pool, workspace.companyId, 'employee-other');
    await addProjectMember(pool, workspace.projectId, otherEmployee);
    await insertSession(pool, {
      projectId: workspace.projectId,
      employeeId: otherEmployee,
      source: 'claude_code',
      sourceScope: storedScope(workspace.companyId, otherEmployee),
      sourceSessionId: 'other-employee-to',
    });
    const otherCompany = await insertCompany(pool, 'company-other');
    const otherCompanyEmployee = await insertEmployee(pool, otherCompany, 'employee-other-company');
    const otherCompanyProject = await insertProject(pool, otherCompany, 'repo-other-company');
    await insertSession(pool, {
      projectId: otherCompanyProject,
      employeeId: otherCompanyEmployee,
      source: 'claude_code',
      sourceScope: storedScope(otherCompany, otherCompanyEmployee),
      sourceSessionId: 'other-company-to',
    });
    // 手入力のraw scopeは標準namespaceではないため互換対象にしない。
    await insertSession(pool, {
      projectId: workspace.projectId,
      employeeId: workspace.employeeId,
      source: 'claude_code',
      sourceScope: SCOPE,
      sourceSessionId: 'raw-scope-to',
    });

    const cases: Array<{ label: string; toSessionId: string; secret: string }> = [
      { label: '未存在のto', toSessionId: 'missing-to', secret: 'missing-to' },
      { label: '別案件のto', toSessionId: 'other-project-to', secret: otherProject },
      { label: '他社員のto', toSessionId: 'other-employee-to', secret: otherEmployee },
      { label: '別会社のto', toSessionId: 'other-company-to', secret: otherCompany },
      { label: 'raw scopeのto', toSessionId: 'raw-scope-to', secret: 'raw-scope-to' },
    ];

    for (const testCase of cases) {
      const response = await postSessionLink({
        token: workspace.token,
        body: buildLinkBody({
          from: { source: 'codex', source_scope: SCOPE, source_session_id: 'own-from' },
          to: { source: 'claude_code', source_scope: SCOPE, source_session_id: testCase.toSessionId },
          evidence: {
            source: 'claude_code',
            source_scope: SCOPE,
            source_session_id: testCase.toSessionId,
            source_message_id: 'unknown-message',
            revision: 1,
          },
        }),
      });
      assert.equal(response.statusCode, 404, `${testCase.label}を404にしない: ${response.statusCode} ${response.body}`);
      assert.equal(errorCode(response), 'not_found', `${testCase.label}のerror code`);
      assert.ok(!response.body.includes(testCase.secret), `${testCase.label}: 存在情報を応答へ開示している`);
    }
    assert.equal(await countLinks(), 0, '非開示caseでsession_linksが保存されている');
  });

  it('根拠発言はendpoint session所属のcurrent revisionだけを受理し、不一致を400にする', async () => {
    const fromSessionId = await seedSessionFor('codex', 'evidence-from');
    const toSessionId = await seedSessionFor('claude_code', 'evidence-to');
    const thirdSessionId = await seedSessionFor('claude_code', 'evidence-third');
    const inTo = await insertMessage(pool, { sessionId: toSessionId, sourceMessageId: 'evidence-in-to', sequenceNo: 1 });
    const inThird = await insertMessage(pool, { sessionId: thirdSessionId, sourceMessageId: 'evidence-in-third', sequenceNo: 1 });
    void fromSessionId;

    const base = {
      from: { source: 'codex', source_scope: SCOPE, source_session_id: 'evidence-from' },
      to: { source: 'claude_code', source_scope: SCOPE, source_session_id: 'evidence-to' },
    } as const;

    const wrongSession = await postSessionLink({
      token: workspace.token,
      body: buildLinkBody({
        ...base,
        evidence: {
          source: 'claude_code',
          source_scope: SCOPE,
          source_session_id: 'evidence-third',
          source_message_id: 'evidence-in-third',
          revision: 1,
        },
      }),
    });
    assert.equal(wrongSession.statusCode, 400, `endpoint外の根拠を400にしない: ${wrongSession.statusCode} ${wrongSession.body}`);
    assert.equal(errorCode(wrongSession), 'invalid_request');

    await advanceMessageRevision(inTo.messageId, '改訂後の根拠');
    const staleRevision = await postSessionLink({
      token: workspace.token,
      body: buildLinkBody({
        ...base,
        evidence: {
          source: 'claude_code',
          source_scope: SCOPE,
          source_session_id: 'evidence-to',
          source_message_id: 'evidence-in-to',
          revision: 1,
        },
      }),
    });
    assert.equal(staleRevision.statusCode, 400, `旧revisionの根拠を400にしない: ${staleRevision.statusCode} ${staleRevision.body}`);
    assert.equal(errorCode(staleRevision), 'invalid_request');

    const missingMessage = await postSessionLink({
      token: workspace.token,
      body: buildLinkBody({
        ...base,
        evidence: {
          source: 'claude_code',
          source_scope: SCOPE,
          source_session_id: 'evidence-to',
          source_message_id: 'missing-message',
          revision: 1,
        },
      }),
    });
    assert.equal(missingMessage.statusCode, 400, `未存在の根拠を400にしない: ${missingMessage.statusCode} ${missingMessage.body}`);
    assert.equal(errorCode(missingMessage), 'invalid_request');
    void inThird;
    assert.equal(await countLinks(), 0, '根拠不一致でsession_linksが保存されている');
  });

  it('同内容の冪等再送は同じlinkを200で返し、内容違い・一意制約競合は409にする', async () => {
    const fromSessionId = await seedSessionFor('codex', 'idem-from');
    const toSessionId = await seedSessionFor('claude_code', 'idem-to');
    const otherToSessionId = await seedSessionFor('claude_code', 'idem-to-2');
    await insertMessage(pool, { sessionId: toSessionId, sourceMessageId: 'idem-evidence', sequenceNo: 1 });
    await insertMessage(pool, { sessionId: toSessionId, sourceMessageId: 'idem-evidence-2', sequenceNo: 2 });
    await insertMessage(pool, { sessionId: fromSessionId, sourceMessageId: 'idem-from-evidence', sequenceNo: 1 });
    void otherToSessionId;

    const body = buildLinkBody({
      idempotencyKey: 'idem-key-1',
      from: { source: 'codex', source_scope: SCOPE, source_session_id: 'idem-from' },
      to: { source: 'claude_code', source_scope: SCOPE, source_session_id: 'idem-to' },
      evidence: {
        source: 'claude_code',
        source_scope: SCOPE,
        source_session_id: 'idem-to',
        source_message_id: 'idem-evidence',
        revision: 1,
      },
    });

    const first = await postSessionLink({ token: workspace.token, body });
    assert.equal(first.statusCode, 201, `初回を201にしない: ${first.statusCode} ${first.body}`);
    const firstLinkId = first.json<LinkResponseBody>().link_id;
    assertUuid(firstLinkId, 'link_id');

    const resend = await postSessionLink({ token: workspace.token, body });
    assert.equal(resend.statusCode, 200, `同内容再送を200にしない: ${resend.statusCode} ${resend.body}`);
    assert.equal(resend.json<LinkResponseBody>().link_id, firstLinkId, '同内容再送で別linkを返している');
    assert.equal(await countLinks(), 1, '同内容再送でlinkが増殖している');

    const changedContent = await postSessionLink({
      token: workspace.token,
      body: buildLinkBody({
        idempotencyKey: 'idem-key-1',
        from: { source: 'codex', source_scope: SCOPE, source_session_id: 'idem-from' },
        to: { source: 'claude_code', source_scope: SCOPE, source_session_id: 'idem-to' },
        evidence: {
          source: 'claude_code',
          source_scope: SCOPE,
          source_session_id: 'idem-to',
          source_message_id: 'idem-evidence-2',
          revision: 1,
        },
      }),
    });
    assert.equal(changedContent.statusCode, 409, `同じ冪等キーの内容違いを409にしない: ${changedContent.statusCode} ${changedContent.body}`);
    assert.equal(errorCode(changedContent), 'conflict');

    const changedTo = await postSessionLink({
      token: workspace.token,
      body: buildLinkBody({
        idempotencyKey: 'idem-key-1',
        from: { source: 'codex', source_scope: SCOPE, source_session_id: 'idem-from' },
        to: { source: 'claude_code', source_scope: SCOPE, source_session_id: 'idem-to-2' },
        evidence: {
          source: 'codex',
          source_scope: SCOPE,
          source_session_id: 'idem-from',
          source_message_id: 'idem-from-evidence',
          revision: 1,
        },
      }),
    });
    assert.equal(changedTo.statusCode, 409, `同じ冪等キーでto違いを409にしない: ${changedTo.statusCode} ${changedTo.body}`);
    assert.equal(errorCode(changedTo), 'conflict');

    const duplicateActive = await postSessionLink({
      token: workspace.token,
      body: buildLinkBody({
        idempotencyKey: 'idem-key-2',
        from: { source: 'codex', source_scope: SCOPE, source_session_id: 'idem-from' },
        to: { source: 'claude_code', source_scope: SCOPE, source_session_id: 'idem-to' },
        evidence: {
          source: 'claude_code',
          source_scope: SCOPE,
          source_session_id: 'idem-to',
          source_message_id: 'idem-evidence',
          revision: 1,
        },
      }),
    });
    assert.equal(duplicateActive.statusCode, 409, `同じactive linkの再作成を409にしない: ${duplicateActive.statusCode} ${duplicateActive.body}`);
    assert.equal(errorCode(duplicateActive), 'conflict');
    assert.equal(await countLinks(), 1, 'conflict時にlinkが保存されている');
  });

  it('POST /v1/eventsの標準経路で作ったfrom/to/evidenceをraw外部scopeで解決する', async () => {
    // fromは他社員のsession。標準POST /v1/eventsはその社員のnamespaceでscopeを保存する。
    const fromEmployee = await insertEmployee(pool, workspace.companyId, 'employee-integration-from');
    await addProjectMember(pool, workspace.projectId, fromEmployee);
    const fromToken = await issueAuthToken(pool, workspace.companyId, fromEmployee);
    const fromEvent = buildEventInput({
      source: 'codex',
      source_scope: SCOPE,
      source_session_id: 'integration-from-session',
      source_message_id: 'integration-from-message',
      role: 'assistant',
      text: 'INTEGRATION-FROM',
    });
    const fromResponse = await postEvents(app, {
      token: fromToken,
      body: buildEventBatch(workspace.projectId, [fromEvent]),
    });
    assert.equal(fromResponse.statusCode, 202, `fromイベント受付失敗: ${fromResponse.statusCode} ${fromResponse.body}`);

    const toEvent = buildEventInput({
      source: 'claude_code',
      source_scope: SCOPE,
      source_session_id: 'integration-to-session',
      source_message_id: 'integration-to-message',
      role: 'assistant',
      text: 'INTEGRATION-TO',
    });
    const toResponse = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, [toEvent]),
    });
    assert.equal(toResponse.statusCode, 202, `toイベント受付失敗: ${toResponse.statusCode} ${toResponse.body}`);
    const toResult = toResponse.json<EventsResponse>().results[0];
    assert.ok(toResult, 'toイベント結果がない');

    const response = await postSessionLink({
      token: workspace.token,
      body: buildLinkBody({
        from: { source: 'codex', source_scope: SCOPE, source_session_id: 'integration-from-session' },
        to: { source: 'claude_code', source_scope: SCOPE, source_session_id: 'integration-to-session' },
        evidence: {
          source: 'claude_code',
          source_scope: SCOPE,
          source_session_id: 'integration-to-session',
          source_message_id: 'integration-to-message',
          revision: 1,
        },
      }),
    });
    assert.equal(response.statusCode, 201, `標準経路のidentityを201にしない: ${response.statusCode} ${response.body}`);
    const json = response.json<LinkResponseBody>();
    assertUuid(json.link_id, 'link_id');

    const fromSession = await pool.query<{ id: string }>(
      `SELECT id FROM sessions
        WHERE source = 'codex' AND source_session_id = 'integration-from-session'
          AND source_scope = 'v1|' || $1::text || '|' || $2::text || '|' || $3::text`,
      [workspace.companyId, fromEmployee, SCOPE],
    );
    const toSession = await pool.query<{ id: string }>(
      `SELECT id FROM sessions
        WHERE source = 'claude_code' AND source_session_id = 'integration-to-session'
          AND source_scope = 'v1|' || $1::text || '|' || $2::text || '|' || $3::text`,
      [workspace.companyId, workspace.employeeId, SCOPE],
    );
    assert.ok(fromSession.rows[0], '標準経路のfrom sessionがない');
    assert.ok(toSession.rows[0], '標準経路のto sessionがない');
    assert.equal(json.from_session_id, fromSession.rows[0]?.id, 'from外部scopeが内部IDへ解決されていない');
    assert.equal(json.to_session_id, toSession.rows[0]?.id, 'to外部scopeが内部IDへ解決されていない');
    assert.equal(json.evidence_message_id, toResult.message_id, 'evidence外部identityが内部IDへ解決されていない');

    const row = await readLinkRow(json.link_id as string);
    assert.equal(row.from_session_id, fromSession.rows[0]?.id);
    assert.equal(row.to_session_id, toSession.rows[0]?.id);
    assert.equal(row.evidence_message_id, toResult.message_id);
  });

  it('根拠revision更新と競合した作成は、更新先行なら400にしてstale linkを残さない', async () => {
    const toSessionId = await seedSessionFor('claude_code', 'race-to');
    await seedSessionFor('codex', 'race-from');
    const evidence = await insertMessage(pool, { sessionId: toSessionId, sourceMessageId: 'race-evidence', sequenceNo: 1 });
    const body = buildLinkBody({
      from: { source: 'codex', source_scope: SCOPE, source_session_id: 'race-from' },
      to: { source: 'claude_code', source_scope: SCOPE, source_session_id: 'race-to' },
      evidence: {
        source: 'claude_code',
        source_scope: SCOPE,
        source_session_id: 'race-to',
        source_message_id: 'race-evidence',
        revision: 1,
      },
    });

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      // eventsのrevision更新と同じ順でmessages行を排他lockする。link作成はFOR SHAREで待つ。
      await holder.query(
        `INSERT INTO message_revisions (message_id, revision, text, content_hash) VALUES ($1, 2, $2, $3)`,
        [evidence.messageId, 'race-evidence-revised', sha256Bytes('race-evidence-revised')],
      );
      await holder.query('UPDATE messages SET current_revision = 2, updated_at = now() WHERE id = $1', [evidence.messageId]);

      const pending = postSessionLink({ token: workspace.token, body });
      const settledEarly = await Promise.race([
        pending.then(() => true),
        sleep(300).then(() => false),
      ]);
      assert.equal(settledEarly, false, '根拠revision更新のcommit前にlink作成が完了した（row lockがない）');
      await holder.query('COMMIT');

      const response = await pending;
      assert.equal(response.statusCode, 400, `stale revisionのlink作成を400にしない: ${response.statusCode} ${response.body}`);
      assert.equal(errorCode(response), 'invalid_request');
      assert.equal(await countLinks(), 0, '競合時にstaleなsession_linksが保存されている');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('未認証は401、案件memberでないtokenは403にする', async () => {
    const otherWorkspace = await seedWorkspace(pool, { name: 'company-b', repositoryIdentifier: 'repo-b' });
    const body = buildLinkBody({
      from: { source: 'codex', source_scope: SCOPE, source_session_id: 'auth-from' },
      to: { source: 'claude_code', source_scope: SCOPE, source_session_id: 'auth-to' },
      evidence: {
        source: 'claude_code',
        source_scope: SCOPE,
        source_session_id: 'auth-to',
        source_message_id: 'auth-evidence',
        revision: 1,
      },
    });

    const unauthorized = await postSessionLink({ token: null, body });
    assert.equal(unauthorized.statusCode, 401, `未認証を401にしない: ${unauthorized.statusCode} ${unauthorized.body}`);
    assert.equal(errorCode(unauthorized), 'unauthorized');

    const forbidden = await postSessionLink({ token: otherWorkspace.token, body });
    assert.equal(forbidden.statusCode, 403, `非memberを403にしない: ${forbidden.statusCode} ${forbidden.body}`);
    assert.equal(errorCode(forbidden), 'forbidden');
  });
});
