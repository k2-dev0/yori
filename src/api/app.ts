import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { MAX_EVENT_BODY_BYTES, type ErrorBody } from './contract.js';
import { authenticate, EventConflictError, ingestEvents, isProjectMember } from './events.js';
import { eventsRequestSchema } from './schema.js';

// 認証・入力検証・project権限・保存をHTTP境界としてまとめる。DB失敗の詳細は応答へ出さない。
export function buildApp(deps: { pool: Pool }): FastifyInstance {
  const app = Fastify({ bodyLimit: MAX_EVENT_BODY_BYTES });

  // 予期しない例外の応答にDBメッセージ・SQL・本文・認証情報を含めない。4xxは状態だけを保つ。
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    void reply.code(statusCode).send(errorBody(errorCodeForStatus(statusCode)));
  });

  app.get('/health/live', async (_request, reply) => reply.code(200).send({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      return reply.code(200).send({ status: 'ready' });
    } catch {
      // DB等の依存が落ちていても受付可否だけを返し、接続情報やSQLは出さない。
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.post('/v1/events', async (request, reply) => {
    const auth = await authenticate(deps.pool, request.headers.authorization);
    if (!auth) {
      return reply.code(401).send(errorBody('unauthorized'));
    }
    const parsed = eventsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(errorBody('invalid_request'));
    }
    if (!(await isProjectMember(deps.pool, auth, parsed.data.project_id))) {
      return reply.code(403).send(errorBody('forbidden'));
    }
    try {
      return reply.code(202).send(await ingestEvents(deps.pool, auth, parsed.data));
    } catch (error) {
      if (error instanceof EventConflictError || isUniqueViolation(error)) {
        return reply.code(409).send(errorBody('conflict'));
      }
      return reply.code(500).send(errorBody('internal_error'));
    }
  });

  return app;
}

// HTTP statusから利用側が分岐に使う固定code文字列を選ぶ。
function errorCodeForStatus(statusCode: number): string {
  if (statusCode === 400) return 'invalid_request';
  if (statusCode === 401) return 'unauthorized';
  if (statusCode === 403) return 'forbidden';
  if (statusCode === 409) return 'conflict';
  if (statusCode === 413) return 'payload_too_large';
  return 'internal_error';
}

// 応答のエラー本文はcodeだけにし、内部メッセージを含めない。
function errorBody(code: string): ErrorBody {
  return { error: { code } };
}

// PostgreSQLの一意制約違反だけを409候補として判定する。
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}
