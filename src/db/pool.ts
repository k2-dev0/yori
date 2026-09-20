import { Pool } from 'pg';

// DATABASE_URLからAPI・ワーカー用の接続プールを作る。接続数は計画14.1の初期値に合わせる。
export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    // 接続・query・statementの待ちを有限にし、依存障害で受付が無限に固まらないようにする。
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 15_000,
    statement_timeout: 30_000,
  });
  // idle接続のエラーは次回queryでpgが張り直す。未処理のerrorでprocessを落とさない。
  pool.on('error', () => undefined);
  return pool;
}

// テスト・CLIでDB接続先を必須にする。未設定のまま接続して誤ったDBへ書かない。
export function requireDatabaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = source.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL が未設定です。deployment/compose.yaml の db サービスへ接続する値を設定してください。');
  }
  return databaseUrl;
}
