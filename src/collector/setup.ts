import { z } from 'zod';
import type { RedactionPolicy } from '../api/redaction.js';
import { validateCustomRedactionRules } from '../api/redaction.js';

const SETUP_TIMEOUT_MS = 5_000;

// setup応答はstrictに検証し、token・raw HTTP error・rules適用前本文は呼出元のstateへ渡さない。
const setupResponseSchema = z.strictObject({
  project_id: z.uuid(),
  repository: z.string().min(1),
  redaction_policy: z.strictObject({
    version: z.int().min(0),
    rules: z.array(z.string()),
  }),
});

export interface CollectorSetup {
  projectId: string;
  policy: RedactionPolicy;
}

// canonical repositoryのmember projectとcurrent policyをsetup APIから取得する。
// 通信失敗・非200・不正応答・repository不一致・不正ruleはすべてnullにし、失敗内容を保持しない。
export async function fetchCollectorSetup(input: {
  api_url: string;
  token: string;
  repository: string;
}): Promise<CollectorSetup | null> {
  const endpoint = `${input.api_url.replace(/\/+$/, '')}/v1/collector/setup`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repository: input.repository }),
      signal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    return null;
  }
  if (response.status !== 200) {
    return null;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const parsed = setupResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.repository !== input.repository) {
    return null;
  }
  try {
    validateCustomRedactionRules(parsed.data.redaction_policy.rules);
  } catch {
    return null;
  }
  return {
    projectId: parsed.data.project_id,
    policy: { version: parsed.data.redaction_policy.version, rules: parsed.data.redaction_policy.rules },
  };
}
