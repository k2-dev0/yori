-- 推定session継続の判定結果。検索時のJev判定をやめ、session単位でバックグラウンド判定した結果を保存する。
-- session_idは判定したsession（後から始まった側）、candidate_session_idは継続元の候補。
-- continuous=falseも保存し、同じ組を再判定しない。
CREATE TABLE session_continuity_judgments (
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  candidate_session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  continuous boolean NOT NULL,
  policy_version text NOT NULL,
  questions_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, candidate_session_id, policy_version),
  CHECK (session_id <> candidate_session_id)
);
CREATE INDEX session_continuity_judgments_candidate_idx ON session_continuity_judgments (candidate_session_id, policy_version)
  WHERE continuous;
CREATE INDEX session_continuity_judgments_session_idx ON session_continuity_judgments (session_id, policy_version)
  WHERE continuous;

ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check
  CHECK (kind IN ('classify_message', 'route_search', 'build_documents', 'execute_search', 'judge_continuity'));
