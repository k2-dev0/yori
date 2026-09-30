import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_BATCH_SIZE, MAX_SOURCE_IDENTIFIER_BYTES, MAX_TEXT_LENGTH } from '../contract.js';
import { MAX_REVISION, MAX_WAIT_MS } from '../schema.js';

// API契約実装計画の採用シナリオ1・2・6をHTTP公開境界の外から確認するRedテスト。
// 実装される契約:
// - src/api/openapi.ts が generateOpenApiJson(): string をexportし、既存Zod契約から決定的なOpenAPI 3.1を生成する
// - repository直下のopenapi.jsonは同じbytesを追跡し、再生成結果とのbyte driftをtestで検出する
// - 生成・versioning・互換性規則はdocs/api-contract.mdへ文書化する
// OpenAPI generatorは未実装のため、loadGenerator()が生成契約の欠落を明示して各itがRedになる。

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OPENAPI_PATH = path.join(REPO_ROOT, 'openapi.json');
const API_CONTRACT_DOCS_PATH = path.join(REPO_ROOT, 'docs/api-contract.md');
const OPENAPI_MODULE_URL = new URL('../openapi.ts', import.meta.url).href;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

interface OpenApiSchema {
  [key: string]: unknown;
  $ref?: unknown;
  type?: unknown;
  properties?: Record<string, OpenApiSchema>;
  items?: unknown;
  required?: unknown;
  maxItems?: unknown;
  maxLength?: unknown;
  additionalProperties?: unknown;
  anyOf?: unknown[];
  oneOf?: unknown[];
  enum?: unknown[];
  const?: unknown;
}

interface OpenApiParameter {
  name?: unknown;
  in?: unknown;
  required?: unknown;
  schema?: unknown;
}

interface OpenApiPathItem {
  [key: string]: unknown;
  parameters?: OpenApiParameter[];
  security?: Array<Record<string, unknown>>;
}

interface OpenApiOperation {
  [key: string]: unknown;
  operationId?: unknown;
  description?: unknown;
  parameters?: OpenApiParameter[];
  requestBody?: { required?: unknown; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  security?: Array<Record<string, unknown>>;
}

interface OpenApiDocument {
  openapi?: unknown;
  info?: { title?: unknown; version?: unknown };
  servers?: Array<{ url?: unknown }>;
  security?: Array<Record<string, unknown>>;
  paths?: Record<string, OpenApiPathItem>;
  components?: { securitySchemes?: Record<string, Record<string, unknown>>; schemas?: Record<string, unknown> };
}

interface RouteContract {
  path: string;
  method: 'get' | 'post';
  secured: boolean;
  success: string[];
  errors: string[];
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
}

// 計画4節のroute表をそのまま固定する。実装が返さないstatusを推測で増やさない。
const ROUTES: RouteContract[] = [
  { path: '/health/live', method: 'get', secured: false, success: ['200'], errors: ['500'], pathParams: [], queryParams: [], hasBody: false },
  { path: '/health/ready', method: 'get', secured: false, success: ['200'], errors: ['503'], pathParams: [], queryParams: [], hasBody: false },
  {
    path: '/v1/events',
    method: 'post',
    secured: true,
    success: ['202'],
    errors: ['400', '401', '403', '409', '413', '500'],
    pathParams: [],
    queryParams: [],
    hasBody: true,
  },
  {
    path: '/v1/searches',
    method: 'post',
    secured: true,
    success: ['200', '202'],
    errors: ['400', '401', '403', '404', '409', '413', '500'],
    pathParams: [],
    queryParams: [],
    hasBody: true,
  },
  {
    path: '/v1/session-links',
    method: 'post',
    secured: true,
    success: ['200', '201'],
    errors: ['400', '401', '403', '404', '409', '413', '500'],
    pathParams: [],
    queryParams: [],
    hasBody: true,
  },
  {
    path: '/v1/searches/by-input',
    method: 'get',
    secured: true,
    success: ['200'],
    errors: ['400', '401', '403', '500'],
    pathParams: [],
    queryParams: [
      'project_id',
      'input_id',
      'input_revision',
      'wait_ms',
      'source',
      'source_scope',
      'source_session_id',
      'source_message_id',
      'revision',
    ],
    hasBody: false,
  },
  {
    path: '/v1/searches/{id}',
    method: 'get',
    secured: true,
    success: ['200'],
    errors: ['400', '401', '404', '500'],
    pathParams: ['id'],
    queryParams: ['wait_ms'],
    hasBody: false,
  },
  {
    path: '/v1/evidence/{message_id}',
    method: 'get',
    secured: true,
    success: ['200'],
    errors: ['400', '401', '403', '404', '500'],
    pathParams: ['message_id'],
    queryParams: ['project_id', 'revision'],
    hasBody: false,
  },
  {
    path: '/v1/collector/setup',
    method: 'post',
    secured: true,
    success: ['200'],
    errors: ['400', '401', '404', '500'],
    pathParams: [],
    queryParams: [],
    hasBody: true,
  },
];

const ERROR_CODES = ['invalid_request', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'payload_too_large', 'internal_error', 'suspected_secret'];

interface GeneratedOpenApi {
  json: string;
  document: OpenApiDocument;
}

let generatorCache: (() => string) | undefined;
let generatedCache: GeneratedOpenApi | undefined;

// src/api/openapi.tsの生成契約を読み込み、未実装なら生成物の欠落として失敗させる。
async function loadGenerator(): Promise<() => string> {
  if (generatorCache !== undefined) {
    return generatorCache;
  }
  let moduleExports: Record<string, unknown>;
  try {
    moduleExports = (await import(OPENAPI_MODULE_URL)) as Record<string, unknown>;
  } catch (error) {
    assert.fail(`src/api/openapi.ts のOpenAPI生成契約が未実装です: ${error instanceof Error ? error.message : String(error)}`);
  }
  const generate = moduleExports.generateOpenApiJson;
  assert.equal(typeof generate, 'function', 'src/api/openapi.ts が generateOpenApiJson() をexportしていない');
  generatorCache = generate as () => string;
  return generatorCache;
}

// 生成文字列をJSONへparseし、object以外はOpenAPI documentとして受理しない。
async function generatedOpenApi(): Promise<GeneratedOpenApi> {
  if (generatedCache !== undefined) {
    return generatedCache;
  }
  const generate = await loadGenerator();
  const json = generate();
  assert.equal(typeof json, 'string', 'generateOpenApiJson()が文字列を返していない');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    assert.fail('generateOpenApiJson()の出力がJSONとして不正です');
  }
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed), 'OpenAPI documentがobjectではない');
  generatedCache = { json, document: parsed as OpenApiDocument };
  return generatedCache;
}

function operationOf(document: OpenApiDocument, route: RouteContract): { operation: OpenApiOperation; pathItem: OpenApiPathItem } {
  const pathItem = document.paths?.[route.path];
  assert.ok(pathItem !== undefined, `${route.method.toUpperCase()} ${route.path} がOpenAPI pathsにない`);
  const operation = pathItem[route.method];
  assert.ok(typeof operation === 'object' && operation !== null, `${route.method.toUpperCase()} ${route.path} のoperationがない`);
  return { operation: operation as OpenApiOperation, pathItem };
}

// generatorがoperation-levelとpath-levelのどちらへparameterを置いても契約としては同じ。
function parametersOf(pathItem: OpenApiPathItem, operation: OpenApiOperation): OpenApiParameter[] {
  return [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(operation.parameters ?? [])];
}

function requiredNames(schema: OpenApiSchema | undefined): string[] {
  const required = schema?.required;
  return Array.isArray(required) ? required.filter((value): value is string => typeof value === 'string') : [];
}

// #/components/schemas等のJSON Pointerを解決し、参照先がなければundefinedを返す。
function resolveSchema(document: OpenApiDocument, schema: unknown): OpenApiSchema | undefined {
  if (typeof schema !== 'object' || schema === null) {
    return undefined;
  }
  const candidate = schema as OpenApiSchema;
  if (typeof candidate.$ref !== 'string') {
    return candidate;
  }
  if (!candidate.$ref.startsWith('#/')) {
    return undefined;
  }
  let current: unknown = document;
  for (const rawToken of candidate.$ref.slice(2).split('/')) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }
  return resolveSchema(document, current);
}

function jsonResponseSchema(document: OpenApiDocument, operation: OpenApiOperation, status: string): OpenApiSchema | undefined {
  const media = operation.responses?.[status]?.content?.['application/json'];
  return resolveSchema(document, media?.schema);
}

function requestBodySchema(document: OpenApiDocument, operation: OpenApiOperation): OpenApiSchema | undefined {
  const media = operation.requestBody?.content?.['application/json'];
  return resolveSchema(document, media?.schema);
}

function effectiveSecurity(document: OpenApiDocument, pathItem: OpenApiPathItem, operation: OpenApiOperation): Array<Record<string, unknown>> {
  const security = operation.security ?? pathItem.security ?? document.security ?? [];
  return Array.isArray(security) ? security : [];
}

describe('OpenAPI 3.1契約の生成', () => {
  it('OpenAPI 3.1として9 routeをpathsへ1回ずつ定義し、operationIdを固定する', async () => {
    const { document } = await generatedOpenApi();
    assert.match(String(document.openapi), /^3\.1\.\d+$/, 'OpenAPI 3.1.xではない');
    assert.equal(document.info?.version, '1.0.0', 'API契約版が1.0.0ではない');
    assert.ok(typeof document.info?.title === 'string' && document.info.title.length > 0, 'info.titleがない');

    const paths = document.paths ?? {};
    assert.deepEqual(Object.keys(paths).sort(), ROUTES.map((route) => route.path).sort(), 'pathsのroute集合が実装と一致しない');

    const operationIds: string[] = [];
    for (const route of ROUTES) {
      const { operation } = operationOf(document, route);
      const methods = Object.keys(paths[route.path] ?? {}).filter((key) =>
        (HTTP_METHODS as readonly string[]).includes(key),
      );
      assert.deepEqual(methods, [route.method], `${route.path} のmethodが実装契約と一致しない`);
      assert.ok(
        typeof operation.operationId === 'string' && operation.operationId.length > 0,
        `${route.path} のoperationIdがない`,
      );
      operationIds.push(operation.operationId as string);
    }
    assert.equal(new Set(operationIds).size, operationIds.length, 'operationIdが重複している');
  });

  it('routeごとのpath parameter・query・bodyが既存Zod入力契約と一致する', async () => {
    const { document } = await generatedOpenApi();

    for (const route of ROUTES) {
      const { operation, pathItem } = operationOf(document, route);
      const parameters = parametersOf(pathItem, operation);
      const pathParams = parameters.filter((parameter) => parameter.in === 'path').map((parameter) => parameter.name);
      const queryParams = parameters.filter((parameter) => parameter.in === 'query').map((parameter) => parameter.name);
      assert.deepEqual([...pathParams].sort(), [...route.pathParams].sort(), `${route.path} のpath parameterが一致しない`);
      assert.deepEqual([...queryParams].sort(), [...route.queryParams].sort(), `${route.path} のquery parameterが一致しない`);
      for (const parameter of parameters) {
        if (parameter.in === 'path') {
          assert.equal(parameter.required, true, `${route.path} のpath parameter ${String(parameter.name)} が必須でない`);
        }
      }
      if (!route.hasBody) {
        assert.equal(operation.requestBody, undefined, `${route.path} へ不要なrequestBodyがある`);
        continue;
      }
      assert.ok(operation.requestBody !== undefined, `${route.path} にrequestBodyがない`);
      assert.equal(operation.requestBody?.required, true, `${route.path} のrequestBodyが必須でない`);
      const bodySchema = requestBodySchema(document, operation);
      assert.equal(bodySchema?.type, 'object', `${route.path} のrequestBodyがobject schemaでない`);
    }

    // events bodyはcontract.tsの上限をZod変換後も保持する。
    const events = operationOf(document, ROUTES[2]);
    const eventsSchema = requestBodySchema(document, events.operation);
    assert.deepEqual(requiredNames(eventsSchema).sort(), ['events', 'project_id']);
    assert.equal(eventsSchema?.properties?.events?.maxItems, MAX_BATCH_SIZE, 'eventsのbatch上限がZod契約と一致しない');
    const eventItem = resolveSchema(document, eventsSchema?.properties?.events?.items);
    assert.equal(eventItem?.additionalProperties, false, 'eventのunknown fieldがstrictでない');
    assert.equal(eventItem?.properties?.idempotency_key?.maxLength, 512, 'idempotency_key上限がZod契約と一致しない');
    assert.deepEqual(eventItem?.properties?.source?.enum, ['codex', 'claude_code', 'cursor']);
    assert.equal(eventItem?.properties?.model_id?.maxLength, 1024, 'model_id上限が公開契約にない');
    assert.deepEqual(requiredNames(eventItem).sort(), [
      'idempotency_key',
      'occurred_at',
      'revision',
      'role',
      'sequence_no',
      'source',
      'source_message_id',
      'source_scope',
      'source_session_id',
      'text',
    ]);

    const searches = operationOf(document, ROUTES[3]);
    const searchSchema = requestBodySchema(document, searches.operation);
    assert.deepEqual(requiredNames(searchSchema).sort(), [
      'force_refresh',
      'idempotency_key',
      'input_id',
      'input_revision',
      'project_id',
      'query',
    ]);

    const sessionLinks = operationOf(document, ROUTES[4]);
    const linkSchema = requestBodySchema(document, sessionLinks.operation);
    assert.deepEqual(requiredNames(linkSchema).sort(), ['evidence', 'from', 'idempotency_key', 'project_id', 'to']);
    const fromSchema = resolveSchema(document, linkSchema?.properties?.from);
    assert.deepEqual(requiredNames(fromSchema).sort(), ['source', 'source_scope', 'source_session_id']);
    const evidenceSchema = resolveSchema(document, linkSchema?.properties?.evidence);
    assert.deepEqual(requiredNames(evidenceSchema).sort(), [
      'revision',
      'source',
      'source_message_id',
      'source_scope',
      'source_session_id',
    ]);
  });

  it('入力上限とby-input排他的branchをZod契約と同じ値でOpenAPIへ表現する', async () => {
    const { document } = await generatedOpenApi();

    // 本文のUnicodeコードポイント上限とidentifierのUTF-8 byte上限は標準keywordで表せないためx-yori拡張で示す。
    const eventsSchema = requestBodySchema(document, operationOf(document, ROUTES[2]).operation);
    const eventItem = resolveSchema(document, eventsSchema?.properties?.events?.items);
    const textSchema = resolveSchema(document, eventItem?.properties?.text);
    assert.equal(textSchema?.maxLength, MAX_TEXT_LENGTH, 'events本文のmaxLengthがZod契約と一致しない');
    assert.equal(textSchema?.['x-yori-max-code-points'], MAX_TEXT_LENGTH, 'events本文上限がZod契約と一致しない');
    assert.ok(String(textSchema?.description).includes(String(MAX_TEXT_LENGTH)), 'events本文上限の説明がない');
    for (const field of ['source_scope', 'source_session_id', 'source_message_id']) {
      const fieldSchema = resolveSchema(document, eventItem?.properties?.[field]);
      assert.equal(fieldSchema?.['x-yori-max-utf8-bytes'], MAX_SOURCE_IDENTIFIER_BYTES, `${field}のUTF-8 byte上限がない`);
      assert.ok(String(fieldSchema?.description).includes(String(MAX_SOURCE_IDENTIFIER_BYTES)), `${field}のbyte上限説明がない`);
    }
    const searchSchema = requestBodySchema(document, operationOf(document, ROUTES[3]).operation);
    assert.equal(searchSchema?.properties?.query?.maxLength, MAX_TEXT_LENGTH, '検索queryのmaxLengthがない');
    assert.equal(searchSchema?.properties?.query?.['x-yori-max-code-points'], MAX_TEXT_LENGTH, '検索queryの本文上限がない');

    // query parameterはwireが文字列でも、意味上のinteger/min/maxを表す。
    const byInputOperation = operationOf(document, ROUTES[5]).operation;
    const byInputParams = new Map((byInputOperation.parameters ?? []).map((item) => [item.name, item]));
    assert.deepEqual(byInputParams.get('wait_ms')?.schema, {
      type: 'integer',
      minimum: 0,
      maximum: MAX_WAIT_MS,
      description: `0〜${MAX_WAIT_MS}の整数をquery文字列として送る`,
    });
    for (const name of ['input_revision', 'revision']) {
      const schema = byInputParams.get(name)?.schema as OpenApiSchema | undefined;
      assert.equal(schema?.type, 'integer', `${name}がintegerでない`);
      assert.equal(schema?.minimum, 1);
      assert.equal(schema?.maximum, MAX_REVISION);
    }
    const detailParams = new Map((operationOf(document, ROUTES[6]).operation.parameters ?? []).map((item) => [item.name, item]));
    assert.equal((detailParams.get('wait_ms')?.schema as OpenApiSchema | undefined)?.maximum, MAX_WAIT_MS);

    // by-inputの2 branchは標準keywordで表せないため、descriptionとx-yori拡張で排他を機械可読に固定する。
    const branches = byInputOperation['x-yori-input-branches'];
    assert.ok(Array.isArray(branches), 'by-inputのx-yori-input-branchesがない');
    const branchList = branches as Array<{ name?: unknown; required?: unknown; optional?: unknown }>;
    assert.deepEqual(branchList.map((branch) => branch.name).sort(), ['external', 'internal']);
    const stringsOf = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    const internal = branchList.find((branch) => branch.name === 'internal');
    const external = branchList.find((branch) => branch.name === 'external');
    assert.deepEqual(stringsOf(internal?.required).sort(), ['input_id', 'input_revision', 'project_id']);
    assert.deepEqual(stringsOf(internal?.optional), ['wait_ms']);
    assert.deepEqual(stringsOf(external?.required).sort(), [
      'project_id',
      'revision',
      'source',
      'source_message_id',
      'source_scope',
      'source_session_id',
    ]);
    assert.deepEqual(stringsOf(external?.optional), ['wait_ms']);
    assert.ok(String(byInputOperation.description).includes('どちらか一方'), 'by-input排他の説明がない');
    assert.ok(
      String(byInputOperation.description).includes('internal') && String(byInputOperation.description).includes('external'),
      'branch名の説明がない',
    );
  });

  it('HTTP bearer security schemeを定義し、health以外の全operationが参照する', async () => {
    const { document } = await generatedOpenApi();
    const schemes = document.components?.securitySchemes ?? {};
    const bearerEntries = Object.entries(schemes).filter(([, scheme]) => scheme.type === 'http' && scheme.scheme === 'bearer');
    assert.equal(bearerEntries.length, 1, 'HTTP bearer security schemeが1つだけ定義されていない');
    const bearerName = bearerEntries[0]?.[0] as string;

    for (const route of ROUTES) {
      const { operation, pathItem } = operationOf(document, route);
      const referencesBearer = effectiveSecurity(document, pathItem, operation).some((entry) => entry[bearerName] !== undefined);
      assert.equal(
        referencesBearer,
        route.secured,
        route.secured ? `${route.path} がBearer認証を要求していない` : `${route.path} だけがBearer認証なしであるべき`,
      );
    }
    assert.ok(!JSON.stringify(bearerEntries).includes('token'), 'security schemeへtoken形式を埋め込んでいる');
  });

  it('routeごとの成功・失敗statusとerror codeが既存実装と一致する', async () => {
    const { document } = await generatedOpenApi();
    const serialized = JSON.stringify(document);

    for (const route of ROUTES) {
      const { operation } = operationOf(document, route);
      const responses = operation.responses ?? {};
      assert.deepEqual(
        Object.keys(responses).sort(),
        [...route.success, ...route.errors].sort(),
        `${route.path} のstatus codeが実装契約と一致しない`,
      );
      for (const status of [...route.success, ...route.errors]) {
        assert.ok(jsonResponseSchema(document, operation, status) !== undefined, `${route.path} ${status} にJSON response schemaがない`);
      }
      for (const status of route.errors) {
        // health/readyの503は受付可否本文（status=unavailable）で、共通error本文ではない。
        if (status === '503') {
          continue;
        }
        const errorSchema = jsonResponseSchema(document, operation, status);
        assert.deepEqual(requiredNames(errorSchema).sort(), ['error'], `${route.path} ${status} のerror本文が{error}でない`);
        const errorProperty = resolveSchema(document, errorSchema?.properties?.error);
        assert.deepEqual(requiredNames(errorProperty).sort(), ['code'], `${route.path} ${status} のerror.codeがない`);
        assert.ok(resolveSchema(document, errorProperty?.properties?.code) !== undefined, `${route.path} ${status} のerror code schemaがない`);
      }
    }
    for (const code of ERROR_CODES) {
      assert.ok(serialized.includes(`"${code}"`), `error code ${code} がOpenAPIへ記録されていない`);
    }
  });

  it('openapi.jsonが再生成結果とbyte単位で一致し、生成が決定的である', async () => {
    const { json } = await generatedOpenApi();
    const generate = await loadGenerator();
    assert.equal(generate(), json, 'generateOpenApiJson()の出力が決定的でない');

    let committed: string;
    try {
      committed = await readFile(OPENAPI_PATH, 'utf8');
    } catch {
      assert.fail('openapi.json が未生成です。npm run api:contract で生成した結果を追跡してください');
    }
    assert.equal(committed, json, 'openapi.json が再生成結果とdriftしています');
  });

  it('server URLは相対pathを正本にし、localhostや資格情報を埋め込まない', async () => {
    const { document } = await generatedOpenApi();
    const servers = document.servers ?? [];
    for (const server of servers) {
      assert.ok(
        typeof server.url === 'string' && server.url.startsWith('/'),
        `server URL ${String(server.url)} が相対pathでない`,
      );
    }
    const serialized = JSON.stringify(servers);
    assert.ok(!serialized.includes('localhost') && !serialized.includes('127.0.0.1'), 'server URLへlocalhostを埋め込んでいる');
    assert.ok(document.paths?.['/openapi.json'] === undefined, '公開OpenAPI endpointをpathsへ追加している');
  });

  it('collector setup応答のpolicyをfields/terms/suspicion_mode/detector_versionで生成する', async () => {
    const { document } = await generatedOpenApi();
    const setupRoute = ROUTES.find((route) => route.path === '/v1/collector/setup');
    assert.ok(setupRoute, 'collector setupのroute契約がない');
    const { operation } = operationOf(document, setupRoute);
    const responseSchema = jsonResponseSchema(document, operation, '200');
    const policySchema = resolveSchema(document, responseSchema?.properties?.redaction_policy);
    assert.ok(policySchema, 'CollectorSetupResponseにredaction_policyがない');
    assert.equal(policySchema?.properties?.rules, undefined, '旧redaction_policy.rulesが残っている');
    assert.deepEqual(
      requiredNames(policySchema).sort(),
      ['detector_version', 'fields', 'suspicion_mode', 'terms', 'version'],
      'redaction_policyの必須fieldが新shapeと異なる',
    );

    const versionSchema = resolveSchema(document, policySchema?.properties?.version);
    assert.equal(versionSchema?.type, 'integer', 'redaction_policy.versionがintegerでない');
    for (const name of ['fields', 'terms']) {
      const arraySchema = resolveSchema(document, policySchema?.properties?.[name]);
      assert.equal(arraySchema?.type, 'array', `redaction_policy.${name}がarrayでない`);
      assert.equal(resolveSchema(document, arraySchema?.items)?.type, 'string', `redaction_policy.${name}のitemがstringでない`);
    }

    const modeSchema = resolveSchema(document, policySchema?.properties?.suspicion_mode);
    const modeValues = modeSchema?.enum ?? (modeSchema?.const === undefined ? undefined : [modeSchema.const]);
    assert.ok(Array.isArray(modeValues), 'redaction_policy.suspicion_modeのenumがない');
    assert.deepEqual([...modeValues].sort(), ['block', 'observe'], 'suspicion_modeのenumがobserve/blockでない');

    const detectorSchema = resolveSchema(document, policySchema?.properties?.detector_version);
    const detectorValues = detectorSchema?.enum ?? (detectorSchema?.const === undefined ? undefined : [detectorSchema.const]);
    assert.ok(Array.isArray(detectorValues), 'redaction_policy.detector_versionのenumがない');
    assert.deepEqual([...detectorValues], ['initial-v1'], 'detector_versionがinitial-v1でない');
  });

  it('生成・versioning・互換性規則がdocs/api-contract.mdへ文書化されている', async () => {
    let content: string;
    try {
      content = await readFile(API_CONTRACT_DOCS_PATH, 'utf8');
    } catch {
      assert.fail('docs/api-contract.md が未作成です');
    }
    for (const anchor of ['openapi.json', 'npm run api:contract', 'OpenAPI 3.1', 'breaking change']) {
      assert.ok(content.includes(anchor), `docs/api-contract.md に ${anchor} の記述がない`);
    }
  });
});
