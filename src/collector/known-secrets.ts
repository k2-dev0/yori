import {
  KNOWN_SECRETS_ENV,
  MAX_KNOWN_SECRETS,
  MAX_KNOWN_SECRET_CODE_POINTS,
  MIN_KNOWN_SECRET_CODE_POINTS,
} from '../api/contract.js';

// collector CLIのlocal input。known secretはcollector processだけが受け取り、中央API・state・logへ渡さない。
// strict JSON string arrayだけを受理し、parseに成功したらprocess.envから削除して子・後続処理へ残さない。

function codePointLength(value: string): number {
  return [...value].length;
}

// 未設定は空配列。設定されているがJSON不正・非array・非string・長さ/件数/重複違反ならfail-closedにthrowする。
export function parseKnownSecretsEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = env[KNOWN_SECRETS_ENV];
  if (raw === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('YORI_KNOWN_SECRETS_JSONがJSONとして不正です');
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_KNOWN_SECRETS) {
    throw new Error('YORI_KNOWN_SECRETS_JSONは最大件数以内のstring arrayで指定してください');
  }
  const seen = new Set<string>();
  const secrets: string[] = [];
  for (const value of parsed) {
    const length = typeof value === 'string' ? codePointLength(value) : 0;
    if (
      typeof value !== 'string' ||
      length < MIN_KNOWN_SECRET_CODE_POINTS ||
      length > MAX_KNOWN_SECRET_CODE_POINTS ||
      seen.has(value)
    ) {
      throw new Error('YORI_KNOWN_SECRETS_JSONの要素が不正です');
    }
    seen.add(value);
    secrets.push(value);
  }
  // 検証に成功した場合だけ、生値をenvへ残さない。
  delete env[KNOWN_SECRETS_ENV];
  return secrets;
}
