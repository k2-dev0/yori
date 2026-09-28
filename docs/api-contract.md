# yori API契約（OpenAPI 3.1）

中央HTTP APIの公開契約は、実行時検証に使うZod schemaから決定的に生成したOpenAPI 3.1文書`openapi.json`を正本とする。OpenAPIを手書きの第二正本にしない。Swagger UIや公開`/openapi.json` endpointは提供しない。

## 対象route

`openapi.json`は計画4節の8 routeとM10のcollector setup 1 routeの計9 routeを含む。

| method | path | 主な成功status | 主な失敗status |
|---|---|---:|---|
| GET | `/health/live` | 200 | 500 |
| GET | `/health/ready` | 200 | 503 |
| POST | `/v1/events` | 202 | 400, 401, 403, 409, 413, 500 |
| POST | `/v1/searches` | 200, 202 | 400, 401, 403, 404, 409, 413, 500 |
| POST | `/v1/collector/setup` | 200 | 400, 401, 404, 500 |
| POST | `/v1/session-links` | 200, 201 | 400, 401, 403, 404, 409, 413, 500 |
| GET | `/v1/searches/by-input` | 200 | 400, 401, 403, 500 |
| GET | `/v1/searches/{id}` | 200 | 400, 401, 404, 500 |
| GET | `/v1/evidence/{message_id}` | 200 | 400, 401, 403, 404, 500 |

Bearer認証はhealth以外の全operationが要求する。error本文は`{"error":{"code":"..."}}`のcodeだけとし、説明文・SQL・DB接続・token・原文を追加しない。

## 生成とdrift検査

- 正本のschema: `src/api/schema.ts`（入力）、`src/api/response-schema.ts`（成功・error応答）、`src/api/openapi.ts`（route契約と生成）
- 生成: `npm run api:contract` が`openapi.json`を書き出す
- 検査: `npm run api:contract:check` が追跡済み`openapi.json`と再生成結果のbyte driftを検出する（CIでは書き換えない）
- test: `src/api/tests/openapi.test.ts`がroute・status・security・schemaとdriftを検証する

生成は新しい依存を追加せずZod v4のJSON Schema変換だけを使う。`info.version`はAPI契約版`1.0.0`として固定し、package versionとは分ける。server URLへ本番domain・localhost・資格情報を埋め込まず、相対pathを正本にする。exampleへ実在の社員名・案件名・API key・原文を含めない。

## versioningと互換性規則

| 変更 | 扱い |
|---|---|
| optional field追加 | 原則後方互換。consumer testを必須にする |
| enum値追加 | consumerのexhaustive判定を確認してから追加する |
| 必須field追加 | breaking change |
| field削除・rename・型変更 | breaking change |
| status code変更 | breaking change |
| error code変更 | breaking change |
| fieldの意味変更 | 名前が同じでもbreaking change |
| MCP tool名・必須引数変更 | breaking change |

breaking changeは既存`/v1`やMCP toolへ黙って入れない。`/v2`、新tool名、または全consumer同時更新の設計判断へ戻す。サーバーが返す正本schemaはstrict、MCP consumer側は後方互換のためloose（追加field保持）を維持する。
