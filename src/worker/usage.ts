import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { JEV_PROVIDER, type JevUsage } from './contract.js';
import type { WorkerConfig } from './config.js';

// usage_eventsはJev試行ごとに1行。原文・key・外部error bodyは保存せず、model/usage/固定codeだけを残す。
export async function recordJevUsage(
  pool: Pool,
  input: { companyId: string; config: WorkerConfig; jobKind: string },
  success: boolean,
  durationMs: number,
  errorCode: string | null,
  usage: JevUsage,
  responseModel: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO usage_events
       (id, company_id, provider, account_ref, endpoint, operation, model, response_model, input_tokens, output_tokens, duration_ms, success, error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      uuidv7(),
      input.companyId,
      JEV_PROVIDER,
      input.config.accountRef,
      input.config.apiUrl,
      input.jobKind,
      input.config.model,
      responseModel,
      usage.input_tokens,
      usage.output_tokens,
      Math.max(0, Math.round(durationMs)),
      success,
      errorCode,
    ],
  );
}
