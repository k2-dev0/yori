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

## テスト

テストは合成fixtureだけを使う専用テストで、実会話・外部Jev/Voyageへは送信しない。開発用composeと同じDB・volumeを触らないよう、テストは専用Compose project `yori-test` と専用volume `yori-test-pgdata` / `yori-test-node-modules` / `yori-test-npm-cache` を使う（`run-tests.mjs` と `deployment/tests/docker.ts` が指定）。開発用の `yori-pgdata` は通常composeのDB永続化用であり、テストからは変更しない。

```sh
npm test                 # srcテスト (container内) → deploymentテスト (ホスト) の順に実行
npm run test:deployment  # deploymentテストのみ（同じテスト用project/volume）
npm run test:src         # compose test service内で実行されるスクリプト。ホストではDATABASE_URLが無いため動かない
npm run migrate          # compose migrate service内で実行されるスクリプト
```

srcテストは`compose run --rm test`、migrationは`compose run --rm migrate`で実行する。DBはポート非公開なのでホストから直接は接続できない。

dockerは標準のcontext/config/DOCKER_HOST/DOCKER_CONFIGを使う（`run-tests.mjs` と `docker.ts` はsocket・configを固定しない）。このマシンで検証する場合も、必要な環境変数は呼出し側から渡す。テスト用のproject/volume名は環境変数で上書きできる（`YORI_TEST_PROJECT`、`YORI_TEST_PGDATA_VOLUME`、`YORI_TEST_NODE_MODULES_VOLUME`、`YORI_TEST_NPM_CACHE_VOLUME`）。

- DBはホストへ公開しない。接続はCompose network内の `db:5432` のみ。
- テスト用volumeを消す場合だけ `docker compose -p yori-test -f deployment/compose.yaml down -v` を明示する。開発用の `yori-pgdata` は消えない。
- macOSに`timeout`は無い。長い出力はpipeせずリダイレクトしてファイルから読む。
