# worker（Jev分類・検索振り分け）

M3の`src/worker/`は、`classify_message`と`route_search`のjobをJevで評価し、分類・原文位置・承認/撤回関係・検索振り分けを保存する。外向きのHTTP先は承認済みJev endpointだけで、実会話をテストへ使わない。M4の`build_documents`とM5の`execute_search`はpendingで登録するところまでで、workerはclaimしない。

## 前提

- `0002_m3.sql`適用済みのPostgreSQL。workerはmigrationを実行しない。
- `JEV_API_KEY`と`JEV_ACCOUNT_REF`。未設定・不正なら偽の判定へ進まず`invalid_worker_config`で起動に失敗する。
- `JEV_API_URL`はHTTPS（開発用loopback HTTPのみ）で、pathは`/v1/systemone`固定。userinfo・query・fragmentは拒否する。3xxは追従せず、承認外endpointへ資格情報や本文を送らない。
- 実データを送る前に、管理者がTypeSafe側のアカウント設定を確認する。この承認記録は設定を変更・証明しない。

## 環境変数

| 変数 | 既定 | 内容 |
|---|---|---|
| `DATABASE_URL` | 必須 | PostgreSQL接続先 |
| `JEV_API_KEY` | 必須 | Bearer credential。ログ・引数へ出さない |
| `JEV_ACCOUNT_REF` | 必須 | 承認とusageのaccount参照 |
| `JEV_API_URL` | `https://api.typesafe.ai/v1/systemone` | 完全endpoint。loopback HTTPは開発用のみ |
| `JEV_MODEL` | `jev-latest` | 送信model |
| `JEV_CONFIDENCE_THRESHOLD` | `0.8` | 採用閾値。未満はunknown・不採用・new_search |
| `JEV_INPUT_BUDGET_BYTES` | `8000` | 質問・JSONメタデータ込みの送信body上限（実トークン数ではない保守的上限） |
| `JEV_REQUEST_TIMEOUT_MS` | `20000` | 1回の外部呼出しtimeout。`JEV_JOB_LEASE_MS`より短くする |
| `JEV_JOB_LEASE_MS` | `60000` | job lease。処理中は半分の間隔で延長する |
| `JEV_WORKER_POLL_MS` | `1000` | 新規jobが無い時のpoll間隔 |

## 起動

`deployment/compose.yaml`の`worker`はapiのhealthcheck後に起動し、共有node_modules volumeへの同時`npm ci`を避ける。migration適用後に起動する。

```sh
docker compose -p yori -f deployment/compose.yaml up -d --wait db
docker compose -p yori -f deployment/compose.yaml --profile tools run --rm migrate
docker compose -p yori -f deployment/compose.yaml up -d api worker
```

tsxで直接動かす場合:

```sh
npm run worker:start
```

`SIGTERM`/`SIGINT`では新規claimを止め、処理中jobの完了を待って終了する。未完了のまま停止したjobはlease期限切れ後、runner起動時と定期回収（30秒間隔）でpendingへ戻る。

## 承認登録・失効

承認はJSONファイルからZod検証して登録する。credentialは引数にもファイルにも含めない。同じ（会社・provider・account・endpoint）の有効な承認は1件だけ保持する。

```json
{
  "company_id": "018f0a00-0000-7000-8000-000000000001",
  "provider": "jev",
  "account_ref": "acct-a",
  "endpoint": "https://api.typesafe.ai/v1/systemone",
  "terms_url": "https://typesafe.ai/legal/mca",
  "terms_checked_at": "2026-09-24T00:00:00.000Z",
  "learning_disabled": true,
  "retention_terms": "処理後直ちに削除（管理者確認）",
  "confirmed_by": "admin-a",
  "confirmed_at": "2026-09-24T00:00:00.000Z"
}
```

```sh
npm run provider:approve -- /path/to/approval.json
npm run provider:revoke -- <approval-id>
```

- `terms_checked_at`は管理者が規約を確認した日時で必須。既存seedとの互換のため、未設定行は`confirmed_at`を確認日として扱う。
- 各HTTP送信の直前にDBの承認を確認する。part・再試行・評価キャッシュ再利用でも同じ。
- 未承認は`classify_message`/`route_search`とも`blocked_policy`として保持し、検索受付は`failed`/`provider_policy_unverified`にする。`no_match`にはしない。
- account・endpointを変えた承認は継承しない。承認失効後は再登録するまで外部送信しない。

## CLI

| command | 動作 |
|---|---|
| `npm run worker:start` | route/classifyの2 laneでjobを処理する |
| `npm run worker:retry -- <jobId>` | `failed`/`blocked_policy`のjobを、現在の承認を確認してpendingへ戻す。routeは検索受付も同一TXで戻す |
| `npm run provider:approve -- <approval.json>` | 承認を登録し、同じendpointの旧承認を失効させる |
| `npm run provider:revoke -- <approval-id>` | 承認を失効させる |

終了コードは`0`成功、`1`失敗。原文・credential・外部error bodyはログへ出さない。

## 処理内容

workerはroute laneとclassify laneを各1、合計2並列で走らせ、各laneは同時に1jobだけclaimする。`build_documents`/`execute_search`はclaimしない。

### classify_message

- 同sessionの対象sequenceより前の最新6発言を最新revisionでstateへ入れる。現在発言はjobの`target_revision`固定。
- 直前の完全発言、直近先行検索の元入力、現在発言の順に予算へ入れる。入り切らない文脈は除外数をstateへ明示する。
- 入力が8,000バイト予算を超える場合は、Unicodeを壊さない連続UTF-16範囲のpartへ分割し、1request 1partで送る。原文範囲（offset/length）は判定と一緒に保存し、原文は切り捨てない。
- retentionは`substantive`→`decision_signal`→`unknown`→`progress_only`の順に保守的に統合する。全partが高信頼`progress_only`の時だけ`is_searchable=false`。
- retention以外の単一分類は全part一致時だけ採用し、不一致はunknownにする。technical_labelsは採用ラベルの和集合。低信頼は採用しない。
- relation_targetはstateへ実際に入れた候補発言ID・none・unknownだけを許可する。decision_actionがaccept/reject/revoke/changeで、対象と明示/推定が高信頼の時だけ`message_relations`へ保存する。低信頼・unknown・候補外は保存しない。
- 適用時はjob lease・対象revisionを同一TXで再確認し、`message_analysis`・関係・`build_documents` job・job完了をまとめて反映する。leaseを失った場合は適用しない。古いrevisionは現在状態へ適用しない。

### route_search

分類の完了を待たず、routeとclassifyは同じstate/questionsから独立に判定する。検索振り分けは保存分類と独立して決まる。

- `new_search`: 条件hashと段階`awaiting_search`を保存し、受付はpendingのまま`execute_search`をenqueueする。
- `reuse`: 高信頼`reuse`＋`same_topic`＋条件同一、同一会社・案件・社員・session・policy、先行入力のcurrent revision一致、権限・根拠が有効な場合だけ。直近の先行検索だけを判定し、不適格でも古い候補へ飛ばない。参照は循環・過長chainを拒否して直接の`new_search`元へ解決する。既存結果はコピーせず、段階`awaiting_reused_search`と`reused_from_request_id`/`original_request_id`を保存する。
- `skip`: 全part高信頼`skip`の時だけ`completed`/`skipped`にする（`no_match`とは表現しない）。
- `pending`/`running`の先行検索は共有できる。`completed`は`matched`かつ10分以内の時だけ。`failed`/`expired`/`skipped`/`no_match`・対象不明・失効・条件変更・不確実・低信頼は`new_search`。
- matchedの根拠はevidenceのmessage_id/revisionが現行revision・同案件であること、最新分析がprogress_onlyでないこと、revoke/change関係で無効化されていないことを検証する。不明な形式・根拠なしは再利用しない。

### 評価キャッシュ

同一会社・provider/account/endpoint・model・閾値・policy版・質問版・state hashが一致する完了済み評価だけを`jev_evaluations`から再利用する。cache利用でも承認を再確認する。同時missでの二重外部評価は許容する。

### usage

外部呼出しの試行ごとに`usage_events`へ会社・provider/account/endpoint・operation・model・実usage（不明はnull）・所要時間・成功/error_codeを記録する。原文・credential・外部error bodyは保存しない。

## 失敗と再開

- 429/529/5xx/timeout/通信障害: jobはpendingへ戻し、Retry-Afterと指数バックオフ+jitterで再試行する。検索受付はfailedとcodeを持ち、自動再試行のclaim時にpendingへ戻す。
- 401/422/応答契約不正: `failed`で保持する。自動では再送しない。
- 承認未確認: `blocked_policy`。`worker:retry`は現在の承認が有効な時だけpendingへ戻す。
- 検索受付の`failed`は`no_match`ではない。M5の検索完了を偽らない。

## M4/M5待ちの見分け

`build_documents`と`execute_search`がpendingのまま残っているのはM4/M5未実装のためで、分類失敗や検索のno_matchではない。原文は`message_revisions`に保持され、`message_analysis`と`message_relations`は再実行で増殖しない。

## テスト

`npm test`は隔離Compose DBと合成loopback HTTP fixtureだけを使う。実Jev/Voyage・実会話は送信しない。workerのテストは`src/worker/tests/`にあり、runner/CLI/cacheも同じfixtureで検証する。
