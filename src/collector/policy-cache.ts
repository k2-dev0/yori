import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { validateRedactionPolicy, type RedactionPolicy } from '../api/redaction.js';

// business policyは伏せ字対象のfield/termそのものなので、端末のstateへ平文で残さない。
// 鍵はtoken本体・apiUrl・用途を分離したKDF入力から導出し、SQLiteへ保存されるnamespaceは入力に使わない。
// DBコピー（namespace＋encryptedPolicy）だけではtokenなしに復号できず、cacheありの通信失敗時だけ復号する。

const IV_BYTES = 12;
const POLICY_CACHE_KEY_DOMAIN = 'yori-collector-policy-cache-v3';

function policyCacheKey(token: string, apiUrl: string): Buffer {
  return createHash('sha256').update(JSON.stringify([POLICY_CACHE_KEY_DOMAIN, apiUrl, token]), 'utf8').digest();
}

// fields/terms/suspicion_mode/detector_version/versionをAES-256-GCMで暗号化し、iv.tag.ciphertextのbase64連結にする。
export function encryptCachedPolicy(token: string, apiUrl: string, policy: RedactionPolicy): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', policyCacheKey(token, apiUrl), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(policy), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

// 復号できない・形が壊れているcacheは未保存として扱い、不完全なpolicyで置換しない。
export function decryptCachedPolicy(token: string, apiUrl: string, value: string): RedactionPolicy | undefined {
  const parts = value.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', policyCacheKey(token, apiUrl), Buffer.from(parts[0]!, 'base64'));
    decipher.setAuthTag(Buffer.from(parts[1]!, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64')), decipher.final()]).toString('utf8');
    const parsed: unknown = JSON.parse(plaintext);
    // 復号できてもpolicy契約を満たさないcache（旧rules形式を含む）は未保存として扱う。
    return validateRedactionPolicy(parsed);
  } catch {
    return undefined;
  }
}
