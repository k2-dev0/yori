# M2 会話収集の実装契約

2026-09-21。実行計画4章・M2と、ユーザーが採用した6シナリオに基づく。M3以降の分類・検索実行は別工程。

## 採用シナリオ

1. Codex/Claude Codeのユーザー・AI発言を本文・日時・順序を保持して保存する。
2. ツール出力、推論、システム指示、コンパクション要約を収集しない。
3. 再読込・再起動で重複せず、同文の別発言を区別する。
4. 通信失敗でも未送信イベントを永続保持し、同じ識別子で再送する。
5. 登録済みrepositoryだけ送信する。未登録は保留。同じremoteのworktreeは同じ案件。
6. 未完行・不正形式・未知形式・サイズ超過を誤送信しない。診断に本文・資格情報を含めない。

## 確認した既存契約と形式

- `src/api/contract.ts`、`schema.ts`、`tests/events.test.ts`が受付契約。POST /v1/events、Bearer認証、202のresults。100件・1MiB、本文65536コードポイント、識別子1024 UTF-8 bytes。時刻・role・sequenceは同じmessageのrevisionで変えられない。既存server/DB契約は変更しない。
- Codex公式 https://learn.chatgpt.com/docs/hooks : stdinのsession_id、cwd、transcript_path。UserPromptSubmitにpromptとturn_id。ログは安定契約ではない。
- ローカルCodex Desktopログのcli_versionは`0.155.0-alpha.9.2`。確認日上記。CLIインストール版0.155.1とは区別する。
- Codexでは`event_msg.payload.type=item_completed`の`payload.item.type=UserMessage`と`AgentMessage`を唯一の会話取込経路とする。item.idが発言ID、payload.thread_idがsession、外側timestampが発言時刻。UserMessage.contentはtype=text/text、AgentMessage.contentはtype=Text/text。AgentMessage.phaseはcommentary/final_answer。response_itemは同じ発言・注入コンテキストを含むため全て除外する。reasoningやtool itemも除外する。session_meta.payload.idをhook.session_idと照合。session_metaにはcli_versionがある。
- Claude公式 https://code.claude.com/docs/en/hooks : 同じcommon input。UserPromptSubmitにprompt。Stopのlast_assistant_messageはあるが、最終ログの書込完了がStop時点で保証されない。
- ローカルClaude Code 2.1.220のJSONLを本文を表示せず構造確認。type=user/assistant、uuid、sessionId、timestamp、version、message.role/content。userはstring又はtext block配列、assistantはtext/thinking/tool_use block配列。assistant.stop_reasonはend_turn/tool_use等。userのtool_resultは除外。isMeta/isCompactSummary/isSidechain/isApiErrorMessage、toolUseResult/sourceToolAssistantUUIDのあるレコードは除外する。system/attachment/queue-operation等も対象外。
- Claudeはレコードuuidで発言を識別する（message.idだけでは別content blockを同一視する危険がある）。同uuidの全文更新はrevisionを増やし、完全一致再録は無視する。userのpromptSourceはtyped/queued/sdk、未指定もあり、これだけを必須判定には使わない。ツール結果blockは再帰的にtext抽出しない。
- 未確認の旧版形式へフォールバックしない。Codexは上記cli_version、Claudeは2.1.220を確認済み対応版として明記。未知版は本文を取り込まず診断して保留する。

## 実装境界

`src/collector/`に専用アダプター、設定schema、SQLite state、収集・送信、CLIを置く。`src/collector/tests/`に合成fixtureとテスト。`docs/collector.md`に導入・制約・再送手順、`deployment/README.md`と計画の進捗欄を更新。Node標準node:sqlite、fs、crypto、child_process、fetchと既存Zodを使い、新規依存やサーバーmigrationは不要。

公開CLIは`node dist/collector/cli.js collect --source codex|claude_code --config <path>`（hook JSONをstdinから読む）、`flush --config <path>`（登録済み保留sourceの再読込と未送信再送）。開発時は同じentryをtsxで実行する。フックからMCP無しで動く。フック設定はサンプルを提供し、ユーザーの実設定は自動編集しない。

設定JSON: `api_url`（HTTPS、開発用loopback HTTPだけ許可、userinfo/query/fragment不可）、`token_env`（環境変数名）、`state_dir`（絶対path）、`projects`（`repository` canonical host/path と `project_id` UUIDの対応配列）。tokenは環境から取得し、DB/ログに生tokenを保存しない。endpointとtoken hashでstate namespaceを固定し、資格情報変更時に旧queueを新社員へ送らない。旧資格情報に紐づくqueueは保持。rotation前にflushする運用を記載する。

hook.cwdから`git -C <cwd> rev-parse --show-toplevel`と`git ... config --get remote.origin.url`を引数配列で呼ぶ。ディレクトリ名を案件IDにしない。HTTPS/SSH/SCP形式のremoteをhost小文字＋path（先頭slash・末尾.git除去、path大小文字維持）に正規化する。userinfo/credential/query/fragmentは識別子・ログへ保存しない。ローカルfile remoteや曖昧なremoteは保留。設定の重複repositoryは拒否。source_scopeはcanonical repository。同remoteのworktreeは同じscope。

未登録sourceはcwd/source/session/transcript_pathの参照をローカルに保持して本文を読まず保留する。flush時に対応表を再確認。ログは指定された単一transcriptだけ読む。全履歴の走査はしない。既存sourceのproject/scope再割当は拒否し、未送信分が別案件へ流れないようにする。

## 永続化と読取

SQLiteはstate_dir配下、directory0700/file0600。namespace、source登録、file cursor、session単位のnext sequence、messageのID/revision/hash/固定日時/role、outbox、本文なしのdiagnosticを保存。1回の入力処理はSQLite transactionでcursor・message・outboxを一体更新する。SQLite busy timeoutとBEGIN IMMEDIATEで並行hookを直列化し、読取からcursor commitまでの競合を防ぐ。ネットワーク待機中はtransactionを持たない。

差分を上限付きのpage/lineで読み、session全体をメモリへ載せない。UTF-8のbyte offsetで管理し、未完の末尾行は次回に回す。行上限1MiB、1回最大4MiB読取・100イベント送信を初期固定予算とする。超過行は小さなbufferで改行まで走査し本文なしの診断を記録。JSON破損は診断・当該行をskip。未知版はcursorを進めず保留。

fileのinode変更・短縮時は0から再読込し、session+source message IDで重複を除く。ファイル先頭の小さなfingerprintも使い同inode書換えを検知する（appendだけでfingerprintが変化しない長さを保持）。ログ切替でもsession単位のsequenceを維持。同じID・同本文なら送らず、本文変更ならrevision+1。role/時刻を変更する更新は保留し診断。source_message_idは元ID、idempotency_keyはnamespace/scope/session/message/revisionの決定的hash。本文内容で別発言を統合しない。

Zodの既存eventsRequestSchemaで送信イベントを最終検証。不正NUL/サロゲート/本文超過は切詰めない。元ログを残し、参照offsetと理由を診断する。診断は固定code＋件数/offsetのみとし、生本文・raw error・URL資格情報を出力しない。

## 送信

outboxはsequence/revision順に最大100件、body1MiB以内でbatch化。5秒timeout、redirect禁止。202かつresultsの件数・idempotency_key・revision・message_id・request_id型が一致した時だけ、そのbatchのoutbox行を削除する。送信後crash/応答消失は同じbodyを再送する。失敗でcursorを巻き戻さずoutboxを保持する。

429/5xx/timeout/通信障害は指数backoff（最大5分）、Retry-After上限付きで次回へ。401/403/400/409等はfailedとして保持し、明示flushで再試行可能にする。自動再試行は連打しない。成功扱いして黙って削除しない。外部へ送る先は設定中央APIだけ。Jev/Voyage等へ呼出しを追加しない。

M2ではhookをログ読取の契機にする。hook.promptやlast_assistant_messageから別IDを発明して二重保存しない。Stop直後に未書込の最終発言は次のhook又は明示flushで回収する。入力時点の即時検索・MCPの照合はM6の残件として明記する。

## 検証

node:test、既存tsx。`npm run test:src`に含まれる配置とする。独立実行は`node --import tsx --test --test-concurrency=1 'src/collector/tests/*.test.ts'`。外部HTTPはNode MockAgent相当のグローバルfetch mock又はローカルHTTP fixtureで検証し、実データ送信なし。HTTPを使う検証はサンドボックス外で実行する。DBとの縦通しは既存Fastify app.inject＋実PostgreSQL fixtureを使い、collectorが生成したbatchを既存APIへ渡して保存・重複・自動検索受付を確認する。

Redは公開関数/CLIの最小stubを許可し、import失敗ではなく未実装の期待値不一致で確認する。Red後に親が1ファイル1commitとbaselineを実施。Green後に対象テスト、既存API回帰、typecheck、lint、buildを実行。独立レビューは固定commit全差分。

テスト環境補足: テスト用Node slim imageにはgitがなく、実行sandboxは一時directory内の.git作成も拒否する。通常テストではテスト専用PATH内のgit fixtureで引数・cwdとremote/worktree応答を検証する。productionへの注入口は追加しない。実gitの連携はホスト上の一時repository/worktreeで別途スモーク検証する。明示flushはretry時刻を待たずfailed/pendingを再試行でき、自動collectだけがbackoffを守る。
