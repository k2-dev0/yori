import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { API_BASE_URL, compose, composeOk, psql, resetDb, runDocker, waitForDbReady, waitForHttp } from './docker.js';

// 実コンテナのDBへ入れるfixture。テスト専用の固定IDで、既存データとは衝突しない。
const COMPANY_ID = '0a000000-0000-7000-8000-000000000001';
const EMPLOYEE_ID = '0a000000-0000-7000-8000-000000000002';
const PROJECT_ID = '0a000000-0000-7000-8000-000000000003';
const TOKEN_ID = '0a000000-0000-7000-8000-000000000004';
const SESSION_ID = '0a000000-0000-7000-8000-000000000005';
const MESSAGE_ID = '0a000000-0000-7000-8000-000000000006';
const TOKEN = 'yori-e2e-token';
const RAW_TEXT = '改行\nと日本語\r\nと末尾空白  ';

function insertWorkspaceSql(): string {
  const tokenHash = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
  return `
    INSERT INTO companies (id, name) VALUES ('${COMPANY_ID}', 'e2e-company');
    INSERT INTO employees (id, company_id, display_name) VALUES ('${EMPLOYEE_ID}', '${COMPANY_ID}', 'e2e-employee');
    INSERT INTO projects (id, company_id, repository_identifier) VALUES ('${PROJECT_ID}', '${COMPANY_ID}', 'e2e-repo');
    INSERT INTO project_members (project_id, employee_id) VALUES ('${PROJECT_ID}', '${EMPLOYEE_ID}');
    INSERT INTO auth_tokens (id, company_id, employee_id, token_hash)
      VALUES ('${TOKEN_ID}', '${COMPANY_ID}', '${EMPLOYEE_ID}', decode('${tokenHash}', 'hex'));
  `;
}

function insertMessageSql(messageId: string): string {
  const contentHash = createHash('sha256').update(RAW_TEXT, 'utf8').digest('hex');
  return `
    INSERT INTO sessions (id, project_id, employee_id, source, source_scope, source_session_id, started_at)
      VALUES ('${SESSION_ID}', '${PROJECT_ID}', '${EMPLOYEE_ID}', 'codex', 'e2e-scope', 'e2e-session', '2026-09-21T01:00:00Z');
    INSERT INTO messages (id, session_id, source_message_id, sequence_no, role, occurred_at, current_revision)
      VALUES ('${messageId}', '${SESSION_ID}', 'e2e-msg', 1, 'user', '2026-09-21T01:00:00Z', 1);
    INSERT INTO message_revisions (message_id, revision, text, content_hash)
      VALUES ('${messageId}', 1, $raw$${RAW_TEXT}$raw$, decode('${contentHash}', 'hex'));
  `;
}

async function storedTextHex(messageId: string): Promise<string> {
  return psql(`SELECT encode(convert_to(text, 'UTF8'), 'hex') FROM message_revisions WHERE message_id = '${messageId}' AND revision = 1`);
}

before(async () => {
  await composeOk(['up', '-d', '--wait', 'db']);
  await composeOk(['run', '--rm', 'migrate']);
  await composeOk(['up', '-d', 'api']);
  await waitForHttp('/health/live');
});

after(async () => {
  await compose(['down', '--remove-orphans']);
});

it('DBコンテナはホストへポートを公開しない', async () => {
  const containerId = (await composeOk(['ps', '-q', 'db'])).trim();
  assert.ok(containerId.length > 0, 'dbコンテナが起動していない');
  const inspect = await runDocker(['inspect', containerId, '--format', '{{json .NetworkSettings.Ports}}']);
  assert.equal(inspect.code, 0, `docker inspectに失敗: ${inspect.stderr}`);
  const ports = JSON.parse(inspect.stdout.trim()) as Record<string, Array<{ HostPort: string }> | null> | null;
  const hostBindings = Object.values(ports ?? {}).flatMap((bindings) => bindings ?? []);
  assert.deepEqual(hostBindings, [], `DBポートがホストへ公開されている: ${inspect.stdout.trim()}`);
});

it('DB稼働中は live・ready ともに200を返す', async () => {
  const live = await waitForHttp('/health/live');
  assert.equal(live.status, 200, 'liveが200でない');
  const ready = await waitForHttp('/health/ready');
  assert.equal(ready.status, 200, 'readyが200でない');
});

it('DB停止中は live 200 / ready 503 を返す', async () => {
  await composeOk(['stop', 'db']);
  try {
    const live = await fetch(`${API_BASE_URL}/health/live`);
    assert.equal(live.status, 200, 'DB停止中にliveが200でない');
    const ready = await fetch(`${API_BASE_URL}/health/ready`);
    assert.equal(ready.status, 503, 'DB停止中にreadyが503でない');
  } finally {
    await composeOk(['start', 'db']);
    await waitForDbReady();
  }
});

it('コンテナ再作成後もmessage_revisionsの原文がバイト単位で残る', async () => {
  await resetDb();
  await psql(insertWorkspaceSql());
  await psql(insertMessageSql(MESSAGE_ID));
  const expectedHex = Buffer.from(RAW_TEXT, 'utf8').toString('hex');
  assert.equal(await storedTextHex(MESSAGE_ID), expectedHex);

  await composeOk(['up', '-d', '--wait', '--force-recreate', 'db']);
  await waitForDbReady();

  assert.equal(await storedTextHex(MESSAGE_ID), expectedHex, 'コンテナ再作成で原文が変化・消失した');
  assert.equal(await psql('SELECT count(*)::text FROM message_revisions'), '1');
});

it('POST /v1/eventsで保存した原文はコンテナ再作成後も残る', async () => {
  await resetDb();
  await psql(insertWorkspaceSql());
  const event = {
    idempotency_key: 'e2e-idem-1',
    source: 'codex',
    source_scope: 'e2e-scope',
    source_session_id: 'e2e-session',
    source_message_id: 'e2e-msg',
    sequence_no: 1,
    revision: 1,
    role: 'user',
    occurred_at: '2026-09-21T01:00:00.000Z',
    text: RAW_TEXT,
  };

  const response = await fetch(`${API_BASE_URL}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ project_id: PROJECT_ID, events: [event] }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 202, `POST /v1/eventsが202でない: ${response.status} ${responseText}`);
  const parsed = JSON.parse(responseText) as { results: Array<{ message_id: string; request_id: string | null }> };
  const savedMessageId = parsed.results[0].message_id;
  assert.ok(savedMessageId.length > 0, `message_idが返らない: ${responseText}`);
  assert.ok(parsed.results[0].request_id, `userイベントのrequest_idが返らない: ${responseText}`);

  await composeOk(['up', '-d', '--wait', '--force-recreate', 'db']);
  await waitForDbReady();

  const expectedHex = Buffer.from(RAW_TEXT, 'utf8').toString('hex');
  assert.equal(await storedTextHex(savedMessageId), expectedHex, 'API保存の原文がコンテナ再作成後に変化した');
  assert.equal(
    await psql(`SELECT encode(content_hash, 'hex') FROM message_revisions WHERE message_id = '${savedMessageId}'`),
    createHash('sha256').update(RAW_TEXT, 'utf8').digest('hex'),
    'content_hashが一致しない',
  );
  assert.equal(await psql('SELECT count(*)::text FROM search_requests'), '1', '自動検索受付が残っていない');
});
