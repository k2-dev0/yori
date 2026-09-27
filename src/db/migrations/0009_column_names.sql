-- M9: DBカラム名を役割が読み取れる名前に統一する。公開HTTP/MCPのfield名（source_scope・input_id・
-- input_revision・stale等）は変えず、0001〜0008の定義も変更しない。migratorが1トランザクションで適用する。

-- sessions: 値は外部repository名ではなく会社・社員を含む保存namespaceであることを名前に合わせる。
ALTER TABLE sessions RENAME COLUMN source_scope TO source_namespace;

-- message_analysis: retentionは保存方針category、model_versionは応答modelの配列であることを名前に合わせる。
ALTER TABLE message_analysis RENAME COLUMN retention TO retention_category;

-- 旧model_version(text)を応答model配列(jsonb)へ変換する。空文字は[]、JSON配列文字列はその配列、
-- それ以外の通常model名は1要素配列にする。不正なJSONもcast errorにせず1要素配列へ倒す。
ALTER TABLE message_analysis ADD COLUMN response_models jsonb;
UPDATE message_analysis
   SET response_models = CASE
     WHEN model_version = '' THEN '[]'::jsonb
     WHEN pg_input_is_valid(model_version, 'jsonb') THEN CASE
       WHEN jsonb_typeof(model_version::jsonb) = 'array' THEN model_version::jsonb
       ELSE jsonb_build_array(model_version)
     END
     ELSE jsonb_build_array(model_version)
   END;
ALTER TABLE message_analysis ALTER COLUMN response_models SET NOT NULL;
-- 常にstring arrayであることをDBでも保証し、通常model名の誤castやscalar保存を拒否する。
ALTER TABLE message_analysis ADD CONSTRAINT message_analysis_response_models_array_check
  CHECK (jsonb_typeof(response_models) = 'array');

-- parts[].model_versionはkey名だけをresponse_modelへ変え、他のkey・順序・値を維持する。
UPDATE message_analysis
   SET parts = CASE
     WHEN jsonb_typeof(parts) = 'array' THEN COALESCE((
       SELECT jsonb_agg(
                CASE
                  WHEN jsonb_typeof(part) = 'object' AND part ? 'model_version'
                    THEN (part - 'model_version') || jsonb_build_object('response_model', part -> 'model_version')
                  ELSE part
                END
                ORDER BY ordinality)
         FROM jsonb_array_elements(parts) WITH ORDINALITY AS element(part, ordinality)
     ), '[]'::jsonb)
     ELSE parts
   END;
ALTER TABLE message_analysis DROP COLUMN model_version;

-- message_relations: 起点/終点のmessage revisionであることをfrom/toで表す。
ALTER TABLE message_relations RENAME COLUMN source_message_id TO from_message_id;
ALTER TABLE message_relations RENAME COLUMN source_revision TO from_message_revision;
ALTER TABLE message_relations RENAME COLUMN target_message_id TO to_message_id;
ALTER TABLE message_relations RENAME COLUMN target_revision TO to_message_revision;

-- provider_policy_approvals: 許可状態はis_active、学習利用の停止はtraining_disabledで表す。
ALTER TABLE provider_policy_approvals RENAME COLUMN learning_disabled TO training_disabled;
ALTER TABLE provider_policy_approvals RENAME COLUMN active TO is_active;

-- search_requests: 入力messageのID/revisionであることを名前に合わせる。
ALTER TABLE search_requests RENAME COLUMN input_id TO input_message_id;
ALTER TABLE search_requests RENAME COLUMN input_revision TO input_message_revision;
-- 旧original_request_idはreused_from_request_idへ統合する。既存のbuildViewと同じくoriginalを優先し、
-- 移行後は受付チェーンをreused_from_request_idだけで辿る。
UPDATE search_requests
   SET reused_from_request_id = COALESCE(original_request_id, reused_from_request_id)
 WHERE original_request_id IS NOT NULL;
ALTER TABLE search_requests DROP COLUMN original_request_id;

-- event_receipts: message revisionとsearch_requestへの参照であることを名前に合わせる。
ALTER TABLE event_receipts RENAME COLUMN revision TO message_revision;
ALTER TABLE event_receipts RENAME COLUMN request_id TO search_request_id;

-- search_document_sources: 文書側のrevisionとmessage側のmessage_revisionを区別する。
ALTER TABLE search_document_sources RENAME COLUMN revision TO document_revision;

-- jev_evaluations/usage_events: modelは要求modelであり、実応答modelはresponse_modelで区別する。
ALTER TABLE jev_evaluations RENAME COLUMN model TO requested_model;
ALTER TABLE usage_events RENAME COLUMN model TO requested_model;

-- document_publications: 旧版警告のbooleanであることを名前に合わせる。
ALTER TABLE document_publications RENAME COLUMN stale TO is_stale;
