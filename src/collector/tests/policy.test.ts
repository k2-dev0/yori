import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { v7 as uuidv7 } from 'uuid';
import { collectFromHook, flushCollector } from '../collect.js';
import { parseCollectorConfig, type CollectorConfig } from '../config.js';
import { closeCollectorState, collectorNamespace, openCollectorState } from '../state.js';
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

const REPOSITORY = 'github.com/Org/Repo';
const API_URL = 'https://api.example.test';

function policyConfig(stateDir: string): CollectorConfig {
  return { api_url: API_URL, token_env: 'YORI_TEST_TOKEN', state_dir: stateDir, projects: [] } as CollectorConfig;
}

function setupResponse(projectId: string, policy: { version: number; rules: string[] }): Response {
  return jsonResponse(200, { project_id: projectId, repository: REPOSITORY, redaction_policy: policy });
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

function hookInput(fixture: CollectorFixture, transcript: string, source: 'codex' | 'claude_code', sessionId: string) {
  return {
    source,
    hook: buildHook({ session_id: sessionId, transcript_path: transcript, cwd: fixture.repoDir }),
    config: policyConfig(fixture.stateDir),
    token: 'token-a',
  };
}

describe('collectorのsetup policy適用', () => {
  it('project_id対応表を書かなくてもcollector設定として受理する', () => {
    const config = parseCollectorConfig({ api_url: API_URL, token_env: 'YORI_TEST_TOKEN', state_dir: '/tmp/yori-collector-state' });
    assert.equal(config.api_url, API_URL);
    assert.equal(config.state_dir, '/tmp/yori-collector-state');
    assert.ok(!JSON.stringify(config).includes('project_id'), '設定契約がproject_id入力を要求している');
  });

  it('codex収集でsetupからprojectとpolicyを取得し、SQLite・送信bodyへ生literalを残さない', async () => {
    const fixture = await createCollectorFixture();
    const projectId = uuidv7();
    const mock = installFetchMock((request) =>
      isSetupRequest(request) ? setupResponse(projectId, { version: 1, rules: ['AcmeSecret'] }) : ackResponse(request),
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
      assert.deepEqual(batches.flatMap((batch) => batch.events).map((event) => event.text), ['[REDACTED:custom] を使う']);

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
      isSetupRequest(request) ? setupResponse(projectId, { version: 1, rules: ['AcmeSecret'] }) : ackResponse(request),
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
      assert.deepEqual(sentEvents(eventRequests(mock.requests)).map((event) => event.text), ['[REDACTED:custom] を使う']);
      await assertStateDoesNotContain(fixture.stateDir, 'AcmeSecret');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('取得した新versionは新規messageから適用し、旧ruleを過去本文へ遡及適用しない', async () => {
    const fixture = await createCollectorFixture();
    const projectId = uuidv7();
    let policy = { version: 1, rules: ['OldSecret'] };
    const mock = installFetchMock((request) => (isSetupRequest(request) ? setupResponse(projectId, policy) : ackResponse(request)));
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'OldSecret の確認' }),
      ]);
      const input = hookInput(fixture, transcript, 'codex', 'session-1');
      await collectFromHook(input);
      assert.deepEqual(sentEvents(eventRequests(mock.requests)).map((event) => event.text), ['[REDACTED:custom] の確認']);

      policy = { version: 2, rules: ['NewSecret'] };
      await appendTranscript(
        transcript,
        `${codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'user', text: 'NewSecret と OldSecret' })}\n`,
      );
      await collectFromHook(input);

      assert.deepEqual(sentEvents(eventRequests(mock.requests)).map((event) => event.text), [
        '[REDACTED:custom] の確認',
        '[REDACTED:custom] と OldSecret',
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
        return setupResponse(projectId, { version: 1, rules: ['AcmeSecret'] });
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
        '[REDACTED:custom] 1',
        '[REDACTED:custom] 2',
      ]);
      await assertStateDoesNotContain(fixture.stateDir, 'AcmeSecret');
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
        return setupResponse(projectId, { version: 1, rules: ['AcmeSecret'] });
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
        ['[REDACTED:custom] を flush で読む'],
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
        return setupResponse(projectId, { version: 1, rules: ['AcmeSecret'] });
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
        '[REDACTED:custom] 1',
        '[REDACTED:custom] を flush でも伏せる',
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
});
