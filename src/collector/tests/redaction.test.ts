import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { collectFromHook } from '../collect.js';
import { closeCollectorState, collectorNamespace, listCollectorDiagnostics, openCollectorState } from '../state.js';
import {
  ackResponse,
  assertStateDoesNotContain,
  buildHook,
  codexMessageLine,
  codexSessionLine,
  createCollectorFixture,
  installFetchMock,
  lineByteOffset,
  sentEvents,
  writeTranscript,
} from './support.js';

// 収集境界で秘匿値を置換し、端末のstateと中央APIへの送信bodyへ生値を残さない。
describe('収集時の秘匿値置換', () => {
  it('秘密値を含む発言はplaceholderで送信し、診断へ値も種類も残さない', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
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

      const state = openCollectorState(fixture.stateDir);
      const diagnostics = listCollectorDiagnostics(state, collectorNamespace(fixture.config.api_url, 'token-a'));
      closeCollectorState(state);
      assert.deepEqual(diagnostics, [
        { code: 'message_redacted', byteOffset: lineByteOffset(lines, 1) },
        { code: 'message_redacted', byteOffset: lineByteOffset(lines, 2) },
      ]);
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });

  it('transcriptを別inodeへ差し替えて読み直しても、置換済み本文のhashが変わらず再送しない', async () => {
    const fixture = await createCollectorFixture({ binding: { repository: 'github.com/Org/Repo', project_id: randomUUID() } });
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

      const state = openCollectorState(fixture.stateDir);
      const diagnostics = listCollectorDiagnostics(state, collectorNamespace(fixture.config.api_url, 'token-a'));
      closeCollectorState(state);
      assert.deepEqual(diagnostics, [{ code: 'message_redacted', byteOffset: lineByteOffset(lines, 1) }]);
    } finally {
      mock.restore();
      await fixture.cleanup();
    }
  });
});
