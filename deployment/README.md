# deployment

M1のサーバーとテスト専用Compose、M2の端末収集の導入先。既存のCompose project・DB・Docker設定は変更しない。端末への導入・設定・再送手順は [docs/collector.md](../docs/collector.md) を参照する。

## 構成

通常起動は `deployment/compose.yaml`（project `yori`）、テストは `deployment/compose.test.yaml`（project `yori-test` 等）を使う。

| file | service | 役割 |
|---|---|---|
| compose.yaml | db | pgvector/pgvector:0.8.6-pg18-trixie。ポート公開なし。volume `yori-pgdata` を `/var/lib/postgresql` (PG18 layout) へマウント |
| compose.yaml | api | Fastifyアプリ。loopbackのみ `${YORI_API_PORT:-39119}` で公開 |
| compose.yaml | worker | M3〜M8の分類・検索・周辺探索・再索引worker。apiのhealthcheck後に起動し、共有volumeへの同時npm ciを避ける |
| compose.yaml | caddy | production profileのみ。HTTP/HTTPS gateway。80/tcpと443/tcp・443/udpだけを外部公開し、api:3210へreverse proxyする |
| compose.yaml | migrate | tools profile。`npm run migrate` でmigrationを適用 |
| compose.test.yaml | db | テスト専用DB。ポート公開なし。volumeはnameを指定せずCompose projectスコープで隔離 |
| compose.test.yaml | api | テスト専用API。loopbackのみ `${YORI_API_PORT:-39120}` で公開 |
| compose.test.yaml | test | DBと同じnetworkで `npm run test:src` を実行 |
| compose.test.yaml | migrate | `npm run migrate` でmigrationを適用 |

node serviceはvolumeでnode_modulesとnpmキャッシュを保持する。imageは固定digestで、pullは不要（親側で取得済み）。

- 通常composeの `migrate` はtools profileに置いてあり、`up` では起動しない。実行する場合は `--profile tools run --rm migrate` を使う。
- テストcomposeのvolumeは `name` を明示しないため、Compose projectスコープの `<project>_pgdata` 等になる。project名を変えても開発用の `yori-pgdata` / `yori-node-modules` / `yori-npm-cache` と共有されない。
- テストは常に `deployment/compose.test.yaml` を使う（`run-tests.mjs` と `deployment/tests/docker.ts` が指定）。`YORI_TEST_PROJECT=yori` は開発project・volumeを共有するため拒否する。

## 通常起動とmigration

開発用はCompose project `yori`、DB volume `yori-pgdata` を使う。

```sh
docker compose -p yori -f deployment/compose.yaml up -d --wait db
docker compose -p yori -f deployment/compose.yaml --profile tools run --rm migrate
docker compose -p yori -f deployment/compose.yaml up -d api worker
curl -sS http://127.0.0.1:39119/health/live
curl -sS http://127.0.0.1:39119/health/ready
```

- APIは `YORI_API_PORT`（既定39119、loopbackのみ）で公開する。`YORI_API_PORT` を変えた場合、curlのportも合わせる。
- `npm run migrate` はmigrate service内で `src/db/migrations/*.sql` をファイル名昇順に1トランザクションで適用し、適用済みversionを`schema_migrations`で管理する。再実行しても適用済みmigrationは実行しない。M1は`0001_init.sql`、M3は`0002_m3.sql`、M7は`0007_m7.sql`。
- migrationを先に適用してから `api worker` を起動する。workerは`JEV_API_KEY`/`VOYAGE_API_KEY`等が無い場合、偽の判定・送信へ進まず起動に失敗する（`invalid_worker_config`）。設定と運用手順は [docs/worker.md](../docs/worker.md)、M4仕様は [docs/m4-design.md](../docs/m4-design.md) を参照する。
- DBはホストへ公開しない。手動で見る場合は `docker compose -p yori -f deployment/compose.yaml exec db psql -U yori -d yori` を使う。
- コンテナを通常停止しても `yori-pgdata` の原文は残る。消す場合だけ `docker compose -p yori -f deployment/compose.yaml down -v` を明示する。

## イベント受付の契約

`POST /v1/events` は合成fixtureや端末収集アダプターからの会話イベントを受ける。`<token>`は社員へ発行した生tokenで、DBにはSHA-256のみ保存されている。

```sh
curl -sS -X POST http://127.0.0.1:39119/v1/events \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"project_id":"<project-uuid>","events":[{"idempotency_key":"idem-1","source":"codex","source_scope":"repo-a","source_session_id":"session-1","source_message_id":"msg-1","sequence_no":1,"revision":1,"role":"user","occurred_at":"2026-09-21T01:00:00.000Z","text":"改行\nも原文のまま保存する"}]}'
```

- body上限1MiB、`events`は1..100件。strict Zod検証でunknown field・不正な型・範囲外は400、body超過は413。
- 認証は `Authorization: Bearer <token>`。token欠落・不正・失効は401、会社・project・project_membersの不一致は403で、どちらもDBへ書かない。
- `project_id` はUUIDの表記ゆれを正規化し、大文字表記を受理しても以降は小文字の正規形として保存・比較・冪等判定する。
- `user`ロールは原文・`classify_message` job・自動検索受付(`search_requests`)・`route_search` jobを同一トランザクションで保存し202を返す。`assistant`/`agent_report`は自動検索を作らない。
- `text`はUnicodeコードポイントで1..65536。`message_revisions.content_hash`はUTF-8バイト列のSHA-256で、空白・改行・末尾空白を無加工で保存する。
- `idempotency_key`・`source_scope`・`source_session_id`・`source_message_id`・`text`はNULと単独サロゲート（不正UTF-16）を400で拒否し、DBへ書かない。有効なサロゲートペアは保持する。
- `source_scope`・`source_session_id`・`source_message_id`は、それぞれUTF-8で1024バイトまで。日本語や絵文字もバイト数で判定し、超過は切り詰めず400で拒否する。scopeにサーバーが付ける会社・社員の接頭辞は入力上限に含めない。sessionの複合索引を含めて保存可能なサイズに収めるための制限で、本文の65536コードポイント上限とは別。
- `revision`は1から始まり、更新は`current_revision + 1`のみ。同revision同本文の再送は既存IDを返し、同revision異本文、session/sequence_no/role/occurred_atの変更、revision飛越しは409。
- 冪等キーは(company, employee, idempotency_key)で一意。`event_receipts.request_hash`は`src/api/contract.ts`の`RECEIPT_PAYLOAD_KEYS`順のcanonical JSON（`occurred_at`は受信した文字列のまま）のSHA-256。

## ジョブキュー

`src/jobs/queue.ts` はPostgreSQLの`SELECT ... FOR UPDATE SKIP LOCKED`とleaseでjobを確保する。

- 分類(`classify_message`, priority 10)は同sessionの先行jobがpending/running/failed/blocked_policyの間は後続をclaimせず、`messages.sequence_no`→`target_revision`昇順で進む。未受信のsequence_noは待たない。
- 同sessionの分類claimはsession単位のtry advisory transaction lockで直列化し、lock取得後に新しいsnapshotでrunning中の分類・先行sequence_no/revisionを再確認する。lockが取れないsessionはskipし、同TX内で追加したrunningも再確認の対象にする。
- `route_search`(priority 100)は分類の状態に依存せずclaimする。別sessionの分類と`route_search`は、他sessionのlock中でも並行して進む。
- 完了はjob id・lease token・未失効lease・対象revisionが一致する場合だけ。期限切れleaseはrecoverでpendingへ戻す。
- 一時障害は指数バックオフ+jitter/Retry-Afterでpending、恒久エラーはfailed、ポリシー未確認はblocked_policyとして保持する。

## 実装範囲

M1実装済み: Compose、PostgreSQL 18+pgvector、migration、`POST /v1/events`（認証・strict検証・冪等保存・revision・自動検索受付・同一TXのjob登録）、永続jobキュー、`GET /health/live`・`GET /health/ready`、原文のコンテナ再作成後の永続化。

M2実装済み: `src/collector/`の端末収集（Codex/Claude Codeアダプター、設定Zod検証、SQLite outbox/cursor/診断、project対応表・remote正規化、送信batch・backoff・明示再送、`collect`/`flush`/`diagnostics` CLI）。導入・設定例・対応版・再送手順は [docs/collector.md](../docs/collector.md) を参照する。

M3実装済み: `src/worker/`のJev分類・選別・承認/撤回関係・検索振り分けworker（route/classifyの2 lane、lease更新・期限切れ回収、承認確認、評価キャッシュ、usage記録、`worker:start`/`worker:retry`/`provider:approve`/`provider:revoke` CLI）。new_searchは`execute_search`をpendingで保存するところまで。

M4実装済み: 決定的な文書分割、VoyageEmbeddingProvider（学習利用条件の送信ゲート、世代管理、原文対応、embedding_cache、runner/retry対応）。仕様は [docs/m4-design.md](../docs/m4-design.md) を参照する。

M5実装済み: `execute_search`、案件内の厳密vector検索、明示識別子完全一致検索、RRF、Jev候補判定、原文根拠付き結果保存。仕様は [docs/m5-design.md](../docs/m5-design.md) を参照する。

M6実装済み: 自動検索結果と追加検索のHTTP API、原文取得、短い対応記録、ローカルstdio MCP。仕様は [docs/m6-design.md](../docs/m6-design.md)、設定は [docs/mcp.md](../docs/mcp.md) を参照する。

M7実装済み: `session_links`、`POST /v1/session-links`、MCP `link_session`、代表根拠の前後・引き継ぎ・訂正／撤回探索、上限・循環検知、結果取得時の再検証、collector補助通知。仕様は [docs/m7-design.md](../docs/m7-design.md) を参照する。

M8実装済み: 世代別再索引（`worker:reindex`）、明示的な世代削除（`worker:generation-delete`）、project scopeの運用metrics（`worker:metrics`）、検索要求の開始世代固定、DB検索duration観測、production profileのCaddy HTTPS gateway、運用・増設手順。再索引・世代切替は旧activeを維持したままcandidate generationへ現在searchableなdesired_revisionを埋め込み、全件整合性確認後に `projects.active_generation_id` を原子的に切り替える。provider specは現在1024次元固定で、既存の `document_embeddings` / `embedding_cache` 物理tableを使う。別モデル・別次元は同じtableへ混在させず、別migration・別物理tableの追加を必要とする。runtime DDLは行わない。

収集工程を含め、実Jev/Voyage・実会話・実クラウドはテストで使用しない。外部AIへ実データを送る前に、管理者が学習利用条件と承認を確認する。

## M8の再索引・世代切替

現在の `WorkerConfig`（`VOYAGE_*`）の完全provider specで新しいcandidate generationを作り、対象projectの現在searchableなdesired_revisionだけをbatchで再埋め込みする。project単位のadvisory lockで同じprojectの同時reindexを拒否し、未完了run（pending / running / blocked_policy）は同じtarget generationでresumeする。

```sh
# migration適用後、通常serviceを起動する（caddyは含まれない）
docker compose -p yori -f deployment/compose.yaml --profile tools run --rm migrate
docker compose -p yori -f deployment/compose.yaml up -d api worker
docker compose -p yori -f deployment/compose.yaml run --rm worker npm run worker:reindex -- <project-uuid>
```

- 再索引中も旧generationのactive検索を継続する。cutoverは `projects` 行を `FOR UPDATE` し、全current searchable desired revisionのtarget embedding・publication・stale=false・input_hash一致を再確認してから、`projects.active_generation_id` をtargetへ変更する。
- 不足があれば切替せず、未公開のtarget publicationを掃除して再走査する。進展がない場合はrunをpendingへ戻し、次回の `worker:reindex` でresumeする。
- 学習利用条件が未承認ならrunを `blocked_policy` にし、外部送信0件で旧activeを維持する。承認後の再実行でresumeする。429/5xx/timeout等のretry可能障害はrunをpendingに、400/401/403/422・応答契約不正はrunとtarget generationをfailedにする。
- 旧generationの削除は明示CLIだけが行う。active project、未完了reindex runのsource/target、pending/runningのsearch requestが参照する世代は削除を拒否する。

```sh
docker compose -p yori -f deployment/compose.yaml run --rm worker npm run worker:generation-delete -- <generation-uuid>
```

## M8の運用metricsと性能手順

`worker:metrics <project-uuid>` はproject scopeのJSONだけをstdoutへ返し、本文・credential・検索条件を含めない。

```sh
docker compose -p yori -f deployment/compose.yaml run --rm worker npm run worker:metrics -- <project-uuid>
```

- `generations`：generation別の `documents`（searchableかつpublicationあり）、`vectors`（embedding件数）、`estimated_vector_bytes`（`vectors × (4×dimensions+8)`）。
- `reindex.pending_documents`：最新未完了runのtargetで未完了の現在searchable desired revision件数。runが無ければ0。
- `search_duration_ms`：DB候補検索durationの `samples` / `p50` / `p95`（project scope、0件は0）。
- `jobs`：pending / running / completed / failed / blocked_policyの件数（session→projectでjoin）。

Lightsail等のLinux VMへ配置する手順の出発点:

1. VMは2 GBから開始する。Docker EngineとComposeを導入し、22/tcp（管理・通常は送信元IP制限）、80/tcp、443/tcp・443/udpだけをfirewallで許可する。DB portは公開しない。
2. DNSで `YORI_DOMAIN` をVMの公開IPへ向ける。`YORI_DOMAIN` を実domainにしてproduction profileを起動すると、Caddyがautomatic HTTPSで証明書を取得する。80はACMEとHTTPS redirectに使う。
3. `docker compose -p yori -f deployment/compose.yaml --profile tools run --rm migrate` でmigrationを適用してから、`docker compose -p yori -f deployment/compose.yaml --profile production up -d` でapi・worker・db・caddyを起動する。apiのhost公開はloopbackのみ、caddy data/configとPostgreSQLはnamed volumeへ永続化される。
4. `curl -sS https://<YORI_DOMAIN>/health/live` と `/health/ready`、`docker compose -p yori -f deployment/compose.yaml ps` でhealthを確認する。
5. 更新は対象fileの変更後にmigrationとworkerを先に更新し、`docker compose ... up -d` で再作成する。問題時は直前のimage digestとmigrationへ戻し、DBは `down -v` を実行しない（volumeを保持する）。ただし単一VM・バックアップなしのため、rollbackの保証範囲はこのVM内に限る。
6. 資源は `docker stats`、`df -h`、`docker system df`、composeのjson-file log rotation（max-size 10m / max-file 3）で監視する。metricsの `search_duration_ms.p50/p95` と `reindex.pending_documents`、job滞留を確認する。
7. 2 GBでOOM・継続的スワップ・待ち行列増加が出た場合は、4 GBへ増設してからDB・workerを再起動する。スワップを性能改善の中心にしない。DBは `shared_buffers=256MB` / `work_mem=4MB` / `maintenance_work_mem=64MB` を出発点とする。
8. 外部Jev/Voyageへ実データを送る前に、管理者が学習利用条件・保持条件を確認し、`provider:approve` で承認を登録する。未承認の間は再索引も `blocked_policy` で外部送信しない。

## テスト

テストは合成fixtureだけを使い、実会話・外部Jev/Voyageへは送信しない。テストは専用Compose file `deployment/compose.test.yaml` と専用Compose project `yori-test` を使い、volumeはfileで`name`を指定せずprojectスコープで隔離する。そのためテスト用の`down -v`が開発用の `yori-pgdata` / `yori-node-modules` / `yori-npm-cache` を削除することはない。開発用composeのvolumeはテストから変更しない。

```sh
npm test                 # srcテスト (container内) → deploymentテスト (ホスト) の順に実行
npm run test:deployment  # deploymentテストのみ（同じテスト用project/volume）
npm run test:src         # compose test service内で実行されるスクリプト。ホストではDATABASE_URLが無いため動かない
npm run migrate          # compose migrate service内で実行されるスクリプト
```

テストAPIは開発用(39119)と分離した既定39120 (`YORI_API_PORT`) で起動する。srcテストは`compose run --rm test`、migrationは`compose run --rm migrate`で実行する。DBはポート非公開なのでホストから直接は接続できない。

dockerは標準のcontext/config/DOCKER_HOST/DOCKER_CONFIGを使う（`run-tests.mjs` と `docker.ts` はsocket・configを固定しない）。このマシンで検証する場合も、必要な環境変数は呼出し側から渡す。テスト用のproject名とAPI portは環境変数で上書きできる（`YORI_TEST_PROJECT`、`YORI_API_PORT`）。

- DBはホストへ公開しない。接続はCompose network内の `db:5432` のみ。
- テスト用volumeを消す場合だけ `docker compose -p yori-test -f deployment/compose.test.yaml down -v` を明示する。テスト専用fileとprojectスコープvolumeだけを対象にするため、開発用の `yori-pgdata` は消えない。
- 開発用compose（`deployment/compose.yaml`）に対する`down -v`は開発DBの`yori-pgdata`を消すため、テストの後始末では使わない。
- macOSに`timeout`は無い。長い出力はpipeせずリダイレクトしてファイルから読む。
