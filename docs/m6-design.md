# M6 API・MCP・対応記録の実装契約

2026-09-24。正本は実装計画の5.2〜5.3、7節、9.0、10.1〜10.4、12節M6と受け入れ条件A11/A13/A16/A34〜A40。
M6は保存済みの自動検索を現在入力から照合・取得するHTTP API、明示的な追加検索、原文取得、短い対応記録、ローカルstdio MCPアダプターまでを扱う。M7の前後・引き継ぎ・撤回探索と安全な時点の補助通知、M8の配置・再索引は対象外。検索開始は既存どおり入力イベント受領時であり、MCP呼出しへ移さない。

## 検索受付と質問

- 自動受付の質問は固定した`input_id`・`input_revision`の原文とする。既存の自動受付、振り分け、`execute_search`の契約を変えない。
- 明示検索は認証社員が所属する案件、現在入力の内部ID・revision、検索質問、クライアントの冪等キーを受け取る。対象messageは認証社員の同案件sessionに属するuser発言で、指定revisionがcurrentでなければならない。
- `force_refresh=false`かつ質問が現在入力の原文と同じ場合は、処理状態にかかわらず同じ入力revisionの自動受付を返す。自動受付を複製しない。
- 質問が異なる場合、または`force_refresh=true`の場合は`trigger=manual`、`search_action=new_search`、`stage=awaiting_search`の追加受付と`execute_search` jobを同一transactionで作る。質問は受付へ保存し、M5の候補検索・Jev判定は入力原文ではなくその質問を使う。自己根拠除外の境界は現在入力の`input_sequence_no`のまま維持する。
- manual受付は会社・社員・冪等キーで一意にする。同じkey・同じcanonical requestは同じrequest IDを返し、同じkeyで内容が違えばconflictとする。`force_refresh`は冪等性を無効化しない。
- 質問、入力revision、案件、force_refresh、policy版を含む決定的hashを条件識別に使う。異なる条件のmanual受付で自動受付や別manual受付を上書きしない。

## 結果取得と入力照合

- `GET /v1/searches/:id`は認証社員が所属する同一会社・案件の受付だけを返す。IDを知っていても他社・他案件・非所属案件の存在を開示しない。
- `GET /v1/searches/by-input`は案件、input revisionと、内部`input_id`または取り込み元の`source`・`source_scope`・`source_session_id`・`source_message_id`を照合する。外部IDの`source_scope`はイベント受付と同じ会社・社員namespaceへ変換し、接続全体の最新受付を推測しない。
- 入力が未受信、revisionが未受信、または対応する自動受付がない場合は`lookup_status=not_received`を返す。これは検索完了の`outcome=no_match`とは別状態である。
- `wait_ms`は0〜5000の整数。受付が`pending`または`running`なら状態変更または期限まで短い間隔で再読込し、期限では現在状態を返す。HTTP接続の終了後もjobを取消し・失効させない。MCP側の累計待機予算は1回5秒、初期10秒を超えて自動pollしない。
- `new_search`と`skip`は当該受付のstatus/outcome/resultを返す。`reuse`は現在受付から`original_request_id`を同じ会社・案件・社員・sessionの範囲で解決し、元受付の現在状態を追跡する。返却値の`request_id`・`input_id`・`input_revision`は現在受付、`reused_from_request_id`は元受付とし、新しい検索で得た結果とは表示しない。
- reuseの取得時は現在入力のrevision、案件権限、元受付のscope、matched evidenceの原文revisionと案件所属を再検証する。無効な根拠、失効・failed・skipped・no_matchをmatchedとして返さず、別入力の結果へ流用しない。元resultを現在受付の新規resultとしてDBへ複製しない。
- provider障害、入力不整合、世代不整合は機械可読なfailed/expired理由を保持し、`no_match`へ変換しない。

## 原文取得

- `GET /v1/evidence/:message_id`は案件とrevisionを必須にし、認証社員が所属する同一会社・案件のmessage revisionだけを返す。
- 応答はmessage ID、revision、employee ID、role、occurred_at、原文を含む。現在revisionと異なるrevisionも保存済みの根拠として取得できるが、指定revisionが存在しない場合や別案件は返さない。
- M7の前後・引き継ぎ・撤回探索はここへ混ぜない。

## 短い対応記録

- MCPの`record_case`は既存`POST /v1/events`へ`role=agent_report`として送る。別の保存経路やtool log収集を追加しない。
- 入力は案件、冪等キー、取り込み元session/message identity、sequence/revision/occurred_atと、必須の「問題／依頼」「対応」「確認状態」、任意の「原因」「調査手順」「失敗した試み」「制約」「関連ファイル・PR」を持つ。
- 本文は固定した項目順で決定的に組み立てる。空の任意項目は出力しない。600文字は推奨上限として超過時にwarningを返すが、既存イベント本文上限内なら拒否しない。
- agent_reportなので自動検索受付とroute jobは作らず、既存の分類・文書化経路へ渡す。人間確認済み・tool実証済みへ格上げしない。

## MCPアダプター

- 公式TypeScript SDK v2の`@modelcontextprotocol/server`とstdio transportを使用する。stdoutはprotocol専用で、診断はstderrへ出す。
- 公開toolは`search_history`、`get_search_result`、`get_evidence`、`record_case`。`link_session`はM7で実装する。
- 各toolはstrictなZod schemaで入力を検証し、中央HTTP APIの結果をstructured contentとtextで返す。HTTP 4xx/5xx、timeout、応答schema不正はtool errorにし、空結果や`no_match`へ変換しない。
- 設定はAPI URLとtokenを保持する環境変数名をローカル設定ファイルから読む。token本文を設定ファイル、stdout、tool結果へ出さない。接続先はHTTPS、または開発用loopback HTTPだけを許可し、redirectを追跡しない。
- `search_history`は明示検索API、`get_search_result`はrequest IDまたは現在入力照合、`get_evidence`は原文取得、`record_case`は既存イベントAPIだけを呼ぶ。

## HTTP境界と失敗

- 全endpointでBearer認証、会社境界、案件membershipを検証する。unknown field、不正UUID、不正revision、長すぎる質問、不正な待機時間を境界で拒否する。
- 応答へSQL、DB接続情報、token、外部error body、他案件の存在を含めない。認証・membership・入力不正・conflict・未発見・内部障害は固定codeで区別する。
- API timeout、429、5xx、通信障害はMCP tool errorとして返す。検索受付の保存状態をMCP側で推測して変更しない。

## 検証範囲

新規Redはユーザーが採用した次のシナリオを対象にする。

1. request IDによるstatus/outcome区別とreuse追跡。
2. 内部・外部入力ID照合と`not_received`。
3. 最大5秒のlong-pollと期限後のjob継続。
4. 同条件の自動受付再利用、別条件・force refreshのmanual受付、冪等性。
5. agent_reportとしての短い対応記録と自動検索非起動。
6. stdio MCPの4 tool、strict入力、stdout非汚染、HTTPS/loopback制約。
7. 認証・案件境界・不正入力・timeout/5xxの失敗区別。

原文取得とM1〜M5契約維持は実装要件から外さないが、ユーザー指定により独立した新規Redシナリオにはしない。既存test、変更packageのtypecheck、対象lint、buildは検証として実行する。
