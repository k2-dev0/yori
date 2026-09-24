import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { processJob } from '../process.js';
import {
  advanceRevision,
  buildWorkerConfig,
  claimJobForMessage,
  countAnalysis,
  isWellFormedText,
  jevChoices,
  jevReply,
  mergeChoices,
  questionField,
  questionPartIndex,
  readAnalysis,
  readJob,
  readRevision,
  seedApproval,
  seedMessage,
  seedSession,
  seedUserMessage,
  startFakeJev,
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

async function processClassify(messageId: string, serverBaseUrl: string): Promise<string> {
  const job = await claimJobForMessage(pool, 'classify_message', messageId);
  await processJob(pool, job, buildWorkerConfig(serverBaseUrl));
  return job.id;
}

describe('長文と応答検証', () => {
  it('直前最大6発言を最新revisionで文脈へ入れ、現在以降と別sessionを入れない', async () => {
    const sessionId = await seedSession(pool, workspace);
    const priors: Array<{ messageId: string; text: string }> = [];
    for (let sequenceNo = 1; sequenceNo <= 8; sequenceNo += 1) {
      const seeded = await seedMessage(pool, {
        sessionId,
        sequenceNo,
        role: sequenceNo % 2 === 0 ? 'assistant' : 'user',
        text: `過去発言-${sequenceNo}-本文`,
      });
      priors.push({ messageId: seeded.messageId, text: `過去発言-${sequenceNo}-本文` });
    }
    await advanceRevision(pool, priors[7].messageId, '過去発言-8-改訂後の本文');
    await seedMessage(pool, { sessionId, sequenceNo: 10, role: 'assistant', text: '現在より後の発言' });
    const otherSessionId = await seedSession(pool, workspace);
    await seedMessage(pool, { sessionId: otherSessionId, sequenceNo: 1, role: 'user', text: '別セッションの発言' });

    const currentText = '現在の対象発言';
    const current = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 9, text: currentText });
    const server = await startFakeJev((request) => ({ body: jevReply(request, jevChoices({ retention: 'substantive' })) }));
    try {
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: buildWorkerConfig(server.baseUrl).apiUrl });
      await processClassify(current.messageId, server.baseUrl);
      assert.equal(server.requests.length, 1, 'Jev呼出し回数が1回でない');
      const request = server.requests[0];
      const state = request.body.state;
      assert.equal(state.prior_messages.length, 6, '文脈が6発言でない');
      const expectedIds = new Set(priors.slice(2).map((prior) => prior.messageId));
      const actualIds = new Set(state.prior_messages.map((message) => message.message_id));
      assert.deepEqual(actualIds, expectedIds, '直近6発言以外が文脈に入っている');
      const revised = state.prior_messages.find((message) => message.message_id === priors[7].messageId);
      assert.equal(revised?.text, '過去発言-8-改訂後の本文', '最新revisionを使っていない');
      assert.equal(state.current.message_id, current.messageId);
      assert.equal(state.current.revision, 1);
      assert.equal(state.current.parts.map((part) => part.text).join(''), currentText);

      const raw = request.rawBody;
      assert.equal(raw.includes('過去発言-8-旧本文'), false);
      assert.equal(raw.includes('過去発言-1-本文'), false, '古い文脈が入っている');
      assert.equal(raw.includes('過去発言-2-本文'), false, '古い文脈が入っている');
      assert.equal(raw.includes('現在より後の発言'), false, '現在以降の発言が入っている');
      assert.equal(raw.includes('別セッションの発言'), false, '別sessionの発言が入っている');
      assert.ok(Buffer.byteLength(raw, 'utf8') <= 8_000, '送信bodyが入力予算を超えている');
    } finally {
      await server.close();
    }
  });

  it('予算に入らない古い文脈は完全な発言だけ残して除外を明示する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const priors: Array<{ messageId: string; text: string }> = [];
    for (let sequenceNo = 1; sequenceNo <= 6; sequenceNo += 1) {
      // 6件合計は8,000バイト予算を超えるが、最新1件と質問定義は収まるサイズにする。
      const text = `過去文脈-${sequenceNo}:` + 'あ'.repeat(600);
      const seeded = await seedMessage(pool, { sessionId, sequenceNo, role: sequenceNo % 2 === 0 ? 'assistant' : 'user', text });
      priors.push({ messageId: seeded.messageId, text });
    }
    const current = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 7, text: '長い文脈の対象発言' });
    const server = await startFakeJev((request) => ({ body: jevReply(request, jevChoices({ retention: 'substantive' })) }));
    try {
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: buildWorkerConfig(server.baseUrl).apiUrl });
      await processClassify(current.messageId, server.baseUrl);
      const request = server.requests[0];
      assert.ok(request, 'Jevへ送信していない');
      assert.ok(Buffer.byteLength(request.rawBody, 'utf8') <= 8_000, '送信bodyが入力予算を超えている');
      const state = request.body.state;
      assert.equal(state.truncation.split_current, false);
      assert.ok(state.truncation.omitted_prior_messages >= 1, '除外した文脈数がstateにない');
      assert.ok(state.prior_messages.length >= 1, '直近文脈が入っていない');
      const newest = state.prior_messages.find((message) => message.message_id === priors[5].messageId);
      assert.ok(newest, '最新の文脈が入っていない');
      assert.equal(newest.text, priors[5].text, '入れた文脈が完全でない');
      assert.equal(request.rawBody.includes(priors[0].text), false, '予算外の古い文脈が入っている');
      for (const message of state.prior_messages) {
        const original = priors.find((prior) => prior.messageId === message.message_id);
        assert.ok(original, '由来不明の文脈が入っている');
        assert.equal(message.text, original.text, '途中で切れた文脈が入っている');
      }
    } finally {
      await server.close();
    }
  });

  it('長文の現在発言をUnicode境界で分割し、offset付きpartを保存する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const original = '😀日本語テキスト'.repeat(700);
    const current = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: original });
    const server = await startFakeJev((request) => ({ body: jevReply(request, jevChoices({ retention: 'substantive' })) }));
    try {
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: buildWorkerConfig(server.baseUrl).apiUrl });
      await processClassify(current.messageId, server.baseUrl);
      assert.ok(server.requests.length >= 2, '1回の予算へ収まらない長文が複数callへ分割されていない');
      for (const request of server.requests) {
        assert.equal(request.body.state.current.message_id, current.messageId, '別messageを送信している');
        assert.ok(Buffer.byteLength(request.rawBody, 'utf8') <= 8_000, '送信ごとのbodyが入力予算を超えている');
      }
      const sentParts = server.requests.flatMap((request) => request.body.state.current.parts);
      assert.ok(sentParts.length >= 2, '長文が分割されていない');
      let offset = 0;
      for (const part of sentParts) {
        assert.equal(part.offset, offset, 'partのoffsetが連続していない');
        assert.ok(part.length > 0, '空のpartがある');
        assert.ok(isWellFormedText(part.text), 'Unicode境界で分割されている');
        assert.equal(original.slice(part.offset, part.offset + part.length), part.text, 'part本文が原文範囲と一致しない');
        offset += part.length;
      }
      assert.equal(offset, original.length, '現在発言が切り捨てられている');
      assert.equal(sentParts.map((part) => part.text).join(''), original);

      const analysis = await readAnalysis(pool, current.messageId, 1);
      assert.ok(analysis, 'message_analysisが保存されていない');
      assert.equal(analysis.parts.length, sentParts.length, '保存part数が送信part数と違う');
      for (const [index, part] of analysis.parts.entries()) {
        assert.equal(part.offset, sentParts[index].offset);
        assert.equal(part.length, sentParts[index].length);
      }
      assert.equal(analysis.retention, 'substantive');
      assert.equal(analysis.is_searchable, true);
    } finally {
      await server.close();
    }
  });

  it('part間のretentionは優先順位で統合し、全part高信頼progress_onlyだけ除外する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const mixed = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: '😀日本語テキスト'.repeat(700) });
    const allProgress = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 2, text: '😀日本語テキスト'.repeat(700) });
    const server = await startFakeJev((request) =>
      ({
        body: jevReply(
          request,
          mergeChoices(
            (question, sentRequest) => {
              if (sentRequest.state.current.message_id !== mixed.messageId) {
                return undefined;
              }
              const index = questionPartIndex(question.id);
              const part = index === null ? sentRequest.state.current.parts[0] : sentRequest.state.current.parts[index];
              const field = questionField(question.id);
              if (field === 'retention') {
                return part?.offset === 0 ? 'substantive' : 'progress_only';
              }
              if (field === 'primary_intent') {
                return part?.offset === 0 ? 'implementation' : 'other';
              }
              return undefined;
            },
            jevChoices({ retention: 'progress_only' }),
          ),
        ),
      }),
    );
    try {
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: buildWorkerConfig(server.baseUrl).apiUrl });
      await processClassify(mixed.messageId, server.baseUrl);
      await processClassify(allProgress.messageId, server.baseUrl);
      const mixedAnalysis = await readAnalysis(pool, mixed.messageId, 1);
      assert.ok(mixedAnalysis, 'message_analysisが保存されていない');
      assert.equal(mixedAnalysis.retention, 'substantive', 'retentionのpart混在を優先順位どおりsubstantiveにしていない');
      assert.equal(mixedAnalysis.is_searchable, true, 'retention混在で除外している');
      assert.equal(mixedAnalysis.primary_intent, 'unknown', 'retention以外のpart不一致をunknownにしていない');

      const allProgressAnalysis = await readAnalysis(pool, allProgress.messageId, 1);
      assert.ok(allProgressAnalysis, 'progress_onlyのmessage_analysisがない');
      assert.equal(allProgressAnalysis.retention, 'progress_only');
      assert.equal(allProgressAnalysis.is_searchable, false, '全part高信頼progress_onlyが除外されていない');
      assert.equal((await readRevision(pool, allProgress.messageId, 1))?.text, '😀日本語テキスト'.repeat(700), 'progress_onlyで原文が消えている');
    } finally {
      await server.close();
    }
  });

  it('質問定義だけで予算を超える設定は送信せずfailedにする', async () => {
    const sessionId = await seedSession(pool, workspace);
    const current = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: '予算不足の確認' });
    const server = await startFakeJev((request) => ({ body: jevReply(request, jevChoices()) }));
    try {
      const config = buildWorkerConfig(server.baseUrl, { inputBudgetBytes: 100 });
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: config.apiUrl, active: true });
      const job = await claimJobForMessage(pool, 'classify_message', current.messageId);
      await processJob(pool, job, config);
      assert.equal(server.requests.length, 0, '予算不足なのに外部送信している');
      const stored = await readJob(pool, job.id);
      assert.equal(stored.status, 'failed', `予算不足がfailedでない: ${stored.status}`);
      assert.ok(stored.error_code !== null, '予算不足のerror_codeがない');
      assert.equal(await countAnalysis(pool), 0);
      assert.equal((await readRevision(pool, current.messageId, 1))?.text, '予算不足の確認');
    } finally {
      await server.close();
    }
  });
  it('partごとに異なる応答modelは重複除去した出現順の配列でmodel_versionへ保存する', async () => {
    const sessionId = await seedSession(pool, workspace);
    const original = '😀日本語テキスト'.repeat(700);
    const current = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: original });
    let call = 0;
    const server = await startFakeJev((request) => {
      call += 1;
      return {
        body: {
          ...jevReply(request, jevChoices({ retention: 'substantive' })),
          model: call % 2 === 1 ? 'model-a' : 'model-b',
        },
      };
    });
    try {
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: buildWorkerConfig(server.baseUrl).apiUrl });
      await processClassify(current.messageId, server.baseUrl);
      assert.ok(server.requests.length >= 2, '複数partへ分割されていない');

      const analysis = await readAnalysis(pool, current.messageId, 1);
      assert.ok(analysis, 'message_analysisが保存されていない');
      assert.equal(analysis.model_version, JSON.stringify(['model-a', 'model-b']), '混在modelの重複除去配列になっていない');
      assert.deepEqual(
        analysis.parts.map((part) => part.model_version),
        server.requests.map((_, index) => (index % 2 === 0 ? 'model-a' : 'model-b')),
        'partごとの応答modelが出現順に保存されていない',
      );
    } finally {
      await server.close();
    }
  });
});
