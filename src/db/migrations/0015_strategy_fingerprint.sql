-- 設計方針fingerprint。対象・用語が違っても同型の設計判断を候補へ入れる検索経路に使う。
-- 値は`軸:値`の昇順配列。none/unknown・低信頼の回答は含めない。旧分析は空配列で、再分類時に埋まる。
ALTER TABLE message_analysis ADD COLUMN strategy_terms text[] NOT NULL DEFAULT '{}';
CREATE INDEX message_analysis_strategy_terms_idx ON message_analysis USING gin (strategy_terms)
  WHERE cardinality(strategy_terms) > 0;

-- 自動検索の入力から得た設計方針fingerprint。NULLは未評価（manual検索・旧受付）を表す。
ALTER TABLE search_requests ADD COLUMN strategy_terms text[];
