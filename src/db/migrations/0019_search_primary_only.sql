-- 明示検索で一次資料だけを求める指定。trueの受付は、検索結果の注入を受けて書かれた回答を根拠に持つ文書を候補から外す。
-- 自動受付と既存の受付はfalseのままで、挙動は変わらない。
ALTER TABLE search_requests
  ADD COLUMN primary_only boolean NOT NULL DEFAULT false;
