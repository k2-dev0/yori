#!/usr/bin/env node
// production Composeへ渡す設定の検査script。
// process.envの必須10キーを検査し、値やsecretは出力しない。成功0・失敗非0。
const REQUIRED_KEYS = [
  'YORI_POSTGRES_USER',
  'YORI_POSTGRES_PASSWORD',
  'YORI_POSTGRES_DB',
  'YORI_DOMAIN',
  'JEV_API_KEY',
  'JEV_ACCOUNT_REF',
  'JEV_API_URL',
  'VOYAGE_API_KEY',
  'VOYAGE_ACCOUNT_REF',
  'VOYAGE_API_URL',
];

// 未設定・空文字・空白だけを拒否する。判定した値は出力へ含めない。
const missingOrEmpty = REQUIRED_KEYS.filter((key) => {
  const value = process.env[key];
  return typeof value !== 'string' || value.trim() === '';
});

const errors = [];
if (missingOrEmpty.length > 0) {
  errors.push(`必須環境変数が未設定または空です: ${missingOrEmpty.join(', ')}`);
}

// DATABASE_URL組立に使うpasswordは、予約文字を含まない小文字64桁hexに限定する。
if (!missingOrEmpty.includes('YORI_POSTGRES_PASSWORD') && !/^[0-9a-f]{64}$/.test(process.env.YORI_POSTGRES_PASSWORD ?? '')) {
  errors.push('YORI_POSTGRES_PASSWORD は小文字64桁hexで指定してください');
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exitCode = 1;
}
