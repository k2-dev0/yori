-- token単位の権限scope。既存tokenはDEFAULTによりemployeeとして移行する。

ALTER TABLE auth_tokens
  ADD COLUMN scope text NOT NULL DEFAULT 'employee',
  ADD CONSTRAINT auth_tokens_scope_check CHECK (scope IN ('employee', 'company_admin'));
