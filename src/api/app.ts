import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { MAX_EVENT_BODY_BYTES, type ErrorBody } from './contract.js';
import { authenticate, EventConflictError, ingestEvents, isProjectMember } from './events.js';
import {
  createSearch,
  loadEvidence,
  lookupSearchByInput,
  readSearch,
  SearchConflictError,
  SearchNotFoundError,
  SearchTargetError,
} from './searches.js';
import {
  eventsRequestSchema,
  evidenceQuerySchema,
  searchByInputQuerySchema,
  searchDetailQuerySchema,
  searchRequestSchema,
} from './schema.js';

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

  // 明示検索は同じ入力原文・force_refresh=falseなら自動受付を再利用し、それ以外はmanual受付を作る。
  app.post('/v1/searches', async (request, reply) => {
    const auth = await authenticate(deps.pool, request.headers.authorization);
    if (!auth) {
      return reply.code(401).send(errorBody('unauthorized'));
    }
    const parsed = searchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(errorBody('invalid_request'));
    }
    if (!(await isProjectMember(deps.pool, auth, parsed.data.project_id))) {
      return reply.code(403).send(errorBody('forbidden'));
    }
    try {
      const created = await createSearch(deps.pool, auth, parsed.data);
      return reply.code(created.reused ? 200 : 202).send({ request_id: created.requestId });
    } catch (error) {
      if (error instanceof SearchConflictError || isUniqueViolation(error)) {
        return reply.code(409).send(errorBody('conflict'));
      }
      if (error instanceof SearchTargetError) {
        return reply.code(400).send(errorBody('invalid_request'));
      }
      if (error instanceof SearchNotFoundError) {
        return reply.code(404).send(errorBody('not_found'));
      }
      return reply.code(500).send(errorBody('internal_error'));
    }
  });

  // 入力identityの照合は未受付をnot_receivedとして返し、no_matchと混同しない。
  app.get('/v1/searches/by-input', async (request, reply) => {
    const auth = await authenticate(deps.pool, request.headers.authorization);
    if (!auth) {
      return reply.code(401).send(errorBody('unauthorized'));
    }
    const parsed = searchByInputQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(errorBody('invalid_request'));
    }
    if (!(await isProjectMember(deps.pool, auth, parsed.data.project_id))) {
      return reply.code(403).send(errorBody('forbidden'));
    }
    return reply.code(200).send(await lookupSearchByInput(deps.pool, auth, parsed.data, parsed.data.wait_ms ?? 0));
  });

  // request IDの結果取得は同一会社・案件membershipだけを返し、他案件の存在を開示しない。
  app.get('/v1/searches/:id', async (request, reply) => {
    const auth = await authenticate(deps.pool, request.headers.authorization);
    if (!auth) {
      return reply.code(401).send(errorBody('unauthorized'));
    }
    const id = z.uuid().safeParse((request.params as { id?: string }).id ?? '');
    if (!id.success) {
      return reply.code(400).send(errorBody('invalid_request'));
    }
    const parsed = searchDetailQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(errorBody('invalid_request'));
    }
    try {
      return reply.code(200).send(await readSearch(deps.pool, auth, id.data.toLowerCase(), parsed.data.wait_ms ?? 0));
    } catch (error) {
      if (error instanceof SearchNotFoundError) {
        return reply.code(404).send(errorBody('not_found'));
      }
      return reply.code(500).send(errorBody('internal_error'));
    }
  });

  // 原文取得は保存済みrevisionを案件membershipで返し、別案件・未保存revisionを開示しない。
  app.get('/v1/evidence/:message_id', async (request, reply) => {
    const auth = await authenticate(deps.pool, request.headers.authorization);
    if (!auth) {
      return reply.code(401).send(errorBody('unauthorized'));
    }
    const messageId = z.uuid().safeParse((request.params as { message_id?: string }).message_id ?? '');
    if (!messageId.success) {
      return reply.code(400).send(errorBody('invalid_request'));
    }
    const parsed = evidenceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(errorBody('invalid_request'));
    }
    if (!(await isProjectMember(deps.pool, auth, parsed.data.project_id))) {
      return reply.code(403).send(errorBody('forbidden'));
    }
    const evidence = await loadEvidence(deps.pool, auth, messageId.data.toLowerCase(), parsed.data.project_id, parsed.data.revision);
    if (evidence === null) {
      return reply.code(404).send(errorBody('not_found'));
    }
    return reply.code(200).send(evidence);
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
