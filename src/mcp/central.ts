import { z } from 'zod';
import {
  byInputSearchLookupOutputSchema,
  evidenceResponseOutputSchema,
  getEvidenceInputSchema,
  getSearchResultInputSchema,
  linkSessionInputSchema,
  linkSessionOutputSchema,
  recordCaseOutputSchema,
  requestIdSearchViewOutputSchema,
  searchAcceptedOutputSchema,
  searchHistoryInputSchema,
} from './schema.js';

// 中央HTTP APIの呼出し。tokenはAuthorizationだけに載せ、応答bodyや外部error bodyをtool結果・ログへ出さない。
export class CentralApiError extends Error {}

// 応答schemaは./schema.tsの出力契約を正本にし、loose validationで追加fieldを保持する。

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

// tool入力の型は./schema.tsのZod schemaから推論し、handler引数とcentral clientの要求を一致させる。
export type SearchHistoryInput = z.infer<typeof searchHistoryInputSchema> & { project_id: string };
export type GetSearchResultInput = z.infer<typeof getSearchResultInputSchema> & { project_id: string };
export type GetEvidenceInput = z.infer<typeof getEvidenceInputSchema> & { project_id: string };
export type LinkSessionInput = z.infer<typeof linkSessionInputSchema> & { project_id: string };

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
    return parseResponse(searchAcceptedOutputSchema, await this.request('POST', '/v1/searches', input));
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
      // request_id branchはlookup_statusなしviewだけを受理する。
      const view = parseResponse(requestIdSearchViewOutputSchema, await this.request('GET', path));
      // request_id branchはproject_idをqueryへ送れないため、応答側の案件identityを入力と照合する。
      // 両案件memberでも別案件の受付を返さない。
      if (view.project_id.toLowerCase() !== input.project_id.toLowerCase()) {
        throw new CentralApiError('中央APIの応答project_idが入力と一致しません');
      }
      return view;
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
    // by-input branchはfoundの完全viewかnot_receivedだけを受理する。
    return parseResponse(byInputSearchLookupOutputSchema, await this.request('GET', `/v1/searches/by-input?${params.toString()}`));
  }

  async getEvidence(input: GetEvidenceInput): Promise<unknown> {
    const params = new URLSearchParams({ project_id: input.project_id, revision: String(input.revision) });
    return parseResponse(evidenceResponseOutputSchema, await this.request('GET', `/v1/evidence/${input.message_id}?${params.toString()}`));
  }

  async linkSession(input: LinkSessionInput): Promise<unknown> {
    const response = parseResponse(linkSessionOutputSchema, await this.request('POST', '/v1/session-links', input));
    // 応答schemaだけでなく、要求した案件のlinkが返ったことを照合する。
    if (response.project_id.toLowerCase() !== input.project_id.toLowerCase()) {
      throw new CentralApiError('中央APIの応答project_idが入力と一致しません');
    }
    return response;
  }

  async recordCase(projectId: string, event: RecordCaseEvent): Promise<unknown> {
    const response = parseResponse(
      recordCaseOutputSchema,
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
