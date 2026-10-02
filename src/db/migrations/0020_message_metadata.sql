-- 発言を生成したmodelとその思考量。modelが分かる発言のrevisionにだけ行を作り、user発言のように値が無い行を持たない。
CREATE TABLE message_metadata (
  message_id uuid NOT NULL,
  revision integer NOT NULL,
  model_id text NOT NULL,
  reasoning_effort text,
  PRIMARY KEY (message_id, revision),
  FOREIGN KEY (message_id, revision) REFERENCES message_revisions (message_id, revision) ON DELETE CASCADE
);

-- message_revisionsに置いていたmodelを移し、ほぼ全行が空になる列を消す。
INSERT INTO message_metadata (message_id, revision, model_id)
  SELECT message_id, revision, model_id FROM message_revisions WHERE model_id IS NOT NULL;

ALTER TABLE message_revisions DROP COLUMN model_id;
