import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { MAX_EVENT_BODY_BYTES } from './contract.js';

// M1 Red時点はルート契約とbody上限のみ。認証・検証・保存はM1 Greenで実装する。
export function buildApp(deps: { pool: Pool }): FastifyInstance {
  const app = Fastify({ bodyLimit: MAX_EVENT_BODY_BYTES });
  void deps.pool;

  app.get('/health/live', async (_request, reply) => reply.code(501).send(notImplemented('GET /health/live')));
  app.get('/health/ready', async (_request, reply) => reply.code(501).send(notImplemented('GET /health/ready')));
  app.post('/v1/events', async (_request, reply) => reply.code(501).send(notImplemented('POST /v1/events')));

  return app;
}

function notImplemented(operation: string) {
  return { error: { code: 'not_implemented', message: `${operation} はM1 Greenで実装します` } };
}
