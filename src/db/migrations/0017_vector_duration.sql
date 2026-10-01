-- vector経路のqueryだけの所要時間。近似索引への切替判定に使う。
-- 既存のduration_ms（vector・entity・strategyの合計）の意味は変えない。列追加前のsampleはNULLのまま残す。
ALTER TABLE search_duration_samples
  ADD COLUMN vector_duration_ms integer CHECK (vector_duration_ms IS NULL OR vector_duration_ms >= 0);
