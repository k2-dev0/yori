# yori MCP の設定と起動

M6で追加したローカルstdio MCPアダプターは、中央yori APIへHTTPSで接続し、保存済みの自動検索結果取得、追加検索、原文取得、短い対応記録をCodex／Claude Codeへ公開する。会話収集と検索開始はcollectorおよび中央APIの責任であり、MCPを起動しなくても継続する。

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

`get_search_result`の`wait_ms`は1回0〜5000ms。エージェント側の初期待機予算は累計10秒とし、期限後も中央の検索jobは継続する。処理中を`no_match`と扱わない。

M7の`link_session`、前後・引き継ぎ・撤回探索、補助通知は未実装。

## 障害時

- HTTP 4xx、429、5xx、timeout、応答形式不正はtool errorになる。空結果や`no_match`へ変換しない。
- `not_received`は中央APIが現在入力をまだ受け付けていない状態であり、該当履歴なしではない。
- `provider_policy_unverified`等の検索失敗は中央の検索受付に残る。MCP側で別プロバイダーへ迂回しない。
- token、SQL、外部error bodyはtool結果へ返さない。
