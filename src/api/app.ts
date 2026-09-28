import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { MAX_EVENT_BODY_BYTES, type ErrorBody, type ErrorCode } from './contract.js';
import { resolveCollectorSetup } from './collector-setup.js';
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
  collectorSetupResponseSchema,
  errorResponseSchema,
  eventsResponseSchema,
  evidenceResponseSchema,
  healthLiveResponseSchema,
  healthReadyResponseSchema,
  searchAcceptedResponseSchema,
  searchLookupResponseSchema,
  searchViewResponseSchema,
  sessionLinkResponseSchema,
} from './response-schema.js';
import {
  collectorSetupRequestSchema,
  eventsRequestSchema,
  evidenceQuerySchema,
  searchByInputQuerySchema,
  searchDetailQuerySchema,
  searchRequestSchema,
  sessionLinkRequestSchema,
} from './schema.js';
import {
  SessionLinkConflictError,
  SessionLinkInvalidError,
  SessionLinkNotFoundError,
  createSessionLink,
} from './session-links.js';

// 認証・入力検証・project権限・保存をHTTP境界としてまとめる。DB失敗の詳細は応答へ出さない。
export function buildApp(deps: { pool: Pool }): FastifyInstance {
  const app = Fastify({ bodyLimit: MAX_EVENT_BODY_BYTES });

  // 予期しない例外の応答にDBメッセージ・SQL・本文・認証情報を含めない。4xxは状態だけを保つ。
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    void reply.code(statusCode).send(errorBody(errorCodeForStatus(statusCode)));
  });

  app.get('/health/live', async (_request, reply) => reply.code(200).send(healthLiveResponseSchema.parse({ status: 'ok' })));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      return reply.code(200).send(healthReadyResponseSchema.parse({ status: 'ready' }));
    } catch {
      // DB等の依存が落ちていても受付可否だけを返し、接続情報やSQLは出さない。
      return reply.code(503).send(healthReadyResponseSchema.parse({ status: 'unavailable' }));
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
      return reply.code(202).send(eventsResponseSchema.parse(await ingestEvents(deps.pool, auth, parsed.data)));
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
      return reply.code(created.reused ? 200 : 202).send(searchAcceptedResponseSchema.parse({ request_id: created.requestId }));
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

  // 認証済みcollectorのsetup。canonical repositoryからmember projectとcurrent policyだけを返す。
  app.post('/v1/collector/setup', async (request, reply) => {
    const auth = await authenticate(deps.pool, request.headers.authorization);
    if (!auth) {
      return reply.code(401).send(errorBody('unauthorized'));
    }
    const parsed = collectorSetupRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(errorBody('invalid_request'));
    }
    try {
      const setup = await resolveCollectorSetup(deps.pool, auth, parsed.data.repository);
      if (setup === null) {
        // 別会社・非member・未登録は同じ404にし、repositoryの存在を開示しない。
        return reply.code(404).send(errorBody('not_found'));
      }
      return reply.code(200).send(collectorSetupResponseSchema.parse(setup));
    } catch {
      return reply.code(500).send(errorBody('internal_error'));
    }
  });

  // M7の明示引き継ぎ登録。strict入力を先に検証し、不存在・別案件・他社員は404へ統一する。
  app.post('/v1/session-links', async (request, reply) => {
    const auth = await authenticate(deps.pool, request.headers.authorization);
    if (!auth) {
      return reply.code(401).send(errorBody('unauthorized'));
    }
    const parsed = sessionLinkRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(errorBody('invalid_request'));
    }
    if (!(await isProjectMember(deps.pool, auth, parsed.data.project_id))) {
      return reply.code(403).send(errorBody('forbidden'));
    }
    try {
      const created = await createSessionLink(deps.pool, auth, parsed.data);
      return reply.code(created.statusCode).send(sessionLinkResponseSchema.parse(created.response));
    } catch (error) {
      if (error instanceof SessionLinkNotFoundError) {
        return reply.code(404).send(errorBody('not_found'));
      }
      if (error instanceof SessionLinkConflictError || isUniqueViolation(error)) {
        return reply.code(409).send(errorBody('conflict'));
      }
      if (error instanceof SessionLinkInvalidError) {
        return reply.code(400).send(errorBody('invalid_request'));
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
    const view = await lookupSearchByInput(deps.pool, auth, parsed.data, parsed.data.wait_ms ?? 0);
    return reply.code(200).send(searchLookupResponseSchema.parse(view));
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
      const view = await readSearch(deps.pool, auth, id.data.toLowerCase(), parsed.data.wait_ms ?? 0);
      return reply.code(200).send(searchViewResponseSchema.parse(view));
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
    return reply.code(200).send(evidenceResponseSchema.parse(evidence));
  });

  return app;
}

// HTTP statusから利用側が分岐に使う固定code文字列を選ぶ。
function errorCodeForStatus(statusCode: number): ErrorCode {
  if (statusCode === 400) return 'invalid_request';
  if (statusCode === 401) return 'unauthorized';
  if (statusCode === 403) return 'forbidden';
  if (statusCode === 409) return 'conflict';
  if (statusCode === 413) return 'payload_too_large';
  return 'internal_error';
}

// 応答のエラー本文は公開response schemaへ通し、code以外のfieldを追加しない。
function errorBody(code: ErrorCode): ErrorBody {
  return errorResponseSchema.parse({ error: { code } });
}

// PostgreSQLの一意制約違反だけを409候補として判定する。
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}
