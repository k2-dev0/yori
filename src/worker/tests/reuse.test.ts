import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { insertProject, insertSession, resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { processJob } from '../process.js';
import {
  advanceRevision,
  buildWorkerConfig,
  claimJobForMessage,
  countJobsByKind,
  jevChoices,
  jevReply,
  matchedResult,
  minutesAgo,
  minutesFromNow,
  readSearchRequest,
  seedApproval,
  seedMessage,
  seedRelation,
  seedSearchRequest,
  seedSession,
  seedUserMessage,
  startFakeJev,
  type EvidenceSeed,
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

interface PairSeed {
  priorSessionId: string;
  evidenceMessageId: string;
  priorRequestId: string;
  current: Awaited<ReturnType<typeof seedUserMessage>>;
}

// 同一sessionの先行completed matched検索と、その後の入力を作る。オプションで不適格条件を作れる。
async function seedPair(
  options: {
    priorStatus?: string;
    priorOutcome?: string | null;
    priorCreatedAt?: Date;
    priorExpiresAt?: Date | null;
    priorPolicyVersion?: string;
    result?: unknown;
    priorSessionId?: string;
    currentSessionId?: string;
  } = {},
): Promise<PairSeed> {
  const priorSessionId = options.priorSessionId ?? (await seedSession(pool, workspace));
  const evidence = await seedMessage(pool, { sessionId: priorSessionId, sequenceNo: 1, role: 'assistant', text: '以前の修正報告' });
  const priorInput = await seedMessage(pool, { sessionId: priorSessionId, sequenceNo: 2, role: 'user', text: '前回の質問' });
  const defaultEvidence: EvidenceSeed = {
    messageId: evidence.messageId,
    revision: 1,
    employeeId: workspace.employeeId,
    role: 'assistant',
    occurredAt: new Date().toISOString(),
    text: '以前の修正報告',
  };
  const priorRequestId = await seedSearchRequest(pool, {
    workspace,
    sessionId: priorSessionId,
    inputId: priorInput.messageId,
    sequenceNo: 2,
    status: options.priorStatus ?? 'completed',
    outcome: options.priorOutcome === undefined ? 'matched' : options.priorOutcome,
    searchAction: 'new_search',
    policyVersion: options.priorPolicyVersion,
    result: options.result === undefined ? matchedResult([defaultEvidence]) : options.result,
    createdAt: options.priorCreatedAt ?? minutesAgo(5),
    expiresAt: options.priorExpiresAt === undefined ? minutesFromNow(5) : options.priorExpiresAt,
  });
  const currentSessionId = options.currentSessionId ?? priorSessionId;
  const current = await seedUserMessage(pool, {
    workspace,
    sessionId: currentSessionId,
    sequenceNo: currentSessionId === priorSessionId ? 3 : 1,
    text: '同じ症状です',
  });
  return { priorSessionId, evidenceMessageId: evidence.messageId, priorRequestId, current };
}

interface ChainSeed {
  originRequestId: string;
  originInputId: string;
  evidenceMessageId: string;
  current: Awaited<ReturnType<typeof seedUserMessage>>;
}

// A(new_search)←B(reuse)←現在入力C を作り、B・Aの状態をオプションで変えられるようにする。
async function seedReuseChain(options: { originStatus?: 'completed' | 'pending'; middleStatus?: 'completed' | 'pending' } = {}): Promise<ChainSeed> {
  const sessionId = await seedSession(pool, workspace);
  const evidence = await seedMessage(pool, { sessionId, sequenceNo: 1, role: 'assistant', text: '以前の修正報告' });
  const evidenceSeed: EvidenceSeed = {
    messageId: evidence.messageId,
    revision: 1,
    employeeId: workspace.employeeId,
    role: 'assistant',
    occurredAt: new Date().toISOString(),
    text: '以前の修正報告',
  };
  const originInput = await seedMessage(pool, { sessionId, sequenceNo: 2, role: 'user', text: '元の質問' });
  const originStatus = options.originStatus ?? 'completed';
  const originRequestId = await seedSearchRequest(pool, {
    workspace,
    sessionId,
    inputId: originInput.messageId,
    sequenceNo: 2,
    status: originStatus,
    outcome: originStatus === 'completed' ? 'matched' : null,
    searchAction: 'new_search',
    result: originStatus === 'completed' ? matchedResult([evidenceSeed]) : null,
    createdAt: minutesAgo(5),
    expiresAt: originStatus === 'completed' ? minutesFromNow(5) : null,
  });
  const middleInput = await seedMessage(pool, { sessionId, sequenceNo: 3, role: 'user', text: '再利用した質問' });
  const middleStatus = options.middleStatus ?? 'pending';
  await seedSearchRequest(pool, {
    workspace,
    sessionId,
    inputId: middleInput.messageId,
    sequenceNo: 3,
    status: middleStatus,
    outcome: middleStatus === 'completed' ? 'matched' : null,
    searchAction: 'reuse',
    reusedFromRequestId: originRequestId,
    result: middleStatus === 'completed' ? matchedResult([evidenceSeed]) : null,
    createdAt: minutesAgo(4),
    expiresAt: middleStatus === 'completed' ? minutesFromNow(5) : null,
  });
  const current = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 4, text: '同じ症状です' });
  return { originRequestId, originInputId: originInput.messageId, evidenceMessageId: evidence.messageId, current };
}

async function expectRouteAction(
  pair: PairSeed,
  server: FakeJevServer,
  expected: 'new_search' | 'reuse',
  label: string,
): Promise<void> {
  await seedApproval(pool, { companyId: workspace.companyId, endpoint: buildWorkerConfig(server.baseUrl).apiUrl });
  const baseline = await countJobsByKind(pool, 'execute_search');
  const job = await claimJobForMessage(pool, 'route_search', pair.current.messageId);
  await processJob(pool, job, buildWorkerConfig(server.baseUrl));
  const request = await readSearchRequest(pool, pair.current.searchRequestId);
  assert.equal(request.search_action, expected, `${label}: search_actionが${expected}でない`);
  if (expected === 'reuse') {
    assert.equal(request.reused_from_request_id, pair.priorRequestId, `${label}: 先行request参照がない`);
    assert.equal(await countJobsByKind(pool, 'execute_search'), baseline, `${label}: reuseでexecute_searchを登録している`);
  } else {
    assert.equal(request.reused_from_request_id, null, `${label}: 不適格な先行検索を参照している`);
    assert.equal(await countJobsByKind(pool, 'execute_search'), baseline + 1, `${label}: execute_searchが登録されていない`);
  }
}

function reuseReply(): (request: Parameters<typeof jevReply>[0]) => { body: unknown } {
  return (request) => ({
    body: jevReply(request, jevChoices({ search_action: 'reuse', continuity: 'same_topic', same_conditions: 'yes' })),
  });
}

describe('再利用の制限', () => {
  it('有効期間内のcompleted matchedは再利用し、期限切れはnew_searchにする', async () => {
    const inside = await seedPair({ priorCreatedAt: minutesAgo(5), priorExpiresAt: minutesFromNow(5) });
    const insideServer = await startFakeJev(reuseReply());
    try {
      await expectRouteAction(inside, insideServer, 'reuse', '期限内');
    } finally {
      await insideServer.close();
    }

    const expired = await seedPair({ priorCreatedAt: minutesAgo(11), priorExpiresAt: minutesAgo(1) });
    const expiredServer = await startFakeJev(reuseReply());
    try {
      await expectRouteAction(expired, expiredServer, 'new_search', '期限切れ');
    } finally {
      await expiredServer.close();
    }
  });

  it('pending/runningの先行検索も共有し、結果をコピーしない', async () => {
    for (const status of ['pending', 'running']) {
      const pair = await seedPair({ priorStatus: status, priorOutcome: null, priorExpiresAt: null, result: null });
      const server = await startFakeJev(reuseReply());
      try {
        await expectRouteAction(pair, server, 'reuse', `${status}の先行検索`);
        const request = await readSearchRequest(pool, pair.current.searchRequestId);
        assert.equal(request.result, null, `${status}: 先行結果をコピーしている`);
      } finally {
        await server.close();
      }
    }
  });

  it('直近の先行検索が不適格でも、古い有効候補へ飛ばない', async () => {
    const sessionId = await seedSession(pool, workspace);
    await seedMessage(pool, { sessionId, sequenceNo: 1, role: 'assistant', text: '以前の修正報告' });
    const olderInput = await seedMessage(pool, { sessionId, sequenceNo: 2, role: 'user', text: '古い質問' });
    await seedSearchRequest(pool, {
      workspace,
      sessionId,
      inputId: olderInput.messageId,
      sequenceNo: 2,
      status: 'completed',
      outcome: 'matched',
      searchAction: 'new_search',
      result: matchedResult([
        { messageId: olderInput.messageId, revision: 1, employeeId: workspace.employeeId, role: 'user', occurredAt: new Date().toISOString(), text: '古い質問' },
      ]),
      createdAt: minutesAgo(6),
      expiresAt: minutesFromNow(4),
    });
    const newerInput = await seedMessage(pool, { sessionId, sequenceNo: 3, role: 'user', text: '最近の失敗した質問' });
    await seedSearchRequest(pool, {
      workspace,
      sessionId,
      inputId: newerInput.messageId,
      sequenceNo: 3,
      status: 'failed',
      outcome: null,
      searchAction: 'new_search',
      result: null,
      createdAt: minutesAgo(1),
      expiresAt: null,
    });
    const current = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 4, text: '同じ症状です' });
    const server = await startFakeJev(reuseReply());
    try {
      await seedApproval(pool, { companyId: workspace.companyId, endpoint: buildWorkerConfig(server.baseUrl).apiUrl });
      const job = await claimJobForMessage(pool, 'route_search', current.messageId);
      await processJob(pool, job, buildWorkerConfig(server.baseUrl));
      const request = await readSearchRequest(pool, current.searchRequestId);
      assert.equal(request.search_action, 'new_search', '失敗した直近検索を飛ばして古い結果を再利用している');
      assert.equal(request.reused_from_request_id, null);
    } finally {
      await server.close();
    }
  });

  it('条件変更・条件不確実・低信頼判定はnew_searchにする', async () => {
    const cases: Array<{ label: string; config: Record<string, string | { choice: string; confidence: number }> }> = [
      { label: '条件変更', config: { search_action: 'reuse', continuity: 'same_topic', same_conditions: 'no' } },
      { label: '条件不確実', config: { search_action: 'reuse', continuity: 'same_topic', same_conditions: 'unknown' } },
      {
        label: '低信頼reuse',
        config: { search_action: { choice: 'reuse', confidence: 0.5 }, continuity: 'same_topic', same_conditions: 'yes' },
      },
    ];
    for (const testCase of cases) {
      const pair = await seedPair();
      const server = await startFakeJev((request) => ({ body: jevReply(request, jevChoices(testCase.config)) }));
      try {
        await expectRouteAction(pair, server, 'new_search', testCase.label);
      } finally {
        await server.close();
      }
    }
  });

  it('revision失効・撤回関係・別案件の根拠は再利用しない', async () => {
    const stale = await seedPair();
    await advanceRevision(pool, stale.evidenceMessageId, '改訂後の報告');
    const staleServer = await startFakeJev(reuseReply());
    try {
      await expectRouteAction(stale, staleServer, 'new_search', 'revision失効');
    } finally {
      await staleServer.close();
    }

    const revoked = await seedPair();
    const revoker = await seedMessage(pool, { sessionId: revoked.priorSessionId, sequenceNo: 4, role: 'assistant', text: '以前の報告を取り消します' });
    await seedRelation(pool, {
      sourceMessageId: revoker.messageId,
      sourceRevision: 1,
      targetMessageId: revoked.evidenceMessageId,
      targetRevision: 1,
      relation: 'revoke',
    });
    const revokedServer = await startFakeJev(reuseReply());
    try {
      await expectRouteAction(revoked, revokedServer, 'new_search', '撤回関係');
    } finally {
      await revokedServer.close();
    }

    const otherProjectId = await insertProject(pool, workspace.companyId, 'repo-b');
    const otherSessionId = await insertSession(pool, { projectId: otherProjectId, employeeId: workspace.employeeId });
    const otherMessage = await seedMessage(pool, { sessionId: otherSessionId, sequenceNo: 1, role: 'assistant', text: '別案件の報告' });
    const foreign = await seedPair({
      result: matchedResult([
        {
          messageId: otherMessage.messageId,
          revision: 1,
          employeeId: workspace.employeeId,
          role: 'assistant',
          occurredAt: new Date().toISOString(),
          text: '別案件の報告',
        },
      ]),
    });
    const foreignServer = await startFakeJev(reuseReply());
    try {
      await expectRouteAction(foreign, foreignServer, 'new_search', '別案件の根拠');
    } finally {
      await foreignServer.close();
    }
  });

  it('policy版・sessionが異なる先行検索は再利用しない', async () => {
    const policyMismatch = await seedPair({ priorPolicyVersion: 'other-v1' });
    const policyServer = await startFakeJev(reuseReply());
    try {
      await expectRouteAction(policyMismatch, policyServer, 'new_search', 'policy版不一致');
    } finally {
      await policyServer.close();
    }

    const differentSession = await seedPair({
      priorSessionId: await seedSession(pool, workspace),
      currentSessionId: await seedSession(pool, workspace),
    });
    const sessionServer = await startFakeJev(reuseReply());
    try {
      await expectRouteAction(differentSession, sessionServer, 'new_search', 'session不一致');
    } finally {
      await sessionServer.close();
    }
  });
  it('reuseのchainは直接のnew_search元まで適格な時だけ再利用する', async () => {
    const cases: Array<{ label: string; seed: () => Promise<ChainSeed> }> = [
      { label: 'B pending・A completed', seed: () => seedReuseChain() },
      { label: 'B completed matched・A completed', seed: () => seedReuseChain({ middleStatus: 'completed' }) },
      { label: 'B pending・A pending', seed: () => seedReuseChain({ originStatus: 'pending' }) },
    ];
    for (const testCase of cases) {
      const chain = await testCase.seed();
      const server = await startFakeJev(reuseReply());
      try {
        await expectRouteAction(
          { priorSessionId: chain.current.sessionId, evidenceMessageId: chain.evidenceMessageId, priorRequestId: chain.originRequestId, current: chain.current },
          server,
          'reuse',
          testCase.label,
        );
      } finally {
        await server.close();
      }
    }
  });

  it('chainの元検索が期限切れ・failed・no_match・原文/根拠失効ならnew_searchへ戻す', async () => {
    const revoker = async (chain: ChainSeed): Promise<void> => {
      const message = await seedMessage(pool, { sessionId: chain.current.sessionId, sequenceNo: 5, role: 'assistant', text: '以前の報告を取り消します' });
      await seedRelation(pool, {
        sourceMessageId: message.messageId,
        sourceRevision: 1,
        targetMessageId: chain.evidenceMessageId,
        targetRevision: 1,
        relation: 'revoke',
      });
    };
    const cases: Array<{ label: string; invalidate: (chain: ChainSeed) => Promise<void> }> = [
      {
        label: 'Aが期限切れ',
        invalidate: async (chain) => {
          await pool.query('UPDATE search_requests SET expires_at = $2 WHERE id = $1', [chain.originRequestId, minutesAgo(1)]);
        },
      },
      {
        label: 'Aがfailed',
        invalidate: async (chain) => {
          await pool.query("UPDATE search_requests SET status = 'failed', outcome = NULL, expires_at = NULL WHERE id = $1", [chain.originRequestId]);
        },
      },
      {
        label: 'Aがno_match',
        invalidate: async (chain) => {
          await pool.query("UPDATE search_requests SET outcome = 'no_match' WHERE id = $1", [chain.originRequestId]);
        },
      },
      {
        label: 'Aの原文revisionが改訂',
        invalidate: async (chain) => {
          await advanceRevision(pool, chain.originInputId, '改訂後の元質問');
        },
      },
      {
        label: 'Aの根拠revisionが改訂',
        invalidate: async (chain) => {
          await advanceRevision(pool, chain.evidenceMessageId, '改訂後の報告');
        },
      },
      { label: 'Aの根拠が撤回', invalidate: revoker },
    ];
    for (const testCase of cases) {
      const chain = await seedReuseChain();
      await testCase.invalidate(chain);
      const server = await startFakeJev(reuseReply());
      try {
        await expectRouteAction(
          { priorSessionId: chain.current.sessionId, evidenceMessageId: chain.evidenceMessageId, priorRequestId: chain.originRequestId, current: chain.current },
          server,
          'new_search',
          testCase.label,
        );
      } finally {
        await server.close();
      }
    }
  });
});
