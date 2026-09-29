import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { renameSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { v7 as uuidv7 } from 'uuid';
import { collectFromHook, flushCollector, type CollectFromHookInput } from '../collect.js';
import * as policyCacheModule from '../policy-cache.js';
import { fetchCollectorSetup } from '../setup.js';
import { parseCollectorConfig, type CollectorConfig } from '../config.js';
import { closeCollectorState, collectorNamespace, listCollectorDiagnostics, openCollectorState } from '../state.js';
import {
  ackResponse,
  appendTranscript,
  assertStateDoesNotContain,
  buildHook,
  claudeMessageLine,
  codexMessageLine,
  codexSessionLine,
  createCollectorFixture,
  installFetchMock,
  jsonResponse,
  parseSentBatches,
  sentEvents,
  writeTranscript,
  type CapturedRequest,
  type CollectorFixture,
} from './support.js';

// collectorはhookのcanonical repositoryでsetup API（project_id＋current policy）を解決し、policyをSQLiteへcacheする。
// cacheなしの初回取得失敗はtranscript本文を読まず送信0件、cacheありの一時失敗はlast-known policyで継続する。
// policy shapeはfields/terms/suspicion_mode/detector_versionで、cacheは全fieldをtoken由来の鍵で暗号化する。

const REPOSITORY = 'github.com/Org/Repo';
const API_URL = 'https://api.example.test';
const SUSPECTED = 'kR8pQ2mX7vN4bT9wZ3cH6jL1sD5fG0aY';

type PolicyShape = {
  version: number;
  fields: string[];
  terms: string[];
  suspicion_mode: 'observe' | 'block';
  detector_version: 'initial-v1';
};

interface PolicyCacheModule {
  encryptCachedPolicy(token: string, apiUrl: string, policy: PolicyShape): string;
  decryptCachedPolicy(token: string, apiUrl: string, value: string): PolicyShape | undefined;
}

const { encryptCachedPolicy, decryptCachedPolicy } = policyCacheModule as unknown as PolicyCacheModule;

interface KnownSecretsInput extends CollectFromHookInput {
  knownSecrets?: readonly string[];
}

function policyShape(overrides: Partial<PolicyShape> = {}): PolicyShape {
  return { version: 1, fields: [], terms: [], suspicion_mode: 'observe', detector_version: 'initial-v1', ...overrides };
}

function policyConfig(stateDir: string): CollectorConfig {
  return { api_url: API_URL, token_env: 'YORI_TEST_TOKEN', state_dir: stateDir, projects: [] } as CollectorConfig;
}

function setupResponse(projectId: string, redaction_policy: PolicyShape): Response {
  return jsonResponse(200, { project_id: projectId, repository: REPOSITORY, redaction_policy });
}

function isSetupRequest(request: CapturedRequest): boolean {
  return request.url === `${API_URL}/v1/collector/setup`;
}

function eventRequests(requests: CapturedRequest[]): CapturedRequest[] {
  return requests.filter((request) => request.url === `${API_URL}/v1/events`);
}

function outboxCount(fixture: CollectorFixture, token: string): number {
  const state = openCollectorState(fixture.stateDir);
  try {
    const row = state.db
      .prepare('SELECT count(*) AS count FROM outbox WHERE namespace = ?')
      .get(collectorNamespace(API_URL, token)) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  } finally {
    closeCollectorState(state);
  }
}

function diagnosticsOf(fixture: CollectorFixture, token: string): Array<{ code: string; byteOffset: number | null }> {
  const state = openCollectorState(fixture.stateDir);
  try {
    return listCollectorDiagnostics(state, collectorNamespace(API_URL, token));
  } finally {
    closeCollectorState(state);
  }
}

function hookInput(
  fixture: CollectorFixture,
  transcript: string,
  source: 'codex' | 'claude_code',
  sessionId: string,
  knownSecrets?: readonly string[],
): KnownSecretsInput {
  return {
    source,
    hook: buildHook({ session_id: sessionId, transcript_path: transcript, cwd: fixture.repoDir }),
    config: policyConfig(fixture.stateDir),
    token: 'token-a',
    ...(knownSecrets === undefined ? {} : { knownSecrets }),
  };
}

describe('collectorのsetup policy適用', () => {
  it('project_id対応表を書かなくてもcollector設定として受理する', () => {
    const config = parseCollectorConfig({ api_url: API_URL, token_env: 'YORI_TEST_TOKEN', state_dir: '/tmp/yori-collector-state' });
    assert.equal(config.api_url, API_URL);
    assert.equal(config.state_dir, '/tmp/yori-collector-state');
    assert.ok(!JSON.stringify(config).includes('project_id'), '設定契約がproject_id入力を要求している');
  });

  it('codex収集でsetupからprojectとpolicyを取得し、SQLite・送信bodyへ生termを残さない', async () => {
    const fixture = await createCollectorFixture();
    const projectId = uuidv7();
    const mock = installFetchMock((request) =>
      isSetupRequest(request) ? setupResponse(projectId, policyShape({ version: 1, terms: ['AcmeSecret'] })) : ackResponse(request),
    );
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const lines = [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'AcmeSecret を使う' }),
      ];
      await writeTranscript(transcript, lines);

      await collectFromHook(hookInput(fixture, transcript, 'codex', 'session-1'));

      const setup = mock.requests[0];
      assert.ok(setup, 'setup APIが呼ばれていない');
      assert.ok(isSetupRequest(setup), `最初のrequestがsetupでない: ${setup.url}`);
      assert.equal(setup.method, 'POST');
      assert.equal(setup.headers.authorization, 'Bearer token-a');
      assert.deepEqual(JSON.parse(setup.body), { repository: REPOSITORY });

      const batches = parseSentBatches(eventRequests(mock.requests));
      assert.deepEqual(batches.map((batch) => batch.project_id), [projectId], 'setupのproject_idを使っていない');
      assert.deepEqual(batches.flatMap((batch) => batch.events).map((event) => event.text), ['[REDACTED:business_term] を使う']);

      await assertStateDoesNotContain(fixture.stateDir, 'AcmeSecret');
      await assertStateDoesNotContain(fixture.stateDir, 'token-a');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('claude_code収集でも同じsetup policy契約を使う', async () => {
    const fixture = await createCollectorFixture();
    const projectId = uuidv7();
    const mock = installFetchMock((request) =>
      isSetupRequest(request) ? setupResponse(projectId, policyShape({ version: 1, terms: ['AcmeSecret'] })) : ackResponse(request),
    );
    try {
      const transcript = path.join(fixture.root, 'claude.jsonl');
      await writeTranscript(transcript, [
        claudeMessageLine({
          sessionId: 'session-claude',
          uuid: 'item-1',
          role: 'user',
          content: 'AcmeSecret を使う',
        }),
      ]);

      await collectFromHook(hookInput(fixture, transcript, 'claude_code', 'session-claude'));

      assert.ok(mock.requests.some(isSetupRequest), 'claude_codeでsetup APIが呼ばれていない');
      assert.deepEqual(sentEvents(eventRequests(mock.requests)).map((event) => event.text), ['[REDACTED:business_term] を使う']);
      await assertStateDoesNotContain(fixture.stateDir, 'AcmeSecret');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('field ruleをcodex/claude双方で適用し、生valueをSQLite・送信bodyへ残さない', async () => {
    for (const source of ['codex', 'claude_code'] as const) {
      const fixture = await createCollectorFixture();
      const projectId = uuidv7();
      const rawSecret = `hogehoge-${source}`;
      const mock = installFetchMock((request) =>
        isSetupRequest(request)
          ? setupResponse(projectId, policyShape({ version: 1, fields: ['pass'], terms: ['AcmeSecret'] }))
          : ackResponse(request),
      );
      try {
        const transcript = path.join(fixture.root, `${source}.jsonl`);
        if (source === 'codex') {
          await writeTranscript(transcript, [
            codexSessionLine('session-1'),
            codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: `pass: ${rawSecret} と AcmeSecret` }),
          ]);
        } else {
          await writeTranscript(transcript, [
            claudeMessageLine({ sessionId: 'session-claude', uuid: 'item-1', role: 'user', content: `pass: ${rawSecret} と AcmeSecret` }),
          ]);
        }

        await collectFromHook(hookInput(fixture, transcript, source, source === 'codex' ? 'session-1' : 'session-claude'));

        assert.deepEqual(
          sentEvents(eventRequests(mock.requests)).map((event) => event.text),
          ['pass: [REDACTED:business_value] と [REDACTED:business_term]'],
          `${source}でfield/term ruleが適用されていない`,
        );
        const sentBodies = JSON.stringify(mock.requests.map((request) => request.body));
        assert.ok(!sentBodies.includes(rawSecret), `${source}の送信bodyへ生valueが残っている: ${rawSecret}`);
        await assertStateDoesNotContain(fixture.stateDir, rawSecret);
        await assertStateDoesNotContain(fixture.stateDir, 'AcmeSecret');
      } finally {
        mock.restore();
        await fixture.cleanup();
      }
    }
  });

  it('取得した新versionは新規messageから適用し、旧ruleを過去本文へ遡及適用しない', async () => {
    const fixture = await createCollectorFixture();
    const projectId = uuidv7();
    let policy: PolicyShape = policyShape({ version: 1, terms: ['OldSecret'] });
    const mock = installFetchMock((request) => (isSetupRequest(request) ? setupResponse(projectId, policy) : ackResponse(request)));
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'OldSecret の確認' }),
      ]);
      const input = hookInput(fixture, transcript, 'codex', 'session-1');
      await collectFromHook(input);
      assert.deepEqual(sentEvents(eventRequests(mock.requests)).map((event) => event.text), ['[REDACTED:business_term] の確認']);

      policy = policyShape({ version: 2, terms: ['NewSecret'] });
      await appendTranscript(
        transcript,
        `${codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'user', text: 'NewSecret と OldSecret' })}\n`,
      );
      await collectFromHook(input);

      assert.deepEqual(sentEvents(eventRequests(mock.requests)).map((event) => event.text), [
        '[REDACTED:business_term] の確認',
        '[REDACTED:business_term] と OldSecret',
      ]);
      assert.equal(mock.requests.filter(isSetupRequest).length, 2, 'collectのたびにcurrent policyを取得していない');
      await assertStateDoesNotContain(fixture.stateDir, 'NewSecret');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('cacheありのsetup一時失敗はlast-known policyで新規messageを送る', async () => {
    const fixture = await createCollectorFixture();
    const projectId = uuidv7();
    let online = true;
    const mock = installFetchMock((request) => {
      if (isSetupRequest(request)) {
        if (!online) {
          throw new Error('network down');
        }
        return setupResponse(projectId, policyShape({ version: 1, terms: ['AcmeSecret'] }));
      }
      return ackResponse(request);
    });
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'AcmeSecret 1' }),
      ]);
      const input = hookInput(fixture, transcript, 'codex', 'session-1');
      await collectFromHook(input);

      online = false;
      await appendTranscript(
        transcript,
        `${codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'user', text: 'AcmeSecret 2' })}\n`,
      );
      await collectFromHook(input);

      assert.deepEqual(sentEvents(eventRequests(mock.requests)).map((event) => event.text), [
        '[REDACTED:business_term] 1',
        '[REDACTED:business_term] 2',
      ]);
      await assertStateDoesNotContain(fixture.stateDir, 'AcmeSecret');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('cacheありのsetup一時失敗でも暗号化済みsuspicion_modeでblockを継続する', async () => {
    const fixture = await createCollectorFixture();
    const projectId = uuidv7();
    let online = true;
    const mock = installFetchMock((request) => {
      if (isSetupRequest(request)) {
        if (!online) {
          throw new Error('network down');
        }
        return setupResponse(projectId, policyShape({ version: 1, suspicion_mode: 'block' }));
      }
      return ackResponse(request);
    });
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '通常の本文' }),
      ]);
      const input = hookInput(fixture, transcript, 'codex', 'session-1');
      await collectFromHook(input);
      assert.deepEqual(sentEvents(eventRequests(mock.requests)).map((event) => event.text), ['通常の本文']);

      online = false;
      const lines = [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '通常の本文' }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'user', text: `候補 ${SUSPECTED}` }),
      ];
      await writeTranscript(transcript, lines);
      await collectFromHook(input);

      assert.deepEqual(sentEvents(eventRequests(mock.requests)).map((event) => event.text), ['通常の本文'], 'cacheのblock modeが失われている');
      const diagnostics = diagnosticsOf(fixture, 'token-a');
      assert.ok(
        diagnostics.some((item) => item.code === 'message_blocked_suspected_secret' && item.byteOffset === Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`, 'utf8')),
        `block診断がない: ${JSON.stringify(diagnostics)}`,
      );
      await assertStateDoesNotContain(fixture.stateDir, SUSPECTED);
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('cacheなしsetup失敗で保留したsourceを、flushの再取得成功で本文から収集して送信する', async () => {
    const fixture = await createCollectorFixture();
    const projectId = uuidv7();
    let online = false;
    const mock = installFetchMock((request) => {
      if (isSetupRequest(request)) {
        if (!online) {
          throw new Error('network down');
        }
        return setupResponse(projectId, policyShape({ version: 1, terms: ['AcmeSecret'] }));
      }
      return ackResponse(request);
    });
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'AcmeSecret を flush で読む' }),
      ]);
      await collectFromHook(hookInput(fixture, transcript, 'codex', 'session-1'));
      assert.equal(eventRequests(mock.requests).length, 0, '取得失敗のcollectで送信している');
      assert.equal(outboxCount(fixture, 'token-a'), 0, '取得失敗のcollectでoutboxへ積んでいる');

      online = true;
      await flushCollector({ config: policyConfig(fixture.stateDir), token: 'token-a' });

      assert.equal(mock.requests.filter(isSetupRequest).length, 2, 'flushがsetup APIを再取得していない');
      const batches = parseSentBatches(eventRequests(mock.requests));
      assert.equal(batches[0]?.project_id, projectId, 'flushで解決したprojectへ送っていない');
      assert.deepEqual(
        batches.flatMap((batch) => batch.events).map((event) => event.text),
        ['[REDACTED:business_term] を flush で読む'],
      );
      await assertStateDoesNotContain(fixture.stateDir, 'AcmeSecret');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('flushもcacheあり一時失敗はlast-known、cacheなし失敗は本文未読・送信0にする', async () => {
    const fixture = await createCollectorFixture();
    const projectId = uuidv7();
    let online = true;
    const mock = installFetchMock((request) => {
      if (isSetupRequest(request)) {
        if (!online) {
          throw new Error('network down');
        }
        return setupResponse(projectId, policyShape({ version: 1, terms: ['AcmeSecret'] }));
      }
      return ackResponse(request);
    });
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'AcmeSecret 1' }),
      ]);
      await collectFromHook(hookInput(fixture, transcript, 'codex', 'session-1'));

      online = false;
      await appendTranscript(
        transcript,
        `${codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'user', text: 'AcmeSecret を flush でも伏せる' })}\n`,
      );
      await flushCollector({ config: policyConfig(fixture.stateDir), token: 'token-a' });

      assert.deepEqual(sentEvents(eventRequests(mock.requests)).map((event) => event.text), [
        '[REDACTED:business_term] 1',
        '[REDACTED:business_term] を flush でも伏せる',
      ]);
      assert.equal(mock.requests.filter(isSetupRequest).length, 2, 'flushがsetupを試行していない');
      await assertStateDoesNotContain(fixture.stateDir, 'AcmeSecret');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }

    // cacheなし: 取得失敗のcollectで保持したsourceを、失敗の続くflushで読まない。
    const cold = await createCollectorFixture();
    const coldMock = installFetchMock((request) => {
      if (isSetupRequest(request)) {
        throw new Error('network down');
      }
      return ackResponse(request);
    });
    try {
      const transcript = path.join(cold.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'AcmeSecret を読まない' }),
      ]);
      await collectFromHook(hookInput(cold, transcript, 'codex', 'session-1'));
      await flushCollector({ config: policyConfig(cold.stateDir), token: 'token-a' });

      assert.equal(eventRequests(coldMock.requests).length, 0, 'cacheなし失敗のflushで送信している');
      assert.equal(coldMock.requests.length, 2, 'flushがsetupを試行していない');
      assert.equal(outboxCount(cold, 'token-a'), 0, 'cacheなし失敗のflushでoutboxへ積んでいる');
      await assertStateDoesNotContain(cold.stateDir, 'AcmeSecret');
    } finally {
      coldMock.restore();
      await cold.cleanup();
    }
  });

  it('cacheなしのsetup取得失敗ではtranscript本文を読まず送信0件にする', async () => {
    const fixture = await createCollectorFixture();
    const mock = installFetchMock((request) => {
      if (isSetupRequest(request)) {
        throw new Error('network down');
      }
      return ackResponse(request);
    });
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'AcmeSecret を使う' }),
      ]);

      await collectFromHook(hookInput(fixture, transcript, 'codex', 'session-1'));

      assert.equal(eventRequests(mock.requests).length, 0, 'setup失敗後にeventを送信している');
      assert.equal(mock.requests.length, 1, 'setup失敗後にtranscriptを読んでいる');
      assert.equal(outboxCount(fixture, 'token-a'), 0, 'setup失敗後にoutboxへ積んでいる');
      await assertStateDoesNotContain(fixture.stateDir, 'AcmeSecret');
      await assertStateDoesNotContain(fixture.stateDir, 'network down');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('policy変更だけでは過去messageのrevisionを増やさず、source本文の実変更はrevision+1にする', async () => {
    const fixture = await createCollectorFixture();
    const projectId = uuidv7();
    let policy: PolicyShape = policyShape({ version: 1, terms: ['PolicyOne'] });
    const mock = installFetchMock((request) => (isSetupRequest(request) ? setupResponse(projectId, policy) : ackResponse(request)));
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const originalLines = [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'PolicyOne を再読込' }),
      ];
      await writeTranscript(transcript, originalLines);
      const input = hookInput(fixture, transcript, 'codex', 'session-1');
      await collectFromHook(input);
      assert.deepEqual(
        sentEvents(eventRequests(mock.requests)).map((event) => [event.revision, event.text]),
        [[1, '[REDACTED:business_term] を再読込']],
      );

      // policy変更後に同内容を別inodeで先頭から読み直してもrevisionを増やさない。
      policy = policyShape({ version: 2, terms: ['PolicyTwo'] });
      const replacement = path.join(fixture.root, 'replacement.jsonl');
      await writeTranscript(replacement, originalLines);
      renameSync(replacement, transcript);
      await collectFromHook(input);
      assert.deepEqual(
        sentEvents(eventRequests(mock.requests)).map((event) => [event.revision, event.text]),
        [[1, '[REDACTED:business_term] を再読込']],
        'policy変更だけでrevisionが増えている',
      );

      // source本文の実変更は従来どおりrevision+1で新しい本文を保存する。
      const changed = path.join(fixture.root, 'changed.jsonl');
      await writeTranscript(changed, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'PolicyTwo に変更' }),
      ]);
      renameSync(changed, transcript);
      await collectFromHook(input);
      assert.deepEqual(
        sentEvents(eventRequests(mock.requests)).map((event) => [event.revision, event.text]),
        [
          [1, '[REDACTED:business_term] を再読込'],
          [2, '[REDACTED:business_term] に変更'],
        ],
        'source本文変更がrevision+1になっていない',
      );
      await assertStateDoesNotContain(fixture.stateDir, 'PolicyOne');
      await assertStateDoesNotContain(fixture.stateDir, 'PolicyTwo');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });
});

// 復号鍵はtoken本体をKDF入力に含め、SQLiteへ保存されるnamespaceだけからは再現できない。
describe('collectorのpolicy cache暗号化', () => {
  const POLICY = policyShape({ version: 3, fields: ['ProjectCodename'], terms: ['AcmeSecret'], suspicion_mode: 'block' });

  // 漏えいしたDBコピーから鍵を再現する攻撃を模し、指定鍵での復号を試みる。
  function decryptWithKey(key: Buffer, value: string): string {
    const parts = value.split('.');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0]!, 'base64'));
    decipher.setAuthTag(Buffer.from(parts[1]!, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64')), decipher.final()]).toString('utf8');
  }

  it('同じtoken/apiUrlだけ復号でき、別token・別apiUrlでは復号できない', () => {
    const encrypted = encryptCachedPolicy('token-a', API_URL, POLICY);

    assert.deepEqual(decryptCachedPolicy('token-a', API_URL, encrypted), POLICY, '同じtoken/apiUrlで復号できていない');
    assert.equal(decryptCachedPolicy('token-b', API_URL, encrypted), undefined, '別tokenで復号できている');
    assert.equal(decryptCachedPolicy('token-a', 'https://other.example.test', encrypted), undefined, '別apiUrlで復号できている');
  });

  it('stateのnamespaceと暗号文だけではtokenなしに復号できず、平文のruleを残さない', async () => {
    const fixture = await createCollectorFixture();
    const projectId = uuidv7();
    const token = 'token-a';
    const namespace = collectorNamespace(API_URL, token);
    const mock = installFetchMock((request) => (isSetupRequest(request) ? setupResponse(projectId, POLICY) : ackResponse(request)));
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      // policyのfield keyを本文へ出さず、cache暗号化だけを検査する。
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: '通常の本文を使う' }),
      ]);
      await collectFromHook(hookInput(fixture, transcript, 'codex', 'session-1'));

      const state = openCollectorState(fixture.stateDir);
      let encryptedValue: string;
      try {
        const row = state.db
          .prepare('SELECT * FROM project_policies WHERE namespace = ? AND repository = ?')
          .get(namespace, REPOSITORY) as Record<string, unknown> | undefined;
        assert.ok(row, 'cacheがSQLiteへ保存されていない');
        const ciphertexts = Object.values(row).filter(
          (value): value is string => typeof value === 'string' && value.split('.').length === 3 && value.length > 40,
        );
        assert.equal(ciphertexts.length, 1, `暗号文の列を特定できない: ${JSON.stringify(row)}`);
        encryptedValue = ciphertexts[0]!;

        const decrypted = decryptCachedPolicy(token, API_URL, encryptedValue);
        assert.deepEqual(decrypted, POLICY, 'tokenを持つcollectorがcacheを復号できていない');
        assert.equal(decrypted?.suspicion_mode, 'block', 'suspicion_modeがcacheで失われている');
        assert.equal(decrypted?.detector_version, 'initial-v1', 'detector_versionがcacheで失われている');

        // 修正前方式（namespace由来の鍵）はDBコピーのnamespaceから再現できるため、鍵更新後は復号できない。
        const namespaceDerivedKey = createHash('sha256').update(`yori-collector-policy\n${namespace}`, 'utf8').digest();
        assert.throws(() => decryptWithKey(namespaceDerivedKey, encryptedValue), 'namespaceから再現した旧鍵で復号できている');
      } finally {
        closeCollectorState(state);
      }

      await assertStateDoesNotContain(fixture.stateDir, 'AcmeSecret');
      await assertStateDoesNotContain(fixture.stateDir, 'ProjectCodename');
      await assertStateDoesNotContain(fixture.stateDir, token);
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });
});

// setup応答のstructured policy検証。validは受理し、不正policyはfetchCollectorSetupのnull契約で拒否する。
describe('collector setup応答のstructured policy検証', () => {
  async function fetchPolicy(redaction_policy: unknown): Promise<PolicyShape | null> {
    const mock = installFetchMock(() =>
      jsonResponse(200, { project_id: uuidv7(), repository: REPOSITORY, redaction_policy }),
    );
    try {
      const setup = await fetchCollectorSetup({ api_url: API_URL, token: 'token-a', repository: REPOSITORY });
      return setup === null ? null : (setup.policy as unknown as PolicyShape);
    } finally {
      mock.restore();
    }
  }

  it('fields/terms/suspicion_mode/detector_versionとversionを受理する', async () => {
    const policy = policyShape({ version: 4, fields: ['pass'], terms: ['AcmeSecret'], suspicion_mode: 'block' });
    assert.deepEqual(await fetchPolicy(policy), policy);
    assert.deepEqual(await fetchPolicy(policyShape({ version: 0 })), policyShape({ version: 0 }), '未登録会社のversion 0・空policyを受理していない');
  });

  it('unknown field・rules形式・欠落field・wrong型を受理しない', async () => {
    const invalidPolicies: unknown[] = [
      { version: 1, rules: [{ type: 'literal', value: 'x' }] },
      { version: 1, fields: [], terms: [] },
      { version: 1, fields: [], terms: [], suspicion_mode: 'observe' },
      { version: 1, fields: [], terms: [], detector_version: 'initial-v1' },
      { version: 1, fields: [], terms: [], suspicion_mode: 'observe', detector_version: 'initial-v1', extra: true },
      { version: 1, fields: 'AcmeSecret', terms: [], suspicion_mode: 'observe', detector_version: 'initial-v1' },
      { version: 1, fields: [], terms: [1], suspicion_mode: 'observe', detector_version: 'initial-v1' },
      { version: 1, fields: [], terms: [], suspicion_mode: 'warn', detector_version: 'initial-v1' },
      { version: 1, fields: [], terms: [], suspicion_mode: 'observe', detector_version: 'latest' },
      { version: -1, fields: [], terms: [], suspicion_mode: 'observe', detector_version: 'initial-v1' },
      { version: 1.5, fields: [], terms: [], suspicion_mode: 'observe', detector_version: 'initial-v1' },
    ];
    for (const policy of invalidPolicies) {
      assert.equal(await fetchPolicy(policy), null, `不正policyを受理している: ${JSON.stringify(policy)}`);
    }
  });

  it('fieldの不正identifier・大小文字重複・REDACTED、termの重複・上限超過を受理しない', async () => {
    const invalidPolicies: unknown[] = [
      policyShape({ fields: ['1pass'] }),
      policyShape({ fields: ['pass key'] }),
      policyShape({ fields: ['pass:key'] }),
      policyShape({ fields: ['a'.repeat(129)] }),
      policyShape({ fields: ['REDACTED'] }),
      policyShape({ fields: ['pass', 'PASS'] }),
      policyShape({ terms: ['dup', 'dup'] }),
      policyShape({ terms: ['x'.repeat(513)] }),
      policyShape({ fields: ['pass'], terms: Array.from({ length: 100 }, (_, index) => `rule-${index}`) }),
    ];
    for (const policy of invalidPolicies) {
      assert.equal(await fetchPolicy(policy), null, `不正policyを受理している: ${JSON.stringify(policy)}`);
    }

    assert.deepEqual(
      await fetchPolicy(policyShape({ fields: ['a'.repeat(128)], terms: ['y'.repeat(512)] })),
      policyShape({ fields: ['a'.repeat(128)], terms: ['y'.repeat(512)] }),
      'field 128/term 512 code pointsの境界を受理していない',
    );
  });
});
