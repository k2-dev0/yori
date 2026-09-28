import { z } from 'zod';
import {
  MAX_REVISION,
  MAX_WAIT_MS,
  collectorSetupRequestSchema,
  eventsRequestSchema,
  normalizedUuid,
  revisionSchema,
  searchByInputBranchSchemas,
  searchRequestSchema,
  sessionLinkRequestSchema,
  waitMsValueSchema,
} from './schema.js';
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

// yori HTTP APIのOpenAPI 3.1文書を、実行時契約のZod schemaから決定的に生成する。
// 公開endpointやSwagger UIは追加せず、生成物openapi.jsonをrepositoryへ追跡する。

const OPENAPI_VERSION = '3.1.0';
const API_CONTRACT_VERSION = '1.0.0';

type JsonObject = Record<string, unknown>;

// Zod v4のJSON Schema変換をOpenAPI 3.1のcomponentとして使う。$schemaはOpenAPI document内では不要なため除く。
function toOpenApiSchema(schema: z.ZodType, io: 'input' | 'output'): JsonObject {
  const converted = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as JsonObject;
  delete converted.$schema;
  return converted;
}

function componentRef(name: string): JsonObject {
  return { $ref: `#/components/schemas/${name}` };
}

interface OperationInput {
  operationId: string;
  summary: string;
  description?: string;
  secured: boolean;
  extensions?: JsonObject;
  parameters?: JsonObject[];
  requestComponent?: string;
  responses: Array<{ status: string; component: string }>;
}

// 1 operationをOpenAPI shapeへ変換する。応答は全てapplication/jsonのcomponent参照にする。
function buildOperation(input: OperationInput): JsonObject {
  const responses: JsonObject = {};
  for (const response of input.responses) {
    responses[response.status] = {
      description: response.status.startsWith('2') ? '成功応答' : 'エラー応答',
      content: { 'application/json': { schema: componentRef(response.component) } },
    };
  }
  return {
    operationId: input.operationId,
    summary: input.summary,
    ...(input.description === undefined ? {} : { description: input.description }),
    security: input.secured ? [{ bearerAuth: [] }] : [],
    parameters: input.parameters ?? [],
    ...(input.extensions ?? {}),
    ...(input.requestComponent === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: componentRef(input.requestComponent) } },
          },
        }),
    responses,
  };
}

function parameter(name: string, location: 'path' | 'query', required: boolean, schema: JsonObject): JsonObject {
  return { name, in: location, required, schema };
}

function requiredNamesOf(schema: JsonObject): string[] {
  const required = schema.required;
  return Array.isArray(required) ? required.filter((value): value is string => typeof value === 'string') : [];
}

function propertySchemasOf(schema: JsonObject): Record<string, JsonObject> {
  const properties = schema.properties;
  return typeof properties === 'object' && properties !== null ? (properties as Record<string, JsonObject>) : {};
}

// 9 routeを計画4節のmethod・path・statusで固定する。実装が返さないstatusは追加しない。
function buildPaths(): JsonObject {
  const uuid = toOpenApiSchema(normalizedUuid, 'input');
  // query parameterはwireが文字列でも、意味上のschemaは整数の範囲として表す。
  const revision = toOpenApiSchema(
    revisionSchema.meta({ description: `1〜${MAX_REVISION}の整数をquery文字列として送る` }),
    'input',
  );
  const waitMs = toOpenApiSchema(
    waitMsValueSchema.meta({ description: `0〜${MAX_WAIT_MS}の整数をquery文字列として送る` }),
    'input',
  );

  // by-inputのparameter一覧と排他branchはZod schemaから生成し、flatなparameterとx-yori拡張を同じ定義から作る。
  const byInputBranches = Object.entries(searchByInputBranchSchemas).map(([name, schema]) => {
    const converted = toOpenApiSchema(schema, 'input');
    const properties = propertySchemasOf(converted);
    const required = requiredNamesOf(converted);
    return {
      name,
      required,
      optional: Object.keys(properties).filter((property) => !required.includes(property)),
      properties,
    };
  });
  const byInputParameters = new Map<string, JsonObject>();
  for (const branch of byInputBranches) {
    for (const [name, schema] of Object.entries(branch.properties)) {
      if (!byInputParameters.has(name)) {
        byInputParameters.set(name, schema);
      }
    }
  }
  byInputParameters.set('wait_ms', waitMs);
  byInputParameters.set('input_revision', revision);
  byInputParameters.set('revision', revision);
  const errorResponses = (statuses: string[]): Array<{ status: string; component: string }> =>
    statuses.map((status) => ({ status, component: 'ErrorResponse' }));
  const success = (status: string, component: string) => ({ status, component });

  return {
    '/health/live': {
      get: buildOperation({
        operationId: 'getHealthLive',
        summary: 'APIプロセスの生存を返す',
        secured: false,
        responses: [success('200', 'HealthLiveResponse'), ...errorResponses(['500'])],
      }),
    },
    '/health/ready': {
      get: buildOperation({
        operationId: 'getHealthReady',
        summary: 'DB依存を含む受付可否を返す',
        secured: false,
        responses: [success('200', 'HealthReadyResponse'), success('503', 'HealthReadyResponse')],
      }),
    },
    '/v1/events': {
      post: buildOperation({
        operationId: 'createEvents',
        summary: '会話イベントを受理し、検索受付を同一TXで作る',
        secured: true,
        requestComponent: 'EventsRequest',
        responses: [success('202', 'EventsResponse'), ...errorResponses(['400', '401', '403', '409', '413', '500'])],
      }),
    },
    '/v1/searches': {
      post: buildOperation({
        operationId: 'createSearch',
        summary: '明示検索を受付または既存受付の再利用で開始する',
        secured: true,
        requestComponent: 'SearchRequest',
        responses: [success('200', 'SearchAcceptedResponse'), success('202', 'SearchAcceptedResponse'), ...errorResponses(['400', '401', '403', '404', '409', '413', '500'])],
      }),
    },
    '/v1/collector/setup': {
      post: buildOperation({
        operationId: 'createCollectorSetup',
        summary: 'canonical repositoryからmember projectとcurrent redaction policyを返す',
        secured: true,
        requestComponent: 'CollectorSetupRequest',
        responses: [success('200', 'CollectorSetupResponse'), ...errorResponses(['400', '401', '404', '500'])],
      }),
    },
    '/v1/session-links': {
      post: buildOperation({
        operationId: 'createSessionLink',
        summary: '明示的なsession引き継ぎを根拠発言付きで登録する',
        secured: true,
        requestComponent: 'SessionLinkRequest',
        responses: [success('200', 'SessionLinkResponse'), success('201', 'SessionLinkResponse'), ...errorResponses(['400', '401', '403', '404', '409', '413', '500'])],
      }),
    },
    '/v1/searches/by-input': {
      get: buildOperation({
        operationId: 'lookupSearchByInput',
        summary: '現在入力identityの自動検索受付を照合する',
        description: `project_idに加え、${byInputBranches
          .map((branch) => `${branch.name}（${branch.required.join(' + ')}）`)
          .join('または')}のどちらか一方だけを指定する。wait_msは任意。`,
        secured: true,
        extensions: {
          'x-yori-input-branches': byInputBranches.map(({ name, required, optional }) => ({ name, required, optional })),
        },
        parameters: [...byInputParameters.entries()].map(([name, schema]) =>
          parameter(name, 'query', name === 'project_id', schema),
        ),
        responses: [success('200', 'SearchLookupResponse'), ...errorResponses(['400', '401', '403', '500'])],
      }),
    },
    '/v1/searches/{id}': {
      get: buildOperation({
        operationId: 'getSearchById',
        summary: 'request IDの検索受付状態と結果を返す',
        secured: true,
        parameters: [
          parameter('id', 'path', true, uuid),
          parameter('wait_ms', 'query', false, waitMs),
        ],
        responses: [success('200', 'SearchViewResponse'), ...errorResponses(['400', '401', '404', '500'])],
      }),
    },
    '/v1/evidence/{message_id}': {
      get: buildOperation({
        operationId: 'getEvidence',
        summary: '保存済みrevisionの原文を返す',
        secured: true,
        parameters: [
          parameter('message_id', 'path', true, uuid),
          parameter('project_id', 'query', true, uuid),
          parameter('revision', 'query', true, revision),
        ],
        responses: [success('200', 'EvidenceResponse'), ...errorResponses(['400', '401', '403', '404', '500'])],
      }),
    },
  };
}

export function buildOpenApiDocument(): JsonObject {
  const componentSchemas: JsonObject = {
    EventsRequest: toOpenApiSchema(eventsRequestSchema, 'input'),
    CollectorSetupRequest: toOpenApiSchema(collectorSetupRequestSchema, 'input'),
    SearchRequest: toOpenApiSchema(searchRequestSchema, 'input'),
    SessionLinkRequest: toOpenApiSchema(sessionLinkRequestSchema, 'input'),
    HealthLiveResponse: toOpenApiSchema(healthLiveResponseSchema, 'output'),
    HealthReadyResponse: toOpenApiSchema(healthReadyResponseSchema, 'output'),
    ErrorResponse: toOpenApiSchema(errorResponseSchema, 'output'),
    EventsResponse: toOpenApiSchema(eventsResponseSchema, 'output'),
    CollectorSetupResponse: toOpenApiSchema(collectorSetupResponseSchema, 'output'),
    SearchAcceptedResponse: toOpenApiSchema(searchAcceptedResponseSchema, 'output'),
    SearchViewResponse: toOpenApiSchema(searchViewResponseSchema, 'output'),
    SearchLookupResponse: toOpenApiSchema(searchLookupResponseSchema, 'output'),
    EvidenceResponse: toOpenApiSchema(evidenceResponseSchema, 'output'),
    SessionLinkResponse: toOpenApiSchema(sessionLinkResponseSchema, 'output'),
  };
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'yori API',
      version: API_CONTRACT_VERSION,
      description: '保存済み会話の共有検索基盤。入力・出力の実行時契約はZod schemaを正本とする。',
    },
    servers: [{ url: '/' }],
    security: [],
    paths: buildPaths(),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'AuthorizationヘッダーのBearer認証',
        },
      },
      schemas: componentSchemas,
    },
  };
}

// openapi.jsonへ書き出すbytes。決定的なJSON整形（2 space、末尾改行）を固定する。
export function generateOpenApiJson(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
