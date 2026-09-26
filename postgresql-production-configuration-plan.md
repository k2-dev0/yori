# yori PostgreSQL本番配置・設定実装計画

- 作成日: 2026-09-26
- 対象: Lightsail本番環境のPostgreSQL、DB資格情報、Compose設定、migration導線
- 状態: 実装前。preflight確認済み
- 目的: PostgreSQLの配置場所と本番設定を確定し、固定資格情報を排除する

## 1. 結論

PostgreSQLは別のRDSやLightsail Managed Databaseへ置かず、作成済みのyori専用Lightsail 2 GBインスタンス上でDocker Composeの`db`サービスとして稼働させる。

```text
Lightsail 2 GB / Ubuntu 24.04
├─ Caddy              外部公開: 80/443
├─ yori API           hostはloopback、Compose内はapi:3210
├─ yori worker        Jev／Voyageへ外向きHTTPS
└─ PostgreSQL+pgvector Compose内db:5432、外部公開なし
   └─ named volume yori-pgdata
```

DBデータはinstance root filesystem上のDocker named volume`yori-pgdata`へ永続化する。コンテナを再作成しても残るが、instance削除・volume削除・ディスク障害からは自動復旧しない。実社員データの投入直前にLightsail自動snapshotを有効にする。

現在の`yori:yori`固定資格情報は廃止する。本番用値はLightsailの`/etc/yori/yori.env`からDocker Composeへ渡す。repositoryへ実値を保存しない。

## 2. 確認済みの既存構成

- `db`は`pgvector/pgvector:0.8.6-pg18-trixie`をdigest固定で使う。`deployment/compose.yaml:26-31`
- DBはhost portを公開していない。`deployment/compose.yaml:25-54`
- PostgreSQL dataは`yori-pgdata:/var/lib/postgresql`へ保存される。`deployment/compose.yaml:42-43,133-136`
- APIとmigrateは共通node serviceの`DATABASE_URL`を使う。`deployment/compose.yaml:5-18,124-131`
- workerは独自environment内の`DATABASE_URL`を使う。`deployment/compose.yaml:73-98`
- 現在のDB user、password、database、URLは`yori`固定である。`deployment/compose.yaml:13,29-31,85`
- PostgreSQL初期値はshared_buffers 256 MB、work_mem 4 MB、maintenance_work_mem 64 MB、statement_timeout 30秒である。`deployment/compose.yaml:32-41`
- production testはDB非公開、API loopback、Caddy 80/443、named volume、log rotationを確認している。`deployment/tests/m8.test.ts:86-154`
- 通常composeとtest composeはproject/volumeを分離している。`deployment/tests/compose.test.ts:64-128`

## 3. 対象範囲

### 3.1 エージェントが実装するもの

1. production ComposeのDB資格情報を必須環境変数化。
2. API、worker、migrate、db healthcheckで同じ設定を使う構造。
3. 追跡可能な`.env.example`。
4. 実`.env`を除外する`.gitignore`。
5. 未設定・不整合・既定password残存を検出するCompose contract test。
6. DB初期化、migration、更新、資格情報変更、volume保持の手順。
7. yori-cliから同じDBへ接続する運用契約。
8. production profile起動前の設定検査手順。

### 3.2 対象外

- Lightsail作成、firewall、Static IP、DNS、domain購入。
- `/etc/yori/yori.env`への実秘密値入力。
- AWS IAM、secret manager、KMS。
- RDS、Lightsail Managed Database、外部PostgreSQL。
- PostgreSQLの外部port公開。
- 自動backup、別region複製、PITR。
- 会社・社員・案件のbootstrap。別repository`yori-cli`の責務。
- 本番API keyの発行・失効。

## 4. 本番環境変数契約

production Composeで次を使用する。

| 変数 | 秘密 | 用途 |
|---|---|---|
| `YORI_POSTGRES_USER` | いいえ | PostgreSQL role。初期値を暗黙補完しない |
| `YORI_POSTGRES_PASSWORD` | はい | PostgreSQL password。64桁hexを運用基準とする |
| `YORI_POSTGRES_DB` | いいえ | database名 |
| `YORI_DOMAIN` | いいえ | Caddyの公開host |
| `JEV_API_KEY` | はい | Jev credential |
| `JEV_ACCOUNT_REF` | いいえ | provider承認・usageのaccount参照 |
| `JEV_API_URL` | いいえ | 固定endpoint |
| `VOYAGE_API_KEY` | はい | Voyage credential |
| `VOYAGE_ACCOUNT_REF` | いいえ | provider承認・usageのaccount参照 |
| `VOYAGE_API_URL` | いいえ | 固定endpoint |

DB接続URLはCompose内で次の契約から組み立てる。

```text
postgres://${YORI_POSTGRES_USER}:${YORI_POSTGRES_PASSWORD}@db:5432/${YORI_POSTGRES_DB}
```

passwordはURL予約文字を含まない64桁hexに限定する運用契約とし、二重のURL encoding手順を不要にする。Composeだけで文字種検証できないため、設定検査scriptまたはtestで空値・予約文字・長さを検出する。

`POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`は同じ`YORI_POSTGRES_*`からdb containerへ渡す。API、worker、migrateへ別のpasswordやdatabase名を設定させない。

### 4.1 `.env.example`

repository直下へ値なしの例を追加する。

```text
YORI_POSTGRES_USER=yori
YORI_POSTGRES_PASSWORD=<64-hex-secret>
YORI_POSTGRES_DB=yori
YORI_DOMAIN=example.invalid
JEV_API_KEY=<secret>
JEV_ACCOUNT_REF=<account-reference>
JEV_API_URL=https://api.typesafe.ai/v1/systemone
VOYAGE_API_KEY=<secret>
VOYAGE_ACCOUNT_REF=<account-reference>
VOYAGE_API_URL=https://api.voyageai.com/v1/embeddings
```

実値、実domain、実account ref、実API keyをexampleへ書かない。

### 4.2 Git除外

- `.env`、`.env.*`、`*.env`を除外する。
- `.env.example`だけは追跡対象として例外指定する。
- `/etc/yori/yori.env`はrepository外なので追跡しない。
- test fixture secretは合成固定値だけを使用し、実値に似せない。

## 5. Compose実装方針

YAML anchorでDB接続設定を一箇所へ集約し、API・worker・migrateのdriftを防ぐ。秘密値にdefaultを置かず、Composeのrequired interpolationで未設定時に`docker compose config`を失敗させる。

概念形:

```yaml
x-database-environment: &database-environment
  DATABASE_URL: postgres://${YORI_POSTGRES_USER:?required}:${YORI_POSTGRES_PASSWORD:?required}@db:5432/${YORI_POSTGRES_DB:?required}
```

db container:

```yaml
environment:
  POSTGRES_USER: ${YORI_POSTGRES_USER:?required}
  POSTGRES_PASSWORD: ${YORI_POSTGRES_PASSWORD:?required}
  POSTGRES_DB: ${YORI_POSTGRES_DB:?required}
```

healthcheckはcontainer内の`POSTGRES_USER`と`POSTGRES_DB`を使い、`yori`をhardcodeしない。`$$`でCompose側の早期展開を避ける。

test専用`deployment/compose.test.yaml`は外部秘密を要求せず、現在の隔離された合成資格情報を維持する。本番composeだけを環境変数化し、test runnerへ実秘密を要求しない。

## 6. 配置とnetwork

- PostgreSQL container名ではなくCompose service名`db`で接続する。
- port 5432はCompose network`yori_default`内だけで使用する。
- hostの`0.0.0.0:5432`、`127.0.0.1:5432`のどちらにもpublishしない。
- 手動DB操作は`docker compose exec db psql`を使う。
- APIのhost portはloopbackのまま維持する。
- Caddyだけが80/tcp、443/tcp、443/udpを外部公開する。
- `yori-cli`は別Compose projectからexternal network`yori_default`へ参加し、`db:5432`へ接続する。

## 7. 初期構築順序

エージェント実装後のoperator契約は次の順とする。

1. `/etc/yori/yori.env`をroot所有・0600で作成する。
2. `docker compose --env-file /etc/yori/yori.env ... config`で検査する。
3. `db`だけを起動し、healthcheckを待つ。
4. tools profileの`migrate`を1回実行する。
5. `yori-cli bootstrap`で会社、社員、案件、所属、tokenを登録する。
6. `provider:approve`でJev／Voyage承認を登録する。
7. production profileでAPI、worker、Caddyを起動する。
8. health、TLS、job、metricsを確認する。

実行commandの確定版は`deployment/README.md`へ記録する。実秘密をcommand line引数へ書かず、`--env-file /etc/yori/yori.env`を使う。

## 8. PostgreSQL初期化と資格情報変更の制約

公式PostgreSQL imageの`POSTGRES_*`は空のdata directoryを最初に初期化するときだけrole・database・passwordを作る。既存`yori-pgdata`に対して環境変数を変えてもDB内部のpasswordは変わらない。

したがって次を固定する。

- 初回起動前に資格情報を確定する。
- 本番volume作成後、環境変数だけを変更してrotation完了と扱わない。
- password rotationはDB内role変更、env更新、API／worker／migrate再作成を一つの運用手順として行う。
- database名・user名変更は新規DB migrationとして扱い、黙ってenvだけを変えない。
- 開発用既存volumeの扱いを本番volumeへ流用しない。
- 本番では`YORI_PGDATA_VOLUME=yori-pgdata`を固定し、意図しない別名で空DBを作らない。

現在のLightsailではまだDBを起動していないため、新しい資格情報で空volumeを初期化できる。

## 9. 永続化・snapshot・復旧

- `docker compose down`ではvolumeを保持する。
- `docker compose down -v`を本番手順へ含めない。
- migrationはforward-onlyで、schema rollbackは行わない。
- 実社員データ投入直前にLightsail自動snapshotを有効にする。
- 大きなmigrationや更新前に手動snapshotを作成する。
- instance snapshotはPostgreSQL論理backupやPITRの代替ではないことを明記する。
- instance削除前は必要な自動snapshotをmanual snapshotとして保持する。
- 復旧試験はsnapshotから別instanceを作り、volume、migration version、healthを確認する。元instanceへ破壊的に上書きしない。

## 10. agent実装ファイル

| file | 変更 |
|---|---|
| `deployment/compose.yaml` | DB資格情報、共通DATABASE_URL、healthcheckの環境変数化 |
| `.env.example` | 値なしの本番設定契約 |
| `.gitignore` | 実env除外とexample例外 |
| `deployment/tests/compose.test.ts` | 必須env、固定password排除、service間整合性 |
| `deployment/tests/m8.test.ts` | DB非公開、volume、production secret契約の維持 |
| `deployment/README.md` | Lightsail配置、初期化、rotation、snapshot、yori-cli接続 |
| `docs/worker.md` | `--env-file`とprovider設定の起動例 |

必要なら本番設定検査用scriptを`deployment/`へ追加する。ただしCompose required interpolationとtestで要件を満たせる場合は新しい実行境界を作らない。

## 11. 必須テスト

- production composeはDB環境変数未設定時にconfig失敗する。
- 合成envを渡したconfigに`yori:yori`が残らない。
- dbのPOSTGRES値とAPI／worker／migrateのURLが同じuser・password・databaseを使う。
- healthcheckにuser/database hardcodeがない。
- DB portをhostへ公開しない。
- APIはloopback、Caddyだけが80/443を外部公開する。
- `yori-pgdata`、Caddy data/config、node_modules/cache volumeを維持する。
- test composeは本番secretを要求せず、開発volumeを共有しない。
- `.env.example`にplaceholderだけがあり、秘密らしい値が無い。
- `.env`がGitで無視され、`.env.example`は追跡可能である。
- migration再実行が適用済みversionを再実行しない。
- container再作成後も原文が残る既存E2Eが成功する。

## 12. 受け入れ条件

| ID | 条件 |
|---|---|
| PG-01 | PostgreSQLがLightsail同一VMのCompose `db`として稼働する |
| PG-02 | 5432をhostまたはinternetへ公開しない |
| PG-03 | 実password、API key、接続URLをrepositoryへ保存しない |
| PG-04 | 固定`yori:yori`資格情報をproduction composeから除去する |
| PG-05 | API、worker、migrate、yori-cliが同じDB設定を使う |
| PG-06 | 未設定のproduction secretで起動・config成功しない |
| PG-07 | container再作成後も`yori-pgdata`の原文が残る |
| PG-08 | env変更だけをpassword rotation成功と誤認しない |
| PG-09 | test composeが本番secret・本番volumeへ依存しない |
| PG-10 | 配置・migration・bootstrap・承認・起動の順序が文書化される |

## 13. 実装順序

1. production Composeの必要envと共通DB URLをtestで固定する。
2. Composeを環境変数化しRedをGreenにする。
3. `.env.example`とGit除外を追加する。
4. production profile、DB非公開、volume永続化の回帰testを実行する。
5. 配置、初期化、rotation、snapshot、yori-cli接続を文書化する。
6. deployment test、src test、typecheck、lint、buildを実行する。
7. 独立レビューで秘密漏えい、DB公開、初期化、既存volume互換を確認する。

追跡対象は1ファイル1コミットとする。

## 14. 完了報告

- PostgreSQLの配置先とnetwork境界。
- 採用した環境変数契約。
- 固定資格情報の除去結果。
- 初期化済みvolumeへの制約。
- yori-cli接続方法。
- 実行したtest、typecheck、lint、build。
- 未実行の実Lightsail、snapshot復旧、実provider疎通。
- commit一覧と独立レビュー結果。
