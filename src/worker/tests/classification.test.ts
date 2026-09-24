import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { processJob } from '../process.js';
import {
  buildWorkerConfig,
  claimJobForMessage,
  countAnalysis,
  countJobsByKind,
  jevChoices,
  jevReply,
  mergeChoices,
  questionField,
  readAnalysis,
  readEvaluations,
  readJob,
  readRelations,
  readRevision,
  readUsageEvents,
  seedMessage,
  seedSession,
  seedUserMessage,
  startApprovedJev,
  type FakeJevServer,
} from './support.js';

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

async function processClassify(messageId: string, server: FakeJevServer): Promise<string> {
  const config = buildWorkerConfig(server.baseUrl);
  const job = await claimJobForMessage(pool, 'classify_message', messageId);
  await processJob(pool, job, config);
  return job.id;
}

describe('分類と原文保持', () => {
  it('substantiveの高信頼分類を保存し、原文とbuild_documents jobを保持する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const text = '毎分100件までにしてください';
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text });
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({
      body: jevReply(
        request,
        jevChoices({
          retention: 'substantive',
          primary_intent: 'requirements',
          statement_status: 'request',
          'technical_label:backend': 'yes',
        }),
      ),
    }));
    try {
      const jobId = await processClassify(seeded.messageId, server);
      assert.equal(server.requests.length, 1, 'Jev呼出し回数が1回でない');
      assert.ok(
        Buffer.byteLength(server.requests[0].rawBody, 'utf8') <= 8_000,
        '送信bodyが入力予算8,000バイトを超えている',
      );

      const analysis = await readAnalysis(pool, seeded.messageId, 1);
      assert.ok(analysis, 'message_analysisが保存されていない');
      assert.equal(analysis.retention, 'substantive');
      assert.equal(analysis.is_searchable, true);
      assert.equal(analysis.primary_intent, 'requirements');
      assert.equal(analysis.statement_status, 'request');
      assert.ok(analysis.technical_labels.includes('backend'), `technical_labelsが不正: ${analysis.technical_labels.join(',')}`);
      assert.equal(analysis.policy_version, 'initial-v1');
      assert.ok(analysis.model_version.length > 0, 'model_versionが保存されていない');
      assert.ok(analysis.state_hash.length > 0, 'state_hashが保存されていない');
      assert.equal(analysis.parts.length, 1);
      assert.deepEqual(
        { offset: analysis.parts[0].offset, length: analysis.parts[0].length },
        { offset: 0, length: text.length },
        'partの原文範囲が一致しない',
      );

      assert.equal((await readJob(pool, jobId)).status, 'completed');
      assert.equal(await countJobsByKind(pool, 'build_documents'), 1, 'build_documents jobがpendingで保存されていない');
      assert.equal((await readRevision(pool, seeded.messageId, 1))?.text, text, '原文が変更されている');
    } finally {
      await server.close();
    }
  });

  it('decision_signalの承認を候補発言revisionへリンクする', async () => {
    const sessionId = await seedSession(pool, workspace);
    const proposal = await seedMessage(pool, { sessionId, sequenceNo: 1, role: 'assistant', text: 'キャッシュを無効化する案です' });
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 2, text: 'その案で実装してください' });
    const select = mergeChoices(
      (question) =>
        questionField(question.id) === 'relation_target'
          ? question.criteria[proposal.messageId] === undefined
            ? 'none'
            : proposal.messageId
          : undefined,
      jevChoices({ retention: 'decision_signal', decision_action: 'accept', continuity: 'same_topic', statement_status: 'approval' }),
    );
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({ body: jevReply(request, select) }));
    try {
      await processClassify(seeded.messageId, server);
      const relations = await readRelations(pool, seeded.messageId, 1);
      assert.equal(relations.length, 1, '承認関係が1件でない');
      assert.equal(relations[0].target_message_id, proposal.messageId, '候補revisionへリンクしていない');
      assert.equal(relations[0].target_revision, 1);
      assert.equal(relations[0].relation, 'accept');
      assert.equal(relations[0].policy_version, 'initial-v1');

      const analysis = await readAnalysis(pool, seeded.messageId, 1);
      assert.ok(analysis, 'message_analysisが保存されていない');
      assert.equal(analysis.retention, 'decision_signal');
      assert.equal(analysis.decision_action, 'accept');
    } finally {
      await server.close();
    }
  });

  it('撤回を候補発言revisionへリンクする', async () => {
    const sessionId = await seedSession(pool, workspace);
    const proposal = await seedMessage(pool, { sessionId, sequenceNo: 1, role: 'assistant', text: '以前の実装案です' });
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 2, text: 'その案は取り消し' });
    const select = mergeChoices(
      (question) =>
        questionField(question.id) === 'relation_target'
          ? question.criteria[proposal.messageId] === undefined
            ? 'none'
            : proposal.messageId
          : undefined,
      jevChoices({ retention: 'decision_signal', decision_action: 'revoke', continuity: 'same_topic', statement_status: 'approval' }),
    );
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({ body: jevReply(request, select) }));
    try {
      await processClassify(seeded.messageId, server);
      const relations = await readRelations(pool, seeded.messageId, 1);
      assert.equal(relations.length, 1, '撤回関係が1件でない');
      assert.equal(relations[0].target_message_id, proposal.messageId);
      assert.equal(relations[0].relation, 'revoke');
    } finally {
      await server.close();
    }
  });

  it('none/unknownのrelation_targetを無関係な提案へ紐付けない', async () => {
    const sessionId = await seedSession(pool, workspace);
    await seedMessage(pool, { sessionId, sequenceNo: 1, role: 'assistant', text: '無関係な提案です' });
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 2, text: '進めておいてください' });
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({
      body: jevReply(request, jevChoices({ retention: 'progress_only', decision_action: 'none', relation_target: 'none' })),
    }));
    try {
      await processClassify(seeded.messageId, server);
      const relations = await readRelations(pool, seeded.messageId, 1);
      assert.equal(relations.length, 0, 'noneのrelation_targetを候補へ紐付けている');
    } finally {
      await server.close();
    }
  });

  it('高信頼progress_onlyだけを検索対象から外し、原文は保持する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const text = '続けてください';
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text });
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({
      body: jevReply(request, jevChoices({ retention: 'progress_only', statement_status: 'request' })),
    }));
    try {
      await processClassify(seeded.messageId, server);
      const analysis = await readAnalysis(pool, seeded.messageId, 1);
      assert.ok(analysis, 'message_analysisが保存されていない');
      assert.equal(analysis.retention, 'progress_only');
      assert.equal(analysis.is_searchable, false, '高信頼progress_onlyが検索対象のまま');
      assert.equal((await readRevision(pool, seeded.messageId, 1))?.text, text, 'progress_onlyで原文が消えている');
    } finally {
      await server.close();
    }
  });

  it('低信頼分類はunknownとし、低信頼ラベルを採用しない', async () => {
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: 'たぶん続けます' });
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({
      body: jevReply(
        request,
        jevChoices({
          retention: { choice: 'progress_only', confidence: 0.5 },
          'technical_label:backend': { choice: 'yes', confidence: 0.5 },
        }),
      ),
    }));
    try {
      await processClassify(seeded.messageId, server);
      const analysis = await readAnalysis(pool, seeded.messageId, 1);
      assert.ok(analysis, 'message_analysisが保存されていない');
      assert.equal(analysis.retention, 'unknown', '低信頼分類を採用している');
      assert.equal(analysis.is_searchable, true, '低信頼分類で検索対象から外している');
      assert.equal(analysis.technical_labels.includes('backend'), false, '低信頼ラベルを採用している');
    } finally {
      await server.close();
    }
  });

  it('候補外IDと不正な確率分布を契約違反として適用しない', async () => {
    const outside = await seedUserMessage(pool, { workspace, sessionId: await seedSession(pool, workspace), sequenceNo: 1, text: '候補外IDを返す' });
    const invalid = await seedUserMessage(pool, { workspace, sessionId: await seedSession(pool, workspace), sequenceNo: 1, text: '不正な分布を返す' });
    const server = await startApprovedJev(pool, workspace.companyId, (request, rawBody) => {
      if (rawBody.includes('候補外IDを返す')) {
        return {
          body: jevReply(
            request,
            mergeChoices(
              (question) => (questionField(question.id) === 'relation_target' ? '0a000000-0000-7000-8000-00000000ffff' : undefined),
              jevChoices(),
            ),
          ),
        };
      }
      const reply = jevReply(request, jevChoices());
      const first = Object.values(reply.answers)[0];
      assert.ok(first, '回答がない');
      first.probabilities = { invalid_choice: 2 };
      return { body: reply };
    });
    try {
      const outsideJobId = await processClassify(outside.messageId, server);
      const invalidJobId = await processClassify(invalid.messageId, server);
      assert.equal((await readJob(pool, outsideJobId)).status, 'failed', '候補外IDがfailedにならない');
      assert.equal((await readJob(pool, invalidJobId)).status, 'failed', '不正な確率分布がfailedにならない');
      assert.equal(await countAnalysis(pool), 0, '契約違反の応答を適用している');
      assert.equal((await readRevision(pool, outside.messageId, 1))?.text, '候補外IDを返す');
      assert.equal((await readRevision(pool, invalid.messageId, 1))?.text, '不正な分布を返す');
    } finally {
      await server.close();
    }
  });
  it('要求model（alias）と実応答modelを区別してanalysis・usage・cacheへ保存する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: '応答modelの区別確認' });
    const server = await startApprovedJev(pool, workspace.companyId, (request) => ({
      body: { ...jevReply(request, jevChoices({ retention: 'substantive', primary_intent: 'implementation' })), model: 'jev-actual-7' },
    }));
    try {
      await processClassify(seeded.messageId, server);
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0].body.model, 'jev-latest', '送信modelが要求aliasでない');

      const analysis = await readAnalysis(pool, seeded.messageId, 1);
      assert.ok(analysis, 'message_analysisが保存されていない');
      assert.equal(analysis.model_version, 'jev-actual-7', 'analysisのmodel_versionが実応答modelでない');
      assert.equal(analysis.parts[0]?.model_version, 'jev-actual-7', 'partのmodel_versionが実応答modelでない');

      const usage = await readUsageEvents(pool, workspace.companyId);
      assert.equal(usage.length, 1);
      assert.equal(usage[0].model, 'jev-latest', 'usageの要求modelがaliasでない');
      assert.equal(usage[0].response_model, 'jev-actual-7', 'usageの応答modelが実応答modelでない');

      const evaluations = await readEvaluations(pool, workspace.companyId);
      assert.equal(evaluations.length, 1);
      assert.equal(evaluations[0].model, 'jev-latest', 'cache keyのmodelがaliasでない');
      assert.equal(evaluations[0].response_model, 'jev-actual-7', 'cacheの応答modelが実応答modelでない');
    } finally {
      await server.close();
    }
  });
});
