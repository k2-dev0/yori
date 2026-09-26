# Codex Desktop collector互換性実装計画

- 作成日: 2026-09-26
- 対象: Codex Desktop transcript `cli_version=0.155.0-alpha.16.4`
- 状態: 実装前。実ログの構造確認済み
- 目的: 現在のCodex Desktop会話を、未知形式の誤収集を避けながらyoriへ収集できるようにする

## 1. 結論

現在のCodex Desktop実ログは`0.155.0-alpha.16.4`である。既存対応版`0.155.0-alpha.9.2`と比較し、収集対象の`session_meta`、`event_msg/item_completed/UserMessage`、`AgentMessage`の構造は互換であることを本文を出さずに確認した。

新旧2版を明示allowlistへ登録し、Desktop更新前の既存ログと現在ログを両方収集する。現在インストールされている外部Codex CLI `0.156.1`はDesktop transcript版と別物であり、メッセージを含む実ログが確認できていないためallowlistへ追加しない。

新版で追加された既知の非会話top-level recordを`ignored`として扱い、診断を汚さない。Reasoning、command、file change、extension、tool結果、response itemは引き続き収集しない。未知の将来版は本文を一切送らず、cursorを進めず保留する。

## 2. 確認済みの既存契約

- 既存adapterは対応版を単一文字列`0.155.0-alpha.9.2`で固定している。`src/collector/adapters/codex.ts:3-4`
- `session_meta.payload.id`と`cli_version`からsession recordを作る。`src/collector/adapters/codex.ts:53-58`
- `event_msg/item_completed`のUserMessageは`content[].type=text`を収集する。`src/collector/adapters/codex.ts:63-82`
- AgentMessageは`content[].type=Text`を収集する。`src/collector/adapters/codex.ts:83-86`
- その他のitem typeは本文を読まず`ignored`にする。`src/collector/adapters/codex.ts:87-88`
- collector本体はsessionまたはmessageのversionが単一対応版と一致しなければ`transcript_unknown_version`で保留する。`src/collector/collect.ts:90-92,343-365`
- 未知版保留時はscan内のmessage、outbox、sequence、cursorをrollbackする既存testがある。`src/collector/tests/log-file.test.ts:320-365`
- collector設定・状態・再送の既存契約は`docs/collector.md`に記録されている。

## 3. 実ログで確認した構造

2026-09-25のCodex Desktop実ログについて、本文、command、tool output、reasoningを出力せず、record typeとkeyだけを調査した。

### 3.1 収集対象

| record | 確認したkey・block |
|---|---|
| `session_meta` | `payload.id`, `payload.cli_version=0.155.0-alpha.16.4` |
| `event_msg/item_completed/UserMessage` | `thread_id`, `item.id`, `item.content[].type=text` |
| `event_msg/item_completed/AgentMessage` | `thread_id`, `item.id`, `item.phase`, `item.content[].type=Text` |

### 3.2 収集しない既知record

top-level:

```text
response_item
turn_context
token_usage_record
world_state
```

event message:

```text
task_started
task_complete
turn_aborted
token_count
thread_settings_applied
```

item type:

```text
Reasoning
CommandExecution
FileChange
Extension
```

既存の`response_item`にはmessage、reasoning、custom_tool_call、custom_tool_call_outputが含まれるが、重複・注入context・tool内容を会話原文として扱わないためtop-levelごと無視する。

## 4. 対象範囲

### 4.1 実装するもの

1. Codex Desktop対応版を複数保持するallowlist。
2. 最新確認版`0.155.0-alpha.16.4`の追加。
3. 旧確認版`0.155.0-alpha.9.2`の維持。
4. 版判定を単一文字列比較からallowlist membershipへ変更。
5. 新版の既知top-level非会話recordを`ignored`化。
6. 新旧対応版、未知版、同session内更新、非会話除外のtest。
7. collector手順と実装計画の対応版記録更新。

### 4.2 対象外

- 外部Codex CLI `0.156.1`の対応。
- transcript formatを安定した公開APIとして扱うこと。
- response_itemからのfallback収集。
- reasoning、tool call、command output、file content、system promptの収集。
- 未確認版をsemver rangeで自動許可すること。
- hook設定の自動編集。
- 同一message IDの過去本文再読込による既知のrevision増殖問題。

## 5. 採用シナリオ

### 1. 新Desktop版の通常収集

- 前提: session metaが`0.155.0-alpha.16.4`で、UserMessageとAgentMessageが既存確認形式である。
- 操作: collectorがtranscriptを読む。
- 期待: user／assistant本文、message ID、session ID、timestampだけをoutboxへ入れる。

### 2. 旧対応版の維持

- 前提: session metaが`0.155.0-alpha.9.2`である。
- 操作: 既存ログを再読込またはflushする。
- 期待: 更新前と同じ結果になり、既存sessionを未知版へ変更しない。

### 3. 新版の既知非会話record

- 前提: `turn_context`、`token_usage_record`、`world_state`、`response_item`が含まれる。
- 操作: collectorがscanする。
- 期待: outboxへ入れず、`transcript_unknown_record`診断も作らない。

### 4. tool・reasoning除外

- 前提: Reasoning、CommandExecution、FileChange、Extension、tool call／outputが含まれる。
- 操作: collectorがscanする。
- 期待: 本文、command、出力、patch、reasoningを収集しない。

### 5. 未知の将来版

- 前提: allowlistにない`cli_version`である。
- 操作: user／assistant発言を含むscanを行う。
- 期待: 外部送信0件、cursor不進行、scan内変更rollback、`transcript_unknown_version`診断だけを残す。

### 6. 同session内の確認済み版切替

- 前提: 同じsession IDのlogに旧確認版session metaと新確認版session metaが現れ、各後続messageが確認形式である。
- 操作: 差分scanまたは再読込する。
- 期待: 両版を対応済みとして扱い、sequenceとrevisionの既存規則を維持する。

### 7. 外部CLI版を混同しない

- 前提: shellの`codex --version`が`0.156.1`であるが、Desktop transcriptは`0.155.0-alpha.16.4`である。
- 操作: 対応版一覧を作る。
- 期待: 実ログ根拠のない`0.156.1`をallowlistへ追加しない。

## 6. 実装方針

adapterに次の契約を置く。

```text
SUPPORTED_CODEX_CLI_VERSIONS = [
  "0.155.0-alpha.9.2",
  "0.155.0-alpha.16.4"
]
```

test fixtureの既定版は最新確認版にする。旧版testでは版を明示し、両方を独立に検証する。

collector本体ではsourceごとに単一の`expectedVersion`を返す設計をやめ、`isSupportedTranscriptVersion(source, version)`相当のpredicateへ変更する。Codexはallowlist membership、Claude Codeは現在の単一確認版との完全一致を使用する。

将来用provider registryやsemver判定は追加しない。対応版数が2件である現在の要件に必要な最小構造にする。

top-levelの既知非会話recordはadapter先頭で明示的に`ignored`へ分類する。未知record一般を黙って無視せず、allowlist外の新しいtypeは従来どおり診断対象にする。

## 7. 変更ファイル候補

| file | 変更 |
|---|---|
| `src/collector/adapters/codex.ts` | 複数版allowlist、既知top-level ignored |
| `src/collector/collect.ts` | source別version predicate |
| `src/collector/tests/support.ts` | 最新版fixtureと旧版指定 |
| `src/collector/tests/codex-adapter.test.ts` | 新版shape、非会話除外、旧版維持 |
| `src/collector/tests/log-file.test.ts` | allowlist、未知版、版切替、rollback |
| `docs/collector.md` | 対応版と確認日更新 |
| `development-conversation-memory-implementation-plan.md` | 実装状況・実検証版更新 |

実ログfileや本文をfixtureへコピーしない。構造を最小合成fixtureへ写し、実社員会話、command、tool output、reasoningをrepositoryへ入れない。

## 8. 必須テスト

- `0.155.0-alpha.16.4`のUserMessageを正しく収集する。
- `0.155.0-alpha.16.4`のAgentMessage commentary／finalを正しく収集する。
- `0.155.0-alpha.9.2`の既存挙動を維持する。
- 新旧両版でmessage ID、session ID、timestamp、role、text以外をeventへ入れない。
- response_item、turn_context、token_usage_record、world_stateを無診断で無視する。
- Reasoning、CommandExecution、FileChange、Extensionを無視する。
- 未知top-level typeは`transcript_unknown_record`になる。
- 未知cli_versionは送信せずcursorを進めない。
- 未知版scanの途中で作成したmessage、outbox、sequenceをrollbackする。
- 同sessionの確認済み版切替で既存identityとsequenceを壊さない。
- 旧file、inode交換、短縮、compaction、Stop後flushの既存testが成功する。

## 9. 検証command

対象testを先に実行し、次にcollector全体、repository全体へ広げる。

```sh
node --import tsx --test --test-concurrency=1 src/collector/tests/codex-adapter.test.ts
node --import tsx --test --test-concurrency=1 src/collector/tests/log-file.test.ts
node --import tsx --test --test-concurrency=1 "src/collector/tests/*.test.ts"
npm test
npm run typecheck
npm run lint
npm run build
```

repositoryの通常testは隔離Compose DBと合成fixtureだけを使い、実Jev／Voyage、実社員会話へ送信しない。

## 10. 受け入れ条件

| ID | 条件 |
|---|---|
| CX-01 | 現在のDesktop版`0.155.0-alpha.16.4`からuser／assistant発言を収集できる |
| CX-02 | 旧対応版`0.155.0-alpha.9.2`のログを継続収集できる |
| CX-03 | reasoning、tool、command、file、response itemを収集しない |
| CX-04 | 新版の既知非会話recordで不要な未知record診断を作らない |
| CX-05 | 未確認版は本文送信0件で保留し、cursorを進めない |
| CX-06 | 外部CLI版とDesktop transcript版を混同しない |
| CX-07 | 実ログ本文・秘密・tool outputをtest fixtureへ持ち込まない |
| CX-08 | collector・API・worker・MCPの既存回帰testが成功する |

## 11. 実装順序

1. 新版を検出するRed testと非会話除外testを追加する。
2. Redが単一版比較・unknown分類により失敗することを確認する。
3. testだけをcommitし、baselineを記録する。
4. allowlist、version predicate、known ignoredを実装する。
5. 対象test、collector全体、repository全体を検証する。
6. 対応版と確認日を文書へ反映する。
7. 独立レビューで誤収集、未知版fallback、既存ログ互換を確認する。

追跡対象は1ファイル1コミットとする。

## 12. 完了報告

- 実ログから確認した構造と確認しなかった本文。
- 対応版allowlist。
- 収集対象と明示除外対象。
- 未知版の保留・rollback結果。
- 実行したtest、typecheck、lint、build。
- 外部CLI `0.156.1`を対象外にした根拠。
- commit一覧、独立レビュー結果、残る既知制限。
