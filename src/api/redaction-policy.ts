import type { Pool, PoolClient } from 'pg';
import { emptyRedactionPolicy, validateRedactionPolicy, type RedactionPolicy } from './redaction.js';

// 認証会社のcurrent policyをversion・fields/terms・suspicion_mode・detector_versionで返す。
// 未登録会社はversion 0・空rule・observe・initial-v1として扱う。
// collector setupと保存境界（events/searches）が同じ読み出しを使い、適用順やversionの解釈を揃える。
export async function loadCompanyRedactionPolicy(db: Pool | PoolClient, companyId: string): Promise<RedactionPolicy> {
  const result = await db.query<{
    version: number;
    suspicion_mode: string;
    detector_version: string;
    rule_type: 'term' | 'field' | null;
    value: string | null;
  }>(
    `SELECT p.version, p.suspicion_mode, p.detector_version, r.rule_type, r.value
       FROM company_redaction_policies p
       LEFT JOIN company_redaction_rules r ON r.company_id = p.company_id
      WHERE p.company_id = $1
      ORDER BY r.rule_type, r.value`,
    [companyId],
  );
  const policy = result.rows[0];
  if (policy === undefined) {
    return emptyRedactionPolicy();
  }
  const fields = result.rows.flatMap((row): string[] => (row.rule_type === 'field' && row.value !== null ? [row.value] : []));
  const terms = result.rows.flatMap((row): string[] => (row.rule_type === 'term' && row.value !== null ? [row.value] : []));
  // DB制約で防いでいても、読み出し境界で不正policyを適用しない。
  return validateRedactionPolicy({
    version: policy.version,
    fields,
    terms,
    suspicion_mode: policy.suspicion_mode,
    detector_version: policy.detector_version,
  });
}
