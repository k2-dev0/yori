-- jobを取り出して処理を始めた時刻。作成から開始までを待ち、開始から完了（completedのupdated_at）までを処理時間として分ける。
-- 再試行では最後に取り出した時刻で上書きする。列追加前のjobはNULLのまま残す。
ALTER TABLE jobs ADD COLUMN started_at timestamptz;

-- 外部呼出しを起こしたjob。検索1件・発言1件あたりの費用をjob経由で集計する。列追加前の行とjobに紐付かない呼出しはNULL。
ALTER TABLE usage_events ADD COLUMN job_id uuid REFERENCES jobs (id) ON DELETE SET NULL;
CREATE INDEX usage_events_job_id_idx ON usage_events (job_id);
