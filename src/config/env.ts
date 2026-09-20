import { z } from 'zod';

// アプリ起動に必要な環境変数を検証する。未設定・不正値は起動時に失敗させる。
export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3210),
});

export function loadEnv(source: NodeJS.ProcessEnv = process.env) {
  return envSchema.parse(source);
}
