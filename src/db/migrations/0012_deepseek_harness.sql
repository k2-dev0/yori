-- DeepSeek Harnessのroot sessionを独立sourceとして保存する。

ALTER TABLE sessions DROP CONSTRAINT sessions_source_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_source_check CHECK (source IN ('codex', 'claude_code', 'cursor', 'deepseek_harness'));
