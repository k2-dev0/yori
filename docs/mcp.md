# yori MCP の設定と起動

M6で追加しM7で拡張したローカルstdio MCPアダプターは、中央yori APIへHTTPSで接続し、保存済みの自動検索結果取得、追加検索、原文取得、短い対応記録、明示的なセッション引き継ぎ登録をCodex／Claude Codeへ公開する。会話収集と検索開始はcollectorおよび中央APIの責任であり、MCPを起動しなくても継続する。

## 前提

- 中央APIが起動し、利用社員のBearer tokenとproject IDが発行済みであること。
- 対象リポジトリの会話収集が必要な場合は、MCPとは別にcollectorを設定すること。
- 接続先はHTTPSを使用する。開発時だけlocalhost、127.0.0.1、`::1`のHTTPを使用できる。

## 設定

token本文を設定ファイルへ保存しない。設定ファイルにはAPI URLとtokenを保持する環境変数名だけを書く。

```json
{
  "api_url_env": "YORI_API_URL",
  "api_token_env": "YORI_API_TOKEN"
}
```

設定ファイルの絶対pathを`YORI_MCP_CONFIG`へ指定し、同じ起動環境へ実値を渡す。

```sh
export YORI_MCP_CONFIG=/absolute/path/to/yori-mcp.json
export YORI_API_URL=https://yori.example.internal
export YORI_API_TOKEN='発行されたtoken'
npm run --silent mcp:start
```

MCPホストには、リポジトリ直下で`npm run --silent mcp:start`を起動するstdioサーバーとして登録する。`--silent`を外すとnpmの起動バナーがprotocol用の標準出力へ混ざるため、省略しない。ホスト固有の設定形式は対象バージョンの公式手順を確認する。標準出力はMCP protocol専用であり、設定エラーは標準エラーへ出る。

接続先URLに資格情報、query、fragmentは指定できない。tokenをコマンド引数、設定ファイル、ログへ書かない。

## 公開ツール

| ツール | 用途 |
|---|---|
| `search_history` | 現在入力のID・revisionを固定して追加検索する。同じ質問は自動受付を再利用し、別質問または`force_refresh`はmanual受付を作る |
| `get_search_result` | request ID、内部input ID、または取り込み元identityで現在入力の結果を取得する。`not_received`、処理中、失敗、`skipped`、`no_match`、`matched`を区別する |
| `get_evidence` | 検索結果のmessage ID・revisionから保存済み原文を取得する |
| `record_case` | 問題、対応、確認状態を短い`agent_report`として保存する。600文字超は警告するが、本文上限内なら受理する |
| `link_session` | 引き継ぎ元・認証社員本人の引き継ぎ先・根拠発言を取り込み元identityで指定し、明示的なセッション関係を登録する |

`get_search_result`の`wait_ms`は1回0〜5000ms。エージェント側の初期待機予算は累計10秒とし、期限後も中央の検索jobは継続する。処理中を`no_match`と扱わない。

M7のmatched結果は代表根拠に加え、前後発言、後続の訂正・撤回、明示またはJevで採用した引き継ぎ先を`related_evidence`で返す。同じ訂正発言が複数根拠を対象にする場合は、原文を重複させず`relations`配列へ全関係を保持する。探索は最大3 hop・合計10 session・追加context約6,000 tokenで打ち切り、未探索部分があれば`truncated`とwarningを返す。結果取得時にも原文revision、案件、relation、activeなsession linkを再確認する。

## セッション引き継ぎ

`link_session`はHTTP `POST /v1/session-links`と同じstrict入力を使う。`from`と`to`は同一案件、`to`は認証社員本人のsession、`evidence`はどちらかのsessionに属する現在revisionでなければならない。

```json
{
  "project_id": "project-uuid",
  "idempotency_key": "handoff-1",
  "from": { "source": "codex", "source_scope": "github.example/team/repo", "source_session_id": "session-a" },
  "to": { "source": "claude_code", "source_scope": "github.example/team/repo", "source_session_id": "session-b" },
  "evidence": {
    "source": "claude_code",
    "source_scope": "github.example/team/repo",
    "source_session_id": "session-b",
    "source_message_id": "handoff-message",
    "revision": 1
  }
}
```

同じ社員・同じ冪等キー・同じ内容の再送は既存linkを返す。内容違いはconflict、自己link・根拠不一致はinvalid request、別案件・他社員の引き継ぎ先は存在を開示せずnot foundになる。

## 障害時

- HTTP 4xx、429、5xx、timeout、応答形式不正はtool errorになる。空結果や`no_match`へ変換しない。
- `not_received`は中央APIが現在入力をまだ受け付けていない状態であり、該当履歴なしではない。
- `provider_policy_unverified`等の検索失敗は中央の検索受付に残る。MCP側で別プロバイダーへ迂回しない。
- token、SQL、外部error bodyはtool結果へ返さない。
