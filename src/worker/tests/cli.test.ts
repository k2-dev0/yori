import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPool, requireDatabaseUrl } from '../../db/pool.js';
import { runMigrations } from '../../db/migrator.js';
import { resetDatabase, seedWorkspace, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import { runCli } from '../cli.js';
import { processJob } from '../process.js';
import {
  buildWorkerConfig,
  claimJobForMessage,
  jevChoices,
  jevReply,
  readAnalysis,
  readJob,
  seedApproval,
  seedSession,
  seedUserMessage,
  sleep,
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

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await sleep(20);
  }
  assert.fail('条件がtimeoutまでに成立しない');
}

describe('worker CLI', () => {
  it('approveで登録した承認だけをretryに使い、revoke後は再送信しない', async () => {
    const server = await startFakeJev((request) => ({
      body: jevReply(request, jevChoices({ retention: 'substantive', search_action: 'new_search' })),
    }));
    const config = buildWorkerConfig(server.baseUrl);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: requireDatabaseUrl(),
      JEV_API_KEY: 'test-key',
      JEV_ACCOUNT_REF: 'acct-a',
      JEV_API_URL: config.apiUrl,
    };
    const directory = await mkdtemp(path.join(tmpdir(), 'yori-worker-cli-'));
    try {
      const sessionId = await seedSession(pool, workspace);
      const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: 'CLI承認の対象発言' });
      const blockedJob = await claimJobForMessage(pool, 'classify_message', seeded.messageId);
      await processJob(pool, blockedJob, config);
      assert.equal((await readJob(pool, blockedJob.id)).status, 'blocked_policy');
      assert.equal(server.requests.length, 0, '未承認で送信している');

      const approvalPath = path.join(directory, 'approval.json');
      await writeFile(
        approvalPath,
        JSON.stringify({
          company_id: workspace.companyId,
          provider: 'jev',
          account_ref: 'acct-a',
          endpoint: config.apiUrl,
          terms_url: 'https://typesafe.ai/legal/mca',
          terms_checked_at: new Date().toISOString(),
          learning_disabled: true,
          retention_terms: 'retention-terms',
          confirmed_by: 'admin-a',
          confirmed_at: new Date().toISOString(),
        }),
      );
      assert.equal(await runCli(['approve', approvalPath], env), 0, 'approveが失敗');
      const approval = await pool.query<{ id: string; active: boolean; terms_checked_at: Date | null }>(
        'SELECT id, active, terms_checked_at FROM provider_policy_approvals WHERE company_id = $1 AND endpoint = $2',
        [workspace.companyId, config.apiUrl],
      );
      assert.equal(approval.rows.length, 1, '承認が登録されていない');
      assert.equal(approval.rows[0].active, true);
      assert.ok(approval.rows[0].terms_checked_at, '規約確認日が保存されていない');

      assert.equal(await runCli(['retry', blockedJob.id], env), 0, 'retryが失敗');
      assert.equal((await readJob(pool, blockedJob.id)).status, 'pending');

      const retriedJob = await claimJobForMessage(pool, 'classify_message', seeded.messageId);
      await processJob(pool, retriedJob, config);
      assert.ok(await readAnalysis(pool, seeded.messageId, 1), 'retry後に分析が保存されていない');
      assert.equal(server.requests.length, 1);

      assert.equal(await runCli(['revoke', approval.rows[0].id], env), 0, 'revokeが失敗');
      const revoked = await pool.query<{ active: boolean }>('SELECT active FROM provider_policy_approvals WHERE id = $1', [
        approval.rows[0].id,
      ]);
      assert.equal(revoked.rows[0].active, false, '承認が失効していない');

      const otherSessionId = await seedSession(pool, workspace);
      const other = await seedUserMessage(pool, { workspace, sessionId: otherSessionId, sequenceNo: 1, text: '失効後の対象発言' });
      const otherJob = await claimJobForMessage(pool, 'classify_message', other.messageId);
      await processJob(pool, otherJob, config);
      assert.equal((await readJob(pool, otherJob.id)).status, 'blocked_policy');
      assert.equal(server.requests.length, 1, '失効後に外部送信している');
    } finally {
      await rm(directory, { recursive: true, force: true });
      await server.close();
    }
  });

  it('worker:startはSIGTERMまでjobを処理して正常終了する', async () => {
    const server = await startFakeJev((request) => ({
      body: jevReply(request, jevChoices({ retention: 'substantive', search_action: 'new_search' })),
    }));
    const config = buildWorkerConfig(server.baseUrl);
    await seedApproval(pool, { companyId: workspace.companyId, endpoint: config.apiUrl });
    const sessionId = await seedSession(pool, workspace);
    const seeded = await seedUserMessage(pool, { workspace, sessionId, sequenceNo: 1, text: 'worker:startの対象発言' });
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker/cli.ts', 'start'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: requireDatabaseUrl(),
        JEV_API_KEY: 'test-key',
        JEV_ACCOUNT_REF: 'acct-a',
        JEV_API_URL: config.apiUrl,
        JEV_WORKER_POLL_MS: '20',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.resume();
    child.stderr?.resume();
    try {
      await waitFor(async () => {
        const classify = await readJob(pool, seeded.classifyJobId);
        const route = await readJob(pool, seeded.routeJobId);
        return classify.status === 'completed' && route.status === 'completed';
      });
      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve) => child.once('exit', (exitCode) => resolve(exitCode)));
      assert.equal(code, 0, `worker:startの終了コードが0でない: ${String(code)}`);
      assert.ok(await readAnalysis(pool, seeded.messageId, 1), 'worker:start後に分析が保存されていない');
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      await server.close();
    }
  });
});
