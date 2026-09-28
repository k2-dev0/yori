import { CUSTOM_REDACTION_PLACEHOLDER, MAX_CUSTOM_REDACTION_LITERAL_CODE_POINTS, MAX_CUSTOM_REDACTION_RULES } from './contract.js';

// 会話本文に現れる秘匿値を、種類だけを残した固定placeholderへ置換する。
// 収集境界（collector）と受付境界（API）が同じ関数を使い、保存・外部送信の前に必ず通す。
// 入力だけから決まる純粋関数にして、再読込・再送で本文とrevisionを増やさない。
// 量化子には上限を置き、長い本文でも線形時間で終わるようにする。

// 代入形（NAME=VALUE / NAME: VALUE）の値だけを伏せる。名前は最終要素が秘匿値の種類を表すものに限り、
// 名前と区切りはそのまま残す。snake_caseとcamelCaseの両方の最終要素を対象にする。
// 比較（==/=>）と名前空間（::）は代入ではないため対象外にする。
const SECRET_ASSIGNMENT_PATTERN =
  /(^|[^A-Za-z0-9_])([A-Za-z0-9_]*)(PASSWORD|PASSWD|SECRET|TOKEN|KEY|APIKEY|CREDENTIAL)(?![A-Za-z0-9_])([ \t]*(?:=(?!=|>)|:(?!:))[ \t]*)("[^"\n]{0,4096}"|'[^'\n]{0,4096}'|[^\s]{1,4096})/gi;

// 置換結果として現れるplaceholder。custom ruleはこの部分文字列も受理しない。
// 追加時はmigration 0010のyori_is_redaction_placeholder_fragment()と同じ集合を保つ。
const REDACTION_PLACEHOLDERS = {
  private_key: '[REDACTED:private_key]',
  aws_access_key: '[REDACTED:aws_access_key]',
  google_api_key: '[REDACTED:google_api_key]',
  github_token: '[REDACTED:github_token]',
  slack_token: '[REDACTED:slack_token]',
  openai_key: '[REDACTED:openai_key]',
  jwt: '[REDACTED:jwt]',
  url_credentials: '[REDACTED:url_credentials]',
  authorization: '[REDACTED:authorization]',
  env_value: '[REDACTED:env_value]',
} as const;

// literalが既知placeholderの部分文字列なら、置換済み本文の再適用でplaceholderを壊すため拒否する。
function isRedactionPlaceholderFragment(rule: string): boolean {
  return [...Object.values(REDACTION_PLACEHOLDERS), CUSTOM_REDACTION_PLACEHOLDER].some((placeholder) =>
    placeholder.includes(rule),
  );
}

// 会話本文の秘匿値をplaceholderへ置換する。該当がなければ入力をそのまま返す。
export function redactConversationText(text: string): string {
  let redacted = text;
  // 秘密鍵はBEGINからENDまでを丸ごと伏せる。ENDが無い途中までの本文も末尾まで伏せる。
  redacted = redacted.replace(/-----BEGIN [A-Z0-9 ]{0,16}PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]{0,16}PRIVATE KEY-----/g, REDACTION_PLACEHOLDERS.private_key);
  redacted = redacted.replace(/-----BEGIN [A-Z0-9 ]{0,16}PRIVATE KEY-----[\s\S]*/g, REDACTION_PLACEHOLDERS.private_key);
  redacted = redacted.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTION_PLACEHOLDERS.aws_access_key);
  redacted = redacted.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTION_PLACEHOLDERS.google_api_key);
  redacted = redacted.replace(/\bgh[pousr]_[A-Za-z0-9]{36,512}\b/g, REDACTION_PLACEHOLDERS.github_token);
  redacted = redacted.replace(/\bxox[abpros]-[0-9A-Za-z-]{10,512}\b/g, REDACTION_PLACEHOLDERS.slack_token);
  redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{20,512}\b/g, REDACTION_PLACEHOLDERS.openai_key);
  redacted = redacted.replace(/\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\b/g, REDACTION_PLACEHOLDERS.jwt);
  // URLのuserinfoは資格情報として丸ごと伏せ、scheme・host・pathは残す。
  if (redacted.includes('://')) {
    redacted = redacted.replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s:@]{1,256}:[^/\s:@]{1,256}@/gi, '$1' + REDACTION_PLACEHOLDERS.url_credentials + '@');
  }
  // Authorizationヘッダは12文字以上の値だけを伏せる。短い語や<placeholder>は残す。
  redacted = redacted.replace(/(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)([^\s'"]{12,})/gi, (match, prefix: string, credential: string) =>
    credential.startsWith('<') || credential.startsWith('$') ? match : `${prefix}${REDACTION_PLACEHOLDERS.authorization}`,
  );
  // 代入形の値は名前と区切りを残して伏せる。
  return redacted.replace(SECRET_ASSIGNMENT_PATTERN, '$1$2$3$4' + REDACTION_PLACEHOLDERS.env_value);
}

// 会社単位のcustom伏せ字policy。literalはexact・case-sensitiveの固定文字列で、regexは使わない。
export interface RedactionPolicy {
  version: number;
  rules: readonly string[];
}

// custom ruleの集合を境界で検証する。空・placeholder部分文字列・上限超過・重複・非文字列は受理しない。
export function validateCustomRedactionRules(rules: unknown): string[] {
  if (!Array.isArray(rules) || rules.length > MAX_CUSTOM_REDACTION_RULES) {
    throw new Error('custom伏せ字ruleの件数が不正です');
  }
  const seen = new Set<string>();
  for (const rule of rules) {
    if (
      typeof rule !== 'string' ||
      rule.length === 0 ||
      isRedactionPlaceholderFragment(rule) ||
      [...rule].length > MAX_CUSTOM_REDACTION_LITERAL_CODE_POINTS ||
      seen.has(rule)
    ) {
      throw new Error('custom伏せ字ruleが不正です');
    }
    seen.add(rule);
  }
  return rules as string[];
}

// literalをregex特殊文字として解釈させず、longest-firstで1回だけ走査するpatternを作る。
function customRulePattern(rules: readonly string[]): RegExp {
  const escaped = [...rules]
    .sort((left, right) => [...right].length - [...left].length)
    .map((rule) => rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'), 'g');
}

// built-in置換を常に先に適用し、その結果へcustom ruleをlongest-firstで1回だけ適用する。
// 入力だけから決まる純粋関数にし、再適用しても置換済みplaceholderを再置換しない。
export function redactConversationTextWithPolicy(text: string, policy: RedactionPolicy): string {
  const rules = validateCustomRedactionRules(policy.rules);
  const redacted = redactConversationText(text);
  if (rules.length === 0) {
    return redacted;
  }
  return redacted.replace(customRulePattern(rules), CUSTOM_REDACTION_PLACEHOLDER);
}
