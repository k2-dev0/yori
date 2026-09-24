-- M3レビュー修正: Jevの要求model（alias）と実応答modelを区別して保持する。
-- 過去行の応答modelは不明としてNULLのままにし、alias等で推測補完しない。

-- 応答modelが非NULLの完了済み評価だけをキャッシュとして再利用する。
-- 旧行はNULLのため再評価され、ON CONFLICTで実評価の応答modelへ更新する。
ALTER TABLE jev_evaluations ADD COLUMN response_model text;

-- 要求modelは既存model列に保持し、実応答modelはresponse_modelへ記録する。
-- 応答本文を取得できなかった失敗はNULLのままにする。
ALTER TABLE usage_events ADD COLUMN response_model text;
