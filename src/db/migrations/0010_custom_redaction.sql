-- 会社単位のcustom伏せ字policy（version付き）とproject repository alias。
-- yori-cliはこのschemaへ直接literal/assignment_keyを登録できるため、rule種別・正規化・重複・空・placeholder・長さ・件数はDB制約でも拒否する。

-- repository aliasはprojectの会社と整合した組だけを受理する。
ALTER TABLE projects ADD CONSTRAINT projects_id_company_id_unique UNIQUE (id, company_id);

CREATE TABLE company_redaction_policies (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- built-in/customのplaceholderは伏せ字結果そのものなので、その部分文字列もcustom literalとして拒否する。
-- 再適用でplaceholderが壊れず、byte一致が保たれることをDBでも保証する。
CREATE FUNCTION yori_is_redaction_placeholder_fragment(value text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM unnest(ARRAY[
        '[REDACTED:custom]',
        '[REDACTED:private_key]',
        '[REDACTED:aws_access_key]',
        '[REDACTED:google_api_key]',
        '[REDACTED:github_token]',
        '[REDACTED:slack_token]',
        '[REDACTED:openai_key]',
        '[REDACTED:jwt]',
        '[REDACTED:url_credentials]',
        '[REDACTED:authorization]',
        '[REDACTED:env_value]'
      ]) AS placeholder
     WHERE position(value in placeholder) > 0
  );
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE company_redaction_rules (
  company_id uuid NOT NULL REFERENCES company_redaction_policies(company_id) ON DELETE CASCADE,
  rule_type text NOT NULL,
  -- valueは入力表記そのまま（literalのcase-sensitive照合とassignment_keyのkey表記保持に使う）。
  value text NOT NULL,
  -- literalはvalueそのまま、assignment_keyはcase-insensitive照合のためlower(value)を一意性の正規化に使う。
  normalized_value text NOT NULL,
  PRIMARY KEY (company_id, rule_type, normalized_value),
  CONSTRAINT company_redaction_rules_rule_type CHECK (rule_type IN ('literal', 'assignment_key')),
  CONSTRAINT company_redaction_rules_value_not_empty CHECK (value <> ''),
  CONSTRAINT company_redaction_rules_normalized_value CHECK (
    (rule_type = 'literal' AND normalized_value = value)
    OR (rule_type = 'assignment_key' AND normalized_value = lower(value))
  ),
  -- built-in/customのplaceholderは伏せ字結果そのものなので、literalの部分文字列を拒否する。
  CONSTRAINT company_redaction_rules_literal_not_placeholder_fragment CHECK (
    rule_type <> 'literal' OR NOT yori_is_redaction_placeholder_fragment(value)
  ),
  -- assignment_keyはASCII identifierに限定し、placeholderを壊すREDACTEDを大文字小文字を問わず拒否する。
  CONSTRAINT company_redaction_rules_assignment_key_identifier CHECK (
    rule_type <> 'assignment_key' OR value ~ '^[A-Za-z_][A-Za-z0-9_.-]*$'
  ),
  CONSTRAINT company_redaction_rules_assignment_key_not_redacted CHECK (
    rule_type <> 'assignment_key' OR lower(value) <> 'redacted'
  ),
  -- 512/128 code pointsならUTF-8最大4 bytes/pointでも、(company_id, rule_type, normalized_value)主キーの
  -- B-tree index rowの通常上限（約2704 bytes）内へ格納できる。
  CONSTRAINT company_redaction_rules_literal_length CHECK (rule_type <> 'literal' OR char_length(value) <= 512),
  CONSTRAINT company_redaction_rules_assignment_key_length CHECK (rule_type <> 'assignment_key' OR char_length(value) <= 128)
);

-- literal/assignment_key合算で最大100件。target policy行を排他lockしてから数え、並行のatomic replaceでも上限を越えない。
-- 同会社内のvalue変更は件数を増やさないため、limitの対象にしない。
CREATE FUNCTION company_redaction_rules_enforce_limit() RETURNS trigger AS $$
DECLARE
  rule_count integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.company_id = OLD.company_id THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM company_redaction_policies WHERE company_id = NEW.company_id FOR UPDATE;
  SELECT count(*) INTO rule_count FROM company_redaction_rules WHERE company_id = NEW.company_id;
  IF rule_count >= 100 THEN
    RAISE EXCEPTION 'company_redaction_rules exceeds the 100 rule limit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER company_redaction_rules_enforce_limit
  BEFORE INSERT OR UPDATE ON company_redaction_rules
  FOR EACH ROW EXECUTE FUNCTION company_redaction_rules_enforce_limit();

CREATE TABLE project_repositories (
  project_id uuid NOT NULL,
  company_id uuid NOT NULL,
  repository_identifier text NOT NULL,
  PRIMARY KEY (project_id, repository_identifier),
  CONSTRAINT project_repositories_project_company_fkey
    FOREIGN KEY (project_id, company_id) REFERENCES projects(id, company_id) ON DELETE CASCADE,
  CONSTRAINT project_repositories_company_repository_unique UNIQUE (company_id, repository_identifier)
);

-- 会社内でprimary/aliasを通じて1 repository=1 projectをINSERT/UPDATE双方で保証する。
-- alias行とprimary行は別tableなので、同じ(company, repository)のadvisory lockで相互のcheckを直列化する。
CREATE FUNCTION project_repositories_enforce_company_repository_unique() RETURNS trigger AS $$
BEGIN
  -- project_id/repository_identifier/company_idのいずれを変えても、別projectのprimaryと衝突させない。
  PERFORM pg_advisory_xact_lock(hashtext(NEW.company_id::text || '|' || NEW.repository_identifier)::bigint);
  IF EXISTS (
    SELECT 1
      FROM projects p
     WHERE p.company_id = NEW.company_id
       AND p.repository_identifier = NEW.repository_identifier
       AND p.id <> NEW.project_id
  ) THEN
    RAISE EXCEPTION 'repository_identifier is already the primary repository of another project in this company'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_repositories_enforce_company_repository_unique
  BEFORE INSERT OR UPDATE ON project_repositories
  FOR EACH ROW EXECUTE FUNCTION project_repositories_enforce_company_repository_unique();

CREATE FUNCTION projects_enforce_company_repository_unique() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.company_id = OLD.company_id AND NEW.repository_identifier = OLD.repository_identifier THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.company_id::text || '|' || NEW.repository_identifier)::bigint);
  IF EXISTS (
    SELECT 1
      FROM project_repositories pr
     WHERE pr.company_id = NEW.company_id
       AND pr.repository_identifier = NEW.repository_identifier
       AND pr.project_id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'repository_identifier is already an alias of another project in this company'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER projects_enforce_company_repository_unique
  BEFORE INSERT OR UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_enforce_company_repository_unique();

-- 既存projectのprimary repositoryをalias表へbackfillする（未登録会社のpolicyは行を持たない）。
-- 同一projectのprimary行はtriggerの p.id <> NEW.project_id 条件で許可する。
INSERT INTO project_repositories (project_id, company_id, repository_identifier)
SELECT id, company_id, repository_identifier
  FROM projects
ON CONFLICT DO NOTHING;
