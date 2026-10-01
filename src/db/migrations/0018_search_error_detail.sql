-- 検索失敗の切り分け用。失敗したprovider名と、応答検証のどの条件で落ちたかの固定識別子だけを保存する。
-- 原文・外部error body・credentialは保存しない。statusがfailedの時だけ有効で、失敗のたびに上書きする。
ALTER TABLE search_requests
  ADD COLUMN error_detail text;
