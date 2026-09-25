# yori 管理CLI実装計画

- 作成日: 2026-09-25
- 対象: 会社・社員・案件・案件メンバー・認証トークンの初期登録と日常管理
- 状態: 実装前。既存schema・認証経路・CLI作法のpreflight確認済み
- 目的: `development-conversation-memory-implementation-plan.md` 15節の「認証トークン・プロジェクト登録用の管理CLI」を満たす

## 1. 結論

管理CLIはworker CLIへ追加せず、独立した`yori-admin`として実装する。初期導入を1トランザクションで行う`bootstrap`と、社員・案件・所属・トークンを個別管理するコマンドを提供する。

DB migrationは追加しない。既存の`companies`、`employees`、`projects`、`project_members`、`auth_tokens`を正本として使用する。会社・社員・案件を物理削除するコマンドは提供せず、初期版の破壊的操作は案件メンバー解除とトークン失効に限定する。

生の認証トークンはCLIが生成し、発行成功時のJSONへ一度だけ出力する。DBにはSHA-256だけを保存し、一覧、診断、エラー、ログへ生トークンまたはtoken hashを出さない。

## 2. 確認済みの既存契約

### 2.1 schema

- IDはアプリがUUIDv7を生成する契約である。`src/db/migrations/0001_init.sql:1-2`
- 会社、社員、案件、案件メンバー、認証トークンのtableは実装済みである。`src/db/migrations/0001_init.sql:6-45`
- 案件のrepository identifierは会社内で一意である。`src/db/migrations/0001_init.sql:21-29`
- 案件メンバーは`project_id`と`employee_id`の組で一意だが、DB制約だけでは両者が同じ会社かを保証しない。`src/db/migrations/0001_init.sql:31-36`
- 認証トークンはtoken hashを全体で一意に保持し、`revoked_at`で失効を表す。`src/db/migrations/0001_init.sql:38-45`

### 2.2 認証

- APIはBearer tokenのUTF-8バイト列をSHA-256にして`auth_tokens.token_hash`と照合する。`src/api/events.ts:19-33`
- 認証時はtokenの会社と社員の会社が一致し、かつtokenが未失効であることを要求する。`src/api/events.ts:25-33`
- 案件利用時は認証会社と案件会社の一致、および案件メンバー登録を要求する。`src/api/events.ts:36-45`

### 2.3 再利用する実装パターン

- テストfixtureには24 random bytesのbase64urlへ`yori_`を付ける生トークン生成、SHA-256保存、失効の既存例がある。`src/db/tests/fixtures.ts:24-30,59-68,95-97`
- 既存worker CLIはZod入力検証、`DATABASE_URL`必須化、明示transaction、固定エラーコード、stdoutとstderrの分離を行う。`src/worker/cli.ts:13-38,82-147,237-273`
- repository identifierの正規化処理はcollectorの`normalizeRepositoryIdentifier`を再利用できる。`src/collector/remote.ts:68`
- 通常Composeにはtools profileがあり、migrationと同じnetwork内からDBへ接続できる。`deployment/compose.yaml:124-131`

## 3. 対象範囲

### 3.1 実装するもの

1. 空のyori DBへ最初の会社・社員・案件・所属・トークンを一括登録する`bootstrap`。
2. 会社、社員、案件の個別登録。
3. 案件メンバーの追加と解除。
4. 社員トークンの発行と失効。
5. 会社単位の設定確認。生トークンとhashは返さない。
6. ホスト上のnpm scriptと、Compose tools profileからの実行経路。
7. 実PostgreSQLを使う正常系・異常系・競合テスト。
8. 管理者向けの実行手順と固定エラーコード一覧。

### 3.2 対象外

- 秘密情報を誰が、どこで、どのsecret managerへ作成・配布・ローテーションするかの運用設計。
- `.env`、API key、DB password、社員端末の環境変数を作成する手順。
- OpenAPIを生成するか、既存Zod schemaと設計書を同等のAPI契約として扱うかの判断。
- 管理Web UI、SSO、管理者アカウント、RBAC。
- 会社・社員・案件の物理削除。
- 社員表示名やrepository identifierの更新。
- 管理操作の監査table追加。
- provider policy承認。既存の`provider:approve` / `provider:revoke`を使用する。
- collector、MCP、workerの起動設定そのもの。

秘密情報作成手順とAPI契約の扱いは、本計画へ混在させず別の運用・契約計画として決定する。

## 4. 公開コマンド契約

エントリポイントは`npm run admin -- <command>`とする。Composeでは次の形で実行できるようにする。

```sh
docker compose -p yori -f deployment/compose.yaml --profile tools run --rm admin <command>
```

初期コマンドは次に固定する。

| command | 入力 | 動作 |
|---|---|---|
| `bootstrap <file.json>` | strict JSON | 空のDBへ会社1件、社員1件以上、案件1件以上、所属、初回トークンを1 transactionで登録 |
| `company:create <file.json>` | strict JSON | 会社をUUIDv7で登録 |
| `employee:create <file.json>` | strict JSON | 指定会社へ社員をUUIDv7で登録 |
| `project:create <file.json>` | strict JSON | repository identifierを正規化し、指定会社へ案件を登録 |
| `member:add <file.json>` | strict JSON | 同一会社の案件と社員に限り所属を追加 |
| `member:remove <file.json>` | strict JSON | 同一会社の所属だけを解除 |
| `token:issue <file.json>` | strict JSON | 指定会社の社員へtokenを発行し、生tokenを一度だけ返す |
| `token:revoke <file.json>` | strict JSON | 指定会社に属するtoken IDを失効 |
| `inspect <company-uuid>` | UUID | 会社、社員、案件、所属、token metadataをJSONで返す |

`bootstrap`以外の作成・変更コマンドもJSON file入力とし、引数順序の誤りとshell履歴への値の露出を避ける。入力JSONはunknown fieldを拒否する。

### 4.1 `bootstrap`入力

```json
{
  "company": { "name": "example" },
  "employees": [
    { "ref": "alice", "display_name": "Alice", "issue_token": true },
    { "ref": "bob", "display_name": "Bob", "issue_token": true }
  ],
  "projects": [
    {
      "ref": "project-a",
      "repository": "github.com/example/project-a",
      "member_refs": ["alice", "bob"]
    }
  ]
}
```

- `ref`は同じbootstrap file内だけで参照する一時識別子で、DBへ保存しない。
- `ref`、社員、案件、所属の重複をZodで拒否する。
- repositoryは`normalizeRepositoryIdentifier`でcanonical化し、変換不能値を拒否する。
- `issue_token`がtrueの社員だけ初回トークンを作る。
- 会社が1件でも存在するDBでは`bootstrap_already_completed`として何も変更しない。
- 同時bootstrapはtransaction advisory lockで直列化し、双方が空DBを観測して二重登録する競合を防ぐ。
- 途中の入力不正、DB制約違反、token生成・保存失敗では全登録をrollbackする。

### 4.2 個別入力のscope

- `employee:create`は`company_id`と`display_name`を受ける。
- `project:create`は`company_id`と`repository`を受ける。
- `member:add` / `member:remove`は`company_id`、`project_id`、`employee_id`を受ける。
- `token:issue`は`company_id`と`employee_id`を受ける。
- `token:revoke`は`company_id`と`token_id`を受ける。生トークンを入力させない。
- UUIDは正規形へ変換して比較し、会社scopeを毎回DB正本で再確認する。

## 5. 出力・エラー契約

### 5.1 stdout

- 成功時は1行のJSON objectだけをstdoutへ出す。
- 作成結果は生成したIDと正規化済みの非秘密情報を返す。
- `token:issue`と`bootstrap`のtoken発行結果だけ、`token_id`と生の`token`を返す。
- `inspect`はtoken ID、社員ID、作成日時、失効日時だけを返し、生tokenとtoken hashを返さない。
- npm bannerが混ざらないよう、運用例では`npm run --silent admin -- ...`を使用する。

`token:issue`の成功出力例:

```json
{"status":"created","token_id":"<uuid>","employee_id":"<uuid>","token":"yori_<secret>"}
```

### 5.2 stderrと終了コード

- 既知の失敗は`admin: <fixed_code>`だけをstderrへ出し、終了コード1とする。
- 成功は終了コード0とする。
- SQL、接続文字列、入力file本文、token、token hash、DB error本文を出さない。
- 予期しない例外も固定`internal_error`へ縮退し、raw errorは標準出力・標準エラーへ出さない。

初期固定code:

```text
invalid_arguments
invalid_admin_config
invalid_input_file
invalid_input
bootstrap_already_completed
company_not_found
employee_not_found
project_not_found
token_not_found
company_scope_mismatch
repository_conflict
member_already_exists
member_not_found
token_already_revoked
internal_error
```

## 6. 永続化と安全性

### 6.1 transaction

- 各コマンドは1 transactionで完結する。
- `bootstrap`は会社、社員、案件、所属、token hashを同じtransactionで保存する。
- `member:add` / `member:remove`は案件行と社員行を読み、同一`company_id`であることを確認してから変更する。
- `token:issue`は社員の会社を確認してからtokenを生成・保存する。
- `token:revoke`はtoken ID、token会社、社員会社の一致を確認してから`revoked_at`を更新する。
- 外部HTTPは行わず、transaction中にネットワーク待ちを持たない。

### 6.2 token

- 生token形式は既存fixtureと同じ`yori_`＋24 random bytesのbase64urlを採用する。
- 乱数は`node:crypto.randomBytes`を使う。
- hashはAPI認証経路と同じUTF-8 SHA-256とする。
- 生tokenは変数として必要な時間だけ保持し、DB、file、ログ、例外へ保存しない。
- token hashの一意衝突は新しいtokenで限定回数だけ再生成する。別のDB障害は再生成で隠さない。
- token失効は物理削除せず`revoked_at`を設定する。

### 6.3 冪等性と再実行

- 初期版では管理操作用の新tableやidempotency keyを追加しない。
- `bootstrap`の再実行は成功扱いにせず、空DB条件を満たさなければ全体を拒否する。
- `member:add`の既存所属、`member:remove`の未存在所属、`token:revoke`の失効済みtokenは固定codeで区別し、別状態へ変更しない。
- 作成成功後に出力を紛失した場合、同じ作成コマンドを盲目的に再実行しない。`inspect`で状態を確認する。生tokenを紛失した場合は新tokenを発行し、紛失したtoken IDを失効する。

## 7. モジュール構成

| file | 責任 |
|---|---|
| `src/admin/contract.ts` | 入出力型、Zod schema、固定結果・エラーcode |
| `src/admin/service.ts` | transaction、会社scope検証、登録、所属変更、token発行・失効、inspect |
| `src/admin/cli.ts` | argv、file読取、`DATABASE_URL`、stdout/stderr、終了コード |
| `src/admin/tests/admin-cli.test.ts` | 実PostgreSQLによるCLI・serviceの正常系、異常系、競合検証 |
| `docs/admin.md` | JSON例、ホスト／Compose実行、token紛失・失効、固定code |
| `package.json` | `admin` script追加 |
| `deployment/compose.yaml` | tools profileの`admin` service追加 |
| `deployment/README.md` | migration後のbootstrap、通常管理コマンドへの導線 |

production codeから`src/db/tests/fixtures.ts`をimportしない。token生成・hash等の共通化が必要ならproduction moduleへ実装し、fixture側はその契約をテストする。

## 8. 実装順序

1. `src/admin/contract.ts`で入力・出力・固定codeを確定する。
2. `src/admin/service.ts`へ会社scope検証と個別操作を実装する。
3. `bootstrap`のadvisory lock、全体transaction、ref解決を実装する。
4. `src/admin/cli.ts`へコマンドdispatch、JSON file読取、出力境界を実装する。
5. 実PostgreSQLテストを追加する。
6. `package.json`へ`admin` scriptを追加する。
7. Compose tools profileへ`admin` serviceを追加する。
8. `docs/admin.md`と`deployment/README.md`へ運用手順を追加する。
9. `npm test`、`npm run typecheck`、`npm run lint`、`npm run build`を実行する。
10. 独立レビューで契約、会社境界、秘密漏えい、競合、既存回帰を確認する。

追跡対象の変更はリポジトリ規約どおり1ファイル1コミットとする。各コミットで、その時点の依存関係が壊れない順に追加する。

## 9. 必須テスト

### 9.1 正常系

- 空DBの`bootstrap`で会社、複数社員、複数案件、所属、初回tokenが一括作成される。
- 発行tokenをAPIの`authenticate`へ渡すと正しい会社・社員になる。
- repositoryのHTTPS、SSH、SCP表記が同じcanonical identifierになる。
- 個別コマンドで会社、社員、案件、所属を追加できる。
- tokenを追加発行でき、複数の未失効tokenを同じ社員が利用できる。
- token失効後、API認証が拒否される。
- `inspect`が会社scope内の構成を返し、秘密情報を含まない。
- Compose tools profileから同じCLIを実行できる。

### 9.2 異常系

- `DATABASE_URL`欠落、file欠落、不正JSON、unknown field、不正UUIDをDB接続または変更前に拒否する。
- 空文字、NUL、単独surrogate、repository上限超過を拒否する。
- 存在しない会社、社員、案件、tokenを固定codeで拒否する。
- 別会社の社員を案件へ追加できない。
- 別会社の社員へtokenを発行できない。
- 別会社のtokenを失効できない。
- repository重複時に既存案件を変更しない。
- bootstrap途中の制約違反で先行insertをすべてrollbackする。
- 同時bootstrapの片方だけが成功する。
- token hashの人工的な衝突で限定再生成し、他のDB errorをretryしない。
- 既存所属追加、未存在所属解除、失効済みtoken再失効を固定codeで区別する。

### 9.3 情報漏えい

- 生tokenは発行成功時のstdoutにだけ現れる。
- DBには生tokenが存在せず、hashだけが保存される。
- `inspect`、stderr、例外経路、失敗出力にtoken、hash、`DATABASE_URL`が現れない。
- JSON file内容とDB error本文をstderrへ転記しない。

### 9.4 回帰

- 既存のAPI認証、案件認可、イベント受付が変わらない。
- collector、worker、MCPの既存CLI出力が変わらない。
- migration数、Compose service allowlist等の固定assertがある場合は`admin`追加を反映する。
- `npm test`、typecheck、lint、buildが成功する。

## 10. 受け入れ条件

| ID | 条件 |
|---|---|
| CLI-01 | 空DBを1回の`bootstrap`で利用可能な最小構成へできる |
| CLI-02 | 途中失敗で会社・社員・案件・所属・tokenの一部だけが残らない |
| CLI-03 | 別会社の社員・案件・tokenを関連付けまたは変更できない |
| CLI-04 | 発行した生tokenは一度だけ返り、DBにはSHA-256だけが残る |
| CLI-05 | 失効後のtokenでAPI認証できない |
| CLI-06 | repository identifierがcollectorと同じ規則でcanonical化される |
| CLI-07 | stdoutは機械可読な1行JSON、stderrは固定codeだけになる |
| CLI-08 | `inspect`と全失敗経路に秘密情報が含まれない |
| CLI-09 | ホストとCompose tools profileの両方から実行できる |
| CLI-10 | 既存API、collector、worker、MCPの回帰テストが成功する |

## 11. ロールアウトと復旧

1. 隔離テストDBで全コマンドを検証する。
2. ステージングDBを空にした状態で`bootstrap`を実行する。
3. 返されたIDと`inspect`を照合する。
4. 合成イベントを発行tokenで送信し、API認証と案件認可を確認する。
5. tokenを失効し、同じtokenが拒否されることを確認する。
6. 本番migration適用後、worker起動前に`bootstrap`を1回だけ実行する。
7. 本番ではstdoutを共有ログへ流さず、token発行結果を管理者が直接受け取る。具体的な保存・配布方法は別の秘密情報作成手順で決める。

CLIが途中失敗した場合はtransaction rollbackを正本とし、自動補償処理を行わない。成功か不明な場合は再実行せず、まず`inspect`でDB状態を確認する。会社・社員・案件の誤登録を取り消す物理削除コマンドは初期版に含めないため、誤登録時は影響を確認したうえで別途修正方針を決める。

## 12. 完了報告に含めるもの

- 実装したコマンドと入力・出力契約。
- 変更ファイルと1ファイル1コミットのcommit一覧。
- 実行したテスト、typecheck、lint、buildの結果。
- 生tokenが発行成功時以外に出ないことの確認結果。
- 会社境界、transaction、同時bootstrapの検証結果。
- 未実施の実VM・実端末確認。
- 秘密情報作成手順とAPI契約方針が本計画の対象外であること。
