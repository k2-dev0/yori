// 会話本文に現れる秘匿値を、種類だけを残した固定placeholderへ置換する。
// 収集境界（collector）と受付境界（API）が同じ関数を使い、保存・外部送信の前に必ず通す。
// 入力だけから決まる純粋関数にして、再読込・再送で本文とrevisionを増やさない。
// 量化子には上限を置き、長い本文でも線形時間で終わるようにする。

// 代入形（NAME=VALUE / NAME: VALUE）の値だけを伏せる。名前は最終要素が秘匿値の種類を表すものに限り、
// 名前と区切りはそのまま残す。snake_caseとcamelCaseの両方の最終要素を対象にする。
// 比較（==/=>）と名前空間（::）は代入ではないため対象外にする。
const SECRET_ASSIGNMENT_PATTERN =
  /(^|[^A-Za-z0-9_])([A-Za-z0-9_]*)(PASSWORD|PASSWD|SECRET|TOKEN|KEY|APIKEY|CREDENTIAL)(?![A-Za-z0-9_])([ \t]*(?:=(?!=|>)|:(?!:))[ \t]*)("[^"\n]{0,4096}"|'[^'\n]{0,4096}'|[^\s]{1,4096})/gi;

// 会話本文の秘匿値をplaceholderへ置換する。該当がなければ入力をそのまま返す。
export function redactConversationText(text: string): string {
  let redacted = text;
  // 秘密鍵はBEGINからENDまでを丸ごと伏せる。ENDが無い途中までの本文も末尾まで伏せる。
  redacted = redacted.replace(/-----BEGIN [A-Z0-9 ]{0,16}PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]{0,16}PRIVATE KEY-----/g, '[REDACTED:private_key]');
  redacted = redacted.replace(/-----BEGIN [A-Z0-9 ]{0,16}PRIVATE KEY-----[\s\S]*/g, '[REDACTED:private_key]');
  redacted = redacted.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED:aws_access_key]');
  redacted = redacted.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:google_api_key]');
  redacted = redacted.replace(/\bgh[pousr]_[A-Za-z0-9]{36,512}\b/g, '[REDACTED:github_token]');
  redacted = redacted.replace(/\bxox[abpros]-[0-9A-Za-z-]{10,512}\b/g, '[REDACTED:slack_token]');
  redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{20,512}\b/g, '[REDACTED:openai_key]');
  redacted = redacted.replace(/\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\b/g, '[REDACTED:jwt]');
  // URLのuserinfoは資格情報として丸ごと伏せ、scheme・host・pathは残す。
  if (redacted.includes('://')) {
    redacted = redacted.replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s:@]{1,256}:[^/\s:@]{1,256}@/gi, '$1[REDACTED:url_credentials]@');
  }
  // Authorizationヘッダは12文字以上の値だけを伏せる。短い語や<placeholder>は残す。
  redacted = redacted.replace(/(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)([^\s'"]{12,})/gi, (match, prefix: string, credential: string) =>
    credential.startsWith('<') || credential.startsWith('$') ? match : `${prefix}[REDACTED:authorization]`,
  );
  // 代入形の値は名前と区切りを残して伏せる。
  return redacted.replace(SECRET_ASSIGNMENT_PATTERN, '$1$2$3$4[REDACTED:env_value]');
}
