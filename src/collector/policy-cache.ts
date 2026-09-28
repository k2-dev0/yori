import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { collectorNamespace } from './state.js';

// custom ruleは伏せ字対象のliteralそのものなので、端末のstateへ平文で残さない。
// tokenを保存せずに導出した鍵で暗号化し、cacheありの通信失敗時だけ復号してlast-known policyに使う。

const IV_BYTES = 12;

function policyCacheKey(token: string, apiUrl: string): Buffer {
  const namespace = collectorNamespace(apiUrl, token);
  return createHash('sha256').update(`yori-collector-policy\n${namespace}`, 'utf8').digest();
}

// 適用順を保ったrule配列をAES-256-GCMで暗号化し、iv.tag.ciphertextのbase64連結にする。
export function encryptCachedRules(token: string, apiUrl: string, rules: readonly string[]): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', policyCacheKey(token, apiUrl), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(rules), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

// 復号できない・形が壊れているcacheは未保存として扱い、不完全なruleで置換しない。
export function decryptCachedRules(token: string, apiUrl: string, value: string): string[] | undefined {
  const parts = value.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', policyCacheKey(token, apiUrl), Buffer.from(parts[0], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64')), decipher.final()]).toString('utf8');
    const parsed: unknown = JSON.parse(plaintext);
    if (!Array.isArray(parsed) || parsed.some((rule) => typeof rule !== 'string')) {
      return undefined;
    }
    return parsed as string[];
  } catch {
    return undefined;
  }
}
