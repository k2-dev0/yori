# collector（端末側の会話収集）

M2の`src/collector/`は、Codex/Claude Codeのフックを契機に確定済みの発言だけを読み、SQLiteへ未送信キューとして保持して中央APIへ送る。本文の選別・索引化はM3以降で、この工程では外部Jev/Voyageへ何も送らない。

## 前提

- Node.js 24以降と`git`（案件特定に`git -C <cwd> rev-parse`と`remote.origin.url`を使う）。
- 中央APIの社員token（`POST /v1/events`のBearer）と、案件の`project_id`。
- 対応版: Codex Desktopは`cli_version=0.155.0-alpha.9.2`、Claude Codeは`2.1.220`。未知版のログは本文を取り込まず診断にだけ記録して保留する。旧版形式へのフォールバックはしない。
- 外部へ送る先は設定の中央APIだけ。Jev/Voyage等の呼出しはない。

## 設定

`state_dir`は端末ごとの絶対path。tokenは環境変数から読み、DBやログへ生値を保存しない。

```json
{
  "api_url": "https://yori.example.com",
  "token_env": "YORI_TOKEN",
  "state_dir": "/Users/example/.yori-collector",
  "projects": [
    { "repository": "github.com/example/project-a", "project_id": "018f0a00-0000-7000-8000-000000000001" }
  ]
}
```

- `api_url`はHTTPSのみ（開発用loopback `http://127.0.0.1`等だけHTTP可）。userinfo/query/fragmentは拒否する。
- `repository`は`host/path`のcanonical形式。HTTPS/SSH/SCP形式のremote URLを書いても正規化される。同じremoteのworktreeは同じ案件になる。
- 同じrepositoryの重複・未登録repositoryは拒否・保留する。ディレクトリ名から案件を推定しない。
- 正規化後のrepositoryは既存APIと同じ1024 UTF-8 bytes以内とし、NUL・単独サロゲートを拒否する。収集入口でも確認し、超過値をoutboxへ入れない。

## フック

フックは収集と補助通知の契機で、hook JSONをstdinから読む。最初に`npm ci`と`npm run build`を実行する。以下はCodex用のサンプルで、`~/.codex/hooks.json`へ既存設定を保持して追加し、`/hooks`で信頼を確認する。Claude Codeでは`~/.claude/settings.json`の`hooks`へ同じ構造を追加し、両方のコマンドの`--source codex`を`--source claude_code`へ変更する。実行するエージェントの環境に`YORI_TOKEN`を設定し、pathは実際の絶対pathに置き換える。実設定は自動編集しない。

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /path/to/yori/dist/collector/cli.js notify --source codex --config /Users/example/.yori-collector.json", "async": true }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /path/to/yori/dist/collector/cli.js collect --source codex --config /Users/example/.yori-collector.json" }] }
    ]
  }
}
```

- Codex/Claude Codeとも同じcommon input（`session_id`、`cwd`、`transcript_path`）を使う。`hook.prompt`や`last_assistant_message`から別IDを発明しない。
- 両エージェントに`UserPromptSubmit`と`Stop`を登録する。`UserPromptSubmit`の`notify`は内部でcollectも行うため、同じeventへ別のcollectを並列登録しない。今回のcollectで新規または改訂されたuser発言を特定できた場合だけ、検索結果を1回最大5秒・累計最大10秒待つ。
- `notify`は完了結果を`hookSpecificOutput.additionalContext`として返す。Codexは現在turnの次の安全地点、なければ次のuser turn、Claude Codeは次のconversation turnで受け取る。hook完了だけで新しいturnを強制開始しない。処理中・未受付・timeoutは無出力で、明示的なMCP取得を置き換えない。
- Stop直後に未書込の最終発言は、次のhookまたは明示flushで回収する。入力直後の自動検索と現在入力のID照合はM6で実装済み。
- 1回の入力処理はcursor・message・outboxを同一SQLite transactionで更新する。ネットワーク待機中はtransactionを保持しない。

## CLI

開発時はtsx、配布時は`node dist/collector/cli.js`で同じentryを実行する。

```sh
npm run collector:collect -- --source codex --config ~/.yori-collector.json < hook.json
npm run collector:notify -- --source codex --config ~/.yori-collector.json < hook.json
npm run collector:flush -- --config ~/.yori-collector.json
npm run collector:diagnostics -- --config ~/.yori-collector.json
```

- `collect`: hook JSONをstdinから読み、指定transcriptの差分だけを処理する。全履歴は走査しない。
- `notify`: collect後、今回確定したuser入力の検索結果だけを待ち、安全な次のmodel入力へ渡すJSONをstdoutへ出す。未完了・入力不明では何も出さない。
- `flush`: 保留sourceの対応表を再確認して未読分を取り込み、未送信eventを同じbody・同じ識別子で再送する。
- `diagnostics`: 資格情報のnamespaceに保存された診断を`[{"code":"...","byteOffset":123}]`のJSON配列でstdoutへ出す。本文・通知コンテキスト・raw errorは出さない。
- `collect`・`flush`の成功時はstdoutへ本文や通知コンテキストを出さない。`notify`だけが完了結果の追加context JSONをstdoutへ出す。不正な引数・設定・token欠落は固定codeをstderrへ出して非0で終了する。

## 再送とtoken rotation

- 通信失敗・429/5xxは指数backoff（最大5分、Retry-Afterは上限付き）で次回の自動collectへ回す。401/403/400/409等の恒久エラーはそのprojectのoutboxをfailedとして保持し、自動collectでは送信しない。`flush`で明示的に再試行でき、成功またはretryable/invalid応答でfailedを解除する。明示flushはretry時刻を待たない。
- 再送はoutboxに保持した同じbody・同じ`idempotency_key`を使う。成功扱いは202かつresultsの件数・`idempotency_key`・`revision`・`message_id`（UUIDであること）・`request_id`型が一致した時だけ。
- state namespaceは`api_url`とtoken hashで固定する。tokenを変更すると旧資格情報のqueueは新しいnamespaceへ送られず保持されるため、rotation前に`flush`で送り切る。
- 収集元のworktreeが移動・削除されても、保存済みoutboxは現在の登録済みrepository/projectの組と照合して再送する。元cwdを読めないsourceの未読ログ収集だけを省略する。登録解除・案件再割当による送信停止は維持する。

## 診断と制約

- 未完行は次回へ回す。JSON破損・未知record・未知版・1MiB超の行・NUL/単独サロゲート・本文65536コードポイント超・識別子1024 UTF-8 bytes超は、本文を送信せず固定codeと参照byte offsetだけを診断へ記録する。行長はチャンク境界に依存せず、未完分と今回chunkの完成行bytesの合計で判定する（1MiBちょうどは取り込む）。
- 完成行を文字列へ変換する前にUTF-8を検証する。不正バイトを含む行は置換せず除外し、`transcript_invalid_utf8`とoffsetを記録する。正常なUnicodeと後続行は保持する。未完行の途中で切れた文字は完成まで判定しない。
- 未知版・session不一致で保留したscanは、そのscanで積んだmessage/outbox/採番/cursorを一体でrollbackし、保留原因の診断だけを残す。原因が解消すると同じ行を先頭から同じ順で読み直し、重複しないsequenceを採番する。
- 1MiB超の行は本文を保持せず改行まで読み捨てる。読み捨て中の元行startと読取済みoffsetは`file_cursors`へ保存し、次回は途中から再開する。4MiBの読取予算は読み捨て中の読取も含む。inode交換・短縮・fingerprint不一致の再読込時は読み捨て状態も捨てる。旧schemaのstateには列を後方互換で追加する。
- 識別子はserver契約と同じく空・NUL・単独サロゲート・1024 UTF-8 bytes超を拒否する。不正な`source_message_id`はoutboxへ入れず診断し、不正な`session_id`は収集境界で診断してsource/sessionを保存しない。
- 同じmessage IDの本文変更はrevisionを増やし、完全一致の再録は無視する。role・発言時刻を変える更新は保留して診断する。
- 既知の制限: 同じmessage IDの異なる過去本文を含むログを先頭から再読込すると、過去本文を新しいrevisionとして扱う。対応エージェントの通常運用でこの条件が生じるかは未確認。ユーザー判断により修正を保留し、履歴管理の追加は今回行わない。
- 1回の処理は最大4MiB読取・100イベント送信。outboxのSELECTも残りの送信予算（最大100件）以下に限り、本文を余分に読まない。outboxはsequence/revision順に最大100件・body 1MiB以内でbatch化する。
- 同一sessionへの並行collectは`BEGIN IMMEDIATE`でcursor読取からcommitまでを直列化する。transcriptはscanと同じfile descriptorの同一inodeでstat/fingerprintし、scan中にpathのinodeが差し替わった場合はcommitせず次回へ回す。旧fileのoffsetを新inodeへ記録しない。
- 送信前に設定`projects`とoutboxの`source_scope`/`project_id`をペアで照合し、設定から外れた・再割当されたoutboxは送らず保持する。同じ`project_id`に複数repositoryがある設定でも、各repositoryのoutboxを送る。別projectのcollectが起動しても撤去済みprojectのoutboxは流れない。
- `state_dir`は0700、SQLiteファイルは0600で作成する。送信は5秒timeoutでredirectを追わない。
- 未登録repositoryのsourceは`cwd`/`source`/`session`/`transcript_path`の参照だけを保持し、本文を読まずに保留する。

## 検証

- `node --import tsx --test --test-concurrency=1 'src/collector/tests/*.test.ts'`で収集・送信・設定・CLIを検証する。HTTPはグローバルfetch mockだけを使い、実送信しない。
- テスト用PATHのgit fixtureは`rev-parse`と`remote.origin.url`の引数・cwd・remote/worktree応答だけを検証する。実Gitで既存repositoryのremote解決は確認済み。一時repository/worktreeの作成は承認付き実行でも`.git`保護により拒否され、実worktreeでのスモークは未確認。
- DB縦通し（`db-integration.test.ts`）は`DATABASE_URL`設定時だけ実PostgreSQLで実行する。

## 仕様の出典

- [Codex Hooks](https://learn.chatgpt.com/docs/hooks): matcher group内のhooks配列、共通入力、ログ形式が安定契約ではないこと。
- [Claude Code Hooks](https://code.claude.com/docs/en/hooks): 設定構造、UserPromptSubmit/Stop、Stop時点で最終ログ書込が保証されないこと。

2026-09-21確認。実社員ログの中央API送信・実端末へのフック登録・クラウド配置は未実施。
