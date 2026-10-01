-- 発言の情報源。過去会話の検索結果を引用・要約しただけの伝聞を、一次情報と区別して候補順位を下げるために使う。
-- 旧分析はunknownのままで、再分類するまで順位へ影響しない。
ALTER TABLE message_analysis
  ADD COLUMN information_source text NOT NULL DEFAULT 'unknown';
