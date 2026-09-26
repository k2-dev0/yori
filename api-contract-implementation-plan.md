# yori API契約実装計画

- 作成日: 2026-09-26
- 対象: 中央HTTP APIとローカルMCPの入力・出力契約
- 状態: 実装前。preflight確認済み
- 目的: `development-conversation-memory-implementation-plan.md` 15節の「OpenAPIまたは同等のAPI契約、MCPの入力・出力スキーマ」を満たす

## 1. 結論

Zod schemaを実行時契約の正本とし、そこから静的な`openapi.json`を生成する。OpenAPIを手書きの第二正本にしない。HTTP入力だけでなく、成功応答、エラー応答、path/query、HTTP statusを明示する。

本番APIへSwagger UIや`/openapi.json` endpointは追加しない。生成物はrepositoryへ追跡し、CI相当のtestで生成結果との差分を検出する。

MCPは現在のSDK `@modelcontextprotocol/server` 2.1.0で入力schemaを登録済みだが、依存内に`outputSchema`の実装は確認できない。存在しないSDK機能を創作せず、MCPの出力は共有Zod schemaによる実行時検証、文書、tool listのsnapshot testで契約化する。

## 2. 確認済みの既存経路

### 2.1 HTTP

- Fastify routeは`src/api/app.ts:40-195`に集約されている。
- HTTP入力は`src/api/schema.ts:17-120`のstrict Zod schemaで検証される。
- 成功応答はrouteまたはserviceのTypeScript interfaceから直接返され、HTTP境界で共通の応答Zod schemaを通していない。`src/api/app.ts:65,88-100,118-130,147,165,191-195`
- エラー本文は`{ error: { code } }`へ固定される。`src/api/app.ts:201-213`
- 公開応答のTypeScript型は`src/api/contract.ts`、`src/api/searches.ts`、`src/api/session-links.ts`に分散している。

### 2.2 MCP

- MCPの5 toolは`src/mcp/server.ts:122-174`で登録され、入力Zod schemaを持つ。
- 中央API clientは最小必須fieldを`z.looseObject`で検証し、追加fieldを保持する。`src/mcp/central.ts:6-54`
- HTTP入力とMCP入力には同じ意味のfieldを別々に定義した箇所があり、上限・Unicode・byte数のdrift余地がある。`src/api/schema.ts:4-15`、`src/mcp/server.ts:13-99`
- 現在のSDK package内に`outputSchema`識別子は確認できないため、tool登録時の出力schemaは前提にしない。

## 3. 対象範囲

### 3.1 実装するもの

1. HTTP request、path、query、success response、error responseのZod schema。
2. routeごとのmethod、path、認証、request、response、status code定義。
3. Zod v4のJSON Schema変換を使う静的OpenAPI 3.1生成。
4. repository直下の`openapi.json`。
5. 生成物drift test。
6. 実API応答が公開response schemaへ適合するcontract test。
7. MCPとHTTPで共有できるschemaの共通化。
8. MCP structuredContentの実行時出力検証。
9. MCP tool listのname・description・input schema snapshot test。
10. breaking changeとversioningの規則文書。

### 3.2 対象外

- HTTP routeの業務挙動、認証、認可、DB query、status codeの変更。
- `/v2`の新設。
- Swagger UIや公開OpenAPI endpoint。
- 管理CLIの契約。`yori-cli`は別repositoryで管理する。
- provider APIのOpenAPI化。
- client SDKの自動生成・公開。
- API key、DB password、secret managerの設定。

## 4. HTTP公開契約

初期OpenAPIに含めるrouteを次に固定する。

| method | path | 主な成功status | 主な失敗status |
|---|---|---:|---|
| GET | `/health/live` | 200 | 500 |
| GET | `/health/ready` | 200 | 503 |
| POST | `/v1/events` | 202 | 400, 401, 403, 409, 413, 500 |
| POST | `/v1/searches` | 200, 202 | 400, 401, 403, 404, 409, 413, 500 |
| POST | `/v1/session-links` | 200, 201 | 400, 401, 403, 404, 409, 413, 500 |
| GET | `/v1/searches/by-input` | 200 | 400, 401, 403, 500 |
| GET | `/v1/searches/{id}` | 200 | 400, 401, 404, 500 |
| GET | `/v1/evidence/{message_id}` | 200 | 400, 401, 403, 404, 500 |

実装前に既存testとroute本文を再照合し、実際に返さないstatusを推測で追加しない。Fastifyの共通body上限による413を各body routeへ記録する。

### 4.1 認証

- health以外はBearer認証を要求する。
- OpenAPIのsecurity schemeはHTTP bearerとして定義する。
- token形式、hash方式、token本文はOpenAPIへ載せない。
- 401と403を区別し、他社員・他案件の存在を開示しない404契約を保持する。

### 4.2 エラー

共通schemaは次の形を正本にする。

```json
{"error":{"code":"invalid_request"}}
```

公開codeは既存routeとtestから列挙し、説明文やDB errorを応答契約へ追加しない。未知fieldを許可するかは既存挙動を測定し、サーバーが返す正本schemaはstrict、consumer側は後方互換のためlooseを維持する。

### 4.3 検索結果

`pending`、`running`、`completed`、`failed`、`expired`と、`matched`、`no_match`、`skipped`、`not_received`をOpenAPI上で別状態として表現する。単一の自由なobjectへ潰さない。

検索result内のprimary evidence、related evidence、warning、truncated、reuse元、世代、pending/failed件数は現在の保存・取得契約からschema化する。原文revisionや案件scopeのfieldをoptional化して既存検証を弱めない。

## 5. schemaの配置

基準案は次の通り。

| file | 責任 |
|---|---|
| `src/api/schema.ts` | HTTP request/path/query schema。既存責務を維持 |
| `src/api/response-schema.ts` | HTTP成功・エラー応答schemaと推論型 |
| `src/api/openapi.ts` | route契約とOpenAPI object生成 |
| `src/api/generate-openapi.ts` | `openapi.json`を書き出すCLI entry |
| `src/api/tests/openapi.test.ts` | 生成物drift、route/status/security/schema検証 |
| `src/api/tests/response-contract.test.ts` | 実Fastify応答のZod適合検証 |
| `src/mcp/schema.ts` | MCP tool入力とstructuredContent出力schema |
| `src/mcp/tests/contract.test.ts` | tool listと出力検証 |
| `openapi.json` | 生成済みOpenAPI 3.1成果物 |
| `docs/api-contract.md` | versioning、生成、互換性、consumer規則 |

既存のTypeScript interfaceをschemaと重複定義したまま残さず、公開境界の型は可能な範囲で`z.infer`へ寄せる。ただしDB内部row、worker保存JSON、非公開service型まで無理に共通化しない。

## 6. OpenAPI生成

- OpenAPI versionは3.1.xとする。
- Zod v4のJSON Schema変換を利用し、新しい変換libraryを追加しない基準案から開始する。
- `info.version`はpackage versionとは別にAPI契約版`1.0.0`を明示する。
- server URLに本番domain、localhost、資格情報を埋め込まない。相対pathを正本にする。
- exampleへ実社員名、実案件名、API key、実原文を含めない。
- operationIdは既存route責務に合わせて固定し、生成ごとに変わらない。
- schema component名、並び順、JSON整形を決定的にする。
- `npm run api:contract`で生成し、`npm run api:contract:check`またはtestで差分を検出する。

生成時にrepository fileを書き換えるcommandと、CIで書き換えず比較するcommandを分ける。

## 7. MCP契約

- tool名は`search_history`、`get_search_result`、`get_evidence`、`link_session`、`record_case`を固定する。
- HTTPと同じfieldは共有schemaから構築し、UUID正規化、本文上限、identifierのUTF-8 byte上限を揃える。
- SDKが公開するtool input schemaをsnapshotし、必須field、排他的branch、上限値を検証する。
- 中央APIの応答はtoolへ返す前にMCP output schemaで検証する。
- `structuredContent`とtext JSONが同じ値であることをtestする。
- SDKにoutputSchema登録機能が無い間は、公開tool説明と`docs/mcp.md`へ出力schemaを記録する。SDK更新だけを目的に依存を上げない。
- HTTPの追加fieldをMCP consumerが受け取れるよう、中央API clientのloose validationは維持する。ただしidentityと分岐判定に必要なfieldは必須のままにする。

## 8. 互換性規則

| 変更 | 扱い |
|---|---|
| optional field追加 | 原則後方互換。consumer test必須 |
| enum値追加 | consumerのexhaustive判定を確認してから追加 |
| 必須field追加 | breaking change |
| field削除・rename・型変更 | breaking change |
| status code変更 | breaking change |
| error code変更 | breaking change |
| fieldの意味変更 | 名前が同じでもbreaking change |
| MCP tool名・必須引数変更 | breaking change |

breaking changeは既存`/v1`やtoolへ黙って入れない。`/v2`、新tool名、または全consumer同時更新の設計判断へ戻す。

## 9. 実装順序

1. route・service・既存testから全statusと応答shapeを棚卸しする。
2. HTTP response Zod schemaを追加し、既存interfaceとの差をtestで検出する。
3. Fastifyの実応答をschemaへ通すcontract testを追加する。
4. route契約定義とOpenAPI generatorを追加する。
5. `openapi.json`を生成し、drift testを追加する。
6. MCP入力schemaを共有moduleへ移し、既存挙動が不変であることを確認する。
7. MCP output schemaとstructuredContent検証を追加する。
8. versioning・生成手順を文書化する。
9. src test、deployment test、typecheck、lint、buildを実行する。
10. 独立レビューで公開契約、認証、情報漏えい、互換性を確認する。

追跡対象はリポジトリ規約どおり1ファイル1コミットとする。

## 10. 必須テスト

- 全routeがOpenAPI pathsへ1回だけ現れる。
- method、path parameter、query、body、security、成功status、失敗statusが実装と一致する。
- `openapi.json`が再生成結果とbyte単位で一致する。
- unknown request field、UUID、wait_ms、本文長、batch上限が現在のZod契約と一致する。
- health routeだけがBearer認証なしになる。
- error responseにSQL、DB接続、token、原文が含まれない。
- 検索状態とoutcomeを取り違えない。
- evidenceにmessage ID、revision、社員、role、日時、原文が含まれる。
- MCP 5 toolの入力schemaが登録される。
- MCPの排他的入力branchが維持される。
- 中央APIの不正応答をtool errorにし、`no_match`へ変換しない。
- HTTP追加fieldをMCPが破棄せずstructuredContentへ返す。

## 11. 受け入れ条件

| ID | 条件 |
|---|---|
| API-01 | Zodが入力・出力の実行時正本であり、OpenAPIと別管理にならない |
| API-02 | 全HTTP route、status、error code、認証がOpenAPIへ記録される |
| API-03 | `openapi.json`のdriftを自動testで検出できる |
| API-04 | 公開応答に秘密・内部error・SQLを追加しない |
| API-05 | MCP 5 toolの入力と出力契約が検証・文書化される |
| API-06 | pending／failed／no_match／skipped／not_receivedを契約上区別する |
| API-07 | breaking change規則が文書化され、`/v1`を黙って変更しない |
| API-08 | 既存API・MCP・collector・workerの回帰testが成功する |

## 12. 完了報告

- 追加・変更した公開契約。
- routeとOpenAPI operationIdの対応。
- 生成・drift検査command。
- MCP outputSchema非対応を含むSDK制約。
- 実行したtest、typecheck、lint、build。
- breaking changeの有無。
- 1ファイル1コミット一覧。
- 独立レビュー結果と未解決事項。
