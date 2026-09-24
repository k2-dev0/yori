# M5 案件内厳密検索・候補判定の実装契約

2026-09-24。正本は実装計画の5.2〜5.3、8.2〜8.3、9.0〜9.3、10.3、12節M5と受け入れ条件A01/A02/A11/A13/A17/A19/A22〜A24/A27〜A33/A39/A40。
M5は`execute_search`、案件内の厳密vector検索、明示識別子の完全一致検索、RRF、Jev候補判定、原文根拠付き結果の保存までを扱う。M6のHTTP/MCP結果取得、M7の前後・引き継ぎ・撤回探索、M8の世代切替・再索引CLIは対象外。

## schemaと識別子

- `0005_m5.sql`は`document_entities`を追加する。文書ID・revision、会社・案件、種別、文字大小を保持したkeyを持ち、文書revisionへの複合FK、`(document_id, revision, entity_type, entity_key)`の一意制約、`(company_id, project_id, entity_type, entity_key)`の検索indexを持つ。
- `build_documents`の文書計画適用TXで、文書revisionの本文から明示識別子を決定的に抽出し、当該revisionの行を置換する。本文不変のready文書も同期対象にし、0005適用前から存在する文書を通常の再処理でbackfillする。revision・publication・embeddingは作り直さず、再実行でentityを増殖させない。
- 初期の識別子は拡張子付きファイルpath/ファイル名（複数階層の`../`、`./`、絶対path、`.github/`等のhidden directoryを含む）、`name()`形式の関数、`Issue #123`、`PR #123`。文字大小と先頭表記を変えず、文末句読点やURL内部の部分pathを含めない。推定・部分一致・日本語全文検索は行わない。

## 検索開始と世代

- `execute_search`はjob payloadのUUID形式`search_request_id`とjob対象message/revision、必須のjob session、会社・案件・社員・session、`new_search`をDB正本で照合する。他の受付を入力IDから推測せず、障害更新とretryも同じscope一致を必須にする。不正UUID、不一致payload、NULLまたはmessage所属と異なるjob sessionでは外部送信・受付更新を行わない。
- 完了済みresultの再実行はresultを変更せず、同じjobだけをlease条件付きで完了する。
- 外部送信前にjob leaseとscopeを再確認し、対象受付だけを`running`にする。失敗・retry・明示再開もpayloadの受付1件だけを更新する。
- 開始時にprojectの`active_generation_id`を固定する。NULLなら外部送信せず`completed/no_match`。会社、status、provider/model、次元、metric、tokenizer、document/query前処理が現在configと一致しなければ`embedding_generation_mismatch`でfailedにし、自動切替しない。
- 質問は固定世代の`VoyageEmbeddingProvider.embedQuery`で処理する。`voyage-4-lite`、`input_type=query`、1024次元、float、`truncation=false`と既存の承認・cache・usage契約を使う。

## 候補取得と順位統合

- query埋め込み後の短い`REPEATABLE READ` TXで、固定世代のvector上位20件と明示識別子完全一致上位20件を同じ公開snapshotから読む。TX内で外部HTTPを呼ばず、statement timeoutは5秒。
- company/project、`is_searchable`、ready revision、固定世代のpublicationをSQLで強制する。現在input自身と、現在input以降の同session発言をsourceに含む文書は除外する。別sessionは社員横断。
- route順位`r`へ`1/(60+r)`を加算し、同じ文書revisionを統合する。同点は文書ID・revisionで安定順にする。
- 同じ原文range集合は1件へまとめ、上位10件までをJevへ渡す。重複range、10件上限、token予算による除外は機械可読なwarningへ記録する。
- Jevへ渡す現在質問本文と候補本文の合計を固定Voyage tokenizerで8,000 token相当以下にする。質問だけで予算を使い切る場合、または候補は存在するが全件が残予算に収まらない場合は`input_budget_exceeded`でfailedにし、`no_match`へ変換しない。

## Jev候補判定

- TypeSafeの`POST /v1/systemone`へstructured objectのstateを送り、候補ごとの4段階relevance（unrelated/peripheral/useful/direct）とは別に、対象一致、症状または修正依頼の類似、環境・制約の近さ、実装理由の根拠、手順の再利用性、proposal/reported_completed/reported_verified/unknownを独立したChoice質問で判定する。
- `useful`または`direct`だけを採用し、relevance段階、RRF、文書IDの順で代表候補を1件選ぶ。confidenceを正答率へ変換しない。
- 検証済みChoice回答だけを、全候補について`candidate_evaluations`へ保存する。document ID・revision、総合relevance、positiveな理由コード、statement status、各質問のchoice・全probabilities・confidence、代表採用の有無を残す。原文や外部error bodyはこの診断fieldへ複製しない。
- HTTP送信直前にJevの会社・account・endpoint・学習利用条件の承認を確認する。試行ごとにusageを保存し、原文・credential・外部error bodyは運用ログへ出さない。
- TypeSafe公式APIはstateにstring/object/arrayを受け付け、構造化fieldをinstructionsから参照できる。実Jevへの社内データ送信は未実施で、テストはloopback fixtureのみ。

## 保存と競合

- 外部待ち後は成功・provider障害の両経路でjob identity/payloadをDB現在値から再検証する。成功の保存TXではさらに受付のinput identity・会社・案件・社員・session・search action、input messageのsession・sequence、session employee、project/company、current revision、publication、文書検索可否、全sourceのcurrent revisionを再確認する。inputのmessage/session/projectとsourceの`messages`行は確認時からcommitまで共有lockし、所属変更・改訂との確定順序をDBで固定する。
- 有効な代表候補だけ、原文message ID・revision・社員・role・日時・本文をevidenceへ保存する。assistant/agent_report由来は`agent_reported`とし、ツール実証済みとは表現しない。
- 候補sourceのrevision変更やpublication削除は候補を無効化し、残る候補がなければ`no_match`。lease喪失時は旧ownerがjob・受付を更新しない。
- input自身が改訂された古い検索は、外部送信前または保存TXで当該受付だけを`expired/input_revision_stale`へし、jobをcompletedにする。新revisionの結果として流用しない。
- 成功時は受付の`completed/matched|no_match`、計画10.3のresult、job完了を同一TXで保存する。`index_status`は案件内のpending/failed文書数、固定世代ID、`exact_vector_and_entity`を含む。

## 障害と再開

- Voyage/Jev未承認は`blocked_policy/provider_policy_unverified`。`worker:retry`は`execute_search`についてVoyageとJevの両承認を要求する。
- 429/529/5xx/timeout/通信障害はjobをbackoff付きpendingへ戻し、受付はfailedとcodeを保持する。恒久4xx、応答契約不正、世代不一致、入力予算超過はfailed。いずれも`no_match`にしない。
- runnerはroute lane 1と、classify/build/execute_searchの外部処理lane 1を動かす。`execute_search`はbuildより高い既存priorityでclaimするが、外部処理の並列数は増やさない。

## 検証

`src/worker/tests/m5-search.test.ts`が実PostgreSQLとloopback Jev/Voyageで、識別子索引、leading path、社員横断検索、案件境界、自己根拠除外、RRF、候補上限・token予算、6項目の独立判定と生回答保存、no_match、承認・provider障害、世代固定、実行状態、payload単位の障害更新、stale input、原文改訂の両競合順序、publication/revision/lease競合、冪等再実行、runnerを検証する。実Jev・実Voyage・実会話は使用しない。
