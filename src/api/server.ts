import { loadEnv } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { buildApp } from './app.js';

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);
const app = buildApp({ pool });

// コンテナ停止時に接続を閉じる。SIGKILL時はDB側の接続断で解放される。
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => pool.end());
  });
}

await app.listen({ host: env.API_HOST, port: env.API_PORT });
