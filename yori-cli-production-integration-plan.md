# yori-cli 本番統合計画

- 作成日: 2026-09-26
- 対象repository: `../yori-cli`
- 対象: 管理CLIの本番DB接続、配布、Lightsail配置
- 状態: CLI機能実装済み。本番統合未完了
- 目的: 固定DB資格情報を使わず、yori本体のPostgreSQLへ安全にbootstrap・管理操作を行う

## 1. 結論

`yori-cli`の会社・社員・案件・所属・token管理機能は実装済みだが、本番統合は未完了である。現在のCLI Composeは`YORI_ADMIN_DATABASE_URL`未設定時に`postgres://yori:yori@db:5432/yori`へfallbackする。yori本体のDB資格情報を変更すると不一致になり、未設定を安全に失敗させる契約にも反する。

試運転ではnpm公開せず、private GitHub repositoryをLightsailの`/srv/yori-cli`へread-only Deploy Keyでcloneする。yori本体のCompose network`yori_default`へtools profileの一時containerとして参加し、`/etc/yori/yori.env`から同じDB URLを受け取る。

## 2. 確認済みの現状

- `yori-cli`は別repository、別package、別entry pointである。`../yori-cli/README.md`
- `bootstrap`、会社・社員・案件、member、token、inspectは実装済みである。`../yori-cli/src/admin/`
- DB schemaは独自migrationを持たず、yori本体`0001_init.sql`を正本とする。`../yori-cli/README.md`
- Compose admin serviceはexternal network`yori_default`へ参加する。`../yori-cli/deployment/compose.yaml:19-40`
- `YORI_ADMIN_DATABASE_URL`に固定資格情報fallbackがある。`../yori-cli/deployment/compose.yaml:27-28`
- packageは`UNLICENSED`で、npm公開前に配布方針決定が必要である。`../yori-cli/package.json`
- `develop`の実装コミットはlocalにあり、確認時点の`origin/develop`は初期commitだけである。

## 3. 対象範囲

### 3.1 エージェントが実装するもの

1. `YORI_ADMIN_DATABASE_URL`を必須化し、固定fallbackを削除する。
2. 空値・未設定でCompose configまたはCLI実行を失敗させる。
3. yori本体の`/etc/yori/yori.env`を使う実行契約。
4. external network名を明示し、存在しないnetworkで安全に失敗する手順。
5. Lightsailへのprivate clone・更新手順。
6. read-only Deploy Keyの分離手順。
7. bootstrap input fileをrepository外からread-only mountする方法。
8. 生token出力を共有logへ流さない運用手順。
9. yori本体の実migration後schemaに対するintegration smoke。
10. package公開を使わない試運転導線。

### 3.2 対象外

- CLIの業務command追加・挙動変更。
- 会社・社員・案件の物理削除。
- npm public registryへのpublish。
- GitHub repositoryの公開化。
- API keyやDB passwordの生成。
- Lightsail、firewall、DNSの操作。
- yori本体のCompose変更。`postgresql-production-configuration-plan.md`の責務。

## 4. 本番接続契約

CLI containerは次を必須とする。

| 変数 | 値 |
|---|---|
| `YORI_ADMIN_DATABASE_URL` | yori本体と同じuser、password、database、host=`db`、port=`5432` |
| `YORI_ADMIN_NETWORK` | 既定`yori_default`。別project名なら明示 |

固定URLのdefaultを置かない。

```yaml
environment:
  DATABASE_URL: ${YORI_ADMIN_DATABASE_URL:?required}
```

`YORI_ADMIN_DATABASE_URL`は`/etc/yori/yori.env`に記録し、yori本体がCompose内で使う値と同じ資格情報から作る。hostだけはCLI containerから到達するCompose service名`db`に固定する。

CLIはDB portをhostへ公開せず、external Docker networkからのみ接続する。

## 5. 配置方法

試運転の配置先を次に固定する。

```text
/srv/yori
/srv/yori-cli
/etc/yori/yori.env
/etc/yori/bootstrap.json
/etc/yori/provider-approvals/
```

- `yori`と`yori-cli`は別のread-only Deploy Keyを使う。GitHub Deploy Keyをrepository間で共有しない。
- serverに個人GitHub鍵を置かない。
- `bootstrap.json`はAPI keyやDB passwordを含めないが、社員名を含むためroot管理または管理者限定にする。
- bootstrap成功後も、生tokenはfileへ自動保存しない。管理者がstdoutから会社指定password managerへ移す。
- serverのshell historyへ生tokenを入力しない。

## 6. 実行順序

1. yori本体の`db`を起動する。
2. yori本体migrationを適用する。
3. `docker network inspect yori_default`でnetworkを確認する。
4. yori-cliのCompose configを`/etc/yori/yori.env`で検査する。
5. `/etc/yori/bootstrap.json`をadmin containerへread-only mountする。
6. `bootstrap`を1回だけ実行する。
7. 生tokenをpassword managerへ保存する。
8. `inspect`で会社、社員、案件、member、token metadataを確認する。
9. 発行tokenでyori APIの合成イベントを1件受け付ける。
10. 不要になったbootstrap fileを管理者方針に従い保管または安全に削除する。

実行例の正本は`../yori-cli/deployment/README.md`へ記録する。実秘密をcommand引数へ書かない。

## 7. 配布方針

### 7.1 試運転

- private GitHub repositoryをcloneする。
- branchではなく、レビュー済みcommit SHAまたはrelease tagをcheckoutする。
- `git pull`前に現在SHAを記録する。
- package publishを行わない。

### 7.2 将来

npmやprivate registryへ配布する場合は別判断とする。

- package名の所有確認。
- `UNLICENSED`の扱い。
- public／private registry。
- provenance、署名、versioning。
- publish権限と2FA。
- install時scriptの有無。

試運転完了のためにpublishを必須にしない。

## 8. 必須テスト

- `YORI_ADMIN_DATABASE_URL`未設定でCompose configまたはrunが失敗する。
- 空値で固定defaultへfallbackしない。
- 合成URLでDATABASE_URLがadmin containerへ渡る。
- DB portをhostへ公開しない。
- `yori_default`へだけ参加する。
- yori本体のmigration済みschemaへbootstrapできる。
- bootstrap再実行は`bootstrap_already_completed`で何も変更しない。
- `inspect`に生tokenとtoken hashが出ない。
- token発行成功以外のstdout／stderrに生token、DB URL、passwordが出ない。
- repository symlink／npx／bin entrypointの既存testが成功する。
- typecheck、lint、buildが成功する。

## 9. 受け入れ条件

| ID | 条件 |
|---|---|
| CLI-I01 | 固定`yori:yori`DB資格情報へfallbackしない |
| CLI-I02 | yori本体と同じPostgreSQLへinternal Docker networkだけで接続する |
| CLI-I03 | migration未適用DBで成功扱いしない |
| CLI-I04 | private repositoryのreview済みcommitから実行できる |
| CLI-I05 | 生tokenは発行成功時のstdoutに一度だけ現れる |
| CLI-I06 | 実秘密と社員tokenをrepository・image・logへ保存しない |
| CLI-I07 | 実yori schemaとのintegration smokeが成功する |

## 10. 実装ファイル

対象は`../yori-cli`側である。

| file | 変更 |
|---|---|
| `deployment/compose.yaml` | DB URL必須化、固定fallback削除 |
| `deployment/tests/*` | 未設定拒否、network、secret非露出 |
| `deployment/README.md` | `/etc/yori/yori.env`、private clone、bootstrap mount |
| `README.md` | 試運転はprivate cloneを推奨、npm publish非必須 |

yori本体側のファイルはこの作業で編集しない。

## 11. 完了報告

- yori-cliの配置commit SHA。
- 固定DB資格情報の除去結果。
- yori本体schemaとのintegration結果。
- bootstrap／inspectの合成実行結果。
- 生token非露出の確認。
- 実行したtest、typecheck、lint、build。
- npm publish未実施、実Lightsail bootstrap未実施の区別。
- commit一覧と独立レビュー結果。
