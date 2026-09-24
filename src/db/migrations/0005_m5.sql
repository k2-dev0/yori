-- M5: 案件内厳密検索・明示識別子検索・RRF・Jev候補判定・原文結果保存。
-- document_entitiesはbuild_documentsが文書revisionの本文から決定的に抽出した明示識別子だけを保持する。

CREATE TABLE document_entities (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 原文revisionの存在を複合FKで保証し、文書revisionの再計画時は同じrevision番号で置換する。
  FOREIGN KEY (document_id, revision) REFERENCES search_document_revisions (document_id, revision) ON DELETE CASCADE,
  -- 再送・再試行でも同じ識別子を増殖させない冪等キー。
  UNIQUE (document_id, revision, entity_type, entity_key)
);

-- 会社・案件で絞った識別子の完全一致検索用。
CREATE INDEX document_entities_search_idx ON document_entities (company_id, project_id, entity_type, entity_key);
