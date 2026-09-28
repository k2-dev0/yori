import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { buildApp } from '../app.js';
import type { EventsResponse } from '../contract.js';
import { redactConversationText } from '../redaction.js';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { postSearch } from './m6-support.js';
import { buildEventBatch, buildEventInput, canonicalReceiptHash, postEvents } from './support.js';

// POST /v1/events と POST /v1/searches は認証会社のcurrent policyを読み、保存前にbuilt-in＋customを適用する。
// collectorを経ない直接送信でも生literalを保存せず、receipt hash・revision・冪等性は置換後本文で維持する。

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

async function savePolicy(companyId: string, version: number, rules: string[]): Promise<void> {
  await pool.query('INSERT INTO company_redaction_policies (company_id, version) VALUES ($1, $2)', [companyId, version]);
  for (const rule of rules) {
    await pool.query('INSERT INTO company_redaction_rules (company_id, literal) VALUES ($1, $2)', [companyId, rule]);
  }
}

async function readCurrentRevisionText(messageId: string): Promise<string | undefined> {
  const result = await pool.query<{ text: string }>(
    `SELECT r.text
       FROM message_revisions r
       JOIN messages m ON m.id = r.message_id AND m.current_revision = r.revision
      WHERE m.id = $1`,
    [messageId],
  );
  return result.rows[0]?.text;
}

describe('POST /v1/events のcustom伏せ字適用', () => {
  it('custom literalを保存前に置換し、receipt hashと再送冪等性を置換後本文で維持する', async () => {
    await savePolicy(workspace.companyId, 2, ['AcmeSecret', 'hunter2']);
    const rawText = 'PASSWORD=hunter2 と AcmeSecret と AKIAIOSFODNN7EXAMPLE';
    const redactedText = 'PASSWORD=[REDACTED:env_value] と [REDACTED:custom] と [REDACTED:aws_access_key]';
    const event = buildEventInput({ idempotency_key: 'custom-redaction-1', text: rawText });
    const requestBody = buildEventBatch(workspace.projectId, [event]);

    const first = await postEvents(app, { token: workspace.token, body: requestBody });
    assert.equal(first.statusCode, 202, `受付に失敗: ${first.statusCode} ${first.body}`);
    const firstResult = first.json<EventsResponse>().results[0];
    assert.ok(firstResult, '受付結果がない');
    assert.equal(firstResult.revision, 1);
    assert.equal(await readCurrentRevisionText(firstResult.message_id), redactedText);

    const receipt = await pool.query<{ request_hash: Buffer }>(
      'SELECT request_hash FROM event_receipts WHERE company_id = $1 AND employee_id = $2 AND idempotency_key = $3',
      [workspace.companyId, workspace.employeeId, event.idempotency_key],
    );
    // receipt hashはcustom policy変更から独立し、built-in適用後の本文で決まる。
    const expectedHash = canonicalReceiptHash({
      ...event,
      company_id: workspace.companyId,
      employee_id: workspace.employeeId,
      project_id: workspace.projectId,
      text: redactConversationText(rawText),
    });
    assert.ok(receipt.rows[0]?.request_hash.equals(expectedHash), 'receipt hashがbuilt-in適用後の本文で計算されていない');

    const storedRaw = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM message_revisions WHERE text LIKE '%' || $1 || '%'",
      ['AcmeSecret'],
    );
    assert.equal(storedRaw.rows[0]?.count, '0', '生literalがmessage_revisionsへ保存されている');

    const second = await postEvents(app, { token: workspace.token, body: requestBody });
    assert.equal(second.statusCode, 202, `同一本文の再送が失敗: ${second.statusCode} ${second.body}`);
    const secondResult = second.json<EventsResponse>().results[0];
    assert.equal(secondResult?.message_id, firstResult.message_id, '再送で新しいmessageが作られている');
    assert.equal(secondResult?.revision, 1, '再送でrevisionが増えている');

    const revisions = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM message_revisions WHERE message_id = $1',
      [firstResult.message_id],
    );
    assert.equal(revisions.rows[0]?.count, '1', '再送でrevision行が増えている');
  });

  it('policy登録は既存revisionの本文を書き換えず、新規取込にだけ適用する', async () => {
    const existing = buildEventInput({ idempotency_key: 'before-policy-1', text: 'AcmeSecret を含む既存本文' });
    const existingResponse = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [existing]) });
    assert.equal(existingResponse.statusCode, 202, `既存本文の受付に失敗: ${existingResponse.statusCode} ${existingResponse.body}`);
    const existingMessageId = existingResponse.json<EventsResponse>().results[0]!.message_id;
    assert.equal(await readCurrentRevisionText(existingMessageId), existing.text);

    await savePolicy(workspace.companyId, 1, ['AcmeSecret']);
    const fresh = buildEventInput({ idempotency_key: 'after-policy-1', sequence_no: 2, text: 'AcmeSecret を含む新規本文' });
    const freshResponse = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [fresh]) });
    assert.equal(freshResponse.statusCode, 202, `新規本文の受付に失敗: ${freshResponse.statusCode} ${freshResponse.body}`);
    const freshMessageId = freshResponse.json<EventsResponse>().results[0]!.message_id;

    assert.equal(await readCurrentRevisionText(freshMessageId), '[REDACTED:custom] を含む新規本文');
    assert.equal(await readCurrentRevisionText(existingMessageId), existing.text, 'policy登録で既存本文を書き換えている');
  });

  it('ACK喪失後の同一body再送はpolicy追加後も同じreceiptで成功し、別bodyの衝突は維持する', async () => {
    // policy追加前の受付（collectorのACK喪失を模す）。
    const event = buildEventInput({ idempotency_key: 'receipt-policy-change-1', text: 'AcmeSecret と AlphaSecret と 固定本文' });
    const requestBody = buildEventBatch(workspace.projectId, [event]);
    const first = await postEvents(app, { token: workspace.token, body: requestBody });
    assert.equal(first.statusCode, 202, `初回受付に失敗: ${first.statusCode} ${first.body}`);
    const firstResult = first.json<EventsResponse>().results[0]!;
    assert.equal(await readCurrentRevisionText(firstResult.message_id), event.text);

    await savePolicy(workspace.companyId, 1, ['AcmeSecret', 'AlphaSecret']);

    // 同じidempotency_key＋同じ受信bodyはpolicy追加後も同じreceiptとして成功する。
    const retry = await postEvents(app, { token: workspace.token, body: requestBody });
    assert.equal(retry.statusCode, 202, `policy追加後の同一body再送が失敗: ${retry.statusCode} ${retry.body}`);
    const retryResult = retry.json<EventsResponse>().results[0];
    assert.equal(retryResult?.message_id, firstResult.message_id, '同一body再送で新しいmessageが作られている');
    assert.equal(retryResult?.revision, 1);
    assert.equal(await readCurrentRevisionText(firstResult.message_id), event.text, 'policy追加で既存本文を遡及変更している');

    const receipt = await pool.query<{ request_hash: Buffer }>(
      'SELECT request_hash FROM event_receipts WHERE company_id = $1 AND employee_id = $2 AND idempotency_key = $3',
      [workspace.companyId, workspace.employeeId, event.idempotency_key],
    );
    assert.ok(
      receipt.rows[0]?.request_hash.equals(
        canonicalReceiptHash({
          ...event,
          company_id: workspace.companyId,
          employee_id: workspace.employeeId,
          project_id: workspace.projectId,
          text: redactConversationText(event.text),
        }),
      ),
      'receipt hashがcustom policy追加で変化している',
    );

    // 異なる受信bodyがcustomで同じplaceholderになってもconflictを維持する。
    // 直前のeventと同じsource sessionのため、sequence_no=1は使用済み。session identity契約に合わせて2を使う。
    const firstBody = buildEventInput({ idempotency_key: 'receipt-different-body-1', sequence_no: 2, text: 'AcmeSecret のみ' });
    const sent = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [firstBody]) });
    assert.equal(sent.statusCode, 202, `初回bodyの受付に失敗: ${sent.statusCode} ${sent.body}`);
    const conflict = await postEvents(app, {
      token: workspace.token,
      body: buildEventBatch(workspace.projectId, [{ ...firstBody, text: 'AlphaSecret のみ' }]),
    });
    assert.equal(conflict.statusCode, 409, `別受信bodyがplaceholder一致で受理された: ${conflict.statusCode} ${conflict.body}`);

    // policy追加前の既存revisionはrawのままが契約。後から受けたbodyのrevisionだけを対象にする。
    const sentResult = sent.json<EventsResponse>().results[0]!;
    const rawRows = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM message_revisions WHERE message_id = $1 AND (text LIKE '%AcmeSecret%' OR text LIKE '%AlphaSecret%')",
      [sentResult.message_id],
    );
    assert.equal(rawRows.rows[0]?.count, '0', '生bodyがmessage_revisionsへ保存されている');
    const sentRevisions = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM message_revisions WHERE message_id = $1',
      [sentResult.message_id],
    );
    assert.equal(sentRevisions.rows[0]?.count, '1', 'conflictした別bodyがrevisionとして保存されている');
  });

  it('別会社のpolicy ruleを自社の保存本文へ適用しない', async () => {
    await savePolicy(workspace.companyId, 1, ['CompanyASecret']);
    const other = await seedWorkspace(pool, { name: 'company-policy-b', repositoryIdentifier: 'repo-b' });
    const event = buildEventInput({ idempotency_key: 'company-scope-1', text: 'CompanyASecret は会社Aだけのrule' });

    const response = await postEvents(app, { token: other.token, body: buildEventBatch(other.projectId, [event]) });
    assert.equal(response.statusCode, 202, `受付に失敗: ${response.statusCode} ${response.body}`);
    const result = response.json<EventsResponse>().results[0];
    assert.equal(await readCurrentRevisionText(result!.message_id), event.text, '他社policyを適用している');
  });
});

describe('POST /v1/searches のcustom伏せ字適用', () => {
  it('質問本文を保存前に置換し、同一本文の再送で同じ受付を再利用する', async () => {
    await savePolicy(workspace.companyId, 1, ['AcmeSecret']);
    const inputEvent = buildEventInput({ idempotency_key: 'search-input-1', text: '入力の原文' });
    const ingested = await postEvents(app, { token: workspace.token, body: buildEventBatch(workspace.projectId, [inputEvent]) });
    assert.equal(ingested.statusCode, 202, `入力受付に失敗: ${ingested.statusCode} ${ingested.body}`);
    const inputId = ingested.json<EventsResponse>().results[0]!.message_id;

    const searchBody = {
      project_id: workspace.projectId,
      input_id: inputId,
      input_revision: 1,
      query: 'AcmeSecret の確認',
      idempotency_key: 'search-custom-1',
      force_refresh: false,
    };
    const first = await postSearch(app, { token: workspace.token, body: searchBody });
    assert.ok([200, 202].includes(first.statusCode), `検索受付に失敗: ${first.statusCode} ${first.body}`);
    const requestId = first.json<{ request_id: string }>().request_id;

    const stored = await pool.query<{ question: string }>('SELECT question FROM search_requests WHERE id = $1', [requestId]);
    assert.equal(stored.rows[0]?.question, '[REDACTED:custom] の確認', '質問本文が置換されず保存されている');
    const rawRows = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM search_requests WHERE question LIKE '%AcmeSecret%'",
    );
    assert.equal(rawRows.rows[0]?.count, '0', '生literalがsearch_requestsへ保存されている');

    const second = await postSearch(app, { token: workspace.token, body: searchBody });
    assert.equal(second.statusCode, 200, `同一本文の再送で再利用していない: ${second.statusCode} ${second.body}`);
    assert.equal(second.json<{ request_id: string }>().request_id, requestId);
    const manualCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM search_requests WHERE company_id = $1 AND employee_id = $2 AND trigger = 'manual' AND idempotency_key = $3",
      [workspace.companyId, workspace.employeeId, searchBody.idempotency_key],
    );
    assert.equal(manualCount.rows[0]?.count, '1', '同一質問の再送でmanual受付が増えている');
  });
});
