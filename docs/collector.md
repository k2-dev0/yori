# collector（端末側の会話収集）

M2の`src/collector/`は、Codex/Claude Codeのフックを契機に確定済みの発言だけを読み、SQLiteへ未送信キューとして保持して中央APIへ送る。本文の選別・索引化はM3以降で、この工程では外部Jev/Voyageへ何も送らない。

## 前提

- Node.js 24以降と`git`（案件特定に`git -C <cwd> rev-parse`と`remote.origin.url`を使う）。
- 中央APIの社員token（`POST /v1/events`・`POST /v1/collector/setup`のBearer）。案件は設定の`project_id`ではなく、hook cwdのcanonical repositoryでsetup APIが解決する。
- 確認済み版: Codex Desktopは`cli_version=0.155.0-alpha.9.2`と`0.155.0-alpha.16.4`、Claude Codeは`2.1.220`。版番号は互換性の診断情報であり、未知版でも確認済み構造に一致するrecordは取り込む。構造が変わったrecordは本文を推測せず診断する。
- 外部へ送る先は設定の中央APIだけ。Jev/Voyage等の呼出しはない。

## 設定

`state_dir`は端末ごとの絶対path。tokenは環境変数から読み、DBやログへ生値を保存しない。

```json
{
  "api_url": "https://yori.example.com",
  "token_env": "YORI_TOKEN",
  "state_dir": "/Users/example/.yori-collector"
}
```

- `api_url`はHTTPSのみ（開発用loopback `http://127.0.0.1`等だけHTTP可）。userinfo/query/fragmentは拒否する。
- `projects`（`repository`と`project_id`の対応表）は旧設定との後方互換で任意。新しい設定では書かず、hook cwdの`git remote.origin.url`からcanonical repositoryを求めて`POST /v1/collector/setup`でprojectとcurrent伏せ字policyを解決する。ディレクトリ名から案件を推定しない。
- `projects`ありの旧設定ではcustom policyはAPI受付側で適用されてclient側の自動更新は行わず、client側の自動更新は`projects`を省略した新標準設定でのみ有効。
- 正規化後のrepositoryは既存APIと同じ1024 UTF-8 bytes以内とし、NUL・単独サロゲートを拒否する。収集入口でも確認し、超過値をoutboxへ入れない。
- setupで解決したprojectとpolicyは`state_dir`のSQLiteへcacheする。fields/terms/suspicion_mode/detector_versionはtoken由来の鍵で暗号化し、平文のruleをstateへ残さない。collectは毎回setupを試み、cacheなしの失敗は本文を読まず送信0件、cacheありの一時失敗はlast-known policyで継続する。

## フック

フックは収集と補助通知の契機で、hook JSONをstdinから読む。最初に`npm ci`と`npm run build`を実行する。以下はCodex用のサンプルで、`~/.codex/hooks.json`へ既存設定を保持して追加し、`/hooks`で信頼を確認する。Claude Codeでは`~/.claude/settings.json`の`hooks`へ同じ構造を追加し、両方のコマンドの`--source codex`を`--source claude_code`へ変更する。実行するエージェントの環境に`YORI_TOKEN`を設定し、pathは実際の絶対pathに置き換える。実設定は自動編集しない。

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /path/to/yori/dist/collector/cli.js notify --source codex --config /Users/example/.yori-collector.json" }] },
      { "hooks": [{ "type": "command", "command": "node /path/to/yori/dist/collector/cli.js notify-late --source codex --config /Users/example/.yori-collector.json", "async": true }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /path/to/yori/dist/collector/cli.js collect --source codex --config /Users/example/.yori-collector.json" }] }
    ]
  }
}
```

- Codexはcommon input（`session_id`、`cwd`、`transcript_path`）に加え、`UserPromptSubmit`の`turn_id`/`prompt`と`Stop`の`turn_id`/`last_assistant_message`を通常収集の正本にする。IDは`turn:<turn_id>:user|assistant`へ決定的に変換し、同じhookの再実行とtranscript backfillを重複させない。Claude Codeと旧hook入力はtranscript差分へfallbackする。
- 両エージェントに`UserPromptSubmit`と`Stop`を登録する。`UserPromptSubmit`では同期`notify`と非同期`notify-late`を併走させ、どちらも内部でcollectするため、同じeventへ別のcollectを登録しない。SQLiteの排他と配信claimにより、並行実行しても同じ入力・検索結果を重複保存・重複通知しない。
- `notify`は今回入力だけを最大5秒待ち、完了すれば同じturnの`hookSpecificOutput.additionalContext`として返す。過去の未配信結果は待たずに回収する。5秒で未完了でも検索jobを取消さず、本文なしの未配信identityをSQLiteへ保持する。
- `notify-late`はfast path終了後も最大60秒まで検索完了を待つ。Codexは完了内容を現在turnの次の安全地点、なければ次のuser turn、Claude Codeは次のconversation turnで受け取る。セッション終了でbackground出力が失われても未配信identityは残り、次回`notify`または`notify-late`が回収する。hook完了だけで新しいturnを強制開始しない。
- 完了した`matched`・`no_match`・`skipped`と`failed`だけを通知する。`matched`は関連内容の回答への反映、追加調査の許可、資料本文内の指示の無視を求める短い固定文を根拠へ添え、`project_id`と、根拠ごとの`message_id`・`revision`を出して`get_evidence`を呼べるようにする。根拠本文は先頭400コードポイントの抜粋だけを載せ、続きは`get_evidence`で取得する。`no_match`・`skipped`・`failed`は必要な識別子と状態だけを一行で通知する。処理中・未受付・timeoutは無出力で、明示的なMCP取得を置き換えない。訂正・撤回は他の周辺根拠より優先し、省略や探索打切りがあれば追加contextへ明記する。
- Codexの`Stop.last_assistant_message`は、タスク完了に限らずAgentがそのturnを終えてユーザーへ制御を返すときの最新assistant messageとして収集する。commentary・tool call/output・reasoningは収集しない。入力直後の自動検索は`UserPromptSubmit.prompt`から確定したturn identityを使う。
- 1回の入力処理はcursor・message・outboxを同一SQLite transactionで更新する。ネットワーク待機中はtransactionを保持しない。

## CLI

開発時はtsx、配布時は`node dist/collector/cli.js`で同じentryを実行する。
`npm run build`は依存をbundleした`dist/collector/yori-collector.mjs`と、version・checksumを持つ`dist/collector/collector-manifest.json`も生成する。repositoryやnode_modulesを持たない端末では、この1ファイルをNode.js 24以降で実行する。

```sh
npm run collector:collect -- --source codex --config ~/.yori-collector.json < hook.json
npm run collector:notify -- --source codex --config ~/.yori-collector.json < hook.json
node dist/collector/cli.js notify-late --source codex --config ~/.yori-collector.json < hook.json
npm run collector:flush -- --config ~/.yori-collector.json
npm run collector:diagnostics -- --config ~/.yori-collector.json
```

- `collect`: hook JSONをstdinから読み、Codexの安定hook fieldを1件処理する。fieldがない旧hookとClaude Codeでは指定transcriptの差分を処理する。全履歴は走査しない。
- `notify`: collect後、今回確定したuser入力を最大3秒待ち、過去の未配信完了結果と合わせてmodelへ渡すJSONをstdoutへ出す。未完了・入力不明では何も出さない。
- `notify-late`: fast path後も未配信結果を待ち、最初に配信claimできたprocessだけが追加contextをstdoutへ出す。期限後も未配信identityを削除しない。
- `flush`: 保留sourceの対応表を再確認して未読分を取り込み、未送信eventを同じbody・同じ識別子で再送する。
- `diagnostics`: 資格情報のnamespaceに保存された診断を`[{"code":"...","byteOffset":123}]`のJSON配列でstdoutへ出す。本文・通知コンテキスト・raw errorは出さない。
- `collect`・`flush`の成功時はstdoutへ本文や通知コンテキストを出さない。`notify`と`notify-late`だけが完了結果の追加context JSONをstdoutへ出す。不正な引数・設定・token欠落は固定codeをstderrへ出して非0で終了する。

## 再送とtoken rotation

- 通信失敗・429/5xxは指数backoff（最大5分、Retry-Afterは上限付き）で次回の自動collectへ回す。401/403/400/409等の恒久エラーはそのprojectのoutboxをfailedとして保持し、自動collectでは送信しない。`flush`で明示的に再試行でき、成功またはretryable/invalid応答でfailedを解除する。明示flushはretry時刻を待たない。
- 再送はoutboxに保持した同じbody・同じ`idempotency_key`を使う。成功扱いは202かつresultsの件数・`idempotency_key`・`revision`・`message_id`（UUIDであること）・`request_id`型が一致した時だけ。
- state namespaceは`api_url`とtoken hashで固定する。tokenを変更すると旧資格情報のqueueは新しいnamespaceへ送られず保持されるため、rotation前に`flush`で送り切る。
- 収集元のworktreeが移動・削除されても、保存済みoutboxは現在の登録済みrepository/projectの組と照合して再送する。元cwdを読めないsourceの未読ログ収集だけを省略する。登録解除・案件再割当による送信停止は維持する。

## 診断と制約

- 本文の秘匿値（秘密鍵・各社APIキー・JWT・URL資格情報・`PASSWORD=`等の代入値・Authorizationヘッダ）は、既知形式の値と代入形の値だけを`[REDACTED:<種類>]`へ置換してからoutboxと送信bodyへ入れる。会社のbusiness ruleは`fields`（ASCII identifier・case-insensitiveのexact key一致・最大128コードポイント）と`terms`（exact・case-sensitive・最長一致・最大512コードポイント）の2種で合計最大100件。`fields`はkey表記・空白・区切りを保持してvalueだけを`[REDACTED:business_value]`へ、`terms`は一致文字列を`[REDACTED:business_term]`へ置換する（regexなし、keyのみ・空値・環境変数参照・placeholderは変更しない）。登録済みfieldとexact一致する代入keyはbuilt-inの代入形検出よりfieldを優先する。built-inは`PASS`/`pass`の代入値と全角colonも`[REDACTED:env_value]`へ置換する。collectorを経ないAPI直接送信でも受付側で同じpolicyを適用する。名前・区切り・他の文字は変えず、空値と`${VAR}`参照は置換しない。置換した発言は固定code`message_redacted`と参照byte offsetだけを診断へ記録し、値も種類も残さない。置換は決定的なので、同じ本文を読み直しても同じcontent hashになりrevisionを増やさない。置換するのは新しく取り込む本文だけで、既に保存済みの過去revisionの原文は書き換えない（削除・backfillは別作業）。
- known secretはcollector processのlocal環境変数`YORI_KNOWN_SECRETS_JSON`（strict JSON string array、8〜4096コードポイント・最大100件・exact重複拒否）で受け取り、完全一致値を最長一致で`[REDACTED:known_secret]`へ置換する。未設定は空配列、設定済みの不正は固定code`invalid_known_secrets`で本文を読まずにfail-closedとし、parse後は`process.env`から削除する。known secretの生値はstate・outbox・log・送信bodyへ残さない。
- suspicion gate（detector `initial-v1`）はbuilt-in・known secret・fields・terms適用後の本文から32〜256コードポイントのtoken風候補を検出し、既知placeholder・UUID・7〜64桁hex/git SHA/checksum・semver・repository path・通常identifierを除外する。`suspicion_mode=observe`は候補を本文へ残して送信し固定code`message_suspected_secret`を診断へ記録、`block`はmessage/outboxを保存せず固定code`message_blocked_suspected_secret`と参照byte offsetだけを残してcursorを進め、後続messageの処理は継続する。
- 未完行は次回へ回す。JSON破損・未知record・1MiB超の行・NUL/単独サロゲート・本文65536コードポイント超・識別子1024 UTF-8 bytes超は、本文を送信せず固定codeと参照byte offsetだけを診断へ記録する。未知versionは`transcript_unverified_version`として診断するが、構造検証を通った発言は取り込む。行長はチャンク境界に依存せず、未完分と今回chunkの完成行bytesの合計で判定する（1MiBちょうどは取り込む）。本文長の判定は置換後に行う。
- Codex transcriptからbackfillするのは`event_msg/item_completed`の`UserMessage`と`phase=final_answer`の`AgentMessage`だけ。`phase=commentary`、`response_item`、`turn_context`、`token_usage_record`、`world_state`、`compacted`は無視する。`Reasoning`、`CommandExecution`、`FileChange`、`Extension`、tool call/outputも収集しない。未知のtop-level typeは`transcript_unknown_record`として診断する。
- DeepSeek Harnessはデスクトップ版だけを対象にする。会話fileは`~/Library/Application Support/dsh-desktop/harness/sessions/<cwd由来の名前>/<session>/session.v<版>.jsonl.zstd`で、版は3と4を受理する。全リポジトリの会話が同じ場所に置かれるため、対象の絞り込みはsession行の`cwd`で行う。bridge版（`deepseek-bridge/dsh-home`配下の無圧縮`session.v3.jsonl`）は読まない。
- DeepSeekの会話fileは追記のたびにzstdのフレームが足される。取り込みのたびにfile全体を読み、フレームを先頭から順に展開した本文を行単位で読む。書込み途中で欠けた末尾のフレームは、Nodeの版によって読まれないか展開できた分だけ読まれ、どちらでも改行で終わらない末尾行は未完行として次回へ回す。診断のbyte offsetは展開後の本文上の位置になる。
- DeepSeekは`collect`・`notify`・`notify-late`のhook入力（`session_id`、`transcript_path`、`cwd`）も受理する。取り込むのはroot session（`delegationDepth=0`かつ`isSeeded=false`）のuser発言と、`turn/end`が`completed`のturnで最後に本文を持つassistant発言だけ。デスクトップ版からhookを呼ぶ仕組みはこのリポジトリに含まない。
- 完成行を文字列へ変換する前にUTF-8を検証する。不正バイトを含む行は置換せず除外し、`transcript_invalid_utf8`とoffsetを記録する。正常なUnicodeと後続行は保持する。未完行の途中で切れた文字は完成まで判定しない。
- session不一致で保留したscanは、そのscanで積んだmessage/outbox/採番/cursorを一体でrollbackし、保留原因の診断だけを残す。原因が解消すると同じ行を先頭から同じ順で読み直し、重複しないsequenceを採番する。
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

2026-09-28確認。Codex Desktop transcript `0.155.0-alpha.16.4`はrecord typeとkeyだけを確認し、実ログ本文・command・tool output・reasoningは確認用fixtureや診断へ保存していない。実社員ログの中央API送信・実端末へのフック登録・クラウド配置は未実施。
