import {
  BUSINESS_FIELD_PLACEHOLDER,
  BUSINESS_TERM_PLACEHOLDER,
  KNOWN_SECRET_PLACEHOLDER,
  MAX_BUSINESS_FIELD_CODE_POINTS,
  MAX_BUSINESS_REDACTION_RULES,
  MAX_BUSINESS_TERM_CODE_POINTS,
  MAX_KNOWN_SECRETS,
  MAX_KNOWN_SECRET_CODE_POINTS,
  MIN_KNOWN_SECRET_CODE_POINTS,
  SUSPECTED_SECRET_CODE,
  SUSPECTED_SECRET_DETECTOR_VERSION,
  SUSPECTED_SECRET_OBSERVED,
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

// 置換結果として現れるplaceholder。termはこの部分文字列も受理しない。
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
  business_value: BUSINESS_FIELD_PLACEHOLDER,
  business_term: BUSINESS_TERM_PLACEHOLDER,
  known_secret: KNOWN_SECRET_PLACEHOLDER,
} as const;

// termがplaceholderの構文・種類名そのものなら、置換済み本文の再適用でplaceholderを壊すため拒否する。
// 種類名を含む一般語（例: known_secretの部分文字列secret）は、term適用をplaceholder外へ限定して許可する。
const PLACEHOLDER_KINDS = new Set(Object.keys(REDACTION_PLACEHOLDERS));
function isRedactionPlaceholderFragment(rule: string): boolean {
  return rule.includes(':') || rule.includes('[') || rule.includes(']') || rule === 'REDACTED' || PLACEHOLDER_KINDS.has(rule);
}

// 会話本文の秘匿値をplaceholderへ置換する。該当がなければ入力をそのまま返す。
export function redactConversationText(text: string): string {
  return redactCredentialText(text, EMPTY_FIELD_KEYS);
}

const EMPTY_FIELD_KEYS: ReadonlySet<string> = new Set();

// 登録済みfieldのkeyとexact一致（case-insensitive）する代入はbuilt-inの代入形検出から除外し、
// 後段のfields適用でbusiness_valueへ置換する。key表記・区切り・compass/bypass等の扱いは変えない。
function redactCredentialText(text: string, fieldKeys: ReadonlySet<string>): string {
  const isRegisteredField = (prefix: string, name: string): boolean => fieldKeys.has(`${prefix}${name}`.toLowerCase());
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
      isRegisteredField(prefix, name) || isUnchangedAssignmentValue(value)
        ? match
        : `${lead}${prefix}${name}${separator}${REDACTION_PLACEHOLDERS.env_value}`,
  );
  return redacted.replace(
    PASS_ASSIGNMENT_PATTERN,
    (match, lead: string, name: string, separator: string, value: string) =>
      isRegisteredField('', name) || isUnchangedAssignmentValue(value)
        ? match
        : `${lead}${name}${separator}${REDACTION_PLACEHOLDERS.env_value}`,
  );
}

// 会社単位のbusiness伏せ字policy。fieldはASCII identifierをcase-insensitiveで照合し代入valueだけを伏せ、
// termはexact・case-sensitiveの固定文字列を伏せる。どちらも公開policyではfields/termsとして保持する。
export type SuspicionMode = 'observe' | 'block';
export type DetectorVersion = 'initial-v1';

export interface RedactionPolicy {
  version: number;
  fields: readonly string[];
  terms: readonly string[];
  suspicion_mode: SuspicionMode;
  detector_version: DetectorVersion;
}

// sanitizeの戻り値。blockは本文を返さず、sendのfindingsは固定codeだけを持つ。
export type SanitizationResult =
  | { action: 'send'; text: string; findings: string[] }
  | { action: 'block'; code: 'suspected_secret' };

// 未登録会社・policy未取得の既定値。observeでbuilt-in置換だけを適用する。
export function emptyRedactionPolicy(): RedactionPolicy {
  return { version: 0, fields: [], terms: [], suspicion_mode: 'observe', detector_version: SUSPECTED_SECRET_DETECTOR_VERSION };
}

const FIELD_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function codePointLength(value: string): number {
  return [...value].length;
}

// policyを境界で検証する。shape・field identifier・重複・placeholder断片・上限を満たさないpolicyは適用しない。
export function validateRedactionPolicy(policy: unknown): RedactionPolicy {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    throw new Error('redaction policyが不正です');
  }
  const record = policy as Record<string, unknown>;
  const keys = Object.keys(record);
  const required = ['version', 'fields', 'terms', 'suspicion_mode', 'detector_version'];
  if (keys.length !== required.length || !required.every((key) => keys.includes(key))) {
    throw new Error('redaction policyが不正です');
  }
  const { version, fields, terms, suspicion_mode, detector_version } = record;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new Error('redaction policyのversionが不正です');
  }
  if (!Array.isArray(fields) || !Array.isArray(terms)) {
    throw new Error('redaction policyのfields/termsが不正です');
  }
  if (fields.length + terms.length > MAX_BUSINESS_REDACTION_RULES) {
    throw new Error('redaction ruleの件数が上限を超えています');
  }

  const seenFields = new Set<string>();
  const validatedFields: string[] = [];
  for (const field of fields) {
    if (typeof field !== 'string') {
      throw new Error('redaction fieldが不正です');
    }
    const normalized = field.toLowerCase();
    if (
      !FIELD_IDENTIFIER.test(field) ||
      codePointLength(field) > MAX_BUSINESS_FIELD_CODE_POINTS ||
      normalized === 'redacted' ||
      seenFields.has(normalized)
    ) {
      throw new Error('redaction fieldが不正です');
    }
    seenFields.add(normalized);
    validatedFields.push(field);
  }

  const seenTerms = new Set<string>();
  const validatedTerms: string[] = [];
  for (const term of terms) {
    if (
      typeof term !== 'string' ||
      term.length === 0 ||
      isRedactionPlaceholderFragment(term) ||
      codePointLength(term) > MAX_BUSINESS_TERM_CODE_POINTS ||
      seenTerms.has(term)
    ) {
      throw new Error('redaction termが不正です');
    }
    seenTerms.add(term);
    validatedTerms.push(term);
  }

  if (suspicion_mode !== 'observe' && suspicion_mode !== 'block') {
    throw new Error('suspicion_modeが不正です');
  }
  if (detector_version !== SUSPECTED_SECRET_DETECTOR_VERSION) {
    throw new Error('detector_versionが不正です');
  }
  return { version, fields: validatedFields, terms: validatedTerms, suspicion_mode, detector_version };
}

// known secretはcollector processだけが環境変数から受け取る。境界で長さ・件数・exact重複を検証する。
function validateKnownSecrets(knownSecrets: readonly string[]): string[] {
  if (!Array.isArray(knownSecrets) || knownSecrets.length > MAX_KNOWN_SECRETS) {
    throw new Error('known secretの件数が不正です');
  }
  const seen = new Set<string>();
  const validated: string[] = [];
  for (const secret of knownSecrets) {
    const length = typeof secret === 'string' ? codePointLength(secret) : 0;
    if (
      typeof secret !== 'string' ||
      length < MIN_KNOWN_SECRET_CODE_POINTS ||
      length > MAX_KNOWN_SECRET_CODE_POINTS ||
      seen.has(secret)
    ) {
      throw new Error('known secretが不正です');
    }
    seen.add(secret);
    validated.push(secret);
  }
  return validated;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// longest-firstのliteral alternationを1回だけ走査する。重複・短い候補は境界で除外済み。
function literalPattern(values: readonly string[]): RegExp {
  const sorted = [...values].sort((left, right) => codePointLength(right) - codePointLength(left));
  return new RegExp(sorted.map(escapeRegExp).join('|'), 'g');
}

function redactKnownSecrets(text: string, knownSecrets: readonly string[]): string {
  return knownSecrets.length === 0 ? text : text.replace(literalPattern(knownSecrets), KNOWN_SECRET_PLACEHOLDER);
}

// fieldはkey名の完全一致で走査する。key表記・空白・区切りはcaptureして保持する。
// 前後がidentifier文字なら別identifier内とみなし、compass/bypass/DB_PASSへ反応しない。
function redactBusinessFields(text: string, fields: readonly string[]): string {
  if (fields.length === 0) {
    return text;
  }
  const sorted = [...fields].sort((left, right) => right.length - left.length);
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_.-])(${sorted.map(escapeRegExp).join('|')})([ \\t]*)(:(?!:)|：(?!：)|=(?!=|>))([ \\t]*)("[^"\\n]{0,4096}"|'[^'\\n]{0,4096}'|[^\\s]{1,4096})`,
    'gi',
  );
  return text.replace(
    pattern,
    (match: string, key: string, leading: string, separator: string, trailing: string, value: string) =>
      isUnchangedAssignmentValue(value) ? match : `${key}${leading}${separator}${trailing}${BUSINESS_FIELD_PLACEHOLDER}`,
  );
}

const PLACEHOLDER_PATTERN = /\[REDACTED:[A-Za-z0-9_]+\]/g;

// 置換済みplaceholderの内側はterm走査から除外し、known_secretのような種類名を含むtermでも壊さない。
function redactBusinessTerms(text: string, terms: readonly string[]): string {
  if (terms.length === 0) {
    return text;
  }
  const pattern = literalPattern(terms);
  let result = '';
  let lastIndex = 0;
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const index = match.index ?? 0;
    result += text.slice(lastIndex, index).replace(pattern, BUSINESS_TERM_PLACEHOLDER);
    result += match[0];
    lastIndex = index + match[0].length;
  }
  return result + text.slice(lastIndex).replace(pattern, BUSINESS_TERM_PLACEHOLDER);
}

// detector initial-v1。32〜256 code pointsのbase64/token風candidateだけを対象に、
// 既知placeholder・UUID・hex/git SHA/checksum・semver・repository path・通常identifierを除外する。
// 具体閾値（長さ・class・entropy）はRed testとこの実装でdeterministicに固定する。
const SUSPICION_CANDIDATE_PATTERN = /[A-Za-z0-9+/=_-]{32,}/g;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_PATTERN = /^[0-9a-fA-F]{7,64}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MIN_SUSPICION_CODE_POINTS = 32;
const MAX_SUSPICION_CODE_POINTS = 256;
const MIN_DISTINCT_CHARACTERS = 8;
const MIN_ENTROPY_BITS_PER_CHARACTER = 3.5;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  const length = codePointLength(value);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isSuspectedCandidate(candidate: string): boolean {
  const length = codePointLength(candidate);
  if (length < MIN_SUSPICION_CODE_POINTS || length > MAX_SUSPICION_CODE_POINTS) {
    return false;
  }
  if (UUID_PATTERN.test(candidate) || HEX_PATTERN.test(candidate) || SEMVER_PATTERN.test(candidate)) {
    return false;
  }
  // repository pathと通常identifierはupper/lower/digitの3classを満たさないため除外される。
  if (candidate.includes('/')) {
    return false;
  }
  if (!/[A-Z]/.test(candidate) || !/[a-z]/.test(candidate) || !/[0-9]/.test(candidate)) {
    return false;
  }
  if (new Set(candidate).size < MIN_DISTINCT_CHARACTERS) {
    return false;
  }
  return shannonEntropy(candidate) >= MIN_ENTROPY_BITS_PER_CHARACTER;
}

function hasSuspectedSecret(text: string): boolean {
  for (const match of text.matchAll(SUSPICION_CANDIDATE_PATTERN)) {
    if (isSuspectedCandidate(match[0])) {
      return true;
    }
  }
  return false;
}

// built-in credential → known exact → fields → terms → suspicion gateの順に適用する純粋関数。
// observeは本文を変えず固定codeをfindingsへ残し、blockは本文を返さずmessage全体を拒否する。
export function sanitizeConversationText(
  text: string,
  policy: RedactionPolicy,
  knownSecrets: readonly string[] = [],
): SanitizationResult {
  const validatedPolicy = validateRedactionPolicy(policy);
  const validatedKnownSecrets = validateKnownSecrets(knownSecrets);

  const fieldKeys = new Set(validatedPolicy.fields.map((field) => field.toLowerCase()));
  let redacted = redactCredentialText(text, fieldKeys);
  redacted = redactKnownSecrets(redacted, validatedKnownSecrets);
  redacted = redactBusinessFields(redacted, validatedPolicy.fields);
  redacted = redactBusinessTerms(redacted, validatedPolicy.terms);

  if (!hasSuspectedSecret(redacted)) {
    return { action: 'send', text: redacted, findings: [] };
  }
  if (validatedPolicy.suspicion_mode === 'block') {
    return { action: 'block', code: SUSPECTED_SECRET_CODE };
  }
  return { action: 'send', text: redacted, findings: [SUSPECTED_SECRET_OBSERVED] };
}
