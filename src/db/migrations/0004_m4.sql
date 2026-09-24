-- M4: 決定的な検索文書生成、Voyage埋め込み世代、原文対応、公開状態、埋め込みcache。
-- IDはアプリがUUIDv7を生成する。日時はtimestamptz、ベクトルは世代で次元を固定する。

-- 埋め込みモデル・前処理・tokenizerの世代。company境界と完全なprovider specで再利用する。
CREATE TABLE embedding_generations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  provider text NOT NULL,
  account_ref text NOT NULL,
  endpoint text NOT NULL,
  model text NOT NULL,
  model_revision text,
  dimensions integer NOT NULL CHECK (dimensions >= 1 AND dimensions <= 2000),
  metric text NOT NULL,
  tokenizer_version text NOT NULL,
  document_input_type text NOT NULL,
  query_input_type text NOT NULL,
  normalization text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- projects(company_id, active_generation_id)の複合FKが同一会社だけを参照できるようにする。
  UNIQUE (company_id, id)
);

CREATE INDEX embedding_generations_company_spec_idx
  ON embedding_generations (company_id, provider, account_ref, endpoint, model, dimensions, tokenizer_version);

-- 検索文書。document_keyはsession・先頭原文・chunker版から決定的に生成する。
CREATE TABLE search_documents (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  document_key text NOT NULL,
  desired_revision integer NOT NULL CHECK (desired_revision >= 0),
  is_searchable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, document_key)
);

CREATE INDEX search_documents_company_project_session_idx ON search_documents (company_id, project_id, session_id);

-- 文書revision。statusはpending/embedding/ready/failed/superseded/excluded。
CREATE TABLE search_document_revisions (
  document_id uuid NOT NULL REFERENCES search_documents (id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  content text NOT NULL,
  content_hash bytea NOT NULL,
  chunker_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'embedding', 'ready', 'failed', 'superseded', 'excluded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, revision)
);

-- 検索本文と原文revisionの対応。start/endはJS UTF-16の半開区間。
CREATE TABLE search_document_sources (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL,
  revision integer NOT NULL,
  message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  message_revision integer NOT NULL CHECK (message_revision >= 1),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  display_order integer NOT NULL CHECK (display_order >= 0),
  source_kind text NOT NULL CHECK (source_kind IN ('original', 'overlap')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (document_id, revision) REFERENCES search_document_revisions (document_id, revision) ON DELETE CASCADE,
  -- 原文revisionの存在を複合FKで保証する。
  FOREIGN KEY (message_id, message_revision) REFERENCES message_revisions (message_id, revision) ON DELETE CASCADE,
  UNIQUE (document_id, revision, display_order)
);

CREATE INDEX search_document_sources_document_idx ON search_document_sources (document_id, revision);
CREATE INDEX search_document_sources_message_idx ON search_document_sources (message_id, message_revision);

-- 世代別の文書埋め込み。初期世代はvector(1024)。
CREATE TABLE document_embeddings (
  document_id uuid NOT NULL,
  revision integer NOT NULL,
  generation_id uuid NOT NULL REFERENCES embedding_generations (id) ON DELETE CASCADE,
  embedding vector(1024) NOT NULL,
  input_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (document_id, revision) REFERENCES search_document_revisions (document_id, revision) ON DELETE CASCADE,
  UNIQUE (document_id, revision, generation_id)
);

-- 世代ごとの公開revision。staleは旧版の警告・無効化状態を表す。
CREATE TABLE document_publications (
  document_id uuid NOT NULL REFERENCES search_documents (id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES embedding_generations (id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  stale boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, generation_id),
  FOREIGN KEY (document_id, revision) REFERENCES search_document_revisions (document_id, revision) ON DELETE CASCADE
);

-- 会社・世代・処理種別・完全な入力hash単位の埋め込みcache。出典は統合しない。
CREATE TABLE embedding_cache (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES embedding_generations (id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('document', 'query')),
  input_hash bytea NOT NULL,
  embedding vector(1024) NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions >= 1),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, generation_id, operation, input_hash)
);

-- 登録済み世代だけをprojectのactive世代として参照する。
-- 複合FKにより別会社のgenerationをactive世代へ指定できない。世代削除時はactive_generation_idだけをNULLにする。
ALTER TABLE projects
  ADD CONSTRAINT projects_active_generation_id_fkey
  FOREIGN KEY (company_id, active_generation_id) REFERENCES embedding_generations (company_id, id)
  ON DELETE SET NULL (active_generation_id);
