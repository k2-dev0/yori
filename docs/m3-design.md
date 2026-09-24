# M3 分類・検索振り分けの実装契約

2026-09-24。正本は直下の実装計画の3.4、6、8.1、9.0、10.3節。
ユーザー採用シナリオは1、2、4、5、7、8。3（報告状態の専用test）、6（競合・再実行の専用test）は不採用。実装計画の不変条件自体は削除しない。

## 既存経路・変更範囲

- `src/api/events.ts`が原文、分類job、userだけのroute_search jobとsearch_requestを同一TXで作る。policyは`initial-v1`。受付の公開契約は維持する。
- `src/jobs/queue.ts`が分類のsession直列化、route優先、lease、再試行、policy停止を持つ。これを使用する。
- 新規`src/worker/`にJev質問・応答境界、文脈構築、処理、CLIを置く。必要なDB変更は`0002_m3.sql`。既存migrationを書き換えない。
- 新規workerは計画で明示されたAPIと別プロセス。既存queueを使い別ブローカーは追加しない。通常Composeにworkerを追加し、test Composeは既存test serviceで検証する。
- 新規検索は`execute_search` jobをpendingで保存するところまで。分類後は`build_documents` jobをpendingで保存するところまで。M3のworkerはこれらをclaimせず、M4/M5未実装をcompleted/no_matchと偽らない。
- package scripts、deployment手順、worker手順、既存migration数・service一覧のtestを変更範囲に含める。schemaは既存PostgreSQL/UUIDv7/timestamptz規約を優先し、Prisma固有の規約は適用しない。

## Jevの契約

公式確認: [API](https://docs.typesafe.ai/api)、[primitives](https://docs.typesafe.ai/primitives)、[confidence](https://docs.typesafe.ai/confidence)。確認日2026-09-24。
Node fetchでPOST `https://api.typesafe.ai/v1/systemone`、Bearer認証。JSONは`model`（初期`jev-latest`）、`state`、`questions`。`questions`は質問IDをkeyとするmapで、質問本体にIDを含めない。Choice質問は`type: choice`、`instructions`、選択肢をkeyとする`criteria`。応答は`model`、`answers`、`usage.input_tokens/output_tokens`。Choice応答は`type`、`choice`、`probabilities`、`confidence`。429/529は再試行対象。aliasは不変revisionとは表現しない。

分類は計画6.2の選択肢をそのまま使う。technical_labelsはラベルごとにyes/no/unknownのChoiceを独立して同時質問する。関係targetは渡した候補IDとnone/unknownのみ。明示/推定もChoiceで判定する。検索用にはsearch_actionと、直近検索に対し対象・制約が同一かのyes/no/unknownを独立して質問する。質問はすべてstateだけを読む。質問IDだけに意味を持たせずinstructionsで対象fieldと判断基準を記す。

Zodで応答の型、全質問の存在、選択肢、分布のkey・有限値・範囲・合計（丸め許容）、confidence、usageを検証する。候補外IDや自由文は保存しない。confidence閾値0.8は設定可能。低信頼分類はunknown、低信頼ラベルは不採用、低信頼関係は確定しない。低信頼検索はnew_search。

## 文脈・長文

同sessionの対象sequenceより前の最大6発言を最新revisionで読む。現在発言はjobのtarget_revision固定。現在以降や別sessionを文脈へ入れない。関係候補は実際にstateへ含めた発言だけ（IDとrevisionを保持）。
Jev用tokenizerは公式契約で確認できていないため、入力予算8,000トークン相当をUTF-8バイト数による保守的なアプリ上限として実装し、実トークン数とは呼ばない。質問・JSONメタデータを含めた送信bodyのUTF-8バイト数を上限とする。Unicodeを壊さず現在発言を原文UTF-16 offset付きの連続範囲に分割する。直前文脈はbudgetに入る最近の完全な発言のみを入れ、除外/分割の存在をstateへ明示する。現在発言は切り捨てない。質問定義だけで予算を超える設定は明示エラー。

partごとの判定とoffsetを保存する。retentionはsubstantive、decision_signal、unknown、progress_onlyの順で保守的に統合し、全partで高信頼progress_onlyのときだけ除外。他の単一分類は全part一致時のみ採用し、不一致はunknown。ラベルは採用値の和集合。関係は各partの確認できた対象だけを位置付きで保存。検索は全partで高信頼skipの場合のみskip、全partで高信頼reuseかつ条件同一の場合のみreuse、それ以外はnew_search。文脈不足を理由に除外・関係を過剰確定しない。

同一入力revision・完全state hash・質問/policy版・設定model・閾値が一致する評価はDBに保存して再利用する。userのrouteとclassifyは同じ質問set/stateを作り分類結果も得るが、routeは分類の完了を待たない。キャッシュは完了済み評価だけ再利用し、同時missでの二重外部評価は許容する。分析適用とrelation保存は分類jobが担当する。

## 保存・実行

`message_analysis`は(message_id, revision, policy_version)一意、分類・part結果・model版・state hash・is_searchableを保存。`message_relations`は元/先message revision、関係、明示/推定、原文範囲、policy版を保存し重複を防ぐ。targetは同sessionの先行原文revisionに限定。原文は更新/削除しない。progress_only再判定はis_searchable=falseとしbuild_documentsに除外要求を渡す。M4で検索文書が導入されるまで索引無効化の実行は未実装。

外部待ちでDB lockを持たない。書込時にjob/lease/期限/対象revisionを検証して分析・関係・後続job・job完了を同じTXで反映する。古いrevisionは現在の状態へ適用せずjobを終了する。評価キャッシュは適用とは別の派生データ。既存queueの完了関数がTXで使えない場合はPoolClient対応へ型を広げるかworkerの同一TXに条件付きSQLを置く。

workerはroute laneとclassify lane各1、合計2を上限にし、同時に1jobずつclaimする。長いmulti-part処理はleaseを更新し、所有を失った場合は適用しない。timeoutはleaseより短く設定。SIGTERM/SIGINTでは新規claimを止め、処理中は終了待ちまたは期限回収可能にする。定期的に期限切れjobを回収する。

## 検索の振り分け

保存分類とsearch_actionは独立。reuseには高信頼reuse＋same_topic＋条件同一、同会社・案件・社員・session・policy、前のinput_sequence、元入力のcurrent revision一致、権限の現存が必要。直近の先行検索を判定対象とし、不適格だからさらに古い検索へ飛ばさない。参照は直接のnew_search元へ解決し、循環/過長のchainは拒否する。

有効期間は初期10分。pending/runningも共有可能。completedはmatchedのみでexpires_at内。failed/expired/skipped/no_match、対象不明、失効はnew_search。matchedの`result.matches[].evidence[]`を計画10.3に従い検証し、原文revisionが現行・同案件、最新分析がprogress_onlyでないことと、採用済みrevoke/change関係による無効化がないことを確認する。不明な結果形式・根拠なしは再利用しない。M5以降も取得時に権限/根拠再検証が必要。

new_searchは条件hash（会社/案件/社員/session、原文質問、文脈hash、policy）と段階awaiting_searchを保存しexecute_searchをenqueue。受付はpendingのまま。reuseは先行request参照とoriginal_request_id・現在input_idを保持し段階awaiting_reused_search、既存結果を別入力の新規結果としてコピーしない。skipはcompleted/skipped。振り分け後の後続検索・再利用元完了追跡・MCP取得はM5/M6。

## ポリシー・失敗・運用

`provider_policy_approvals`はcompany、provider、account参照、endpoint完全一致、規約URL/確認日、学習不使用、保持条件、設定確認時刻/確認者、activeを保持。credentialは保存しない。学習確認は管理者の申告記録であり提供元の設定を変更/証明しない。各HTTP送信直前にDBから承認を確認する（part・再試行も同じ）。未承認はblocked_policy、検索はfailed/provider_policy_unverified、原文保持。無設定なら偽の分類に進まず停止する。redirectは拒否し承認外endpointへ資格情報/本文を送らない。

接続設定はJEV_API_KEY、JEV_ACCOUNT_REF、JEV_API_URL（既定公式HTTPS）、JEV_MODELとworker予算/timeout/閾値。合成fixtureのloopback HTTP endpointをテストで利用できるが、本番の非loopback HTTPは拒否。自動fallback先なし。

`usage_events`はcompany、provider/account/endpoint、operation、model、実usage（不明はnull）、外部所要時間、成功/エラーを記録する。ログに原文・key・外部error bodyを出さない。DB適用時間も本文なしで計測する。429/529/5xx/timeout/通信障害は既存バックオフ/Retry-After、401/422/応答契約不正はfailed。検索受付は障害中failedとcodeを持ち、明示retryまたは自動再試行着手時にpendingへ戻す。no_matchにしない。

CLIはworker起動、指定jobのfailed/blocked_policyからの明示retry、承認登録/失効。承認はJSONファイルからZod検証して登録し、資格情報を引数に含めない。retryは先に承認を確認し検索受付も同一TXで戻す。運用手順に実データ送信前の確認、別account/endpointへの承認非継承、M4/M5待ちの見分けを記す。

## 検証シナリオ

1. 分類・原文保持：substantive/decision_signal/progress_only/unknown、高信頼だけ除外、低信頼保持。
2. 承認・撤回：候補revisionへのリンク、none/unknownは無関係な提案に紐付けない。
4. 独立振り分け：新条件はnew_search、承認はreuse可能、進行のみskip、分類がblockedでもroute可能。
5. 再利用制限：境界、10分期限、pending/running/matched、権限・根拠失効、条件変更/不確実性。
7. 外部送信・障害：未承認/承認失効/endpoint・account変更で送信ゼロ、原文保持、明示再開、429/timeout/恒久エラー。
8. 長文・検証：6発言/予算/原文範囲/Unicode、契約不正と候補外ID、キーなしfixtureによる結合検証。

既存方式node:test、Fastify inject、実PostgreSQL。外部AIだけローカルHTTP fixtureとし本番コードに偽応答を入れない。Redではtestと必要最小限の型・未実装stubを用意し、import/type/syntax失敗でなく未実装挙動によるassert失敗を確認して一度返却する。Green前に親が1fileずつcommitしbaselineを記録する。
検証は`npm test`（隔離Compose DB＋既存回帰）、`npm run typecheck`、変更pathのeslint、`npm run build`。既存migration数固定assertとCompose service allowlistは追加分を含める。HTTPを行う実行はsandbox外。実社員会話は送信しない。

## レビュー後の修正範囲（2026-09-24）

ユーザー指定により指摘1・3・4・5を修正し、2は保留する。

- 再利用chainは途中の受付だけでなく、直接の元検索を含む各参照先の状態・policy・先行入力revision・期限・根拠を検証する。不適格ならnew_searchへ戻す。
- 外部評価後、保存TX内で比較対象の受付を同じIDで読み直し、評価した入力revisionの有効性を確認する。chain終端はnew_search確定済みに限定し、検索要否未判定のpending受付は再利用しない。chainの各受付・元入力へ共有行ロックを取り、参照の保存とjob完了のcommitまで保持する。イベント受付と同じ会社・社員単位のadvisory lockを行ロックより先に取得し、batch改訂とのロック順逆転を防ぐ。HTTP待ち中はこれらのロックを保持しない。
- lease更新等のDB待機後、HTTP送信直前にも有効な送信承認を確認する。外部待機中にDB lockは保持しない。
- ワーカー待機はタイマー満了・停止通知の両経路でtimer/listenerを解放する。
- 設定modelはcache照合に保持し、応答modelは別途cache・usage・各partへ記録する。analysisのmodel_versionは応答modelが全part同一ならその値、混在なら重複除去した応答modelのJSON配列文字列とする。過去cacheで応答modelが不明なものは再利用せず再評価する。追加migrationで既存データを保持する。
- 保留事項2：成功ヘッダー受信後の本文受信中のtimeout/通信切断は、現在provider_contract_invalidとして恒久失敗になる。原文は残り、明示retryで回復できる。今回この挙動は変更しない。
- 再レビューで追加された「同じ関係を示す複数partの根拠範囲が最初の1件だけになる」「正常応答の所要時間に本文受信時間が含まれない」は、ユーザー指定の今回の修正対象から外す。
- 再取得後から保存までの先行入力改訂は、上記の保存TXへ検証を移して対処した。実DBのロック待ちを観測する4回帰ケース（直接/chain × 改訂先行/保存先行）を追加し、修正前に4件失敗、修正後に成功を確認。改訂が先に確定した場合はnew_searchへ戻し、再利用の確定が先なら改訂はcommitまで待つ。保存後に行われる改訂についてはM5/M6の結果取得時にも再検証が必要。
- 同レビューの別件として、正常usage記録後のcache保存失敗でusageを二重計上し得ること、HTTP日時形式のRetry-Afterを解釈しないことを確認。今回指定された2件の外側であり、未修正として引き継ぐ。
- 保存TXによる改訂排他の修正は独立レビューで追加指摘なし。別件として、relation_explicitの質問文が同一呼出し内のrelation_target回答を前提にしており、複数候補で明示/推定を選択対象へ正しく対応付けられない問題を確認。ユーザーが指定した保存競合の修正範囲外として未修正で記録し、M3全体に未解決がないとは扱わない。
