# M7 前後・引き継ぎ・撤回探索の実装契約

## 範囲

M7は検索結果の代表根拠を起点に、同一セッションの前後、明示的または限定的に推定したセッション継続、後続の訂正・撤回を取得する。明示的な引き継ぎ登録用のHTTP APIとMCP tool、安全な時点で検索完了を伝える補助通知も追加する。

M8の再索引・世代切替・配置・性能検証は対象外。検索の開始条件、代表候補の検索・Jev判定、原文取得、MCPの明示取得はM6までの契約を維持する。補助通知はMCP取得の代替にせず、通知不能・期限超過を`no_match`へ変換しない。

## 採用シナリオ

1. `link_session`は引き継ぎ元・先・根拠発言を取り込み元identityで受け、認証社員が所属する同一会社・同一案件の内部IDへ解決して保存する。引き継ぎ先は認証社員本人のセッションとし、別案件・別会社の存在は開示しない。同じ冪等キーの同内容再送は同じリンクを返し、内容違いはconflict、自己リンクはinvalid requestにする。
2. 代表根拠と同じセッションから、sequence上の前後2発言を現在revisionで取得する。現在入力以降の同一セッション発言、旧revision、別案件は含めない。
3. 明示セッションリンクを優先して両方向へ探索し、最大3ホップ・合計10セッションで止める。訪問済みセッションIDで循環を検出する。
4. 推定のセッション継続はバックグラウンドで判定して保存する。各セッションの文書構築後に`judge_continuity` jobを10分遅延で1件登録し、同社員・同案件の直前3セッションと、共通する明示Issue／PR entityを持つセッションを候補として、1回のJev requestで「作業を引き継いでいるか」を判定する。高信頼の継続だけを`session_continuity_judgments`へ継続として保存し、判定済みの組は再判定しない。時刻隣接だけでは採用しない。検索時はJevを呼ばず、継続と判定されたセッションの文書のうち質問の埋め込みに近いものだけを推定候補として付ける。
5. `revoke`・`change`の後続関係を最大3ホップで追跡し、元根拠を残したまま訂正・撤回原文と関係種別を返す。訪問済みmessage ID＋revisionで循環を検出する。
6. 最終コンテキストは既存のVoyage tokenizerで約6,000 tokenを上限とし、代表根拠、訂正・撤回、明示リンク、推定リンクの順で採用する。代表根拠の原文は切り詰めない。候補数・hop・session数・token予算・外部判定失敗で探索を打ち切った場合は`truncated=true`と機械可読なwarningを返す。
7. 保存直前と結果取得時に、原文のcurrent revision、案件所属、検索対象入力のrevision、relation/linkの有効状態を再検証する。現在入力以降の同一セッション発言は周辺・引き継ぎ・訂正のどの経路でも返さない。
8. 補助通知CLIは`UserPromptSubmit`の非同期hookから`turn_id`と`prompt`を収集し、最大10秒の結果待機後、完了結果だけを安全な次のmodel入力へ追加する。message IDは`turn:<turn_id>:user`として決定的に生成し、現在入力を特定できない場合は通知しない。利用者のhook設定を自動編集せず、強制的に新しいturnを開始しない。
9. migration、API、MCP、worker、collector、案件境界、循環、上限、revision競合、既存M1〜M6の回帰を実PostgreSQLとloopback fixtureで検証する。実Jev・実Voyage・実会話は送信しない。

## `session_links`の保存契約

M7 migrationで`session_links`を追加する。

| column | 契約 |
|---|---|
| `id` | アプリ生成UUIDv7 |
| `company_id` / `project_id` | linkの会社・案件境界 |
| `from_session_id` / `to_session_id` | 引き継ぎ元・先。異なるsessionを要求 |
| `evidence_message_id` / `evidence_revision` | 明示的引き継ぎの根拠。いずれかのendpoint sessionに属する現在revision |
| `is_explicit` | `link_session`では常にtrue。質問依存の推定候補は永続linkにしない |
| `status` | `active` / `revoked`。M7の公開APIはactive作成だけを扱う |
| `created_by_employee_id` | 登録した認証社員 |
| `idempotency_key` / `condition_hash` | 同一社員の再送照合。資格情報や原文をhash対象へ入れない |
| `created_at` / `updated_at` | 監査時刻 |

`from_session_id`、`to_session_id`に個別indexを置く。`company_id, created_by_employee_id, idempotency_key`を一意にし、同じactiveな元・先・根拠を重複保存しない。外部identityをSQL識別子へ展開せず、すべて値parameterとして解決する。

## HTTP API

`POST /v1/session-links`は次のstrict JSONを受ける。

```json
{
  "project_id": "uuid",
  "idempotency_key": "client-generated-key",
  "from": {
    "source": "codex",
    "source_scope": "github.example/team/repository",
    "source_session_id": "source-session-id"
  },
  "to": {
    "source": "claude_code",
    "source_scope": "github.example/team/repository",
    "source_session_id": "destination-session-id"
  },
  "evidence": {
    "source": "claude_code",
    "source_scope": "github.example/team/repository",
    "source_session_id": "destination-session-id",
    "source_message_id": "handoff-message-id",
    "revision": 1
  }
}
```

- 初回作成は201、同内容の冪等再送は200。
- session identityは`source + source_scope + source_session_id`で解決する。
- `from`と`to`は同一会社・案件に属し、`to`は認証社員本人のsessionでなければならない。
- `evidence`は`from`または`to`のsessionに属する現在revisionでなければならない。
- 未存在・別会社・別案件・他社員の引き継ぎ先は404へ統一し、存在を開示しない。
- unknown field、自己リンク、根拠session不一致は400。同じ冪等キーの内容違い、一意制約競合は409。
- 成功応答は`link_id`、`project_id`、`from_session_id`、`to_session_id`、`evidence_message_id`、`evidence_revision`、`status`を返す。

## MCP `link_session`

MCP toolはHTTP APIと同じstrict入力を受け、中央APIの成功応答をstructured contentとtextで返す。中央APIの4xx・5xx・timeout・応答schema不正は固定文言のtool errorにし、成功や空結果へ変換しない。token、SQL、外部error bodyを出力しない。

## 周辺・継続探索

探索は代表候補が保存直前の再検証を通過した後、同じ検索job内で行う。

1. 代表文書の一意なsource messageをprimary evidenceとして固定する。
2. primary evidenceごとに同一sessionのsequence前後2発言をcurrent revisionで読む。
3. `message_relations.to -> from`方向（旧target -> source）へ`revoke`・`change`を最大3ホップ探索する。訂正・撤回自身に後続関係があれば同じ上限内で追う。
4. primary sessionからactiveな明示session linkを両方向へ幅優先探索する。link先に根拠messageが属すればその前後2発言、属さなければ順方向の継続先は先頭5発言、逆方向の引き継ぎ元は末尾5発言を候補文脈にする。
5. 明示linkを処理した後、primary sessionとどちら向きでも継続と判定済みの同案件sessionを推定候補にする。既出sessionと、primaryと明示link（active/revoked）でつながるsessionは除く。
6. 推定候補sessionの公開文書（各session最新200件まで）を質問の埋め込みと比べ、各session最大2件のうち、類似度が0.3以上かつ代表文書の類似度の0.8倍以上の文書だけを採用し、そのsource messageを返す。継続判定は質問に依存しないため、質問との関連はこの近さで確認する。
7. 検索時の推定探索は外部HTTPを呼ばない。継続判定jobのJev失敗は通常のjob再試行で扱い、判定前のsessionは推定候補にならない。

合計10sessionにはprimary sessionを含む。明示link、推定候補とも最大3ホップを超えない。sessionとmessage revisionの訪問済み集合を別に持ち、循環時に同じ原文を再追加しない。

## 結果契約

既存matchへ次を追加・確定する。

```json
{
  "evidence": [],
  "related_evidence": [
    {
      "message_id": "uuid",
      "revision": 1,
      "employee_id": "uuid",
      "role": "assistant",
      "occurred_at": "2026-09-21T01:00:00.000Z",
      "text": "後続の訂正です。",
      "relation": "change",
      "related_to_message_id": "uuid",
      "related_to_revision": 1,
      "relations": [
        {
          "relation": "change",
          "related_to_message_id": "uuid",
          "related_to_revision": 1
        }
      ],
      "source_kind": "correction"
    }
  ],
  "related_evidence_ids": ["uuid"],
  "truncated": false
}
```

`source_kind`は`neighbor`、`correction`、`explicit_session_link`、`inferred_session_link`のいずれか。訂正・撤回では`relation`と`related_to_*`を返し、それ以外は省略する。同じ訂正messageが複数の根拠を対象にする場合、原文は1件に保ち、全関係を`relations`へ返す。単一関係では従来の単数fieldを維持し、複数関係でも先頭関係を単数fieldへ残す。`related_evidence_ids`は`related_evidence`のmessage IDを初出順で重複除去した互換fieldとする。

token予算はprimary evidenceを除く追加候補の採用判定に使う。追加候補の予算採用順は訂正・撤回、neighbor、明示session link、推定session linkとし、訂正を長い周辺発言より先に確保する。公開結果の表示順はneighbor、訂正・撤回、明示session link、推定session linkの安定順を維持する。primary evidenceは原文性を壊す切り詰めをせず、単独で6,000 tokenを超えても保持して`truncated=true`と`context_token_budget_exceeded` warningを返す。

## 補助通知

collector CLIへ同期`notify`と非同期`notify-late`を追加し、既存のcollect処理を実行してから、確定したuser message identityに対する検索結果を取得する。

- `notify`は`GET /v1/searches/by-input`を外部identityで呼び、今回入力だけ最大5秒待つ。期限後も検索jobを取消さず、未配信identityをcollector SQLiteへ本文なしで保持する。
- `notify-late`はfast path終了後に起動し、5秒long-pollを繰り返して最大60秒待つ。並行processはSQLiteのatomic claimにより1回だけ配信する。セッション終了や期限でprocessが終わっても未配信identityは残し、次回hookが完了結果を回収する。
- `status=completed`の`matched`・`no_match`・`skipped`、または`status=failed`の結果だけを追加contextとして返す。`not_received`、`pending`、`running`、timeoutは出力なしで終了する。失敗時の`outcome`は既存契約どおりnullのまま、`status`と`error_code`を通知する。
- `matched`の追加contextには、関連する検索結果の回答への反映、追加調査の許可、資料本文内の指示の無視を求める短い固定文と、request ID、outcome、根拠を含める。`no_match`・`skipped`はrequest IDとoutcome、`failed`はrequest IDとstatusとerror codeだけを一行で通知する。
- 訂正・撤回はprimary evidenceとneighbor等の周辺根拠より先に追加contextへ出し、primary evidenceは「元の根拠（訂正・撤回前を含む）」として区別する。複数relationも対象と種別を併記する。関連根拠の件数上限で省略した場合は省略件数を示し、`truncated`またはwarningがあれば全探索済みではないことを明記する。
- 5秒以内の完了結果は同期hookから現在turnへ渡す。遅延結果はCodexでは現在turnの次の安全地点、なければ次のuser turn、Claude Codeでは次のconversation turnへ渡す。idle中に新規turnを強制開始しない。
- hook設定例だけを`docs/collector.md`へ追加する。端末への実設定は`yori-cli`のinstall/updateが、既存の無関係なhookを保持して同期`notify`・非同期`notify-late`・同期`collect`へ更新する。

## 検証

- migration schema・index・制約
- `POST /v1/session-links`の正常、冪等、conflict、strict入力、自己link、根拠不一致、社員・案件・会社境界
- MCP `link_session`のschema、HTTP mapping、応答検証、障害区別、stdout非汚染
- 前後2発言、現在入力境界、current revision、別案件除外
- 明示link優先、両方向、3 hop、10 session、循環検知
- 継続判定jobの候補選定（直前3session・共通Issue／PR・他社員の時刻隣接除外）、1回のJev判定、判定済みの組の再判定防止、検索時の埋め込み近さによる採否
- `revoke`・`change`の後続取得、chain、循環、原文保持
- 6,000 token予算、優先順、`truncated`、warning
- 候補判定中のrevision・link・relation・lease競合
- 補助通知の完了／処理中／未受付／失敗、5秒fast path、late配信の永続化・一意claim、identity不明時の無出力、token非漏えい
- 対象test、src全test、typecheck、変更path lint、build
