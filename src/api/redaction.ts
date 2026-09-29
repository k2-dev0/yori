import {
  CUSTOM_REDACTION_PLACEHOLDER,
  MAX_CUSTOM_REDACTION_ASSIGNMENT_KEY_CODE_POINTS,
  MAX_CUSTOM_REDACTION_LITERAL_CODE_POINTS,
  MAX_CUSTOM_REDACTION_RULES,
} from './contract.js';

// 会話本文に現れる秘匿値を、種類だけを残した固定placeholderへ置換する。
// 収集境界（collector）と受付境界（API）が同じ関数を使い、保存・外部送信の前に必ず通す。
// 入力だけから決まる純粋関数にして、再読込・再送で本文とrevisionを増やさない。
// 量化子には上限を置き、長い本文でも線形時間で終わるようにする。

// 代入形（NAME=VALUE / NAME: VALUE / NAME：VALUE）の値だけを伏せる。名前は最終要素が秘匿値の種類を表すものに限り、
// 名前と区切りはそのまま残す。snake_caseとcamelCaseの両方の最終要素を対象にし、MYTOKENのような
// 全大文字の連結prefixも最終要素の種類で従来どおり検出する。
// 比較（==/=>）と名前空間（::）は代入ではないため対象外にし、全角colonも区切りとして扱う。
const SECRET_ASSIGNMENT_PATTERN =
  /(^|[^A-Za-z0-9_])([A-Za-z0-9_]*)(PASSWORD|PASSWD|SECRET|TOKEN|KEY|APIKEY|CREDENTIAL)(?![A-Za-z0-9_])([ \t]*(?:=(?!=|>)|:(?!:)|：(?!：))[ \t]*)("[^"\n]{0,4096}"|'[^'\n]{0,4096}'|[^\s]{1,4096})/gi;

// PASSは前後にidentifier文字を持たない完全一致だけを代入として扱い、compass/bypass/DB_PASSを検出しない。
const PASS_ASSIGNMENT_PATTERN =
  /(^|[^A-Za-z0-9_])(PASS)(?![A-Za-z0-9_])([ \t]*(?:=(?!=|>)|:(?!:)|：(?!：))[ \t]*)("[^"\n]{0,4096}"|'[^'\n]{0,4096}'|[^\s]{1,4096})/gi;

// 置換結果として現れるplaceholderと、値そのものではない環境変数参照は変更しない。
const ASSIGNMENT_PLACEHOLDER_VALUE = /^\[REDACTED:[A-Za-z0-9_]+\]$/;
const ASSIGNMENT_ENVIRONMENT_REFERENCE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}\n]{1,256}\})$/;

function isUnchangedAssignmentValue(value: string): boolean {
  return ASSIGNMENT_PLACEHOLDER_VALUE.test(value) || ASSIGNMENT_ENVIRONMENT_REFERENCE.test(value);
}

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
  // 代入形の値は名前と区切りを残して伏せる。placeholderと環境変数参照は変更しない。
  redacted = redacted.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (match, lead: string, prefix: string, name: string, separator: string, value: string) =>
      isUnchangedAssignmentValue(value)
        ? match
        : `${lead}${prefix}${name}${separator}${REDACTION_PLACEHOLDERS.env_value}`,
  );
  return redacted.replace(
    PASS_ASSIGNMENT_PATTERN,
    (match, lead: string, name: string, separator: string, value: string) =>
      isUnchangedAssignmentValue(value) ? match : `${lead}${name}${separator}${REDACTION_PLACEHOLDERS.env_value}`,
  );
}

// 会社単位のcustom伏せ字rule。literalはexact・case-sensitiveの固定文字列、
// assignment_keyはASCII identifierをcase-insensitiveで照合し、代入のvalueだけを伏せる。
export type CustomRedactionRule =
  | { type: 'literal'; value: string }
  | { type: 'assignment_key'; value: string };

// 会社単位のcustom伏せ字policy。ruleはliteral/assignment_keyのdiscriminated unionで保持する。
export interface RedactionPolicy {
  version: number;
  rules: readonly CustomRedactionRule[];
}

const ASSIGNMENT_KEY_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// custom ruleの集合を境界で検証する。discriminated union以外・空・placeholder部分文字列・
// 上限超過・不正identifier・type別の重複は受理しない。literalはcase-sensitive、
// assignment_keyはcase-insensitiveで重複を判定する。
export function validateCustomRedactionRules(rules: unknown): CustomRedactionRule[] {
  if (!Array.isArray(rules) || rules.length > MAX_CUSTOM_REDACTION_RULES) {
    throw new Error('custom伏せ字ruleの件数が不正です');
  }
  const seenLiterals = new Set<string>();
  const seenAssignmentKeys = new Set<string>();
  const validated: CustomRedactionRule[] = [];
  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      throw new Error('custom伏せ字ruleが不正です');
    }
    const fields = Object.keys(rule);
    if (fields.length !== 2 || !fields.includes('type') || !fields.includes('value')) {
      throw new Error('custom伏せ字ruleが不正です');
    }
    const { type, value } = rule as { type?: unknown; value?: unknown };
    if (typeof value !== 'string') {
      throw new Error('custom伏せ字ruleが不正です');
    }
    if (type === 'literal') {
      if (
        value.length === 0 ||
        isRedactionPlaceholderFragment(value) ||
        [...value].length > MAX_CUSTOM_REDACTION_LITERAL_CODE_POINTS ||
        seenLiterals.has(value)
      ) {
        throw new Error('custom伏せ字ruleが不正です');
      }
      seenLiterals.add(value);
      validated.push({ type: 'literal', value });
      continue;
    }
    if (type === 'assignment_key') {
      const normalized = value.toLowerCase();
      if (
        !ASSIGNMENT_KEY_IDENTIFIER.test(value) ||
        [...value].length > MAX_CUSTOM_REDACTION_ASSIGNMENT_KEY_CODE_POINTS ||
        normalized === 'redacted' ||
        seenAssignmentKeys.has(normalized)
      ) {
        throw new Error('custom伏せ字ruleが不正です');
      }
      seenAssignmentKeys.add(normalized);
      validated.push({ type: 'assignment_key', value });
      continue;
    }
    throw new Error('custom伏せ字ruleが不正です');
  }
  return validated;
}

// literalをregex特殊文字として解釈させず、longest-firstで1回だけ走査するpatternを作る。
function customRulePattern(rules: readonly string[]): RegExp {
  const escaped = [...rules]
    .sort((left, right) => [...right].length - [...left].length)
    .map((rule) => rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'), 'g');
}

// assignment_keyをkey名の完全一致で走査するpatternを作る。key表記・空白・区切りはcaptureして保持する。
// 前後がidentifier文字なら別identifier内とみなし、compass/bypass/DB_PASSへ反応しない。
function customAssignmentKeyPattern(keys: readonly string[]): RegExp {
  const escaped = [...keys]
    .sort((left, right) => right.length - left.length)
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(
    `(?<![A-Za-z0-9_.-])(${escaped.join('|')})([ \\t]*)(:(?!:)|：(?!：)|=(?!=|>))([ \\t]*)("[^"\\n]{0,4096}"|'[^'\\n]{0,4096}'|[^\\s]{1,4096})`,
    'gi',
  );
}

// custom assignment_keyをbuilt-inより先に適用し、登録rule自身のplaceholderを残す。
// literalはbuilt-in置換後の本文へlongest-firstで1回だけ適用する。
// 入力だけから決まる純粋関数にし、再適用しても置換済みplaceholderを再置換しない。
export function redactConversationTextWithPolicy(text: string, policy: RedactionPolicy): string {
  const rules = validateCustomRedactionRules(policy.rules);
  const assignmentKeys = rules.flatMap((rule) => (rule.type === 'assignment_key' ? [rule.value] : []));
  const literals = rules.flatMap((rule) => (rule.type === 'literal' ? [rule.value] : []));

  let redacted = text;
  if (assignmentKeys.length > 0) {
    redacted = redacted.replace(
      customAssignmentKeyPattern(assignmentKeys),
      (match, key: string, leading: string, separator: string, trailing: string, value: string) =>
        isUnchangedAssignmentValue(value) ? match : `${key}${leading}${separator}${trailing}${CUSTOM_REDACTION_PLACEHOLDER}`,
    );
  }
  redacted = redactConversationText(redacted);
  if (literals.length > 0) {
    redacted = redacted.replace(customRulePattern(literals), CUSTOM_REDACTION_PLACEHOLDER);
  }
  return redacted;
}
