import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { MAX_BATCH_SIZE, RECEIPT_PAYLOAD_KEYS, type EventInput, type EventsRequestBody } from '../contract.js';
import { countRows, sha256Bytes } from '../../db/tests/fixtures.js';
import type { Pool } from 'pg';

// テストのイベント既定値。上書きしたいfieldだけ渡す。
export function buildEventInput(overrides: Partial<EventInput> = {}): EventInput {
  return {
    idempotency_key: `idem-${randomUUID()}`,
    source: 'codex',
    source_scope: 'scope-a',
    source_session_id: 'session-a',
    source_message_id: `msg-${randomUUID()}`,
    sequence_no: 1,
    revision: 1,
    role: 'user',
    occurred_at: '2026-09-21T01:00:00.000Z',
    text: '保存対象の発言',
    ...overrides,
  };
}

export function buildEventBatch(projectId: string, events: EventInput[]): EventsRequestBody {
  assert.ok(events.length <= MAX_BATCH_SIZE, 'テストのbatchは上限以内にする');
  return { project_id: projectId, events };
}

export interface CanonicalReceiptInput extends EventInput {
  company_id: string;
  employee_id: string;
  project_id: string;
}

// receipt payloadは受信値をキー順固定のJSONへ直列化してSHA-256する（本文はJSONとしてそのままの文字列）。
export function canonicalReceiptJson(input: CanonicalReceiptInput): string {
  const ordered = Object.fromEntries(RECEIPT_PAYLOAD_KEYS.map((key) => [key, input[key]]));
  return JSON.stringify(ordered);
}

export function canonicalReceiptHash(input: CanonicalReceiptInput): Buffer {
  return sha256Bytes(canonicalReceiptJson(input));
}

export async function postEvents(
  app: FastifyInstance,
  options: { token?: string | null; body?: unknown; payload?: string },
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? ''}`;
  }
  return app.inject({
    method: 'POST',
    url: '/v1/events',
    headers,
    payload: options.payload ?? JSON.stringify(options.body),
  });
}

// 拒否系のテストで、受付に必要なテーブルへ1行も書かれていないことを確認する。
export async function assertNoEventWrites(pool: Pool): Promise<void> {
  assert.equal(await countRows(pool, 'sessions'), 0, 'sessionsが書かれている');
  assert.equal(await countRows(pool, 'messages'), 0, 'messagesが書かれている');
  assert.equal(await countRows(pool, 'message_revisions'), 0, 'message_revisionsが書かれている');
  assert.equal(await countRows(pool, 'event_receipts'), 0, 'event_receiptsが書かれている');
  assert.equal(await countRows(pool, 'jobs'), 0, 'jobsが書かれている');
  assert.equal(await countRows(pool, 'search_requests'), 0, 'search_requestsが書かれている');
}
