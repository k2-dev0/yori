-- 会社単位のcustom伏せ字policy（version付き）とproject repository alias。
-- yori-cliはこのschemaへ直接literalを登録できるため、重複・空・placeholder・長さ・件数はDB制約でも拒否する。

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
  literal text NOT NULL,
  PRIMARY KEY (company_id, literal),
  CONSTRAINT company_redaction_rules_literal_not_empty CHECK (literal <> ''),
  CONSTRAINT company_redaction_rules_literal_not_placeholder_fragment CHECK (NOT yori_is_redaction_placeholder_fragment(literal)),
  CONSTRAINT company_redaction_rules_literal_length CHECK (char_length(literal) <= 4096)
);

-- literalは最大100件。policy行を排他lockしてから数え、並行のatomic replaceでも上限を越えない。
CREATE FUNCTION company_redaction_rules_enforce_limit() RETURNS trigger AS $$
DECLARE
  rule_count integer;
BEGIN
  PERFORM 1 FROM company_redaction_policies WHERE company_id = NEW.company_id FOR UPDATE;
  SELECT count(*) INTO rule_count FROM company_redaction_rules WHERE company_id = NEW.company_id;
  IF rule_count >= 100 THEN
    RAISE EXCEPTION 'company_redaction_rules exceeds the 100 rule limit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER company_redaction_rules_enforce_limit
  BEFORE INSERT ON company_redaction_rules
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
  IF TG_OP = 'UPDATE' AND NEW.company_id = OLD.company_id AND NEW.repository_identifier = OLD.repository_identifier THEN
    RETURN NEW;
  END IF;
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
