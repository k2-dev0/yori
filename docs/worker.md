# worker（分類・文書構築・検索）

`src/worker/`はM3の`classify_message`/`route_search`（Jev）、M4の`build_documents`（Voyage埋め込み）、M5の`execute_search`（案件内検索・Jev候補判定）を処理する。外向きのHTTP先は承認済みJev/Voyage endpointだけで、実会話をテストへ使わない。

## 前提

- `0005_m5.sql`適用済みのPostgreSQL（M3/M4 migrationを含む）。workerはmigrationを実行しない。
- `JEV_API_KEY`/`JEV_ACCOUNT_REF`と`VOYAGE_API_KEY`/`VOYAGE_ACCOUNT_REF`。未設定・不正なら偽の判定・送信へ進まず`invalid_worker_config`で起動に失敗する。
- `JEV_API_URL`はHTTPS（開発用loopback HTTPのみ）で、pathは`/v1/systemone`固定。`VOYAGE_API_URL`は`/v1/embeddings`固定。userinfo・query・fragmentは拒否する。3xxは追従せず、承認外endpointへ資格情報や本文を送らない。
- 実データを送る前に、管理者がTypeSafe/Voyage側のアカウント設定を確認する。この承認記録は設定を変更・証明しない。

## 環境変数

| 変数 | 既定 | 内容 |
|---|---|---|
| `DATABASE_URL` | 必須 | PostgreSQL接続先 |
| `JEV_API_KEY` | 必須 | Bearer credential。ログ・引数へ出さない |
| `JEV_ACCOUNT_REF` | 必須 | 承認とusageのaccount参照 |
| `JEV_API_URL` | `https://api.typesafe.ai/v1/systemone` | 完全endpoint。loopback HTTPは開発用のみ |
| `JEV_MODEL` | `jev-latest` | 送信model |
| `JEV_CONFIDENCE_THRESHOLD` | `0.8` | 採用閾値。未満はunknown・不採用・new_search |
| `JEV_INPUT_BUDGET_BYTES` | `8000` | 質問・JSONメタデータ込みの送信body上限（実トークン数ではない保守的上限） |
| `JEV_REQUEST_TIMEOUT_MS` | `20000` | 1回の外部呼出しtimeout。`JEV_JOB_LEASE_MS`より短くする |
| `JEV_JOB_LEASE_MS` | `60000` | job lease。処理中は半分の間隔で延長する |
| `JEV_WORKER_POLL_MS` | `1000` | 新規jobが無い時のpoll間隔 |
| `VOYAGE_API_KEY` | 必須 | VoyageのBearer credential。ログ・引数へ出さない |
| `VOYAGE_ACCOUNT_REF` | 必須 | Voyage承認とusageのaccount参照 |
| `VOYAGE_API_URL` | `https://api.voyageai.com/v1/embeddings` | 完全endpoint。loopback HTTPは開発用のみ |
| `VOYAGE_REQUEST_TIMEOUT_MS` | `20000` | Voyage 1回の外部呼出しtimeout。`JEV_JOB_LEASE_MS`より短くする |

## 起動

`deployment/compose.yaml`の`worker`はapiのhealthcheck後に起動し、共有node_modules volumeへの同時`npm ci`を避ける。migration適用後に起動する。

```sh
docker compose -p yori -f deployment/compose.yaml up -d --wait db
docker compose -p yori -f deployment/compose.yaml --profile tools run --rm migrate
docker compose -p yori -f deployment/compose.yaml up -d api worker
```

tsxで直接動かす場合:

```sh
npm run worker:start
```

`SIGTERM`/`SIGINT`では新規claimを止め、処理中jobの完了を待って終了する。未完了のまま停止したjobはlease期限切れ後、runner起動時と定期回収（30秒間隔）でpendingへ戻る。

## 承認登録・失効

承認はJSONファイルからZod検証して登録する。credentialは引数にもファイルにも含めない。同じ（会社・provider・account・endpoint）の有効な承認は1件だけ保持する。

```json
{
  "company_id": "018f0a00-0000-7000-8000-000000000001",
  "provider": "jev",
  "account_ref": "acct-a",
  "endpoint": "https://api.typesafe.ai/v1/systemone",
  "terms_url": "https://typesafe.ai/legal/mca",
  "terms_checked_at": "2026-09-24T00:00:00.000Z",
  "learning_disabled": true,
  "retention_terms": "処理後直ちに削除（管理者確認）",
  "confirmed_by": "admin-a",
  "confirmed_at": "2026-09-24T00:00:00.000Z"
}
```

```sh
npm run provider:approve -- /path/to/approval.json
npm run provider:revoke -- <approval-id>
```

- `terms_checked_at`は管理者が規約を確認した日時で必須。NULL（未設定）は未確認として扱い、外部送信0件・blocked_policyにする（`confirmed_at`での代用はしない）。
- 各HTTP送信の直前にDBの承認を確認する。part・再試行・評価キャッシュ再利用でも同じ。lease更新などDB待機の後も送信直前へ再確認し、待機中に失効していれば送信せず`blocked_policy`にする。
- 未承認は`classify_message`/`route_search`とも`blocked_policy`として保持し、検索受付は`failed`/`provider_policy_unverified`にする。`no_match`にはしない。
- account・endpointを変えた承認は継承しない。承認失効後は再登録するまで外部送信しない。

## CLI

| command | 動作 |
|---|---|
| `npm run worker:start` | route lane 1 + classify/build/execute_searchの外部処理lane 1（計2並列）でjobを処理する |
| `npm run worker:retry -- <jobId>` | `failed`/`blocked_policy`のjobを、現在の承認を確認してpendingへ戻す。route/execute_searchは対象の検索受付も同一TXで戻す |
| `npm run provider:approve -- <approval.json>` | 承認を登録し、同じendpointの旧承認を失効させる |
| `npm run provider:revoke -- <approval-id>` | 承認を失効させる |

終了コードは`0`成功、`1`失敗。原文・credential・外部error bodyはログへ出さない。

## 処理内容

workerはroute laneとclassify/build/execute_search laneを各1、合計2並列で走らせ、各laneは同時に1jobだけclaimする。

### classify_message

- 同sessionの対象sequenceより前の最新6発言を最新revisionでstateへ入れる。現在発言はjobの`target_revision`固定。
- 直前の完全発言、直近先行検索の元入力、現在発言の順に予算へ入れる。入り切らない文脈は除外数をstateへ明示する。
- 入力が8,000バイト予算を超える場合は、Unicodeを壊さない連続UTF-16範囲のpartへ分割し、1request 1partで送る。原文範囲（offset/length）は判定と一緒に保存し、原文は切り捨てない。
- retentionは`substantive`→`decision_signal`→`unknown`→`progress_only`の順に保守的に統合する。全partが高信頼`progress_only`の時だけ`is_searchable=false`。
- retention以外の単一分類は全part一致時だけ採用し、不一致はunknownにする。technical_labelsは採用ラベルの和集合。低信頼は採用しない。
- `message_analysis.model_version`は全partの実応答modelが同一ならその値、混在なら重複除去した応答modelのJSON配列文字列（出現順）にする。partごとの応答modelも`parts[].model_version`へ保存する。
- relation_targetはstateへ実際に入れた候補発言ID・none・unknownだけを許可する。decision_actionがaccept/reject/revoke/changeで、対象と明示/推定が高信頼の時だけ`message_relations`へ保存する。低信頼・unknown・候補外は保存しない。
- 適用時はjob lease・対象revisionを同一TXで再確認し、`message_analysis`・関係・`build_documents` job・job完了をまとめて反映する。leaseを失った場合は適用しない。古いrevisionは現在状態へ適用しない。

### route_search

分類の完了を待たず、routeとclassifyは同じstate/questionsから独立に判定する。検索振り分けは保存分類と独立して決まる。

- `new_search`: 条件hashと段階`awaiting_search`を保存し、受付はpendingのまま`execute_search`をenqueueする。
- `reuse`: 高信頼`reuse`＋`same_topic`＋条件同一、同一会社・案件・社員・session・policy、先行入力のcurrent revision一致、権限・根拠が有効な場合だけ。直近の先行検索だけを判定し、不適格でも古い候補へ飛ばない。参照は循環・過長chainを拒否して直接の`new_search`元へ解決するが、chain上の各受付でもscope・対象sequenceより前・原文revisionの存在とcurrent一致・status適格性・期限・根拠を検証し、1つでも不適格なら`new_search`へ戻す。既存結果はコピーせず、段階`awaiting_reused_search`と`reused_from_request_id`/`original_request_id`を保存する。
- `skip`: 全part高信頼`skip`の時だけ`completed`/`skipped`にする（`no_match`とは表現しない）。
- `pending`/`running`の先行検索は共有できる。`completed`は`matched`かつ10分以内の時だけ。`failed`/`expired`/`skipped`/`no_match`・対象不明・失効・条件変更・不確実・低信頼は`new_search`。
- matchedの根拠はevidenceのmessage_id/revisionが現行revision・同案件であること、最新分析がprogress_onlyでないこと、revoke/change関係で無効化されていないことを検証する。不明な形式・根拠なしは再利用しない。

### build_documents

- sessionの現行message revisionと`initial-v1`の現行analysisだけを使い、is_searchable=false/progress_onlyを除外して決定的な検索文書を作る。現行policyで有効なrevoke/change relationのtarget message revision（sourceとtargetがともに現行revisionで、同一案件・会社内のmessage間）も索引対象から除外し、原文・relationは保持する。詳細は[m4-design.md](m4-design.md)。
- 目標800・上限1200・重複100トークン（provider document prefix予約32トークン込み）。message→paragraph→code block境界を優先し、上限超過blockだけをUTF-16 range付きで分割する。単一blockのatom上限は、次chunkが重複windowと区切りを保持しても上限内に収まる値にし、改行なし長文でも隣接chunkのoverlapを破棄しない。
- projectの初回だけactive generationを作成/再利用して紐付ける。既存世代がconfigと不一致なら`embedding_generation_mismatch`の恒久失敗。
- 文書構築TXの後、承認済みVoyageへ`voyage-4-lite`/input_type=document/1024/float/truncation=falseで送信する。応答index・件数・model・次元・finite・非ゼロを検証し、不正は`provider_contract_invalid`、他の4xxは`provider_rejected`でfailedにする。恒久エラー時はそのjobが保持するpending/embedding revisionだけをfailedにし、明示retryで同じrevisionをpendingへ戻して再埋め込みする。
- 旧公開revisionの全source identity（message_id/message_revision/UTF-16 range/source_kind）が新計画の先頭に残る通常の末尾追加だけ、旧公開revisionをstale=true（旧版利用可・警告付き）で残す。source消失・message revision変更・range変更を含む制限的変更や計画から消えた文書は、外部HTTP前の文書構築TXでpublication行を削除して即時検索不能にし、成功時に作り直す。is_searchableは新desired revisionの埋め込み用にtrueを維持する。
- processBuild開始時に対象messageのcurrent revisionがjobのtarget revisionと不一致なら、文書計画を変更せずlease条件付きcompletedにする。build開始時のsession fingerprint（全messageのcurrent_revision、現行policyのanalysis状態、有効revoke/change relation状態）をapplyDocumentPlanへ渡し、session advisory lock取得後・書込前にjobのrunning/lease_token/期限/target_revisionとfingerprintをDBで再確認する。不一致はLeaseLostError/StaleApplyErrorでrollbackし、desired_revision・publication・revisionを変更しない。
- 文書計画はactive generationのspec検証より先に適用する。pending revisionがある場合だけ世代を作成/検証し、spec不一致・retired/failedは`embedding_generation_mismatch`でfailedにする（自動切替しない）。pendingが無ければ世代の作成/検証は不要として完了する。世代不一致でもprogress_only・有効revoke/change relationなどによる除外とpublication削除は外部HTTP前に反映する。
- 適用TXでmessage current revision・desired_revision・generation・input hash・leaseを再検証し、一致時だけembedding保存・publication更新・revision ready・job完了を同一TXで行う。外部待ち中の改訂・lease喪失では公開しない。新revision公開時にstale=falseへ戻し、以前のready revisionはsupersededにする。
- `embedding_cache`（company+generation+operation+input hash）はvector結果だけを再利用し、document/sourceのidentityを統合しない。cache hitでも承認を再確認し、未承認はblocked_policyにする。

### execute_search

- payloadの`search_request_id`、job対象message/revision、会社・案件・社員・session、`new_search`を照合し、対象受付だけを`running`へする。詳細は[m5-design.md](m5-design.md)。
- 開始時のactive generationを固定し、Voyageへ`input_type=query`で質問を埋め込む。世代なしは外部送信なしの`no_match`、spec不一致は`embedding_generation_mismatch`。
- 短いREPEATABLE READ TXで案件内の厳密vector上位20件と明示識別子完全一致上位20件を取得し、RRFで統合する。現在input自身・現在input以降の同session発言、別案件・別会社は除外する。
- 同じ原文rangeをまとめ、上位10件かつ現在質問と候補本文の合計8,000 token相当までをJevへ送る。除外はwarningへ記録し、質問だけで予算超過なら`input_budget_exceeded`。
- Jevのuseful/direct候補から代表1件を選ぶ。総合relevanceとは別に対象一致、症状・依頼、制約、実装理由、手順、発言状態を判定し、全候補のchoice・probabilities・confidenceと採用理由をresultへ残す。代表候補は原文revision・社員・role・日時・本文を保存し、保存TXでlease、入力revision、publication、source revision、scopeを再検証して原文message行をcommitまで共有lockする。
- input自身が改訂された古い受付は`expired/input_revision_stale`で終端する。候補原文の改訂・非公開化は無効化し、残る候補がなければ`no_match`。lease喪失時は旧ownerが受付・jobを更新しない。

### 評価キャッシュ

同一会社・provider/account/endpoint・要求model・閾値・policy版・質問版・state hashが一致する完了済み評価だけを`jev_evaluations`から再利用する。実応答model（`response_model`）がNULLの旧行は応答model不明として再利用せず、再評価して同keyの行を実応答model付きで更新する。cache利用でも承認を再確認する。同時missでの二重外部評価は許容する。

### usage

外部呼出しの試行ごとに`usage_events`へ会社・provider/account/endpoint・operation・要求model・実応答model（`response_model`、応答本文を取得できない失敗はnull）・実usage（不明はnull）・所要時間・成功/error_codeを記録する。応答契約不正でも本文からmodelを取得できた場合は記録する。原文・credential・外部error bodyは保存しない。

## 失敗と再開

- 429/529/5xx/timeout/通信障害: jobはpendingへ戻し、Retry-Afterと指数バックオフ+jitterで再試行する。検索受付はfailedとcodeを持ち、自動再試行のclaim時にpendingへ戻す。
- 401/422/応答契約不正: `failed`で保持する。自動では再送しない。
- 承認未確認: `blocked_policy`。`worker:retry`は現在の承認が有効な時だけpendingへ戻す（build_documentsはVoyage、classify/routeはJev、execute_searchは両方）。
- Voyageの408/429/5xx/timeout（headers受信後のbody read timeout含む）と、HTTP statusを得られないDNS・接続・TLS・本文受信切断等のtransport failure: jobをpendingへ戻し、Retry-After（秒/HTTP-date）とバックオフで再試行する。400/401/403/422/応答契約不正はfailedで保持し、対象revisionもfailedにする。
- 外部待ち中に原文revision・desired_revision・generation・leaseが変化した応答は保存・公開せず、lease期限後の回収へ委ねる。
- 停止・回収後に再開した旧workerのapplyDocumentPlanは、jobのlease所有・期限・target_revisionとsession fingerprintを書込前に再確認し、不一致なら何も変更せず拒否する（lease期限後の回収へ委ねる）。回収後の別workerが公開した文書状態を上書きしない。
- 検索受付の`failed`は`no_match`ではない。`execute_search`の`running`は処理中、`expired/input_revision_stale`は入力改訂による旧受付の終端である。

## 既知の保留事項

- 公開を拒否したstale応答のvectorは、同じ旧本文のexact hashに対するembedding_cache行として残り得る。stale応答自体は公開せず、cacheはcompany_id+generation_id+operation+完全なinput hashで隔離されるため別本文へ適用されない。
- HTTP待ち中に同じmessage revisionのanalysisだけが変わると、次buildまで旧計画が一時公開され得る（原文・analysisは保持され、次のbuildで新しいanalysisから再計画する）。
- Jevの成功ヘッダー受信後の本文受信timeout・通信切断は恒久失敗となる。原文は保持され、明示retryで再開する。Voyageは上記のretryable transport failureとして扱う。
- 長文の複数partが同じ承認・撤回関係を示す場合、関係の根拠範囲は最初のpartだけが保存される。
- Jevの正常応答所要時間はヘッダー受信までを計測し、本文受信の時間を含まない。Voyageは本文受信・parse完了まで含める。

上記はユーザー指定により今回の修正対象から除外している。再利用は外部評価後、保存トランザクション内で比較対象の受付を読み直し、入力revisionが有効で、直接の元検索がnew_searchと確定している場合だけ採用する。各参照先の受付と元入力を保存完了までロックするため、判定後の改訂は保存完了まで待つ。先に改訂された場合は新規検索へ戻す。保存後の改訂はM5/M6の取得時に再検証する。

## テスト

`npm test`は隔離Compose DBと合成loopback HTTP fixtureだけを使う。実Jev/Voyage・実会話は送信しない。workerのテストは`src/worker/tests/`にあり、runner/CLI/cacheも同じfixtureで検証する。
