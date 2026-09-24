import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { createPool } from '../db/pool.js';
import { JEV_PROVIDER } from './contract.js';
import { isWorkerEndpoint, loadWorkerConfig } from './config.js';
import { retryJob } from './process.js';
import { runWorker } from './runner.js';

// 承認JSON。terms_checked_atは管理者が確認した日時を必須で受け、credentialは含めない。
const approvalFileSchema = z.object({
  company_id: z.uuid(),
  provider: z.string().min(1).default(JEV_PROVIDER),
  account_ref: z.string().min(1),
  endpoint: z.string().min(1).refine(isWorkerEndpoint, { message: 'endpointが許可形式ではありません' }),
  terms_url: z.string().min(1),
  terms_checked_at: z.iso.datetime({ offset: true }),
  learning_disabled: z.literal(true),
  retention_terms: z.string().min(1),
  confirmed_by: z.string().min(1),
  confirmed_at: z.iso.datetime({ offset: true }),
});

function fail(code: string): number {
  process.stderr.write(`worker: ${code}\n`);
  return 1;
}

async function runStart(env: NodeJS.ProcessEnv): Promise<number> {
  let loaded;
  try {
    loaded = loadWorkerConfig(env);
  } catch {
    return fail('invalid_worker_config');
  }
  const pool = createPool(loaded.databaseUrl);
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await runWorker({ pool, config: loaded.config, pollIntervalMs: loaded.pollIntervalMs, signal: controller.signal });
    return 0;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await pool.end();
  }
}

async function runRetry(env: NodeJS.ProcessEnv, jobId: string | undefined): Promise<number> {
  if (jobId === undefined || !z.uuid().safeParse(jobId).success) {
    return fail('invalid_job_id');
  }
  let loaded;
  try {
    loaded = loadWorkerConfig(env);
  } catch {
    return fail('invalid_worker_config');
  }
  const pool = createPool(loaded.databaseUrl);
  try {
    const retried = await retryJob(pool, jobId, loaded.config);
    process.stdout.write(`worker: ${retried ? 'retried' : 'not_retried'}\n`);
    return retried ? 0 : 1;
  } finally {
    await pool.end();
  }
}

// 承認登録・失効はDBだけを必要とし、Jev credentialは要求しない。
function requireDatabaseUrl(env: NodeJS.ProcessEnv): string | null {
  const value = env.DATABASE_URL;
  return value !== undefined && value.length > 0 ? value : null;
}

async function runApprove(env: NodeJS.ProcessEnv, filePath: string | undefined): Promise<number> {
  if (filePath === undefined) {
    return fail('invalid_arguments');
  }
  let fileValue: unknown;
  try {
    fileValue = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fail('invalid_approval_file');
  }
  const parsed = approvalFileSchema.safeParse(fileValue);
  if (!parsed.success) {
    return fail('invalid_approval');
  }
  const databaseUrl = requireDatabaseUrl(env);
  if (databaseUrl === null) {
    return fail('invalid_worker_config');
  }
  const approval = parsed.data;
  const id = uuidv7();
  const pool = createPool(databaseUrl);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE provider_policy_approvals
          SET active = false, updated_at = now()
        WHERE company_id = $1 AND provider = $2 AND account_ref = $3 AND endpoint = $4 AND active`,
      [approval.company_id, approval.provider, approval.account_ref, approval.endpoint],
    );
    await client.query(
      `INSERT INTO provider_policy_approvals
         (id, company_id, provider, account_ref, endpoint, terms_url, terms_checked_at, learning_disabled, retention_terms,
          confirmed_by, confirmed_at, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)`,
      [
        id,
        approval.company_id,
        approval.provider,
        approval.account_ref,
        approval.endpoint,
        approval.terms_url,
        new Date(approval.terms_checked_at),
        approval.learning_disabled,
        approval.retention_terms,
        approval.confirmed_by,
        new Date(approval.confirmed_at),
      ],
    );
    await client.query('COMMIT');
    process.stdout.write(`worker: approved ${id}\n`);
    return 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function runRevoke(env: NodeJS.ProcessEnv, approvalId: string | undefined): Promise<number> {
  if (approvalId === undefined || !z.uuid().safeParse(approvalId).success) {
    return fail('invalid_approval_id');
  }
  const databaseUrl = requireDatabaseUrl(env);
  if (databaseUrl === null) {
    return fail('invalid_worker_config');
  }
  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query('UPDATE provider_policy_approvals SET active = false, updated_at = now() WHERE id = $1 AND active', [
      approvalId,
    ]);
    const revoked = result.rowCount === 1;
    process.stdout.write(`worker: ${revoked ? 'revoked' : 'not_found'}\n`);
    return revoked ? 0 : 1;
  } finally {
    await pool.end();
  }
}

// CLIは資格情報・本文を引数やログへ出さない。終了コードは固定。
export async function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'start') {
    return runStart(env);
  }
  if (command === 'retry') {
    return runRetry(env, rest[0]);
  }
  if (command === 'approve') {
    return runApprove(env, rest[0]);
  }
  if (command === 'revoke') {
    return runRevoke(env, rest[0]);
  }
  return fail('unknown_command');
}

// tsxから直接起動された時だけ実行する。テストはrunCliをimportして呼ぶ。
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
