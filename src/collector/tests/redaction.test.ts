import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { collectFromHook, type CollectFromHookInput } from '../collect.js';
import { closeCollectorState, collectorNamespace, listCollectorDiagnostics, openCollectorState } from '../state.js';
import {
  ackResponse,
  assertStateDoesNotContain,
  buildHook,
  codexMessageLine,
  codexSessionLine,
  claudeMessageLine,
  createCollectorFixture,
  installFetchMock,
  jsonResponse,
  lineByteOffset,
  sentEvents,
  writeTranscript,
} from './support.js';

// 収集境界で秘匿値を置換し、端末のstateと中央APIへの送信bodyへ生値を残さない。
// known secretのlocal inputとsuspected-secret gateのblock/observe診断は契約で固定する。

const REPOSITORY = 'github.com/Org/Repo';
const SUSPECTED = 'kR8pQ2mX7vN4bT9wZ3cH6jL1sD5fG0aY';

type PolicyShape = {
  version: number;
  fields: string[];
  terms: string[];
  suspicion_mode: 'observe' | 'block';
  detector_version: 'initial-v1';
};

function policyShape(overrides: Partial<PolicyShape> = {}): PolicyShape {
  return { version: 1, fields: [], terms: [], suspicion_mode: 'observe', detector_version: 'initial-v1', ...overrides };
}

function setupResponse(projectId: string, redaction_policy: PolicyShape): Response {
  return jsonResponse(200, { project_id: projectId, repository: REPOSITORY, redaction_policy });
}

function isSetupRequest(request: { url: string }): boolean {
  return request.url === 'https://api.example.test/v1/collector/setup';
}

function isEventRequest(request: { url: string }): boolean {
  return request.url === 'https://api.example.test/v1/events';
}

function stateCounts(stateDir: string, namespace: string): { messages: number; outbox: number } {
  const state = openCollectorState(stateDir);
  try {
    const messages = state.db.prepare('SELECT count(*) AS count FROM stored_messages WHERE namespace = ?').get(namespace) as { count: number };
    const outbox = state.db.prepare('SELECT count(*) AS count FROM outbox WHERE namespace = ?').get(namespace) as { count: number };
    return { messages: Number(messages.count), outbox: Number(outbox.count) };
  } finally {
    closeCollectorState(state);
  }
}

function diagnosticsOf(stateDir: string, namespace: string): Array<{ code: string; byteOffset: number | null }> {
  const state = openCollectorState(stateDir);
  try {
    return listCollectorDiagnostics(state, namespace);
  } finally {
    closeCollectorState(state);
  }
}

describe('収集時の秘匿値置換', () => {
  it('秘密値を含む発言はplaceholderで送信し、診断へ値も種類も残さない', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: REPOSITORY, project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const awsKey = `AKIA${'A'.repeat(16)}`;
      const dbPassword = 'hunter2-db-password';
      const lines = [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: `AWSキーは ${awsKey} です` }),
        codexMessageLine({
          sessionId: 'session-1',
          messageId: 'item-2',
          role: 'assistant',
          text: `POSTGRES_PASSWORD=${dbPassword} を設定する`,
        }),
      ];
      const transcript = path.join(fixture.root, 'codex.jsonl');
      await writeTranscript(transcript, lines);

      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      });

      assert.deepEqual(
        sentEvents(mock.requests).map((event) => event.text),
        ['AWSキーは [REDACTED:aws_access_key] です', 'POSTGRES_PASSWORD=[REDACTED:env_value] を設定する'],
      );
      const sentBodies = JSON.stringify(mock.requests.map((request) => request.body));
      for (const secret of [awsKey, dbPassword]) {
        assert.ok(!sentBodies.includes(secret), `送信bodyへ生値が残っている: ${secret}`);
        await assertStateDoesNotContain(fixture.stateDir, secret);
      }

      assert.deepEqual(diagnosticsOf(fixture.stateDir, collectorNamespace(fixture.config.api_url, 'token-a')), [
        { code: 'message_redacted', byteOffset: lineByteOffset(lines, 1) },
        { code: 'message_redacted', byteOffset: lineByteOffset(lines, 2) },
      ]);
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('transcriptを別inodeへ差し替えて読み直しても、置換済み本文のhashが変わらず再送しない', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: REPOSITORY, project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const lines = [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: 'PASSWORD=hunter2 を使う' }),
      ];
      await writeTranscript(transcript, lines);
      const options = {
        source: 'codex' as const,
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
      };

      await collectFromHook(options);
      assert.equal(mock.requests.length, 1);

      // 同じpathへ別inodeの同一内容を置き、先頭から読み直させる。
      const replacement = path.join(fixture.root, 'replacement.jsonl');

      await writeTranscript(replacement, lines);
      renameSync(replacement, transcript);

      await collectFromHook(options);
      assert.equal(mock.requests.length, 1, '置換済み本文の再読込で同じ発言を再送している');

      assert.deepEqual(diagnosticsOf(fixture.stateDir, collectorNamespace(fixture.config.api_url, 'token-a')), [
        { code: 'message_redacted', byteOffset: lineByteOffset(lines, 1) },
      ]);
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('knownSecretsをcase-sensitive exact・longest-firstで伏せ、raw値をstate・送信bodyへ残さない', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: REPOSITORY, project_id: randomUUID() } });
    const mock = installFetchMock(ackResponse);
    try {
      const longSecret = 'abcd1234efgh5678';
      const shortSecret = 'abcd1234';
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const lines = [
        codexSessionLine('session-1'),
        codexMessageLine({
          sessionId: 'session-1',
          messageId: 'item-1',
          role: 'user',
          text: `値は ${longSecret} と ${shortSecret} と ${shortSecret.toUpperCase()} です`,
        }),
      ];
      await writeTranscript(transcript, lines);

      interface KnownSecretsCollectInput extends CollectFromHookInput {
        knownSecrets: readonly string[];
      }
      const input: KnownSecretsCollectInput = {
        source: 'codex',
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config: fixture.config,
        token: 'token-a',
        knownSecrets: [shortSecret, longSecret],
      };
      await collectFromHook(input);

      assert.deepEqual(sentEvents(mock.requests).map((event) => event.text), [
        `値は [REDACTED:known_secret] と [REDACTED:known_secret] と ${shortSecret.toUpperCase()} です`,
      ]);
      const sentBodies = JSON.stringify(mock.requests.map((request) => request.body));
      for (const secret of [longSecret, shortSecret]) {
        assert.ok(!sentBodies.includes(secret), `送信bodyへknown secretが残っている: ${secret}`);
        await assertStateDoesNotContain(fixture.stateDir, secret);
      }
      assert.deepEqual(diagnosticsOf(fixture.stateDir, collectorNamespace(fixture.config.api_url, 'token-a')), [
        { code: 'message_redacted', byteOffset: lineByteOffset(lines, 1) },
      ]);
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('block policyはmessage/outboxを保存せず、cursorを進めて後続messageを処理する (codex)', async () => {
    const fixture = await createCollectorFixture();
    const projectId = randomUUID();
    const mock = installFetchMock((request) =>
      isSetupRequest(request) ? setupResponse(projectId, policyShape({ suspicion_mode: 'block' })) : ackResponse(request),
    );
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const lines = [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: `候補 ${SUSPECTED} は保存しない` }),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-2', role: 'assistant', text: '後続messageは処理する' }),
      ];
      await writeTranscript(transcript, lines);
      const config = { ...fixture.config, projects: [] };

      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config,
        token: 'token-a',
      });

      assert.deepEqual(sentEvents(mock.requests.filter(isEventRequest)).map((event) => event.text), ['後続messageは処理する'], 'block後の後続messageを処理していない');
      assert.deepEqual(diagnosticsOf(fixture.stateDir, collectorNamespace(config.api_url, 'token-a')), [
        { code: 'message_blocked_suspected_secret', byteOffset: lineByteOffset(lines, 1) },
      ]);
      // 後続messageはack済みのためoutboxは0。blockしたmessageはmessage/outboxのどちらにも入らない。
      assert.deepEqual(stateCounts(fixture.stateDir, collectorNamespace(config.api_url, 'token-a')), { messages: 1, outbox: 0 });
      await assertStateDoesNotContain(fixture.stateDir, SUSPECTED);

      // cursorはblock済み行を越えているため、再collectで再処理・再送しない。
      const eventsAfterFirst = mock.requests.filter(isEventRequest).length;
      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config,
        token: 'token-a',
      });
      assert.equal(mock.requests.filter(isEventRequest).length, eventsAfterFirst, 'block済み行をcursorが越えていない');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('block policyはclaude_codeでもmessageを保存せずdiagnosticだけを残す', async () => {
    const fixture = await createCollectorFixture();
    const projectId = randomUUID();
    const mock = installFetchMock((request) =>
      isSetupRequest(request) ? setupResponse(projectId, policyShape({ suspicion_mode: 'block' })) : ackResponse(request),
    );
    try {
      const transcript = path.join(fixture.root, 'claude.jsonl');
      const lines = [claudeMessageLine({ sessionId: 'session-claude', uuid: 'item-1', role: 'user', content: `候補 ${SUSPECTED}` })];
      await writeTranscript(transcript, lines);
      const config = { ...fixture.config, projects: [] };

      await collectFromHook({
        source: 'claude_code',
        hook: buildHook({ session_id: 'session-claude', transcript_path: transcript, cwd: fixture.repoDir }),
        config,
        token: 'token-a',
      });

      assert.equal(sentEvents(mock.requests.filter(isEventRequest)).length, 0, 'blockしたclaude messageを送信している');
      assert.deepEqual(diagnosticsOf(fixture.stateDir, collectorNamespace(config.api_url, 'token-a')), [
        { code: 'message_blocked_suspected_secret', byteOffset: lineByteOffset(lines, 0) },
      ]);
      assert.deepEqual(stateCounts(fixture.stateDir, collectorNamespace(config.api_url, 'token-a')), { messages: 0, outbox: 0 });
      await assertStateDoesNotContain(fixture.stateDir, SUSPECTED);
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('observe policyは候補を本文のまま送信し、値なしのdiagnosticだけを残す', async () => {
    const fixture = await createCollectorFixture();
    const projectId = randomUUID();
    const mock = installFetchMock((request) =>
      isSetupRequest(request) ? setupResponse(projectId, policyShape({ terms: ['AcmeSecret'], suspicion_mode: 'observe' })) : ackResponse(request),
    );
    try {
      const transcript = path.join(fixture.root, 'codex.jsonl');
      const lines = [
        codexSessionLine('session-1'),
        codexMessageLine({ sessionId: 'session-1', messageId: 'item-1', role: 'user', text: `AcmeSecret と候補 ${SUSPECTED}` }),
      ];
      await writeTranscript(transcript, lines);
      const config = { ...fixture.config, projects: [] };

      await collectFromHook({
        source: 'codex',
        hook: buildHook({ session_id: 'session-1', transcript_path: transcript, cwd: fixture.repoDir }),
        config,
        token: 'token-a',
      });

      assert.deepEqual(sentEvents(mock.requests.filter(isEventRequest)).map((event) => event.text), [`[REDACTED:business_term] と候補 ${SUSPECTED}`]);
      const diagnostics = diagnosticsOf(fixture.stateDir, collectorNamespace(config.api_url, 'token-a'));
      const byCode = [...diagnostics].sort((left, right) => left.code.localeCompare(right.code));
      assert.deepEqual(byCode, [
        { code: 'message_redacted', byteOffset: lineByteOffset(lines, 1) },
        { code: 'message_suspected_secret', byteOffset: lineByteOffset(lines, 1) },
      ]);
      assert.ok(!JSON.stringify(diagnostics).includes(SUSPECTED), 'diagnosticsへ候補値が漏れている');
      await assertStateDoesNotContain(fixture.stateDir, 'AcmeSecret');
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });
});
