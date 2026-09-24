-- M6: 明示検索（manual受付）の質問と冪等キーをsearch_requestsへ保持する。
-- auto受付は固定input revisionの原文を質問とするためNULL、manual受付だけquestion/idempotency_keyを持つ。
ALTER TABLE search_requests ADD COLUMN question text;
ALTER TABLE search_requests ADD COLUMN idempotency_key text;

-- manual受付は会社・社員・冪等キーで一意にする。同じキーの再送は同じ受付を返し、受付やjobを複製しない。
CREATE UNIQUE INDEX search_requests_manual_idempotency_idx
  ON search_requests (company_id, employee_id, idempotency_key)
  WHERE trigger = 'manual';
