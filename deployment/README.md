# deployment

M1の専用Compose projectとテスト実行手順。既存のCompose project・DB・Docker設定は変更しない。

## 構成

| service | 役割 |
|---|---|
| db | pgvector/pgvector:0.8.6-pg18-trixie。ポート公開なし。volume `yori-pgdata` を `/var/lib/postgresql` (PG18 layout) へマウント |
| api | Fastifyアプリ。loopbackのみ `${YORI_API_PORT:-39119}` で公開 |
| test | DBと同じnetworkで `npm run test:src` を実行 |
| migrate | `npm run migrate` でmigrationを適用 |

node serviceはvolume `yori-node-modules` と `yori-npm-cache` を使う。imageは固定digestで、pullは不要（親側で取得済み）。

## 通常起動とmigration

開発用はCompose project `yori`、DB volume `yori-pgdata` を使う。

```sh
docker compose -p yori -f deployment/compose.yaml up -d --wait db
docker compose -p yori -f deployment/compose.yaml run --rm migrate
docker compose -p yori -f deployment/compose.yaml up -d api
curl -sS http://127.0.0.1:39119/health/live
curl -sS http://127.0.0.1:39119/health/ready
```

- APIは `YORI_API_PORT`（既定39119、loopbackのみ）で公開する。`YORI_API_PORT` を変えた場合、curlのportも合わせる。
- `npm run migrate` はmigrate service内で `src/db/migrations/*.sql` をファイル名昇順に1トランザクションで適用し、適用済みversionを`schema_migrations`で管理する。再実行しても適用済みmigrationは実行しない。M1のmigrationは`0001_init.sql`のみ。
- DBはホストへ公開しない。手動で見る場合は `docker compose -p yori -f deployment/compose.yaml exec db psql -U yori -d yori` を使う。
- コンテナを通常停止しても `yori-pgdata` の原文は残る。消す場合だけ `down -v` を明示する。

## イベント受付の契約

`POST /v1/events` は合成fixtureや端末収集アダプターからの会話イベントを受ける。`<token>`は社員へ発行した生tokenで、DBにはSHA-256のみ保存されている。

```sh
curl -sS -X POST http://127.0.0.1:39119/v1/events \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"project_id":"<project-uuid>","events":[{"idempotency_key":"idem-1","source":"codex","source_scope":"repo-a","source_session_id":"session-1","source_message_id":"msg-1","sequence_no":1,"revision":1,"role":"user","occurred_at":"2026-09-21T01:00:00.000Z","text":"改行\nも原文のまま保存する"}]}'
```

- body上限1MiB、`events`は1..100件。strict Zod検証でunknown field・不正な型・範囲外は400、body超過は413。
- 認証は `Authorization: Bearer <token>`。token欠落・不正・失効は401、会社・project・project_membersの不一致は403で、どちらもDBへ書かない。
- `user`ロールは原文・`classify_message` job・自動検索受付(`search_requests`)・`route_search` jobを同一トランザクションで保存し202を返す。`assistant`/`agent_report`は自動検索を作らない。
- `text`はUnicodeコードポイントで1..65536。`message_revisions.content_hash`はUTF-8バイト列のSHA-256で、空白・改行・末尾空白を無加工で保存する。
- `revision`は1から始まり、更新は`current_revision + 1`のみ。同revision同本文の再送は既存IDを返し、同revision異本文、session/sequence_no/role/occurred_atの変更、revision飛越しは409。
- 冪等キーは(company, employee, idempotency_key)で一意。`event_receipts.request_hash`は`src/api/contract.ts`の`RECEIPT_PAYLOAD_KEYS`順のcanonical JSON（`occurred_at`は受信した文字列のまま）のSHA-256。

## ジョブキュー

`src/jobs/queue.ts` はPostgreSQLの`SELECT ... FOR UPDATE SKIP LOCKED`とleaseでjobを確保する。

- 分類(`classify_message`, priority 10)は同sessionの先行jobがpending/running/failed/blocked_policyの間は後続をclaimせず、`messages.sequence_no`→`target_revision`昇順で進む。未受信のsequence_noは待たない。
- `route_search`(priority 100)は分類の状態に依存せずclaimする。
- 完了はjob id・lease token・未失効lease・対象revisionが一致する場合だけ。期限切れleaseはrecoverでpendingへ戻す。
- 一時障害は指数バックオフ+jitter/Retry-Afterでpending、恒久エラーはfailed、ポリシー未確認はblocked_policyとして保持する。

## M1の実装範囲

実装済み: Compose、PostgreSQL 18+pgvector、migration、`POST /v1/events`（認証・strict検証・冪等保存・revision・自動検索受付・同一TXのjob登録）、永続jobキュー、`GET /health/live`・`GET /health/ready`、原文のコンテナ再作成後の永続化。

未実装（M2以降）: MCPサーバー、Codex/Claude Code収集アダプター、Jev分類・検索振り分けの実行worker、VoyageEmbeddingProvider、決定的文書分割・埋め込み・検索・周辺探索。M1では外部Jev/Voyageへ実データを送信しない。

## テスト

テストは合成fixtureだけを使い、実会話・外部Jev/Voyageへは送信しない。開発用composeと同じDB・volumeを触らないよう、テストは専用Compose project `yori-test` と専用volume `yori-test-pgdata` / `yori-test-node-modules` / `yori-test-npm-cache` を使う（`run-tests.mjs` と `deployment/tests/docker.ts` が指定）。`YORI_TEST_PROJECT` を変えた場合、volume既定はそのproject名から導出され、`YORI_TEST_PROJECT=yori` は開発環境を壊すため拒否する。開発用の `yori-pgdata` は通常composeのDB永続化用であり、テストからは変更しない。

```sh
npm test                 # srcテスト (container内) → deploymentテスト (ホスト) の順に実行
npm run test:deployment  # deploymentテストのみ（同じテスト用project/volume）
npm run test:src         # compose test service内で実行されるスクリプト。ホストではDATABASE_URLが無いため動かない
npm run migrate          # compose migrate service内で実行されるスクリプト
```

テストAPIは開発用(39119)と分離した既定39120 (`YORI_API_PORT`) で起動する。srcテストは`compose run --rm test`、migrationは`compose run --rm migrate`で実行する。DBはポート非公開なのでホストから直接は接続できない。

dockerは標準のcontext/config/DOCKER_HOST/DOCKER_CONFIGを使う（`run-tests.mjs` と `docker.ts` はsocket・configを固定しない）。このマシンで検証する場合も、必要な環境変数は呼出し側から渡す。テスト用のproject/volume名は環境変数で上書きできる（`YORI_TEST_PROJECT`、`YORI_TEST_PGDATA_VOLUME`、`YORI_TEST_NODE_MODULES_VOLUME`、`YORI_TEST_NPM_CACHE_VOLUME`）。

- DBはホストへ公開しない。接続はCompose network内の `db:5432` のみ。
- テスト用volumeを消す場合だけ `docker compose -p yori-test -f deployment/compose.yaml down -v` を明示する。開発用の `yori-pgdata` は消えない。
- macOSに`timeout`は無い。長い出力はpipeせずリダイレクトしてファイルから読む。
