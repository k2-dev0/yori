import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactConversationText } from '../redaction.js';

// 会話本文の秘匿値置換。収集境界と受付境界が同じ関数を使うため、規則はこのfileで固定する。

const PRIVATE_KEY_BLOCK = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';

describe('会話本文の秘匿値置換', () => {
  it('既知形式のcredentialを種類つきのplaceholderへ置換し、他の文字は保持する', () => {
    const text = [
      '秘密鍵:',
      PRIVATE_KEY_BLOCK,
      'AWS: AKIAIOSFODNN7EXAMPLE',
      `Google: AIza${'A'.repeat(35)}`,
      `GitHub: ghp_${'b'.repeat(36)}`,
      `Slack: xoxb-${'1'.repeat(12)}`,
      `OpenAI: sk-${'c'.repeat(32)}`,
      `JWT: eyJ${'d'.repeat(10)}.${'e'.repeat(10)}.${'f'.repeat(10)}`,
      '以上',
    ].join('\n');
    const expected = [
      '秘密鍵:',
      '[REDACTED:private_key]',
      'AWS: [REDACTED:aws_access_key]',
      'Google: [REDACTED:google_api_key]',
      'GitHub: [REDACTED:github_token]',
      'Slack: [REDACTED:slack_token]',
      'OpenAI: [REDACTED:openai_key]',
      'JWT: [REDACTED:jwt]',
      '以上',
    ].join('\n');

    assert.equal(redactConversationText(text), expected);
    assert.equal(redactConversationText(expected), expected, '置換済みの本文を再置換している');
  });

  it('代入値・認証ヘッダ・URL資格情報を伏せ、名前と構造は残す', () => {
    const text = [
      'PASSWORD=hunter2',
      'export JEV_API_KEY="abcd1234efgh5678"',
      "VOYAGE_KEY = 'test-voyage-key'",
      'POSTGRES_PASSWORD: yori',
      'secretKey = "abcd1234efgh5678"',
      'accessToken: "abcd1234efgh5678"',
      'authorization: Bearer abcdefghijklmnopqrstuvwx',
      'postgres://appuser:s3cretpw@db:5432/yori',
      'DATABASE_URL=postgres://appuser:s3cretpw@db:5432/yori',
    ].join('\n');
    const expected = [
      'PASSWORD=[REDACTED:env_value]',
      'export JEV_API_KEY=[REDACTED:env_value]',
      'VOYAGE_KEY = [REDACTED:env_value]',
      'POSTGRES_PASSWORD: [REDACTED:env_value]',
      'secretKey = [REDACTED:env_value]',
      'accessToken: [REDACTED:env_value]',
      'authorization: Bearer [REDACTED:authorization]',
      'postgres://[REDACTED:url_credentials]@db:5432/yori',
      'DATABASE_URL=postgres://[REDACTED:url_credentials]@db:5432/yori',
    ].join('\n');

    assert.equal(redactConversationText(text), expected);
  });

  it('変数名だけ・短いplaceholder・比較式・別名の代入は変更せず、再適用しても結果を変えない', () => {
    const unchanged = [
      'JEV_API_KEY は環境変数から読む',
      'token_env に変数名だけを書く',
      'Bearer <token>',
      "const API_KEY_ID = 'k-1'",
      "PASSWORD_RESET_MESSAGE = '再設定してください'",
      'if (PASSWORD === input.password) { return; }',
      'PASSWORD=',
      'PASSWORD=   ',
      'AKIA は接頭辞だけでは検出しない',
    ].join('\n');

    assert.equal(redactConversationText(unchanged), unchanged);

    const mixed = 'キーAKIAIOSFODNN7EXAMPLEとPASSWORD=hunter2';
    const once = redactConversationText(mixed);
    assert.equal(once, 'キー[REDACTED:aws_access_key]とPASSWORD=[REDACTED:env_value]');
    assert.equal(redactConversationText(once), once, '再適用で結果が変わっている');
  });

  it('exact PASSの代入値・全角colonの代入値をenv_valueへ置換し、compass/bypass/DB_PASSは変更しない', () => {
    const text = [
      'pass: hogehoge',
      'PASS: hogehoge',
      'pass=hogehoge',
      'pass = hogehoge',
      'Pass：hogehoge',
      'PASS："hogehoge"',
      "pass: 'hogehoge'",
      'compass: hogehoge',
      'compass：hogehoge',
      'bypass = hogehoge',
      'DB_PASS: hogehoge',
      'PASS は環境変数から読む',
      'pass:',
      'pass:   ',
      'pass == hogehoge',
      'pass => hogehoge',
      'pass::hogehoge',
    ].join('\n');
    const expected = [
      'pass: [REDACTED:env_value]',
      'PASS: [REDACTED:env_value]',
      'pass=[REDACTED:env_value]',
      'pass = [REDACTED:env_value]',
      'Pass：[REDACTED:env_value]',
      'PASS：[REDACTED:env_value]',
      "pass: [REDACTED:env_value]",
      'compass: hogehoge',
      'compass：hogehoge',
      'bypass = hogehoge',
      'DB_PASS: hogehoge',
      'PASS は環境変数から読む',
      'pass:',
      'pass:   ',
      'pass == hogehoge',
      'pass => hogehoge',
      'pass::hogehoge',
    ].join('\n');

    assert.equal(redactConversationText(text), expected);
    assert.equal(redactConversationText(expected), expected, 'PASS置換済み本文の再適用で結果が変わっている');
  });

  it('全大文字連結prefixのsecret名も従来どおり検出し、compass/bypass/DB_PASSには反応しない', () => {
    const text = [
      'MYTOKEN=abc123',
      'MYSECRET: abc123',
      'SOMEKEY = abc123',
      'MYPASSWORD：abc123',
      'MYAPIKEY: abc123',
      'compass: hogehoge',
      'bypass = hogehoge',
      'DB_PASS: hogehoge',
    ].join('\n');
    const expected = [
      'MYTOKEN=[REDACTED:env_value]',
      'MYSECRET: [REDACTED:env_value]',
      'SOMEKEY = [REDACTED:env_value]',
      'MYPASSWORD：[REDACTED:env_value]',
      'MYAPIKEY: [REDACTED:env_value]',
      'compass: hogehoge',
      'bypass = hogehoge',
      'DB_PASS: hogehoge',
    ].join('\n');

    assert.equal(redactConversationText(text), expected, '全大文字連結prefixのsecret名が検出されていない');
    assert.equal(redactConversationText(expected), expected, '再適用で結果が変わっている');
  });

  it('既存のsecret名patternは全角colonでも値だけを伏せ、camelCase/underscore挙動を維持する', () => {
    const names = [
      'PASSWORD',
      'POSTGRES_PASSWORD',
      'PASSWD',
      'SECRET',
      'TOKEN',
      'JEV_API_KEY',
      'secretKey',
      'APIKEY',
      'CREDENTIAL',
    ];
    const text = names.map((name) => `${name}：hunter2`).join('\n');
    const expected = names.map((name) => `${name}：[REDACTED:env_value]`).join('\n');

    assert.equal(redactConversationText(text), expected, '既存patternが全角colonへ追随していない');
    assert.equal(redactConversationText(expected), expected, '全角colon置換済み本文の再適用で結果が変わっている');
  });

  it('NUL・単独サロゲート・絵文字・上限超過の本文でも例外を投げず、同じ入力へ同じ結果を返す', () => {
    const samples = ['', '\u0000', '\uD800\uDC00と\uD800', '😀'.repeat(10), 'a'.repeat(70_000), `PASSWORD=${'あ'.repeat(100)}`];

    for (const sample of samples) {
      const once = redactConversationText(sample);
      assert.equal(typeof once, 'string', `文字列以外を返した: ${sample.slice(0, 20)}`);
      assert.equal(redactConversationText(sample), once, `同じ入力で結果が変わっている: ${sample.slice(0, 20)}`);
    }
  });
});
