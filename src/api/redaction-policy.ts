import type { Pool, PoolClient } from 'pg';
import { validateCustomRedactionRules, type RedactionPolicy } from './redaction.js';

// 認証会社のcurrent policyをversionとruleで返す。未登録会社はversion 0・rules空として扱う。
// collector setupと保存境界（events/searches）が同じ読み出しを使い、適用順やversionの解釈を揃える。
export async function loadCompanyRedactionPolicy(db: Pool | PoolClient, companyId: string): Promise<RedactionPolicy> {
  const result = await db.query<{ version: number; literal: string | null }>(
    `SELECT p.version, r.literal
       FROM company_redaction_policies p
       LEFT JOIN company_redaction_rules r ON r.company_id = p.company_id
      WHERE p.company_id = $1
      ORDER BY r.literal`,
    [companyId],
  );
  const policy = result.rows[0];
  if (policy === undefined) {
    return { version: 0, rules: [] };
  }
  const rules = result.rows.flatMap((row) => (row.literal === null ? [] : [row.literal]));
  // DB制約で防いでいても、読み出し境界で不正ruleを適用しない。
  validateCustomRedactionRules(rules);
  return { version: policy.version, rules };
}
