# M8 世代再索引・本番配置・運用計測の実装契約

2026-09-25。正本は実装計画の8.3、12節M8、受け入れ条件A25/A30、14〜15節。

M8は、旧埋め込み世代を検索に使い続けたまま新世代を構築し、現在の検索対象が揃った後だけ案件のactive世代を原子的に切り替える。あわせて、旧世代の明示削除、検索要求の世代固定、案件単位の運用計測、単一Linux VM向けのCaddy HTTPS配置と増設手順を扱う。実Lightsail作成、実domain、実証明書取得、実Jev/Voyage、実会話、高負荷性能試験は実施しない。

## schema（0008_m8.sql）

- `embedding_generations.status`へ`candidate`を追加する。candidateは再索引先であり、案件の`active_generation_id`へ切り替わるまで検索に使わない。
- `reindex_runs`は会社、案件、開始時source世代、target世代、status、error、開始・更新・完了日時を保持する。statusは`pending / running / blocked_policy / failed / completed`。同一案件の未完了runは部分UNIQUE indexで1件に限定する。
- `search_requests.embedding_generation_id`は検索開始時に固定した世代を保持する。世代削除時は完了済み参照をNULLにできるが、pending/running要求が参照する世代は削除CLIが拒否する。
- `search_duration_samples`は会社・案件・世代・DB候補検索時間だけを保持する。本文、質問、資格情報、検索条件は保存しない。
- 現providerは1024次元固定で、既存の`document_embeddings`と`embedding_cache`を使用する。別次元を追加するときはruntime DDLを行わず、別migration・別物理tableを追加する。

## 再索引run

`worker:reindex -- <project-uuid>`は現在のWorkerConfigの完全provider specで新しいcandidate世代を作る。同じ案件・開始時source・current specに一致する未完了runがあれば、既存targetを再利用して再開する。

- 案件単位のsession advisory lockで同じ案件の同時実行を拒否する。
- 現在`is_searchable=true`の`desired_revision`をkeyset paginationとbatchで処理し、全件をメモリへ読み込まない。
- targetのembedding、publication、input hashが揃ったrevisionは再送しない。
- VoyageEmbeddingProviderの承認ゲート、cache、件数・順序・次元・有限値検証を再利用する。
- batch適用時に会社・案件・検索可否・desired revision・content hash・全source messageの現行revisionを再検証する。不一致ならtargetへ公開しない。
- candidateへの公開だけでは世代共通のrevision statusを`ready`へ変えない。旧activeの通常`build_documents`がpending revisionを処理できる状態を維持し、完全なcutover TXでだけdesired revisionを`ready`、旧ready revisionを`superseded`へ揃える。
- 承認未確認は`blocked_policy`、retry可能な外部障害は`pending`として同じtargetを再開可能にする。恒久provider拒否・契約違反はrunとtarget世代を`failed`にする。いずれも旧activeを変更しない。
- 最新completed runのtargetが現在activeで、current specと全documentの完全性が一致する同一操作の再実行は成功no-opとする。新しいrun・generation・provider送信を増やさない。

## 原子的切替

切替TXのlock順序は、会社単位generation advisory lock、案件行`FOR UPDATE`、source message行`FOR SHARE`の順とする。通常の初回世代設定も同じ会社単位lockを先に取り、別案件がretire対象世代を同時にactive参照する競合を防ぐ。

切替直前に次を再確認する。

1. 案件のactive世代がrun開始時sourceと一致する。
2. 現在searchableな全desired revisionにsourceが1件以上あり、全source message revisionが現行である。
3. targetのembeddingとpublicationがdesired revisionを指し、publicationはis_staleでなく、input hashがrevision content hashと一致する。
4. 除外・改訂済み・is_staleなtarget publicationが残っていない。

不足があればpointerを変更せず再走査し、進展がなければrunを`pending`へ戻す。完全な場合だけtargetを`active`にして`projects.active_generation_id`を変更する。sourceをactive参照する他案件がなければ`retired`にし、参照があれば`active`を維持する。文書計画の書込TXは案件行を`FOR SHARE`し、この切替検証と直列化する。

## 検索要求の世代固定

`execute_search`はrequest行をロックし、未固定ならその時点の案件active世代を`search_requests.embedding_generation_id`へ保存する。既に固定済みなら案件切替後も同じ世代を使う。

- 固定済み世代は同一会社・完全spec一致で、`active`または`retired`なら利用できる。`candidate`と`failed`は拒否する。
- 世代別publicationが指すrevisionは`ready`または`superseded`を許可する。切替後も旧世代を固定した実行中検索は有効な旧publicationを使い続け、pending / embedding / failed / excludedは候補にしない。
- 質問埋め込み、vector/entity候補、Jev候補判定、結果の`index_status`まで同一generation IDを使う。
- DB候補検索に成功した試行だけ、所要時間を`search_duration_samples`へ記録する。

## 世代削除とmetrics

`worker:generation-delete -- <generation-uuid>`は、active案件、未完了reindex run、pending/running検索要求、または自動retry待ちのpending/running `execute_search` jobが参照する世代を拒否する。検索retryはgeneration行、request行の順でロックし、削除と直列化する。削除可能な世代を固定していたfailed検索要求は、同じTXで`expired / embedding_generation_deleted`へ終端してから世代参照を外し、後から別active世代へ再固定しない。参照の確認と削除は同一TXで行う。

`worker:metrics -- <project-uuid>`は案件単位のJSONだけをstdoutへ返す。

- 世代別の公開文書数、vector数、次元、`vector数 × (4×次元+8)`の容量目安。
- 最新未完了runの再索引残件数。
- PostgreSQLで集約したDB候補検索時間のsample数、p50、p95。
- 案件に属するjobのpending / running / completed / failed / blocked_policy件数。

本文、質問、検索条件、API key、provider credentialは返さない。

## 近似索引（HNSW）導入の準備

2026-10-01追記。候補検索のvector経路は案件内の全文書を総当たりする厳密検索で、文書数に比例して遅くなる。将来、世代ごとの部分HNSW索引へ切り替えるための判断材料だけを用意する。本番の検索経路（`VECTOR_CANDIDATES_SQL`）は変更せず、近似索引への自動切替もしない。再索引への索引作成の組み込みは次の段階で行う。

### 切替基準

`0017_vector_duration.sql`で`search_duration_samples.vector_duration_ms`（NULL可）を追加し、`loadCandidates`がvector経路のqueryだけの所要時間を記録する。既存の`duration_ms`はvector・entity・strategyの合計のまま変えない。列追加前のsampleはNULLで、判定に使わない。

`worker:metrics`の出力へ`ann_recommendation`を追加する。形式は`{ recommended, reasons, thresholds, observed }`。次のどちらかを満たすと`recommended=true`になる。

| 条件 | reason | しきい値 |
|---|---|---|
| 直近のsampleが50件以上あり、`vector_duration_ms`のp95が100ミリ秒を超える | `vector_p95_exceeded` | `min_samples=50`、`vector_p95_ms=100` |
| active世代で検索対象として公開されている文書が20,000件を超える | `document_count_exceeded` | `documents=20000` |

- 「直近」は、案件のactive世代でvector経路の時間を記録済みのsampleを新しい順に200件まで（`sample_window=200`）。
- sampleが50件未満なら`reasons`へ`insufficient_samples`を入れ、時間の条件は評価しない。文書数の条件は独立しており、sample不足でも文書数が超えていれば推奨する。
- しきい値は`src/worker/metrics.ts`の名前付き定数で、暫定値である。最終調整は実測後に行う。
- 本文・質問・検索条件・credentialは返さない。

### 索引の作成・削除

管理者が明示実行するコマンドだけが索引を作る。workerや再索引は自動では作らない。M8の「runtime DDLを行わない」は通常の実行経路についての方針で、この管理コマンドだけを例外とする。

```
npm run worker:ann-index -- create --generation <generation-uuid>
npm run worker:ann-index -- drop --generation <generation-uuid>
```

- 索引名は`document_embeddings_hnsw_<ハイフンを除いた世代UUID>`。
- 作成は`CREATE INDEX CONCURRENTLY ... USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops) WHERE generation_id = '<id>'`。構築中も検索と書き込みを止めない。
- `CONCURRENTLY`は失敗・中断でINVALIDな索引を残す。`create`の再実行はINVALIDな残骸を削除して作り直し、有効な索引があれば`already_exists`で成功する。同じ索引の同時作成はadvisory lockで拒否する（`ann_index_busy`）。
- 作成に成功すると`worker: created duration_ms=<所要時間> index_bytes=<索引サイズ>`を出力する。構築中も検索を止めないため、本番での実行がそのまま実データでの実測になる。次の作成の見積もりに使う。
- 存在しない世代は`generation_not_found`、存在しない索引の削除は`ann_index_not_found`で終了する。
- `worker:generation-delete`は、世代の削除が確定した後にその世代の索引を`DROP INDEX CONCURRENTLY`で削除する。TX内の`DROP INDEX`は`document_embeddings`の排他lockを取り、待機中も後続の検索を待たせるため使わない。索引の削除だけが失敗した場合は`ann_index_drop_failed`で終了する。世代は削除済みで、残った索引はどの行も指さない。同じ`worker:generation-delete`を再実行すれば残った索引を削除し、`ann_index_dropped`で成功する。
- 構築の実測（2026-10-01、pgvector 0.8.6、`maintenance_work_mem=64MB`、乱数の1024次元ベクトル20,001件、`CONCURRENTLY`なし）：13.5秒、索引52 MB。本番composeと同じ64 MBに収まり、メモリ不足の通知は出なかった。`CONCURRENTLY`は表を2回走査するためこれより長い。文書数がこの数倍になる場合は、構築前に`maintenance_work_mem`を見直す。

### 一致率の比較（shadow比較）

```
npm run worker:ann-recall -- --project <project-uuid> [--samples 50]
```

- 質問は、その案件でactive世代を使った過去の検索要求（`search_requests`）を新しい順に使う。質問ベクトルはVoyageを呼ばず、質問本文のhashで`embedding_cache`の`operation='query'`から引く。費用は増えない。hashはDB内で計算し、質問本文は読み出さない。manual検索は受付の質問、auto検索は入力発言の原文が質問になる。
- 検索要求から検索元のsessionと位置も取るため、他案件の質問は混ざらず、本番と同じ除外条件で比べられる。
- 各ベクトルについて上位20件を2通り取り、厳密検索の結果のうち近似検索にも含まれる割合をrecall@20とする。
  - 厳密検索：`VECTOR_CANDIDATES_SQL`と同じ絞り込み（会社・案件・世代・検索可能な公開revision、検索元sessionの質問以降の発言をsourceに含む文書の除外）で、vector型のcosine距離順。式が違うためhalfvecの索引は使われない。
  - 近似検索：同じ絞り込みで、索引と同じhalfvecの式の距離順。`SET LOCAL hnsw.iterative_scan = relaxed_order`、`hnsw.ef_search = 100`を指定する。索引を使うかどうかをplannerの統計任せにしないため、`enable_seqscan = off`と`enable_sort = off`も指定する。実行計画が索引を使わない場合は`ann_index_not_used`で終了し、近似でない値を報告しない。
- 出力はJSON 1行で、要求した件数（`requested_samples`）、実際に比べた件数（`samples`）、厳密検索の結果が空で比べなかった件数（`skipped_samples`）、recallの平均・最小、厳密・近似それぞれの所要時間p50/p95、使った設定値（`top_k`・`ef_search`・`iterative_scan`・`statement_timeout_ms`・`index_name`）。本文・質問・ベクトルは出力しない。
- 世代に有効な索引がなければ`ann_index_not_found`、cache済みの質問を持つ検索要求がなければ`ann_recall_no_samples`で終了する。厳密検索の結果が空になる質問はsampleへ数えず、全ての質問がそうなら`ann_recall_no_documents`で終了する。

測定値を読むときの制約は次のとおり。

- 使えるのは、検索要求と質問ベクトルのcacheが両方残っている質問だけである。検索要求が失効・削除された質問は測れない。
- 文書は現在の公開状態で比べる。検索要求の時点の文書集合は再現しない。
- recallの低下には、HNSWの取りこぼしとhalfvecへの精度低下の両方が含まれる。
- 所要時間は厳密・近似の実行順を交互に入れ替えて測るが、同じ接続・同じbufferを共有するため目安である。

### 採用の目安

recall@20の平均が0.95以上、かつ最小が0.8以上。`samples`が`requested_samples`を大きく下回る場合は、少数の質問の平均であり、目安を満たしても採用の根拠にしない。満たさない場合は`ef_search`や索引の構築parameterを見直す。目安を満たしても本番の検索は自動では切り替わらない。

## 本番配置

`deployment/compose.yaml`の`production` profileだけがCaddyを起動する。Caddyは固定digestの公式imageを使い、80/tcp、443/tcp、443/udpだけを外部公開して`api:3210`へ転送する。APIのhost portはloopback、PostgreSQLは非公開のままにする。PostgreSQL、Caddy data/configはnamed volumeへ永続化し、全serviceのjson-file logを容量制限する。

運用開始には実domainのDNS、VM firewall、provider承認、migration、health確認が必要である。2 GBは開始候補であり人数保証ではない。OOM、継続的スワップ、job滞留、検索p95悪化、ディスク逼迫を確認して4 GBへ増設する。単一VM・バックアップなしという既知の制限は維持する。

## 検証

- `src/db/tests/m8-schema.test.ts`: migration、run、検索世代固定、検索時間sample。
- `src/worker/tests/m8-reindex.test.ts`: 正常切替、追加・改訂・除外追従、provider障害、承認待ち、恒久失敗、再開・完了後no-op、会社・案件隔離、検索世代固定、明示削除とretry競合、metrics、初回世代設定・source改訂・pointer変更・マイクロ秒cursorとの競合。
- `src/worker/tests/m8-ann.test.ts`: vector経路の時間の記録、`ann_recommendation`の分岐、索引の作成・削除と世代削除時の連動、recall比較のJSON出力と固定エラーコード、本文を出力しないこと。pgvector 0.8系が必要なため`npm test`（compose）で実行する。
- `deployment/tests/m8.test.ts`: production profile、Caddy、公開port、永続volume、log rotation、運用手順。
- 合成fixtureとloopback providerだけを使用し、実Jev/Voyage・実会話・実クラウドへ送信しない。
