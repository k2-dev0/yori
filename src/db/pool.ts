import { Pool } from 'pg';

// DATABASE_URLからAPI・ワーカー用の接続プールを作る。接続数は計画14.1の初期値に合わせる。
export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 5 });
}

// テスト・CLIでDB接続先を必須にする。未設定のまま接続して誤ったDBへ書かない。
export function requireDatabaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = source.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL が未設定です。deployment/compose.yaml の db サービスへ接続する値を設定してください。');
  }
  return databaseUrl;
}
