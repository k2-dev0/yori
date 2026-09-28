# deployment

M1のサーバーとテスト専用Compose、M2の端末収集の導入先。既存のCompose project・DB・Docker設定は変更しない。端末への導入・設定・再送手順は [docs/collector.md](../docs/collector.md) を参照する。

## 構成

通常起動は `deployment/compose.yaml`（project `yori`）、テストは `deployment/compose.test.yaml`（project `yori-test` 等）を使う。

| file | service | 役割 |
|---|---|---|
| compose.yaml | db | pgvector/pgvector:0.8.6-pg18-trixie。ポート公開なし。volume `yori-pgdata`（本番固定名。`YORI_PGDATA_VOLUME`では変更しない）を `/var/lib/postgresql` (PG18 layout) へマウント |
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

開発用はCompose project `yori`、DB volume `yori-pgdata` を使う。production composeは10キーの必須envを要求するため、開発でもリポジトリ直下の`.env`（Git除外）へ`.env.example`をコピーして値を設定しておく。1つでも未設定・空だと`docker compose config`が失敗する。

```sh
cp .env.example .env
# .env のplaceholderを開発用の値へ置き換える（YORI_POSTGRES_PASSWORDは小文字64桁hex）
docker compose -p yori -f deployment/compose.yaml up -d --wait db
docker compose -p yori -f deployment/compose.yaml --profile tools run --rm migrate
docker compose -p yori -f deployment/compose.yaml up -d api worker
curl -sS http://127.0.0.1:39119/health/live
curl -sS http://127.0.0.1:39119/health/ready
```

- APIは `YORI_API_PORT`（既定39119、loopbackのみ）で公開する。`YORI_API_PORT` を変えた場合、curlのportも合わせる。
- `npm run migrate` はmigrate service内で `src/db/migrations/*.sql` をファイル名昇順に1トランザクションで適用し、適用済みversionを`schema_migrations`で管理する。再実行しても適用済みmigrationは実行しない。M1は`0001_init.sql`、M3は`0002_m3.sql`、M7は`0007_m7.sql`。
- migrationを先に適用してから `api worker` を起動する。workerは`JEV_API_KEY`/`VOYAGE_API_KEY`等が無い場合、偽の判定・送信へ進まず起動に失敗する（`invalid_worker_config`）。設定と運用手順は [docs/worker.md](../docs/worker.md)、M4仕様は [docs/m4-design.md](../docs/m4-design.md) を参照する。
- DBはホストへ公開しない。手動で見る場合はcontainer内の`POSTGRES_USER`/`POSTGRES_DB`を使う `docker compose -p yori -f deployment/compose.yaml exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'` を使う。
- コンテナを通常停止しても `yori-pgdata` の原文は残る。本番では`down -v`を実行しない（volumeを消すと原文が失われる）。開発でvolumeを消す場合だけ `docker compose -p yori -f deployment/compose.yaml down -v` を明示する。

## 本番設定 (Lightsail)

production compose (`deployment/compose.yaml`) は次の10キーをすべて必須とする。1つでも未設定・空だとComposeのrequired interpolationで`docker compose config`が失敗し、serviceは起動しない。値はrepositoryへ保存せず、Lightsail VMの`/etc/yori/yori.env`から渡す。

| 変数 | secret | 用途 |
|---|---|---|
| `YORI_POSTGRES_USER` | いいえ | PostgreSQL role。初期値を暗黙補完しない |
| `YORI_POSTGRES_PASSWORD` | はい | PostgreSQL password。`openssl rand -hex 32`の小文字64桁hex |
| `YORI_POSTGRES_DB` | いいえ | database名 |
| `YORI_DOMAIN` | いいえ | Caddyの公開host |
| `JEV_API_KEY` | はい | Jev credential |
| `JEV_ACCOUNT_REF` | いいえ | Jev承認・usageのaccount参照 |
| `JEV_API_URL` | いいえ | Jev endpoint（HTTPS固定運用） |
| `VOYAGE_API_KEY` | はい | Voyage credential |
| `VOYAGE_ACCOUNT_REF` | いいえ | Voyage承認・usageのaccount参照 |
| `VOYAGE_API_URL` | いいえ | Voyage endpoint（HTTPS固定運用） |

`x-database-environment`のYAML anchorで`DATABASE_URL`を1箇所に定義し、api・worker・migrateへ `postgres://${YORI_POSTGRES_USER}:${YORI_POSTGRES_PASSWORD}@db:5432/${YORI_POSTGRES_DB}` として渡す。dbの`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`も同じ`YORI_POSTGRES_*`を使う。healthcheckはcontainer内の`$$POSTGRES_USER`/`$$POSTGRES_DB`を参照する。

本番DB volumeは`deployment/compose.yaml`で`yori-pgdata`へ固定しており、`YORI_PGDATA_VOLUME`等の外部envで別名へ変更できない。意図しない別名volumeで空DBを初期化しない。本番手順に`down -v`を含めず、通常停止ではvolumeを保持する。

### 1. `/etc/yori/yori.env` をroot:root 0600で作成する

```sh
sudo install -d -m 0755 /etc/yori
sudo touch /etc/yori/yori.env
sudo chown root:root /etc/yori/yori.env
sudo chmod 0600 /etc/yori/yori.env
sudo vi /etc/yori/yori.env
```

- 書式は`.env.example`と同じ`KEY=VALUE`。placeholderを実値へ置き換える。
- 実secretを`docker compose`や`node`のcommand line引数へ書かず、`--env-file /etc/yori/yori.env`で渡す。env fileはroot:root 0600なので、これを読む`docker compose`・`node`の各CLI commandは`sudo`で実行する。
- `YORI_POSTGRES_PASSWORD`は`openssl rand -hex 32`が出力する小文字64桁hexを使う（`@`等のURL予約文字を含まない）。

### 2. 設定を検査する

```sh
cd <repository>
sudo node --env-file=/etc/yori/yori.env deployment/check-production-config.mjs
sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml --profile tools config > /dev/null
```

- `node --env-file=/etc/yori/yori.env`はNode 24がenv fileを読み、env fileをshのsourceとして評価しない。`/etc/yori/yori.env`はroot:root 0600のため読み取る`node` commandへ`sudo`を付ける。値はcommand lineへ書かない。
- `deployment/check-production-config.mjs`はprocess.envの10キーの未設定・空と、`YORI_POSTGRES_PASSWORD`が小文字64桁hexであることを検査する。成功0・失敗非0で、検査値は出力しない。
- Compose CLIも`--env-file /etc/yori/yori.env`を自身で読むため、productionの`docker compose` commandはすべて`sudo docker compose --env-file /etc/yori/yori.env ...`で実行する。一般ユーザーではroot:root 0600のenv fileを読めずpermission deniedになる。`--env-file`を省いたり値をcommand lineへ渡したりしない。

### 3. 初期構築順序

1. `db`だけを起動してhealthcheckを待つ。
2. tools profileの`migrate`を1回実行する。
3. 別repositoryの`yori-cli bootstrap`で会社・社員・案件・所属・tokenを登録する。
4. db起動後、api/worker本起動前に`provider:approve`でJev／Voyageの承認を登録する（実データを外部AIへ送る前に実施）。
5. production profileでapi・worker・db・caddyを起動する。
6. health・TLS・job・metricsを確認する。

```sh
sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml up -d --wait db
sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml --profile tools run --rm migrate
# yori-cli bootstrap（下記のexternal network接続）
sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml run --rm --no-deps worker npm run provider:approve -- /path/to/approval.json
sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml --profile production up -d
curl -sS https://<YORI_DOMAIN>/health/live
curl -sS https://<YORI_DOMAIN>/health/ready
sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml ps
```

- `provider:approve`は`run --rm --no-deps worker`で実行する。`--no-deps`はapi/workerを起動せず、手順1で起動済みのdbへ同一networkで接続する前提。承認JSONはcredentialを含めない。順序の詳細は[docs/worker.md](../docs/worker.md)を参照する。
- DBはホストへ公開しない。Caddyだけが80/tcp・443/tcp・443/udpを外部公開する。

### 4. yori-cliの接続契約

`yori-cli`は別repository・別Compose projectとし、yori本体のexternal network `yori_default`へ参加して`db:5432`へ接続する。接続はyori本体と同じ`YORI_POSTGRES_*`（`/etc/yori/yori.env`の値）を使い、固定資格情報へfallbackしない。yori本体側のコード・Compose変更は不要で、実装は別repositoryの責務とする。

### 5. 手動DB操作

```sh
sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

### 6. 更新とrollback

更新前に正確なGit commitと`deployment/compose.yaml`（image digest・profile・volume名）を記録し、互換性を確認してから対象commitへ移動する。

```sh
sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml --profile tools run --rm migrate
sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml --profile production up -d --force-recreate api worker caddy
```

- migrationはforward-onlyで、down migrationは提供しない。適用済みschemaは旧migration fileや旧base imageへ戻しても戻らない。
- rollbackできるのは、適用済みschemaと後方互換な旧sourceへ戻し、依存を復元し、api/worker/caddyを同じく明示再作成する場合だけ。非互換なschema変更後はこの手順だけではrollbackできず、事前に取得した管理者snapshotからのrestoreまたはforward fixが必要。
- 自動backupは今回の実装対象外で、単一VM・バックアップなしのため保証範囲はこのVM内に限る。

### 7. password rotation

1. 新しい小文字64桁hexを生成する（`openssl rand -hex 32`）。
2. `psql`で`ALTER ROLE`を実行し、DB内部のpasswordを変更する。secretは対話SQLで入力し、command line引数やshell historyへ残さない。
3. `/etc/yori/yori.env`の`YORI_POSTGRES_PASSWORD`を新しい値へ更新する。
4. `api`・`worker`を`--force-recreate`で再作成し、`migrate` serviceを同じenvで再実行（再作成）する。
5. 設定検査とhealthを再確認する。

公式PostgreSQL imageの`POSTGRES_*`は、空のdata directoryを最初に初期化する時だけrole・database・passwordを作る。既存`yori-pgdata`にenv変更だけをしてもDB内部のpasswordは変わらないため、env更新だけをrotation完了と扱わない。

### 8. user・database名変更

user名・database名の変更は`ALTER ROLE`・`ALTER DATABASE`や新規DB作成・データ移行を伴う新規DB migrationとして扱い、`YORI_POSTGRES_*`だけを黙って変更しない。変更手順は本番volumeのsnapshot取得後に実施する。

### 9. snapshotと復旧試験

- 本番DB volumeは`deployment/compose.yaml`で`yori-pgdata`固定。`YORI_PGDATA_VOLUME`等で別名を渡しても変わらず、意図しない別名の空DBを作らない。
- 実社員データ投入直前にLightsail自動snapshotを有効にする。大きなmigration・更新の前にも手動snapshotを取得する。
- Lightsail instanceを削除する前には、保持が必要な自動snapshotをmanual snapshotとして明示的に保持する。自動snapshotはinstance削除時に失われるため、削除後も復旧点を残すにはmanual snapshotが必要。削除前に管理者が保持対象（実社員データ投入後・大きなmigration適用後などの復旧点）を確認する。
- 復旧試験はsnapshotから別instanceを作成し、`yori-pgdata`、migration version、healthを確認する。元instanceへ破壊的に上書きしない。
- `docker compose down`ではvolumeを保持する。本番手順に`down -v`を含めない。`down -v`は`yori-pgdata`の原文を削除するため実行しない。instance snapshotはPostgreSQLの論理backupやPITRの代替ではない。

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
- `text`の秘匿値（秘密鍵・各社APIキー・JWT・URL資格情報・`PASSWORD=`等の代入値・Authorizationヘッダ）は`[REDACTED:<種類>]`へ置換してから保存し、`content_hash`・receipt hash・revision比較も置換後の本文で行う。`POST /v1/searches`の`query`も同じ置換を通す。既知形式と代入形だけを対象にし、名前・区切り・他の文字は変えない。
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
sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml --profile tools run --rm migrate
sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml up -d api worker
sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml run --rm worker npm run worker:reindex -- <project-uuid>
```

- 再索引中も旧generationのactive検索を継続する。cutoverは `projects` 行を `FOR UPDATE` し、全current searchable desired revisionのtarget embedding・publication・stale=false・input_hash一致を再確認してから、`projects.active_generation_id` をtargetへ変更する。
- 不足があれば切替せず、未公開のtarget publicationを掃除して再走査する。進展がない場合はrunをpendingへ戻し、次回の `worker:reindex` でresumeする。
- 学習利用条件が未承認ならrunを `blocked_policy` にし、外部送信0件で旧activeを維持する。承認後の再実行でresumeする。429/5xx/timeout等のretry可能障害はrunをpendingに、400/401/403/422・応答契約不正はrunとtarget generationをfailedにする。
- 旧generationの削除は明示CLIだけが行う。active project、未完了reindex runのsource/target、pending/runningのsearch requestが参照する世代は削除を拒否する。

```sh
sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml run --rm worker npm run worker:generation-delete -- <generation-uuid>
```

## M8の運用metricsと性能手順

`worker:metrics <project-uuid>` はproject scopeのJSONだけをstdoutへ返し、本文・credential・検索条件を含めない。

```sh
sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml run --rm worker npm run worker:metrics -- <project-uuid>
```

- `generations`：generation別の `documents`（searchableかつpublicationあり）、`vectors`（embedding件数）、`estimated_vector_bytes`（`vectors × (4×dimensions+8)`）。
- `reindex.pending_documents`：最新未完了runのtargetで未完了の現在searchable desired revision件数。runが無ければ0。
- `search_duration_ms`：DB候補検索durationの `samples` / `p50` / `p95`（project scope、0件は0）。
- `jobs`：pending / running / completed / failed / blocked_policyの件数（session→projectでjoin）。

Lightsail等のLinux VMへ配置する手順の出発点（詳細は「本番設定 (Lightsail)」）:

1. VM上で`/etc/yori/yori.env`をroot:root 0600で作成し、`sudo node --env-file=/etc/yori/yori.env deployment/check-production-config.mjs`で10キーとpassword形式を検査する。
2. VMは2 GBから開始する。Docker EngineとComposeを導入し、22/tcp（管理・通常は送信元IP制限）、80/tcp、443/tcp・443/udpだけをfirewallで許可する。DB portは公開しない。
3. DNSで `YORI_DOMAIN` をVMの公開IPへ向ける。`YORI_DOMAIN` を実domainにしてproduction profileを起動すると、Caddyがautomatic HTTPSで証明書を取得する。80はACMEとHTTPS redirectに使う。
4. `sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml up -d --wait db` でdbを起動し、`sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml --profile tools run --rm migrate` でmigrationを適用する。yori-cli bootstrapと`run --rm --no-deps worker npm run provider:approve -- ...`の後、`sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml --profile production up -d` でapi・worker・db・caddyを起動する。apiのhost公開はloopbackのみ、caddy data/configとPostgreSQLはnamed volumeへ永続化される。
5. `curl -sS https://<YORI_DOMAIN>/health/live` と `/health/ready`、`sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml ps` でhealthを確認する。
6. 更新・rollback: このComposeのnode serviceはホストのsource treeを `/app` へbind mountするため、Node imageのdigestは**アプリ版を固定しない**（依存導入と実行環境の版）。アプリ版はGit commitで管理する。更新前に正確なGit commitと`deployment/compose.yaml`（image digest・profile・volume名）を記録し、互換性を確認してから対象commitへ移動する。`sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml --profile tools run --rm migrate` でmigrationを適用し、`sudo docker compose --env-file /etc/yori/yori.env -p yori -f deployment/compose.yaml --profile production up -d --force-recreate api worker caddy` のようにserviceを明示再作成して新しいsourceを読み直させる。`down -v` は実行しない（volumeを保持する）。
   - migrationはforward-onlyで、down migrationは提供しない。適用済みschemaは旧migration fileや旧base imageへ戻しても戻らない。
   - rollbackできるのは、適用済みschemaと後方互換な旧sourceへ戻し、依存を復元し、api/worker/caddyを同じく明示再作成する場合だけ。非互換なschema変更後はこの手順だけではrollbackできず、事前に取得した管理者snapshotからのrestoreまたはforward fixが必要。自動backupは今回の実装対象外で、単一VM・バックアップなしのため保証範囲はこのVM内に限る。
7. 資源は `docker stats`、`df -h`、`docker system df`、composeのjson-file log rotation（max-size 10m / max-file 3）で監視する。metricsの `search_duration_ms.p50/p95` と `reindex.pending_documents`、job滞留を確認する。
8. 2 GBでOOM・継続的スワップ・待ち行列増加が出た場合は、4 GBへ増設してからDB・workerを再起動する。スワップを性能改善の中心にしない。DBは `shared_buffers=256MB` / `work_mem=4MB` / `maintenance_work_mem=64MB` を出発点とする。
9. 外部Jev/Voyageへ実データを送る前に、管理者が学習利用条件・保持条件を確認し、`provider:approve` で承認を登録する。未承認の間は再索引も `blocked_policy` で外部送信しない。password rotation・user名変更・snapshot復旧は「本番設定 (Lightsail)」を参照する。
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
