-- M7: 明示的なsession引き継ぎリンク。質問依存の推定候補は永続化せず、この表には置かない。
-- 公開APIはactive作成だけを扱い、revokedへの更新は将来用途に限る。
CREATE TABLE session_links (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  from_session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  to_session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  evidence_message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  evidence_revision integer NOT NULL CHECK (evidence_revision >= 1),
  is_explicit boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_by_employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  condition_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 自己リンクはAPIの400契約に加え、保存層でも作らせない。
  CONSTRAINT session_links_endpoints_differ CHECK (from_session_id <> to_session_id)
);

-- 探索は両方向のactive linkをsession単位で引くため、from/toへ個別indexを置く。
CREATE INDEX session_links_from_session_idx ON session_links (from_session_id);
CREATE INDEX session_links_to_session_idx ON session_links (to_session_id);

-- 同一社員の冪等再送を1行へ固定する。内容違いはAPIがcondition_hashで409へ写す。
CREATE UNIQUE INDEX session_links_idempotency_idx
  ON session_links (company_id, created_by_employee_id, idempotency_key);

-- 同じactiveな元・先・根拠の重複保存を拒否する。revokedは対象外にする。
CREATE UNIQUE INDEX session_links_active_endpoint_idx
  ON session_links (from_session_id, to_session_id, evidence_message_id)
  WHERE status = 'active';
