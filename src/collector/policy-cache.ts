import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { validateCustomRedactionRules, type CustomRedactionRule } from '../api/redaction.js';

// custom ruleは伏せ字対象のliteral/assignment_keyそのものなので、端末のstateへ平文で残さない。
// 鍵はtoken本体・apiUrl・用途を分離したKDF入力から導出し、SQLiteへ保存されるnamespaceは入力に使わない。
// DBコピー（namespace＋encryptedRules）だけではtokenなしに復号できず、cacheありの通信失敗時だけ復号する。

const IV_BYTES = 12;
const POLICY_CACHE_KEY_DOMAIN = 'yori-collector-policy-cache-v2';

function policyCacheKey(token: string, apiUrl: string): Buffer {
  return createHash('sha256').update(JSON.stringify([POLICY_CACHE_KEY_DOMAIN, apiUrl, token]), 'utf8').digest();
}

// 適用順を保ったrule配列をAES-256-GCMで暗号化し、iv.tag.ciphertextのbase64連結にする。
export function encryptCachedRules(token: string, apiUrl: string, rules: readonly CustomRedactionRule[]): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', policyCacheKey(token, apiUrl), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(rules), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

// 復号できない・形が壊れているcacheは未保存として扱い、不完全なruleで置換しない。
export function decryptCachedRules(token: string, apiUrl: string, value: string): CustomRedactionRule[] | undefined {
  const parts = value.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', policyCacheKey(token, apiUrl), Buffer.from(parts[0], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64')), decipher.final()]).toString('utf8');
    const parsed: unknown = JSON.parse(plaintext);
    // 復号できてもrule契約を満たさないcache（旧literal-only形式を含む）は未保存として扱う。
    return validateCustomRedactionRules(parsed);
  } catch {
    return undefined;
  }
}
