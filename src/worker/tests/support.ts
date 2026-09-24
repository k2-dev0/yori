import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import {
  CLASSIFY_MESSAGE_PRIORITY,
  ROUTE_SEARCH_PRIORITY,
  claimJobs,
  enqueueJob,
  type ClaimedJob,
  type JobKind,
} from '../../jobs/queue.js';
import { insertMessage, insertSession, sha256Bytes, type WorkspaceFixture } from '../../db/tests/fixtures.js';
import type { WorkerConfig } from '../config.js';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_INPUT_BUDGET_BYTES,
  DEFAULT_JEV_MODEL,
  DEFAULT_VOYAGE_API_URL,
  JEV_API_PATH,
  JEV_PART_SEPARATOR,
  WORKER_POLICY_VERSION,
  type JevAnswer,
  type JevChoiceQuestion,
  type JevRequest,
} from '../contract.js';

// M3の0002_m3.sqlが作るテーブル。未実装の間はassertでRed理由を明示する。
export const M3_TABLES = ['message_analysis', 'message_relations', 'provider_policy_approvals', 'usage_events'] as const;

export async function assertM3Tables(pool: Pool): Promise<void> {
  const result = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  const names = new Set(result.rows.map((row) => row.table_name));
  for (const table of M3_TABLES) {
    assert.ok(names.has(table), `0002_m3.sqlの必須テーブル ${table} がない`);
  }
}

// 合成fixtureのloopback endpointを使い、実APIキーなしでworkerの結合挙動を検証する。
export function buildWorkerConfig(baseUrl: string, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    apiUrl: `${baseUrl}${JEV_API_PATH}`,
    apiKey: 'test-key',
    accountRef: 'acct-a',
    model: DEFAULT_JEV_MODEL,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    inputBudgetBytes: DEFAULT_INPUT_BUDGET_BYTES,
    requestTimeoutMs: 2_000,
    voyageApiUrl: DEFAULT_VOYAGE_API_URL,
    voyageApiKey: 'test-voyage-key',
    voyageAccountRef: 'voyage-acct-a',
    voyageRequestTimeoutMs: 2_000,
    ...overrides,
  };
}

export interface FakeJevReply {
  status?: number;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
}

export interface RecordedJevRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  rawBody: string;
  body: JevRequest;
}

export interface FakeJevServer {
  baseUrl: string;
  requests: RecordedJevRequest[];
  close(): Promise<void>;
}

// 受信bodyをそのまま記録し、responderの応答を返すloopback HTTP fixture。
export async function startFakeJev(
  responder: (request: JevRequest, rawBody: string) => FakeJevReply | Promise<FakeJevReply>,
): Promise<FakeJevServer> {
  const requests: RecordedJevRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: JevRequest;
      try {
        body = JSON.parse(rawBody) as JevRequest;
      } catch {
        body = {} as JevRequest;
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, rawBody, body });
      const reply = await responder(body, rawBody);
      if (reply.delayMs !== undefined) {
        await sleep(reply.delayMs);
      }
      res.statusCode = reply.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(reply.rawBody ?? JSON.stringify(reply.body ?? {}));
    })().catch(() => {
      res.destroy();
    });
    req.on('error', () => undefined);
    res.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

// 合成fixtureを起動し、そのendpointに一致する承認を保存してから返す。
export async function startApprovedJev(
  pool: Pool,
  companyId: string,
  responder: (request: JevRequest, rawBody: string) => FakeJevReply | Promise<FakeJevReply>,
): Promise<FakeJevServer> {
  const server = await startFakeJev(responder);
  try {
    await seedApproval(pool, { companyId, endpoint: `${server.baseUrl}${JEV_API_PATH}` });
  } catch (error) {
    // 承認seed失敗時にfixtureのHTTP serverを残すと、Red確認のtest processが終了しない。
    await server.close();
    throw error;
  }
  return server;
}

export function questionField(questionId: string): string {
  return questionId.split(JEV_PART_SEPARATOR)[0] ?? questionId;
}

export function questionPartIndex(questionId: string): number | null {
  const parts = questionId.split(JEV_PART_SEPARATOR);
  return parts.length > 1 ? Number(parts[1]) : null;
}

export interface ChoiceSelection {
  choice: string;
  confidence?: number;
}

// 送信bodyのQuestionはIDを持たないため、fixtureのselectorにはmap keyをidとして渡す。
export type JevQuestionWithId = JevChoiceQuestion & { id: string };

export type JevChoiceSelector = (question: JevQuestionWithId, request: JevRequest) => string | ChoiceSelection | undefined;

// 前のselectorがundefinedを返した質問だけ次のselectorで決める。
export function mergeChoices(...selectors: JevChoiceSelector[]): JevChoiceSelector {
  return (question, request) => {
    for (const select of selectors) {
      const selection = select(question, request);
      if (selection !== undefined) {
        return selection;
      }
    }
    return undefined;
  };
}

// field単位の既定回答。technical_labelはno、relation_targetはnone、same_conditionsはunknownにする。
export function jevChoices(overrides: Record<string, string | ChoiceSelection> = {}): JevChoiceSelector {
  return (question) => {
    const field = questionField(question.id);
    const exact = overrides[question.id];
    if (exact !== undefined) {
      return exact;
    }
    const byField = overrides[field];
    if (byField !== undefined) {
      return byField;
    }
    if (field.startsWith('technical_label')) {
      return 'no';
    }
    if (field === 'relation_target') {
      return 'none';
    }
    if (field === 'same_conditions') {
      return 'unknown';
    }
    return undefined;
  };
}

// 全質問へchoice/probabilities/confidenceを返す正常なJev応答を作る。
export function jevReply(
  request: JevRequest,
  select: JevChoiceSelector,
): { model: string; answers: Record<string, JevAnswer>; usage: { input_tokens: number | null; output_tokens: number | null } } {
  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const selected = select({ ...question, id }, request);
    const choice = typeof selected === 'string' ? selected : selected?.choice;
    const confidence = typeof selected === 'object' ? selected.confidence ?? 0.95 : 0.95;
    const criteriaKeys = Object.keys(question.criteria);
    const resolvedChoice = choice ?? criteriaKeys[0];
    assert.ok(resolvedChoice !== undefined, `criteriaが空の質問: ${id}`);
    const probabilities: Record<string, number> = {};
    for (const key of criteriaKeys) {
      probabilities[key] = key === resolvedChoice ? 0.95 : 0.05 / Math.max(1, criteriaKeys.length - 1);
    }
    answers[id] = { type: 'choice', choice: resolvedChoice, probabilities, confidence };
  }
  return { model: request.model, answers, usage: { input_tokens: 120, output_tokens: 40 } };
}

export async function seedSession(
  pool: Pool,
  workspace: WorkspaceFixture,
  overrides: { sourceSessionId?: string; source?: 'codex' | 'claude_code' } = {},
): Promise<string> {
  return insertSession(pool, {
    projectId: workspace.projectId,
    employeeId: workspace.employeeId,
    ...overrides,
  });
}

export async function seedMessage(
  pool: Pool,
  input: { sessionId: string; sequenceNo: number; role?: 'user' | 'assistant' | 'agent_report'; text?: string; occurredAt?: Date },
): Promise<{ messageId: string; revision: number }> {
  return insertMessage(pool, {
    sessionId: input.sessionId,
    sourceMessageId: `msg-${uuidv7()}`,
    sequenceNo: input.sequenceNo,
    role: input.role,
    text: input.text,
    occurredAt: input.occurredAt,
  });
}

export interface SeededUserMessage {
  sessionId: string;
  messageId: string;
  revision: number;
  classifyJobId: string;
  routeJobId: string;
  searchRequestId: string;
}

// user発言・classify/route job・自動検索受付を、イベント受付と同じ関係で保存する。
export async function seedUserMessage(
  pool: Pool,
  input: { workspace: WorkspaceFixture; sessionId: string; sequenceNo: number; text: string; occurredAt?: Date },
): Promise<SeededUserMessage> {
  const message = await seedMessage(pool, {
    sessionId: input.sessionId,
    sequenceNo: input.sequenceNo,
    role: 'user',
    text: input.text,
    occurredAt: input.occurredAt,
  });
  const jobs = await enqueueWorkerJobs(pool, { sessionId: input.sessionId, messageId: message.messageId, revision: message.revision });
  const searchRequestId = await seedSearchRequest(pool, {
    workspace: input.workspace,
    sessionId: input.sessionId,
    inputId: message.messageId,
    inputRevision: message.revision,
    sequenceNo: input.sequenceNo,
  });
  return { sessionId: input.sessionId, ...message, ...jobs, searchRequestId };
}

export async function enqueueWorkerJobs(
  pool: Pool,
  input: { sessionId: string; messageId: string; revision: number },
): Promise<{ classifyJobId: string; routeJobId: string }> {
  const classifyJobId = await enqueueJob(pool, {
    kind: 'classify_message',
    idempotencyKey: `classify_message:${input.messageId}:${input.revision}:${WORKER_POLICY_VERSION}`,
    priority: CLASSIFY_MESSAGE_PRIORITY,
    sessionId: input.sessionId,
    messageId: input.messageId,
    targetRevision: input.revision,
  });
  const routeJobId = await enqueueJob(pool, {
    kind: 'route_search',
    idempotencyKey: `route_search:${input.messageId}:${input.revision}:${WORKER_POLICY_VERSION}`,
    priority: ROUTE_SEARCH_PRIORITY,
    sessionId: input.sessionId,
    messageId: input.messageId,
    targetRevision: input.revision,
  });
  // host時計とDB時計のskewで直後のclaimが未到来扱いになるのを避け、DB時刻へ揃える。
  await pool.query('UPDATE jobs SET next_run_at = LEAST(next_run_at, now()) WHERE id = ANY($1::uuid[])', [
    [classifyJobId, routeJobId],
  ]);
  return { classifyJobId, routeJobId };
}

export interface SearchRequestSeed {
  workspace: WorkspaceFixture;
  sessionId: string;
  inputId: string;
  inputRevision?: number;
  sequenceNo: number;
  trigger?: 'auto' | 'manual';
  status?: string;
  outcome?: string | null;
  searchAction?: string | null;
  policyVersion?: string;
  question?: string;
  reusedFromRequestId?: string | null;
  result?: unknown;
  createdAt?: Date;
  expiresAt?: Date | null;
}

export async function seedSearchRequest(pool: Pool, input: SearchRequestSeed): Promise<string> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO search_requests
       (id, company_id, project_id, employee_id, session_id, input_id, input_revision, input_sequence_no, trigger,
        status, outcome, search_action, policy_version, question, reused_from_request_id, result, created_at, updated_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $17, $18)`,
    [
      id,
      input.workspace.companyId,
      input.workspace.projectId,
      input.workspace.employeeId,
      input.sessionId,
      input.inputId,
      input.inputRevision ?? 1,
      input.sequenceNo,
      input.trigger ?? 'auto',
      input.status ?? 'pending',
      input.outcome ?? null,
      input.searchAction ?? null,
      input.policyVersion ?? WORKER_POLICY_VERSION,
      input.question ?? null,
      input.reusedFromRequestId ?? null,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.createdAt ?? new Date(),
      input.expiresAt ?? null,
    ],
  );
  return id;
}

export interface StoredSearchRequest {
  id: string;
  status: string;
  outcome: string | null;
  search_action: string | null;
  error_code: string | null;
  reused_from_request_id: string | null;
  result: unknown;
}

export async function readSearchRequest(pool: Pool, requestId: string): Promise<StoredSearchRequest> {
  const result = await pool.query<StoredSearchRequest>(
    `SELECT id, status, outcome, search_action, error_code, reused_from_request_id, result
       FROM search_requests WHERE id = $1`,
    [requestId],
  );
  const row = result.rows[0];
  assert.ok(row, `search_request ${requestId} がない`);
  return row;
}

export interface EvidenceSeed {
  messageId: string;
  revision: number;
  employeeId: string;
  role: string;
  occurredAt: string;
  text: string;
}

// 10.3節のmatched結果を合成する。再利用可否はworker側がevidenceを検証する。
export function matchedResult(evidence: EvidenceSeed[]): unknown {
  return {
    request_id: uuidv7(),
    input_id: uuidv7(),
    input_revision: 1,
    trigger: 'auto',
    search_action: 'new_search',
    reused_from_request_id: null,
    status: 'completed',
    outcome: 'matched',
    project_id: uuidv7(),
    index_status: { pending_documents: 0, failed_documents: 0, embedding_generation_id: uuidv7(), search_mode: 'exact_vector_and_entity' },
    matches: [
      {
        case_or_document_id: uuidv7(),
        relevance_kind: ['similar_symptom'],
        claim_status: 'agent_reported',
        evidence: evidence.map((item) => ({
          message_id: item.messageId,
          revision: item.revision,
          employee_id: item.employeeId,
          role: item.role,
          occurred_at: item.occurredAt,
          text: item.text,
        })),
        related_evidence_ids: [],
        truncated: false,
      },
    ],
    warnings: [],
  };
}

export interface StoredAnalysisPart {
  offset: number;
  length: number;
  text?: string;
  retention?: string;
  model_version?: string;
}

export interface StoredAnalysis {
  retention: string;
  primary_intent: string;
  technical_labels: string[];
  decision_action: string;
  continuity: string;
  statement_status: string;
  is_searchable: boolean;
  policy_version: string;
  model_version: string;
  state_hash: Buffer;
  parts: StoredAnalysisPart[];
}

export async function readAnalysis(pool: Pool, messageId: string, revision: number): Promise<StoredAnalysis | undefined> {
  await assertM3Tables(pool);
  const result = await pool.query<StoredAnalysis>(
    `SELECT retention, primary_intent, technical_labels, decision_action, continuity, statement_status,
            is_searchable, policy_version, model_version, state_hash, parts
       FROM message_analysis WHERE message_id = $1 AND revision = $2 AND policy_version = $3`,
    [messageId, revision, WORKER_POLICY_VERSION],
  );
  return result.rows[0];
}

export async function countAnalysis(pool: Pool, messageId?: string): Promise<number> {
  await assertM3Tables(pool);
  const result = messageId
    ? await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM message_analysis WHERE message_id = $1', [messageId])
    : await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM message_analysis');
  return Number(result.rows[0]?.count ?? '0');
}

export interface StoredRelation {
  source_message_id: string;
  source_revision: number;
  target_message_id: string;
  target_revision: number;
  relation: string;
  is_explicit: boolean;
  policy_version: string;
}

export async function readRelations(pool: Pool, sourceMessageId: string, sourceRevision: number): Promise<StoredRelation[]> {
  await assertM3Tables(pool);
  const result = await pool.query<StoredRelation>(
    `SELECT source_message_id, source_revision, target_message_id, target_revision, relation, is_explicit, policy_version
       FROM message_relations WHERE source_message_id = $1 AND source_revision = $2`,
    [sourceMessageId, sourceRevision],
  );
  return result.rows;
}

export async function seedRelation(
  pool: Pool,
  input: {
    sourceMessageId: string;
    sourceRevision: number;
    targetMessageId: string;
    targetRevision: number;
    relation: string;
  },
): Promise<void> {
  await assertM3Tables(pool);
  await pool.query(
    `INSERT INTO message_relations
       (id, source_message_id, source_revision, target_message_id, target_revision, relation, is_explicit, policy_version, evidence_ranges)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7, '[]'::jsonb)`,
    [uuidv7(), input.sourceMessageId, input.sourceRevision, input.targetMessageId, input.targetRevision, input.relation, WORKER_POLICY_VERSION],
  );
}

export interface ApprovalSeed {
  companyId: string;
  endpoint: string;
  accountRef?: string;
  provider?: string;
  active?: boolean;
  // nullは規約確認日が未設定（送信不可）を表す。
  termsCheckedAt?: Date | null;
}

export async function seedApproval(pool: Pool, input: ApprovalSeed): Promise<string> {
  await assertM3Tables(pool);
  const id = uuidv7();
  await pool.query(
    `INSERT INTO provider_policy_approvals
       (id, company_id, provider, account_ref, endpoint, terms_url, terms_checked_at, learning_disabled, retention_terms, confirmed_by, confirmed_at, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      input.companyId,
      input.provider ?? 'jev',
      input.accountRef ?? 'acct-a',
      input.endpoint,
      'https://typesafe.ai/legal/mca',
      input.termsCheckedAt === undefined ? new Date() : input.termsCheckedAt,
      true,
      'retention-terms',
      'admin-a',
      new Date(),
      input.active ?? true,
    ],
  );
  return id;
}

// usage_eventsの全列をJSON化し、原文が混入していないか行単位で確認できるようにする。
export async function usageEventRows(pool: Pool, companyId: string): Promise<string[]> {
  await assertM3Tables(pool);
  const result = await pool.query<{ row_text: string }>(
    'SELECT to_jsonb(u)::text AS row_text FROM usage_events u WHERE company_id = $1',
    [companyId],
  );
  return result.rows.map((row) => row.row_text);
}

export interface StoredUsageEvent {
  operation: string;
  model: string;
  response_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  success: boolean;
  error_code: string | null;
}

// 試行ごとのusageを古い順に読み、要求modelと実応答modelの区別を検証できるようにする。
export async function readUsageEvents(pool: Pool, companyId: string): Promise<StoredUsageEvent[]> {
  await assertM3Tables(pool);
  const result = await pool.query<StoredUsageEvent>(
    `SELECT operation, model, response_model, input_tokens, output_tokens, success, error_code
       FROM usage_events WHERE company_id = $1 ORDER BY created_at, id`,
    [companyId],
  );
  return result.rows;
}

export interface StoredEvaluation {
  model: string;
  response_model: string | null;
  answers: Record<string, unknown>;
  state_hash: Buffer;
}

// 評価キャッシュを読み、要求model・実応答model・state hashの対応を検証できるようにする。
export async function readEvaluations(pool: Pool, companyId: string): Promise<StoredEvaluation[]> {
  await assertM3Tables(pool);
  const result = await pool.query<StoredEvaluation>(
    `SELECT model, response_model, answers, state_hash
       FROM jev_evaluations WHERE company_id = $1 ORDER BY created_at, id`,
    [companyId],
  );
  return result.rows;
}

export async function advanceRevision(pool: Pool, messageId: string, text: string): Promise<number> {
  const current = await pool.query<{ current_revision: number }>('SELECT current_revision FROM messages WHERE id = $1', [messageId]);
  const next = (current.rows[0]?.current_revision ?? 0) + 1;
  await pool.query('INSERT INTO message_revisions (message_id, revision, text, content_hash) VALUES ($1, $2, $3, $4)', [
    messageId,
    next,
    text,
    sha256Bytes(text),
  ]);
  await pool.query('UPDATE messages SET current_revision = $2, updated_at = now() WHERE id = $1', [messageId, next]);
  return next;
}

export async function readRevision(pool: Pool, messageId: string, revision: number): Promise<{ text: string } | undefined> {
  const result = await pool.query<{ text: string }>('SELECT text FROM message_revisions WHERE message_id = $1 AND revision = $2', [
    messageId,
    revision,
  ]);
  return result.rows[0];
}

export interface StoredJob {
  status: string;
  error_code: string | null;
  next_run_at: Date;
  attempts: number;
}

export async function readJob(pool: Pool, jobId: string): Promise<StoredJob> {
  const result = await pool.query<StoredJob>('SELECT status, error_code, next_run_at, attempts FROM jobs WHERE id = $1', [jobId]);
  const row = result.rows[0];
  assert.ok(row, `job ${jobId} がない`);
  return row;
}

export async function setJobStatus(pool: Pool, jobId: string, status: string): Promise<void> {
  await pool.query('UPDATE jobs SET status = $2, updated_at = now() WHERE id = $1', [jobId, status]);
}

export async function countJobsByKind(pool: Pool, kind: string): Promise<number> {
  const result = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM jobs WHERE kind = $1', [kind]);
  return Number(result.rows[0]?.count ?? '0');
}

export async function claimJobForMessage(pool: Pool, kind: JobKind, messageId: string): Promise<ClaimedJob> {
  const [job] = await claimJobs(pool, { kinds: [kind], limit: 1 });
  assert.ok(job, `${kind} jobをclaimできない: message=${messageId}`);
  assert.equal(job.messageId, messageId, `${kind} jobの対象messageが違う: ${String(job.messageId)}`);
  return job;
}

export function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

export function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ES2023 libでも使えるwell-formed判定。単独サロゲートを含む場合だけtrueにする。
export function isWellFormedText(value: string): boolean {
  return !/[\uD800-\uDFFF]/u.test(value);
}
