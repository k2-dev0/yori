-- Cursorの会話を独立sourceとして保存し、選択modelを発言revision単位で保持する。

ALTER TABLE sessions DROP CONSTRAINT sessions_source_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_source_check CHECK (source IN ('codex', 'claude_code', 'cursor'));

ALTER TABLE message_revisions
  ADD COLUMN model_id text,
  ADD COLUMN client_version text;
