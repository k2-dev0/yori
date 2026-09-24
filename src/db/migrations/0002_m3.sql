-- M3: Jev分類・選別・承認関係・検索振り分けの保存先と、後続job種別の追加。
-- IDはアプリがUUIDv7を生成する。日時はtimestamptz、判定・根拠はjsonbで保持する。

-- 後続工程（M4のbuild_documents、M5のexecute_search）のjobをM3からpendingで登録する。
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check
  CHECK (kind IN ('classify_message', 'route_search', 'build_documents', 'execute_search'));

-- 検索受付の段階・条件hash・再利用元の直接のnew_search requestを保持する。
ALTER TABLE search_requests
  ADD COLUMN stage text CHECK (stage IN ('awaiting_search', 'awaiting_reused_search', 'completed')),
  ADD COLUMN condition_hash bytea,
  ADD COLUMN original_request_id uuid REFERENCES search_requests (id);

-- 1発言revisionの分類結果。partsにpartごとの判定と原文UTF-16範囲を保存する。
CREATE TABLE message_analysis (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  policy_version text NOT NULL,
  retention text NOT NULL,
  primary_intent text NOT NULL,
  technical_labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision_action text NOT NULL,
  continuity text NOT NULL,
  statement_status text NOT NULL,
  is_searchable boolean NOT NULL,
  model_version text NOT NULL,
  state_hash bytea NOT NULL,
  parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  apply_duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, revision, policy_version)
);

-- 承認・撤回・変更の根拠リンク。元/先とも原文revisionへ固定する。
CREATE TABLE message_relations (
  id uuid PRIMARY KEY,
  source_message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  source_revision integer NOT NULL,
  target_message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  target_revision integer NOT NULL,
  relation text NOT NULL,
  is_explicit boolean NOT NULL,
  evidence_ranges jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX message_relations_unique_idx
  ON message_relations (source_message_id, source_revision, target_message_id, target_revision, relation, policy_version);

-- プロバイダーの学習利用・保持条件の管理者承認。credentialは保存しない。
CREATE TABLE provider_policy_approvals (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  provider text NOT NULL,
  account_ref text NOT NULL,
  endpoint text NOT NULL,
  terms_url text NOT NULL,
  terms_checked_at timestamptz,
  learning_disabled boolean NOT NULL DEFAULT false,
  retention_terms text NOT NULL,
  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 同一endpointの有効な承認は1件に保つ。別account/endpointの承認は継承しない。
CREATE UNIQUE INDEX provider_policy_approvals_active_idx
  ON provider_policy_approvals (company_id, provider, account_ref, endpoint)
  WHERE active;

-- 外部呼出しの試行ごとのusage。原文・key・外部error bodyは保存しない。
CREATE TABLE usage_events (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  provider text NOT NULL,
  account_ref text NOT NULL,
  endpoint text NOT NULL,
  operation text NOT NULL,
  model text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer NOT NULL,
  success boolean NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_events_company_created_idx ON usage_events (company_id, created_at);

-- 完了済みJev評価の再利用キャッシュ。会社・provider/account/endpoint・model・閾値・policy・質問版で区切る。
CREATE TABLE jev_evaluations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  provider text NOT NULL,
  account_ref text NOT NULL,
  endpoint text NOT NULL,
  model text NOT NULL,
  confidence_threshold double precision NOT NULL,
  policy_version text NOT NULL,
  questions_version text NOT NULL,
  state_hash bytea NOT NULL,
  answers jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, provider, account_ref, endpoint, model, confidence_threshold, policy_version, questions_version, state_hash)
);
