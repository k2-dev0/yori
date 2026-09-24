import { z } from 'zod';

// 中央HTTP APIの呼出し。tokenはAuthorizationだけに載せ、応答bodyや外部error bodyをtool結果・ログへ出さない。
export class CentralApiError extends Error {}

// 各toolが要求する最小の応答schema。未知fieldは保持したまま、identityと必須fieldだけを検証する。
const searchHistoryResponseSchema = z.looseObject({ request_id: z.uuid() });

const notReceivedResponseSchema = z.looseObject({ lookup_status: z.literal('not_received') });

const searchViewResponseSchema = z.looseObject({
  request_id: z.uuid(),
  input_id: z.uuid(),
  input_revision: z.int().min(1),
  trigger: z.string(),
  status: z.string(),
  outcome: z.string().nullable(),
  project_id: z.uuid(),
});

const searchResultResponseSchema = z.union([notReceivedResponseSchema, searchViewResponseSchema]);

const evidenceResponseSchema = z.looseObject({
  message_id: z.uuid(),
  revision: z.int().min(1),
  employee_id: z.uuid(),
  role: z.string(),
  occurred_at: z.string(),
  text: z.string(),
});

const eventsResponseSchema = z.looseObject({
  results: z
    .array(
      z.looseObject({
        idempotency_key: z.string().min(1).max(512),
        message_id: z.uuid(),
        revision: z.int().min(1),
        request_id: z.uuid().nullable(),
      }),
    )
    .min(1),
});

function parseResponse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CentralApiError('中央APIの応答が不正です');
  }
  return parsed.data;
}

interface CentralApiOptions {
  apiUrl: string;
  token: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export interface SearchHistoryInput {
  project_id: string;
  input_id: string;
  input_revision: number;
  query: string;
  idempotency_key: string;
  force_refresh: boolean;
}

export interface GetSearchResultInput {
  project_id: string;
  request_id?: string;
  wait_ms?: number;
  input_id?: string;
  input_revision?: number;
  source?: string;
  source_scope?: string;
  source_session_id?: string;
  source_message_id?: string;
  revision?: number;
}

export interface GetEvidenceInput {
  project_id: string;
  message_id: string;
  revision: number;
}

export interface RecordCaseEvent {
  idempotency_key: string;
  source: string;
  source_scope: string;
  source_session_id: string;
  source_message_id: string;
  sequence_no: number;
  revision: number;
  occurred_at: string;
  role: 'agent_report';
  text: string;
}

export class CentralApiClient {
  constructor(private readonly options: CentralApiOptions) {}

  async searchHistory(input: SearchHistoryInput): Promise<unknown> {
    return parseResponse(searchHistoryResponseSchema, await this.request('POST', '/v1/searches', input));
  }

  async getSearchResult(input: GetSearchResultInput): Promise<unknown> {
    if (input.request_id !== undefined) {
      // GET /v1/searches/:idのqueryはwait_msだけ。project_idはAPIのstrict schemaが拒否するため送らない。
      const params = new URLSearchParams();
      if (input.wait_ms !== undefined) {
        params.set('wait_ms', String(input.wait_ms));
      }
      const query = params.toString();
      const path = `/v1/searches/${input.request_id}${query === '' ? '' : `?${query}`}`;
      return parseResponse(searchResultResponseSchema, await this.request('GET', path));
    }
    const params = new URLSearchParams({ project_id: input.project_id });
    if (input.wait_ms !== undefined) {
      params.set('wait_ms', String(input.wait_ms));
    }
    if (input.input_id !== undefined && input.input_revision !== undefined) {
      params.set('input_id', input.input_id);
      params.set('input_revision', String(input.input_revision));
    } else {
      params.set('source', input.source ?? '');
      params.set('source_scope', input.source_scope ?? '');
      params.set('source_session_id', input.source_session_id ?? '');
      params.set('source_message_id', input.source_message_id ?? '');
      params.set('revision', String(input.revision ?? 0));
    }
    return parseResponse(searchResultResponseSchema, await this.request('GET', `/v1/searches/by-input?${params.toString()}`));
  }

  async getEvidence(input: GetEvidenceInput): Promise<unknown> {
    const params = new URLSearchParams({ project_id: input.project_id, revision: String(input.revision) });
    return parseResponse(evidenceResponseSchema, await this.request('GET', `/v1/evidence/${input.message_id}?${params.toString()}`));
  }

  async recordCase(projectId: string, event: RecordCaseEvent): Promise<unknown> {
    const response = parseResponse(
      eventsResponseSchema,
      await this.request('POST', '/v1/events', { project_id: projectId, events: [event] }),
    );
    // 既存events APIの冪等identity確認と同じ責務。要求eventと一致しない応答を成功扱いしない。
    if (response.results.length !== 1 || response.results[0].idempotency_key !== event.idempotency_key) {
      throw new CentralApiError('中央APIの応答が要求eventと一致しません');
    }
    return response;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.options.apiUrl), {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      throw new CentralApiError('中央APIへ接続できません');
    }
    if (!response.ok) {
      throw new CentralApiError(`中央APIが失敗しました (HTTP ${response.status})`);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new CentralApiError('中央APIの応答が不正です');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new CentralApiError('中央APIの応答が不正です');
    }
    return parsed;
  }
}
