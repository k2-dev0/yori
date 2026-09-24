-- M8: 世代再索引run、検索要求の開始世代固定、DB検索duration観測。
-- 1024次元のvector型は既存のembedding_generations/document_embeddings/embedding_cacheを使う。
-- 別モデル・別次元は同じ物理tableへ混在させず、別migration・別物理tableで追加する。

-- 再索引のtargetはproject pointerへ選ばれるまで検索に使わせない。0004のstatusへcandidateを追加する。
ALTER TABLE embedding_generations DROP CONSTRAINT embedding_generations_status_check;
ALTER TABLE embedding_generations ADD CONSTRAINT embedding_generations_status_check
  CHECK (status IN ('active', 'candidate', 'retired', 'failed'));

-- 再開可能な再索引run。未完了runはprojectごとに1件だけにする。
CREATE TABLE reindex_runs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  source_generation_id uuid REFERENCES embedding_generations (id) ON DELETE SET NULL,
  target_generation_id uuid NOT NULL REFERENCES embedding_generations (id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'blocked_policy', 'failed', 'completed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX reindex_runs_project_created_idx ON reindex_runs (project_id, created_at);
CREATE UNIQUE INDEX reindex_runs_project_incomplete_idx
  ON reindex_runs (project_id)
  WHERE status IN ('pending', 'running', 'blocked_policy');

-- 検索要求は開始時に固定した世代を保持する。世代削除時は実行中以外の参照をNULLにする。
ALTER TABLE search_requests
  ADD COLUMN embedding_generation_id uuid REFERENCES embedding_generations (id) ON DELETE SET NULL;

CREATE INDEX search_requests_embedding_generation_idx
  ON search_requests (embedding_generation_id)
  WHERE embedding_generation_id IS NOT NULL;

-- DB候補検索のduration観測。本文・credential・検索条件は保存しない。
CREATE TABLE search_duration_samples (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES embedding_generations (id) ON DELETE CASCADE,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX search_duration_samples_project_created_idx ON search_duration_samples (project_id, created_at);
