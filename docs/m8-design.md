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
3. targetのembeddingとpublicationがdesired revisionを指し、publicationはstaleでなく、input hashがrevision content hashと一致する。
4. 除外・改訂済み・staleなtarget publicationが残っていない。

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

## 本番配置

`deployment/compose.yaml`の`production` profileだけがCaddyを起動する。Caddyは固定digestの公式imageを使い、80/tcp、443/tcp、443/udpだけを外部公開して`api:3210`へ転送する。APIのhost portはloopback、PostgreSQLは非公開のままにする。PostgreSQL、Caddy data/configはnamed volumeへ永続化し、全serviceのjson-file logを容量制限する。

運用開始には実domainのDNS、VM firewall、provider承認、migration、health確認が必要である。2 GBは開始候補であり人数保証ではない。OOM、継続的スワップ、job滞留、検索p95悪化、ディスク逼迫を確認して4 GBへ増設する。単一VM・バックアップなしという既知の制限は維持する。

## 検証

- `src/db/tests/m8-schema.test.ts`: migration、run、検索世代固定、検索時間sample。
- `src/worker/tests/m8-reindex.test.ts`: 正常切替、追加・改訂・除外追従、provider障害、承認待ち、恒久失敗、再開・完了後no-op、会社・案件隔離、検索世代固定、明示削除とretry競合、metrics、初回世代設定・source改訂・pointer変更・マイクロ秒cursorとの競合。
- `deployment/tests/m8.test.ts`: production profile、Caddy、公開port、永続volume、log rotation、運用手順。
- 合成fixtureとloopback providerだけを使用し、実Jev/Voyage・実会話・実クラウドへ送信しない。
