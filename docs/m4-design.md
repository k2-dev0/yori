# M4 決定的文書分割・Voyage埋め込みの実装契約

2026-09-24。正本は実装計画の3.2〜3.4、5.2〜5.3、8.1〜8.3、12節M4と受け入れ条件A07/A10/A19〜A21/A24/A26/A27/A31〜A33。
M4は決定的な検索文書生成、VoyageEmbeddingProvider、学習利用条件の送信ゲート、埋め込み世代、原文対応、古いrevision応答の非公開化までを扱う。M5検索とM8の再索引・世代切替CLIは未実装のままにする。

## schema（0004_m4.sql）

- `embedding_generations`: id, company_id, provider, account_ref, endpoint, model, model_revision(nullable), dimensions（1..2000のCHECK）, metric, tokenizer_version, document_input_type, query_input_type, normalization, status, created_at, updated_at。UNIQUE(company_id, id)。
- `search_documents`: id, company_id, project_id, session_id, document_key, desired_revision, is_searchable, created_at, updated_at。UNIQUE(project_id, document_key)。
- `search_document_revisions`: document_id, revision, content, content_hash, chunker_version, status, created_at, updated_at。UNIQUE(document_id, revision)。statusはpending/embedding/ready/failed/superseded/excluded。
- `search_document_sources`: document_id, revision, message_id, message_revision, start_offset, end_offset, display_order, source_kind, created_at。start/endはJS UTF-16の半開区間。(message_id, message_revision)はmessage_revisionsへの複合FKで保証する。
- `document_embeddings`: document_id, revision, generation_id, embedding vector(1024), input_hash, created_at。UNIQUE(document_id, revision, generation_id)。
- `document_publications`: document_id, generation_id, revision, stale, created_at, updated_at。UNIQUE(document_id, generation_id)。
- `embedding_cache`: id, company_id, generation_id, operation, input_hash, embedding vector(1024), model, dimensions, input_tokens, created_at。UNIQUE(company_id, generation_id, operation, input_hash)。
- `projects(company_id, active_generation_id)`は`embedding_generations(company_id, id)`への複合FKで、同一会社の登録済みgenerationだけを参照する。別会社generationはDBが拒否する。

## 世代

- projectの`active_generation_id`がNULLの初回だけ、会社+完全なprovider spec（provider/account_ref/endpoint/model/dimensions/metric/tokenizer_version/document_input_type/query_input_type/normalization）のactive generationを再利用または作成し、projectへ原子的に紐付ける。
- 既存active generationは`company_id`が対象companyと一致し、`status='active'`で、specがconfigと一致することを必須にする。別会社・retired/failed・spec不一致は自動切替せず`embedding_generation_mismatch`の恒久エラーにする。世代切替はM8。

## 文書生成

- sessionの現行message revisionと`WORKER_POLICY_VERSION`の現行analysisだけをsequence順に使う。is_searchable=false/progress_onlyは除外する。原文は常に`message_revisions`へ残す。
- tokenizerはVoyage公式docsが案内する`voyageai/voyage-4-lite`の公開tokenizerを固定revisionのローカル資産（`assets/voyage-4-lite/`）として使う。実行時に会話本文を配信元へ送らない。`tokenizer_version`へasset revisionと実行library版（`voyageai/voyage-4-lite@0335ddf7698395712e3220733b4079006951cfef+@huggingface/tokenizers@0.2.0`）を記録する。依存はexact 0.2.0に固定する。
- 目標800・上限1200・重複100トークンにprovider document prefixの予約32トークンを含める。message→paragraph→code block境界を優先し、上限を超える単一blockだけをrange付きで分割する。UTF-16サロゲートペアは割らない。
- 単一block分割時のatom上限は、次chunkが重複window（100トークン）と区切り1トークンを保持しても上限内に収まる値にする。改行のない長文でも隣接chunkのoverlapを破棄せず、chunk全体を複製しない。
- `document_key`はsession ID+chunk先頭のmessage ID+そのrevision内start+chunker_versionの決定的hash。先頭messageのrevision番号は含めず、先頭messageを編集して再buildしても同じdocumentの新revisionにする。確定済みchunkは維持し、変化した末尾・編集影響chunkだけ新revisionにする。未公開の最新revisionは同じ番号のまま作り直す。
- 消えた/除外された文書はis_searchable=false、publication削除、最新revision excludedへ揃える（原文rangeは保持）。再び検索対象になった文書は新revisionで再公開する。
- 新revisionがpending/embeddingの間で、旧公開revisionの全source identity（message_id/message_revision/UTF-16 range/source_kind）が新計画の先頭にそのまま残る通常の末尾追加だけ、旧公開revisionをstale=true（旧版利用可・警告付き）にする。source消失・message revision変更・range変更を含む制限的変更では、外部HTTP前の文書構築TXでdocument_publications行を削除して即時検索不能にする。search_documents.is_searchableは新desired revisionの埋め込み用にtrueを維持し、成功時にapplyDocumentEmbeddingsがpublicationを作り直す。
- 新revisionの公開時にstale=falseへ戻して以前のready revisionをsupersededにする。
- provider_rejected/provider_contract_invalidの恒久エラー時は、そのjobが保持するpending/embedding revisionだけをfailedにする（job lease・desired_revisionで限定）。policy blocked・retryable・stale・lease喪失ではfailedにしない。明示retry後は同じ内容のfailed revisionをpendingへ戻して実際に再埋め込みし、空完了にしない。
- 外部HTTPの前に文書構築TXを完了する。processBuild開始時にtarget.currentRevisionとtarget.targetRevisionが不一致なら、文書計画を変更せずlease条件付きcompletedにする。
- loadSessionMessages時点で、session全messageのcurrent_revisionと現行policyのanalysis状態（revision/policy/state_hash/is_searchable/retention）の決定的fingerprintを取得する。applyDocumentPlanはsession advisory lock取得後・書込前に、jobのrunning/lease_token/期限/target_revisionとsession fingerprintをDBで再確認し、不一致はLeaseLostError/StaleApplyErrorでrollbackする。新規message追加・原文revision・分析再分類のいずれでも適用を拒否し、desired_revision/publication/revisionを変更しない。HTTP後の既存再検証も維持する。

## VoyageEmbeddingProvider

- production interfaceは`embedDocuments(texts, generation)` / `embedQuery(text, generation)`。テスト専用のclient injectionは作らず、loopback endpointをconfigで使う。
- 送信は`voyage-4-lite`、input_type=document/query、output_dimension=1024、output_dtype=float、truncation=false。応答のdata indexは重複なし・0..n-1全件を要求し、入力順へ並べ直す。件数/model/1024次元/finite/非ゼロ/usageを検証し、不正は`provider_contract_invalid`とする。
- 408/429/5xx/timeoutだけretryable。headers受信後のbody read timeout/Abortもprovider_timeoutとしてretryableにする。Retry-Afterはdelta-secondsとHTTP-dateを解釈して0..1hへclampする。他の4xxは`provider_rejected`の恒久失敗。試行ごとにusage_eventsを記録し、原文・key・外部error bodyは保存しない。duration_msはbody受信・parse完了まで含める。
- 各HTTP送信の直前にcompany/provider/account/endpoint/active/learning_disabled/`terms_checked_at IS NOT NULL AND <= now()`/`confirmed_at <= now()`で承認を再確認する。NULLの規約確認日は未確認として扱い、外部送信0件・blocked_policyにする。cache hitでも未確認policyの結果を公開に使わない。
- cacheは`company_id+generation_id+operation+完全なinput hash`。vector結果だけを再利用し、document/sourceのidentityは統合しない。
- 応答適用TXでmessage current revision、desired_revision、active generation、input hash、job lease token/期限を全再検証する。一致時だけdocument_embeddings保存・publication更新・revision ready・job完了を同一TXで行う。不一致・所有喪失時は公開しない。

## 実行

- runnerはroute lane 1 + classify/buildの外部処理lane 1の計2並列。`execute_search`はM5までclaimしない。
- `worker:retry`はbuild_documentsにVoyage承認、classify/routeにJev承認を適用し、別providerの承認を流用しない。
- `provider:approve`の承認JSONはproviderに応じてendpointのpathを検証する（voyage_directは`/v1/embeddings`）。

## 設定

`VOYAGE_API_KEY` / `VOYAGE_ACCOUNT_REF`を必須、`VOYAGE_API_URL`（既定`https://api.voyageai.com/v1/embeddings`）と`VOYAGE_REQUEST_TIMEOUT_MS`（既定20000）を設定する。endpointはHTTPS、または開発用loopback HTTPのみ。

## 保留（ユーザー指定）

- 公開を拒否したstale応答のvectorは、同じ旧本文のexact hashに対するembedding_cache行として残り得る（stale応答自体は公開しない）。cacheはcompany_id+generation_id+operation+完全なinput hashで隔離されるため、別の本文の公開へは適用されない。

## 検証

`src/worker/tests/m4-documents.test.ts`がbuild_documents、Voyage送信契約、承認ゲート、cache、障害、外部待ち中の状態変更、runner/retryを実PostgreSQLとloopback HTTP fixtureで検証する。非先頭sourceのprogress_only再分類でのpublication削除、snapshot後のlease回収・snapshot不一致での計画適用拒否、改行なし長文のoverlapも同fileで検証する。`src/db/tests/schema.test.ts`が0004_m4.sqlのschema契約を検証する。実Voyage・実会話は送信しない。
