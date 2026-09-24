import type { Pool } from 'pg';

// 会社・provider・account_ref・endpointの有効な承認を確認する。
// 各外部HTTP送信の直前に呼び、承認なしでproviderへ本文を送らない。
export async function hasActiveProviderApproval(
  pool: Pool,
  input: { companyId: string; provider: string; accountRef: string; endpoint: string },
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
       FROM provider_policy_approvals
      WHERE company_id = $1 AND provider = $2 AND account_ref = $3 AND endpoint = $4
        AND active AND learning_disabled
        AND confirmed_at <= now()
        AND terms_checked_at IS NOT NULL AND terms_checked_at <= now()
      LIMIT 1`,
    [input.companyId, input.provider, input.accountRef, input.endpoint],
  );
  return result.rows.length > 0;
}
