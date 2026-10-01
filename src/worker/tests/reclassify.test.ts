import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { claimJobs } from '../../jobs/queue.js';
import { processJob } from '../process.js';
import { reclassifyMessages } from '../reclassify.js';
import {
  buildWorkerConfig,
  enqueueWorkerJobs,
  jevChoices,
  jevReply,
  readAnalysis,
  readJob,
  seedMessage,
  seedSession,
  startApprovedJev,
  type FakeJevServer,
} from './support.js';

// 情報源の分類を持たない既存の回答を、既存のclassify_message jobを再実行して分類し直す。

const pool = createPool(requireDatabaseUrl());
let workspace: WorkspaceFixture;

before(async () => {
  await runMigrations(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
  workspace = await seedWorkspace(pool);
});

after(async () => {
  await pool.end();
});

// 待機中のclassify_message jobを1件処理し、対象messageのIDを返す。
async function processNextClassify(server: FakeJevServer): Promise<string> {
  const [job] = await claimJobs(pool, { kinds: ['classify_message'], limit: 1 });
  assert.ok(job, 'classify_message jobをclaimできない');
  await processJob(pool, job, buildWorkerConfig(server.baseUrl));
  assert.ok(job.messageId, 'jobに対象messageがない');
  return job.messageId;
}

// 分類済みで情報源だけがunknownの発言（列追加前の状態）を作る。旧版の評価cacheは残さない。
async function seedLegacyMessage(
  server: FakeJevServer,
  input: { sessionId: string; sequenceNo: number; role: 'user' | 'assistant' },
): Promise<{ messageId: string; classifyJobId: string }> {
  const message = await seedMessage(pool, { sessionId: input.sessionId, sequenceNo: input.sequenceNo, role: input.role, text: `既存の発言-${input.sequenceNo}` });
  const jobs = await enqueueWorkerJobs(pool, { sessionId: input.sessionId, messageId: message.messageId, revision: message.revision });
  await pool.query(`UPDATE jobs SET status = 'completed' WHERE id = $1`, [jobs.routeJobId]);
  assert.equal(await processNextClassify(server), message.messageId);
  await pool.query(`UPDATE message_analysis SET information_source = 'unknown' WHERE message_id = $1`, [message.messageId]);
  await pool.query('DELETE FROM jev_evaluations');
  return { messageId: message.messageId, classifyJobId: jobs.classifyJobId };
}

describe('既存発言の再分類', () => {
  it('情報源がunknownの既存の回答を再分類し、Jevの判定を保存する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const legacy = await startApprovedJev(pool, workspace.companyId, (request) => ({ body: jevReply(request, jevChoices({ retention: 'substantive' })) }));
    const seeded = await seedLegacyMessage(legacy, { sessionId, sequenceNo: 1, role: 'assistant' });
    await legacy.close();
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({
      body: jevReply(request, jevChoices({ retention: 'substantive', information_source: 'relayed_history' })),
    }));
    try {
      assert.equal(await reclassifyMessages(pool, workspace.projectId), 1, '再分類の対象件数が違う');
      assert.equal((await readJob(pool, seeded.classifyJobId)).status, 'pending', '既存の分類jobを再実行待ちへ戻していない');
      assert.equal(await processNextClassify(server), seeded.messageId);
      assert.equal(server.requests.length, 1, 'Jevへ再評価を送っていない');
      assert.equal((await readAnalysis(pool, seeded.messageId, 1))?.information_source, 'relayed_history');
    } finally {
      await server.close();
    }
  });

  it('別の案件の発言と利用者の発言は再分類しない', async () => {
    const other = await seedWorkspace(pool, { name: 'company-b', repositoryIdentifier: 'repo-b' });
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({ body: jevReply(request, jevChoices({ retention: 'substantive' })) }));
    const otherServer = await startApprovedJev(pool, other.companyId, (request) => ({ body: jevReply(request, jevChoices({ retention: 'substantive' })) }));
    try {
      const sessionId = await seedSession(pool, workspace);
      const userMessage = await seedLegacyMessage(server, { sessionId, sequenceNo: 1, role: 'user' });
      const reply = await seedLegacyMessage(server, { sessionId, sequenceNo: 2, role: 'assistant' });
      const otherSession = await seedSession(pool, other);
      const otherReply = await seedLegacyMessage(otherServer, { sessionId: otherSession, sequenceNo: 1, role: 'assistant' });

      assert.equal(await reclassifyMessages(pool, workspace.projectId), 1, '対象案件の回答以外を数えている');
      assert.equal((await readJob(pool, reply.classifyJobId)).status, 'pending');
      assert.equal((await readJob(pool, userMessage.classifyJobId)).status, 'completed', '利用者の発言を再分類している');
      assert.equal((await readJob(pool, otherReply.classifyJobId)).status, 'completed', '別の案件の発言を再分類している');
    } finally {
      await server.close();
      await otherServer.close();
    }
  });

  it('途中で止めて再実行しても、分類済みの発言を二重に処理せず残りだけ処理する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const legacy = await startApprovedJev(pool, workspace.companyId, (request) => ({ body: jevReply(request, jevChoices({ retention: 'substantive' })) }));
    const first = await seedLegacyMessage(legacy, { sessionId, sequenceNo: 1, role: 'assistant' });
    const second = await seedLegacyMessage(legacy, { sessionId, sequenceNo: 2, role: 'assistant' });
    await legacy.close();
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({
      body: jevReply(request, jevChoices({ retention: 'substantive', information_source: 'first_hand' })),
    }));
    try {
      assert.equal(await reclassifyMessages(pool, workspace.projectId), 2);
      const processedId = await processNextClassify(server);
      const processed = processedId === first.messageId ? first : second;
      const remaining = processedId === first.messageId ? second : first;

      assert.equal(await reclassifyMessages(pool, workspace.projectId), 0, '分類済み・再実行待ちの発言を再び対象にしている');
      assert.equal((await readJob(pool, processed.classifyJobId)).status, 'completed', '分類済みの発言を再実行待ちへ戻している');
      assert.equal((await readJob(pool, remaining.classifyJobId)).status, 'pending');
      const jobs = await pool.query<{ count: string }>(`SELECT count(*) FROM jobs WHERE kind = 'classify_message' AND message_id = $1`, [remaining.messageId]);
      assert.equal(jobs.rows[0]?.count, '1', '同じ発言の分類jobを重複させている');

      assert.equal(await processNextClassify(server), remaining.messageId);
      assert.equal(server.requests.length, 2, '発言ごとに1回を超えてJevへ送っている');
      assert.equal((await readAnalysis(pool, remaining.messageId, 1))?.information_source, 'first_hand');
    } finally {
      await server.close();
    }
  });
});
