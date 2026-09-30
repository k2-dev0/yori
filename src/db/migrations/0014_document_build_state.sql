-- session単位の変更追跡と末尾chunkの再開状態。原文の正本は従来のrevision。
CREATE TABLE document_build_states (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 0,
  invalidation_version bigint NOT NULL DEFAULT 0,
  built_version bigint,
  dirty_sequence bigint,
  through_sequence bigint NOT NULL DEFAULT -1,
  tail jsonb,
  tail_document_key text,
  chunker_version text,
  policy_version text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 既存データは初回に全体構築してcheckpointを作る。
INSERT INTO document_build_states(session_id, dirty_sequence) SELECT id, 0 FROM sessions;
CREATE INDEX document_build_states_dirty_idx ON document_build_states(updated_at, session_id)
  WHERE dirty_sequence IS NOT NULL;
CREATE INDEX document_revisions_build_pending_idx ON search_document_revisions(document_id, revision)
  WHERE status IN ('pending', 'embedding', 'failed');
CREATE INDEX message_relations_from_revision_idx ON message_relations(from_message_id, from_message_revision);
CREATE INDEX message_relations_to_revision_idx ON message_relations(to_message_id, to_message_revision);

-- 通常公開とは別に訂正探索の入口だけを保持する。原文・embeddingは複製しない。
CREATE TABLE document_correction_anchors (
  document_id uuid NOT NULL REFERENCES search_documents(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES embedding_generations(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  PRIMARY KEY(document_id, generation_id, revision),
  FOREIGN KEY(document_id, revision) REFERENCES search_document_revisions(document_id, revision) ON DELETE CASCADE
);

-- 識別子の欠落だけを再同期する。通常buildの削除/再挿入後は同じTXで要求を解消する。
CREATE TABLE document_entity_repairs (
  document_id uuid PRIMARY KEY REFERENCES search_documents(id) ON DELETE CASCADE
);
INSERT INTO document_entity_repairs SELECT id FROM search_documents;
CREATE FUNCTION track_document_entity_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO document_entity_repairs(document_id) SELECT id FROM search_documents WHERE id = OLD.document_id
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;
CREATE TRIGGER document_entity_deleted AFTER DELETE ON document_entities
FOR EACH ROW EXECUTE FUNCTION track_document_entity_delete();

-- 訂正入口は有効な同案件relationがある間だけ候補となる。単独採用は保存時に別途拒否する。
CREATE VIEW document_search_entries AS
SELECT p.document_id, p.generation_id, p.revision, p.is_stale, false AS correction_only
FROM document_publications p JOIN search_documents d ON d.id = p.document_id WHERE d.is_searchable
UNION ALL
SELECT a.document_id, a.generation_id, a.revision, false, true
FROM document_correction_anchors a JOIN search_documents d ON d.id = a.document_id
WHERE NOT EXISTS (SELECT 1 FROM document_publications p WHERE p.document_id = a.document_id
  AND p.generation_id = a.generation_id AND p.revision = a.revision AND d.is_searchable)
AND EXISTS (
  SELECT 1 FROM search_document_sources s
  JOIN message_relations r ON r.to_message_id = s.message_id AND r.to_message_revision = s.message_revision
  JOIN messages fm ON fm.id = r.from_message_id AND fm.current_revision = r.from_message_revision
  JOIN messages tm ON tm.id = r.to_message_id AND tm.current_revision = r.to_message_revision
  JOIN sessions fs ON fs.id = fm.session_id JOIN sessions ts ON ts.id = tm.session_id
  WHERE s.document_id = a.document_id AND s.document_revision = a.revision
    AND fs.project_id = d.project_id AND ts.project_id = d.project_id
    AND r.policy_version = 'initial-v1' AND r.relation IN ('revoke', 'change')
);

-- 書込と同じTXでdirty範囲を記録し、制限的変更は公開を外す。
-- version行を先にlockする。build側はこのlock中にmessage行lockを取得しない。
CREATE FUNCTION mark_document_build_dirty(message_uuid uuid, unpublish boolean, correction boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE target_session uuid; target_sequence bigint;
BEGIN
  SELECT session_id, sequence_no INTO target_session, target_sequence FROM messages WHERE id = message_uuid;
  IF target_session IS NULL THEN RETURN; END IF;
  INSERT INTO document_build_states(session_id, version, invalidation_version, dirty_sequence)
  VALUES (target_session, 1, CASE WHEN unpublish THEN 1 ELSE 0 END, target_sequence)
  ON CONFLICT (session_id) DO UPDATE SET
    version = document_build_states.version + 1,
    invalidation_version = document_build_states.invalidation_version +
      CASE WHEN target_sequence <= document_build_states.through_sequence OR
        (unpublish AND EXISTS (SELECT 1 FROM search_document_sources s WHERE s.message_id = message_uuid))
      THEN 1 ELSE 0 END,
    dirty_sequence = LEAST(document_build_states.dirty_sequence, target_sequence), updated_at = now();
  IF unpublish THEN
    IF correction THEN
      INSERT INTO document_correction_anchors(document_id, generation_id, revision)
      SELECT p.document_id, p.generation_id, p.revision FROM document_publications p
      WHERE EXISTS (SELECT 1 FROM search_document_sources s WHERE s.message_id = message_uuid
        AND s.document_id = p.document_id AND s.document_revision = p.revision)
      ON CONFLICT DO NOTHING;
    ELSE
      DELETE FROM document_correction_anchors a USING search_document_sources s
      WHERE s.message_id = message_uuid AND s.document_id = a.document_id AND s.document_revision = a.revision;
    END IF;
    UPDATE search_documents d SET is_searchable = false, updated_at = now()
    WHERE d.is_searchable AND EXISTS (SELECT 1 FROM search_document_sources s
      WHERE s.message_id = message_uuid AND s.document_id = d.id AND s.document_revision = d.desired_revision);
    DELETE FROM document_publications p USING search_document_sources s
    WHERE s.message_id = message_uuid AND s.document_id = p.document_id AND s.document_revision = p.revision;
  END IF;
END;
$$;

-- 原文追加・改訂と、改訂によって有効性が変わる撤回先を追跡する。
CREATE FUNCTION track_document_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE related record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.current_revision = OLD.current_revision THEN RETURN NEW; END IF;
  PERFORM mark_document_build_dirty(NEW.id, TG_OP = 'UPDATE');
  IF TG_OP = 'UPDATE' THEN
    FOR related IN SELECT DISTINCT to_message_id FROM message_relations
      WHERE from_message_id = NEW.id AND relation IN ('revoke', 'change') ORDER BY to_message_id
    LOOP PERFORM mark_document_build_dirty(related.to_message_id, false); END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_message_changed AFTER INSERT OR UPDATE OF current_revision ON messages
FOR EACH ROW EXECUTE FUNCTION track_document_message();

-- revisionがmessage追加と別TXで到着しても、本文が利用可能になった時点を記録する。
CREATE FUNCTION track_document_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM messages WHERE id = NEW.message_id AND current_revision = NEW.revision) THEN
    PERFORM mark_document_build_dirty(NEW.message_id, NEW.revision > 1);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_revision_changed AFTER INSERT ON message_revisions
FOR EACH ROW EXECUTE FUNCTION track_document_revision();

CREATE FUNCTION track_document_analysis() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record;
BEGIN
  IF TG_OP = 'DELETE' THEN item := OLD; ELSE item := NEW; END IF;
  IF TG_OP = 'UPDATE' AND
    (NEW.revision, NEW.policy_version, NEW.state_hash, NEW.is_searchable, NEW.retention_category)
    IS NOT DISTINCT FROM
    (OLD.revision, OLD.policy_version, OLD.state_hash, OLD.is_searchable, OLD.retention_category)
  THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM messages m LEFT JOIN document_build_states b ON b.session_id = m.session_id
    WHERE m.id = item.message_id AND m.current_revision = item.revision
      AND item.policy_version = COALESCE(b.policy_version, 'initial-v1')) THEN
    PERFORM mark_document_build_dirty(item.message_id,
      TG_OP = 'DELETE' OR NOT item.is_searchable OR item.retention_category = 'progress_only');
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER document_analysis_changed AFTER INSERT OR UPDATE OR DELETE ON message_analysis
FOR EACH ROW EXECUTE FUNCTION track_document_analysis();

-- 旧/新relation双方を追跡し、現行revision・同案件・現行policyに限って除外する。
CREATE FUNCTION track_document_relation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; candidate record;
BEGIN
  FOR item IN SELECT * FROM jsonb_populate_recordset(NULL::message_relations,
    CASE WHEN TG_OP = 'INSERT' THEN jsonb_build_array(to_jsonb(NEW))
         WHEN TG_OP = 'DELETE' THEN jsonb_build_array(to_jsonb(OLD))
         ELSE jsonb_build_array(to_jsonb(OLD), to_jsonb(NEW)) END)
  LOOP
    IF item.relation NOT IN ('revoke', 'change') THEN CONTINUE; END IF;
    SELECT t.id INTO candidate FROM messages f JOIN sessions fs ON fs.id = f.session_id
      JOIN messages t ON t.id = item.to_message_id JOIN sessions ts ON ts.id = t.session_id
      LEFT JOIN document_build_states b ON b.session_id = t.session_id
    WHERE f.id = item.from_message_id AND f.current_revision = item.from_message_revision
      AND t.current_revision = item.to_message_revision AND fs.project_id = ts.project_id
      AND item.policy_version = COALESCE(b.policy_version, 'initial-v1');
    IF FOUND THEN PERFORM mark_document_build_dirty(candidate.id, TG_OP <> 'DELETE', true); END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER document_relation_changed AFTER INSERT OR UPDATE OR DELETE ON message_relations
FOR EACH ROW EXECUTE FUNCTION track_document_relation();
