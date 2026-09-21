import { validate as isUuid } from 'uuid';
import { MAX_BATCH_SIZE, MAX_EVENT_BODY_BYTES, type EventInput } from '../api/contract.js';
import { eventsRequestSchema } from '../api/schema.js';
import type { CollectorConfig } from './config.js';
import { NO_OFFSET, recordDiagnostic, type CollectorState, type OutboxRow } from './state.js';

const REQUEST_TIMEOUT_MS = 5_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 300_000;

export interface DeliverPendingInput {
  state: CollectorState;
  namespace: string;
  config: CollectorConfig;
  token: string;
  automatic: boolean;
  blockedProjects: ReadonlySet<string>;
}

type PostOutcome =
  | { kind: 'ack' }
  | { kind: 'invalid' }
  | { kind: 'retryable'; retryAfterMs: number }
  | { kind: 'permanent' };

interface Batch {
  rows: OutboxRow[];
  events: EventInput[];
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// serverの202応答がbatchと件数・key・revision・型まで一致するか確認する。
function isAcknowledged(payload: unknown, events: EventInput[]): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.results) || payload.results.length !== events.length) {
    return false;
  }
  const results = payload.results;
  return events.every((event, index) => {
    const result: unknown = results[index];
    if (!isRecord(result)) {
      return false;
    }
    if (result.idempotency_key !== event.idempotency_key || result.revision !== event.revision) {
      return false;
    }
    if (typeof result.message_id !== 'string' || !isUuid(result.message_id)) {
      return false;
    }
    // request_idは自動検索のUUID、または検索を作らない発言のnullだけを受理する。
    return result.request_id === null || (typeof result.request_id === 'string' && isUuid(result.request_id));
  });
}

// Retry-After（秒数またはHTTP日時）を上限付きの待機msへ変換する。
function retryAfterMs(response: Response): number {
  const header = response.headers.get('retry-after');
  if (header === null || header.trim().length === 0) {
    return 0;
  }
  const seconds = Number(header);
  const waitMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(waitMs) || waitMs <= 0) {
    return 0;
  }
  return Math.min(waitMs, BACKOFF_MAX_MS);
}

async function postBatch(endpoint: string, token: string, batch: Batch): Promise<PostOutcome> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: batch.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    return { kind: 'retryable', retryAfterMs: 0 };
  }
  if (response.status === 202) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { kind: 'invalid' };
    }
    return isAcknowledged(payload, batch.events) ? { kind: 'ack' } : { kind: 'invalid' };
  }
  if (response.status === 429 || response.status >= 500) {
    return { kind: 'retryable', retryAfterMs: retryAfterMs(response) };
  }
  return { kind: 'permanent' };
}

interface QueueTarget {
  projectId: string;
  sourceScope: string;
}

// 1回の送信予算100件の中から、次の送信対象を選ぶ。
// 登録確認はproject_idとsource_scopeのペアで行い、同じprojectに複数repositoryがある設定もそれぞれ送る。
// config.projectsと対応が取れないoutbox（設定から削除・再割当）は送らず保持する。
// automaticは恒久failedとbackoff中を対象にしない。
function selectDeliverableProject(
  input: Pick<DeliverPendingInput, 'state' | 'namespace' | 'config' | 'automatic' | 'blockedProjects'>,
): QueueTarget | null {
  const rows = input.state.db
    .prepare(
      `SELECT project_id, source_scope, MIN(id) AS first_id
         FROM outbox
        WHERE namespace = ?
        GROUP BY project_id, source_scope
        ORDER BY first_id`,
    )
    .all(input.namespace);
  const now = Date.now();
  for (const row of rows) {
    const projectId = String(row.project_id);
    const sourceScope = String(row.source_scope);
    const configured = input.config.projects.some(
      (project) => project.project_id === projectId && project.repository === sourceScope,
    );
    if (!configured) {
      continue;
    }
    if (input.blockedProjects.has(projectId)) {
      continue;
    }
    if (input.automatic) {
      const failed = input.state.db
        .prepare('SELECT 1 AS failed FROM queue_failures WHERE namespace = ? AND project_id = ?')
        .get(input.namespace, projectId);
      if (failed !== undefined) {
        continue;
      }
      const backoff = input.state.db
        .prepare('SELECT next_attempt_at FROM queue_backoff WHERE namespace = ? AND project_id = ?')
        .get(input.namespace, projectId);
      if (backoff !== undefined && Number(backoff.next_attempt_at) > now) {
        continue;
      }
    }
    return { projectId, sourceScope };
  }
  return null;
}

// 残りの送信予算（最大100件）以下だけをSQLで読み、本文を余分にメモリへ載せない。
function selectOutboxRows(state: CollectorState, namespace: string, target: QueueTarget, limit: number): OutboxRow[] {
  const rows = state.db
    .prepare(
      `SELECT id, idempotency_key, project_id, source, source_scope, source_session_id, source_message_id, sequence_no, revision, role, occurred_at, text
         FROM outbox
        WHERE namespace = ? AND project_id = ? AND source_scope = ?
        ORDER BY source_session_id, sequence_no, revision, id
        LIMIT ?`,
    )
    .all(namespace, target.projectId, target.sourceScope, Math.min(limit, MAX_BATCH_SIZE));
  return rows.map((row) => ({
    id: Number(row.id),
    idempotency_key: String(row.idempotency_key),
    project_id: String(row.project_id),
    source: row.source as OutboxRow['source'],
    source_scope: String(row.source_scope),
    source_session_id: String(row.source_session_id),
    source_message_id: String(row.source_message_id),
    sequence_no: Number(row.sequence_no),
    revision: Number(row.revision),
    role: row.role as OutboxRow['role'],
    occurred_at: String(row.occurred_at),
    text: String(row.text),
  }));
}

// sequence/revision順の行から1MiB以内のbatchを組み、契約Zodで最終検証する。
function buildBatch(projectId: string, rows: OutboxRow[], limit: number): Batch | null {
  const chosen: OutboxRow[] = [];
  const events: EventInput[] = [];
  for (const row of rows) {
    if (events.length >= limit) {
      break;
    }
    const event: EventInput = {
      idempotency_key: row.idempotency_key,
      source: row.source,
      source_scope: row.source_scope,
      source_session_id: row.source_session_id,
      source_message_id: row.source_message_id,
      sequence_no: row.sequence_no,
      revision: row.revision,
      role: row.role,
      occurred_at: row.occurred_at,
      text: row.text,
    };
    const candidateEvents = [...events, event];
    const candidateBody = JSON.stringify({ project_id: projectId, events: candidateEvents });
    if (events.length > 0 && Buffer.byteLength(candidateBody, 'utf8') > MAX_EVENT_BODY_BYTES) {
      break;
    }
    chosen.push(row);
    events.push(event);
  }
  if (events.length === 0) {
    return null;
  }
  const request = { project_id: projectId, events };
  if (!eventsRequestSchema.safeParse(request).success) {
    return null;
  }
  return { rows: chosen, events, body: JSON.stringify(request) };
}

function deleteOutboxRows(state: CollectorState, ids: number[]): void {
  state.db.exec('BEGIN IMMEDIATE');
  try {
    const statement = state.db.prepare('DELETE FROM outbox WHERE id = ?');
    for (const id of ids) {
      statement.run(id);
    }
    state.db.exec('COMMIT');
  } catch (error) {
    state.db.exec('ROLLBACK');
    throw error;
  }
}

function resetBackoff(state: CollectorState, namespace: string, projectId: string): void {
  state.db.prepare('DELETE FROM queue_backoff WHERE namespace = ? AND project_id = ?').run(namespace, projectId);
}

// 恒久エラーのprojectをfailedとして保持する。自動collectは明示flushまで対象にしない。
function markQueueFailed(state: CollectorState, namespace: string, projectId: string): void {
  state.db
    .prepare(
      `INSERT INTO queue_failures (namespace, project_id, failed_at) VALUES (?, ?, ?)
       ON CONFLICT (namespace, project_id) DO UPDATE SET failed_at = excluded.failed_at`,
    )
    .run(namespace, projectId, Date.now());
}

function clearQueueFailure(state: CollectorState, namespace: string, projectId: string): void {
  state.db.prepare('DELETE FROM queue_failures WHERE namespace = ? AND project_id = ?').run(namespace, projectId);
}

// 失敗は指数backoff（最大5分）で次回へ回す。Retry-Afterは上限付きで優先する。
function scheduleBackoff(state: CollectorState, namespace: string, projectId: string, retryableAfterMs: number): void {
  const row = state.db.prepare('SELECT attempt FROM queue_backoff WHERE namespace = ? AND project_id = ?').get(namespace, projectId);
  const attempt = (row === undefined ? 0 : Number(row.attempt)) + 1;
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  const waitMs = Math.min(Math.max(exponential, retryableAfterMs), BACKOFF_MAX_MS);
  state.db
    .prepare(
      `INSERT INTO queue_backoff (namespace, project_id, attempt, next_attempt_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (namespace, project_id) DO UPDATE SET attempt = excluded.attempt, next_attempt_at = excluded.next_attempt_at`,
    )
    .run(namespace, projectId, attempt, Date.now() + waitMs);
}

// outboxを送信予算内で送る。ack時だけ行を削除し、retryable/invalidはbackoff、恒久エラーはfailedとして保持する。
export async function deliverPending(input: DeliverPendingInput): Promise<void> {
  const endpoint = `${input.config.api_url.replace(/\/+$/, '')}/v1/events`;
  let delivered = 0;
  while (delivered < MAX_BATCH_SIZE) {
    const target = selectDeliverableProject(input);
    if (target === null) {
      return;
    }
    const remaining = MAX_BATCH_SIZE - delivered;
    const rows = selectOutboxRows(input.state, input.namespace, target, remaining);
    const batch = buildBatch(target.projectId, rows, remaining);
    if (batch === null) {
      recordDiagnostic(input.state, input.namespace, 'send_invalid_event', NO_OFFSET);
      return;
    }
    const outcome = await postBatch(endpoint, input.token, batch);
    if (outcome.kind === 'ack') {
      deleteOutboxRows(input.state, batch.rows.map((row) => row.id));
      resetBackoff(input.state, input.namespace, target.projectId);
      clearQueueFailure(input.state, input.namespace, target.projectId);
      delivered += batch.events.length;
      continue;
    }
    if (outcome.kind === 'permanent') {
      recordDiagnostic(input.state, input.namespace, 'send_permanent_failure', NO_OFFSET);
      markQueueFailed(input.state, input.namespace, target.projectId);
      return;
    }
    // retryable/invalidは恒久失敗ではないためfailedを解除し、backoffだけで次回へ回す。
    recordDiagnostic(input.state, input.namespace, outcome.kind === 'invalid' ? 'send_invalid_response' : 'send_failed', NO_OFFSET);
    clearQueueFailure(input.state, input.namespace, target.projectId);
    scheduleBackoff(input.state, input.namespace, target.projectId, outcome.kind === 'retryable' ? outcome.retryAfterMs : 0);
    return;
  }
}
