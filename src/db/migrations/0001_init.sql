-- M1: 会話イベント取り込みに必要なテーブル。
-- IDはアプリがUUIDv7を生成して投入する。日時はtimestamptz、可変の分析・判定結果はjsonbを使う。

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE companies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  repository_identifier text NOT NULL,
  active_generation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, repository_identifier)
);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, employee_id)
);

CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('codex', 'claude_code')),
  source_scope text NOT NULL,
  source_session_id text NOT NULL,
  started_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_scope, source_session_id)
);

CREATE INDEX sessions_project_employee_started_idx ON sessions (project_id, employee_id, started_at, id);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  source_message_id text NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no >= 1),
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'agent_report')),
  occurred_at timestamptz NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, source_message_id),
  UNIQUE (session_id, sequence_no)
);

CREATE TABLE message_revisions (
  message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  text text NOT NULL,
  content_hash bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, revision)
);

CREATE TABLE search_requests (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  input_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  input_revision integer NOT NULL CHECK (input_revision >= 1),
  input_sequence_no integer NOT NULL CHECK (input_sequence_no >= 1),
  trigger text NOT NULL CHECK (trigger IN ('auto', 'manual')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'expired')),
  outcome text,
  search_action text,
  policy_version text NOT NULL,
  reused_from_request_id uuid REFERENCES search_requests (id),
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

CREATE UNIQUE INDEX search_requests_auto_input_idx
  ON search_requests (input_id, input_revision, policy_version)
  WHERE trigger = 'auto';

CREATE INDEX search_requests_project_created_idx ON search_requests (project_id, created_at);

CREATE TABLE event_receipts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  request_id uuid REFERENCES search_requests (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, employee_id, idempotency_key)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('classify_message', 'route_search')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'blocked_policy')),
  priority integer NOT NULL DEFAULT 0,
  session_id uuid REFERENCES sessions (id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages (id) ON DELETE CASCADE,
  target_revision integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL UNIQUE,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_claim_idx ON jobs (status, next_run_at, priority);
CREATE INDEX jobs_session_kind_status_idx ON jobs (session_id, kind, status);
