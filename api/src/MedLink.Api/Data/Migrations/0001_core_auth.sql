-- MEDLINK migration 0001: hospitals, slugs, users, roles, sessions, one-time links, audit log.
-- Runs as the database owner. The application connects as `medlink_app`, which is NOT the
-- table owner, so row-level security always applies to it.
-- No accounts, passwords or example data are created here (BACKEND-SPEC §0).

CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medlink_app') THEN
    CREATE ROLE medlink_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO medlink_app;

-- Request context. Set per transaction with set_config(..., true) by the API.
--   app.scope       : 'company' | 'hospital' | 'system' (auth pipeline only)
--   app.hospital_id : the hospital ID taken from the session principal
CREATE FUNCTION app_scope() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.scope', true), '') $$;

CREATE FUNCTION app_hospital_id() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.hospital_id', true), '') $$;

CREATE FUNCTION app_is_global() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app_scope() IN ('company', 'system') $$;

-- ---------------------------------------------------------------- hospitals
CREATE TABLE hospitals (
  id                  text PRIMARY KEY CHECK (id ~ '^hsp_[0-9A-HJKMNP-TV-Z]{26}$'),
  name_ar             text NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 200),
  name_en             text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 200),
  name_tr             text NULL     CHECK (name_tr IS NULL OR length(name_tr) <= 200),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('active', 'suspended', 'pending')),
  no_show_grace_min   integer NOT NULL DEFAULT 30 CHECK (no_show_grace_min BETWEEN 0 AND 1440),
  retention_months    integer NOT NULL DEFAULT 24 CHECK (retention_months BETWEEN 1 AND 120),
  timezone            text NOT NULL,
  staff_totp_required boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- slugs
-- A slug is never deleted: once used it stays reserved for its hospital forever.
CREATE TABLE reserved_slugs (
  slug text PRIMARY KEY
);
INSERT INTO reserved_slugs (slug) VALUES
  ('admin'), ('api'), ('app'), ('book'), ('booking'), ('www'), ('mail'), ('static'),
  ('assets'), ('medlink'), ('khatib'), ('support'), ('help'), ('login'), ('logout'),
  ('signin'), ('signup'), ('register'), ('account'), ('settings'), ('status'),
  ('health'), ('scan'), ('scanner'), ('qr'), ('link'), ('changed'), ('null'), ('undefined');

CREATE TABLE hospital_slugs (
  slug           text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  hospital_id    text NOT NULL REFERENCES hospitals (id),
  is_primary     boolean NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  retired_at     timestamptz NULL,
  redirect_until timestamptz NULL,
  CHECK (is_primary = (retired_at IS NULL)),
  CHECK (retired_at IS NULL OR redirect_until IS NOT NULL)
);
CREATE UNIQUE INDEX hospital_slugs_one_primary ON hospital_slugs (hospital_id) WHERE is_primary;
CREATE INDEX hospital_slugs_hospital ON hospital_slugs (hospital_id);

CREATE FUNCTION hospital_slugs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM reserved_slugs r WHERE r.slug = NEW.slug) THEN
    RAISE EXCEPTION 'slug % is reserved', NEW.slug USING ERRCODE = '23505';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.slug <> OLD.slug OR NEW.hospital_id <> OLD.hospital_id) THEN
    RAISE EXCEPTION 'slug and owner are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hospital_slugs_guard BEFORE INSERT OR UPDATE ON hospital_slugs
  FOR EACH ROW EXECUTE FUNCTION hospital_slugs_guard();

-- ---------------------------------------------------------------- users & roles
CREATE TABLE users (
  id                  text PRIMARY KEY CHECK (id ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
  scope               text NOT NULL CHECK (scope IN ('company', 'hospital')),
  hospital_id         text NULL REFERENCES hospitals (id),
  email               citext NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
  password_hash       text NULL CHECK (password_hash IS NULL OR password_hash LIKE '$argon2id$%'),
  totp_secret_enc     bytea NULL,
  totp_last_step      bigint NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  failed_attempts     integer NOT NULL DEFAULT 0,
  locked_until        timestamptz NULL,
  password_changed_at timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'company') = (hospital_id IS NULL)),
  CHECK (status <> 'active' OR password_hash IS NOT NULL)
);
CREATE INDEX users_hospital ON users (hospital_id);

CREATE TABLE user_roles (
  user_id text NOT NULL REFERENCES users (id),
  role    text NOT NULL CHECK (role IN ('owner', 'support', 'viewer', 'hosp_admin', 'reception', 'scanner')),
  PRIMARY KEY (user_id, role)
);

-- A company role can only be held by a company user, a hospital role only by a hospital user.
CREATE FUNCTION user_roles_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT scope INTO s FROM users WHERE id = NEW.user_id;
  IF (s = 'company') <> (NEW.role IN ('owner', 'support', 'viewer')) THEN
    RAISE EXCEPTION 'role % does not match user scope %', NEW.role, s USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_roles_scope_guard BEFORE INSERT OR UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION user_roles_scope_guard();

-- ---------------------------------------------------------------- sessions & links
-- Only SHA-256 hashes of tokens are stored.
CREATE TABLE sessions (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users (id),
  token_hash    bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  client        text NOT NULL CHECK (client IN ('web', 'windows')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz NULL,
  revoke_reason text NULL
);
CREATE INDEX sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE one_time_links (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users (id),
  purpose          text NOT NULL CHECK (purpose IN ('setup', 'activation', 'reset')),
  token_hash       bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz NULL,
  pending_totp_enc bytea NULL,
  created_by       text NULL REFERENCES users (id)
);
CREATE INDEX one_time_links_user ON one_time_links (user_id);

-- ---------------------------------------------------------------- audit
-- INSERT only for the application role: no UPDATE or DELETE grant exists.
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    text NULL,
  hospital_id text NULL REFERENCES hospitals (id),
  action      text NOT NULL,
  target      text NOT NULL,
  meta_json   jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at ON audit_log (at DESC);
CREATE INDEX audit_log_hospital ON audit_log (hospital_id, at DESC);

-- ---------------------------------------------------------------- grants
GRANT SELECT ON reserved_slugs TO medlink_app;
GRANT SELECT, INSERT, UPDATE ON hospitals, hospital_slugs, users, sessions, one_time_links TO medlink_app;
GRANT SELECT, INSERT, DELETE ON user_roles TO medlink_app;
GRANT SELECT, INSERT ON audit_log TO medlink_app;
GRANT EXECUTE ON FUNCTION app_scope(), app_hospital_id(), app_is_global() TO medlink_app;

-- ---------------------------------------------------------------- row-level security
ALTER TABLE hospitals      ENABLE ROW LEVEL SECURITY;
ALTER TABLE hospital_slugs ENABLE ROW LEVEL SECURITY;
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_time_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log      ENABLE ROW LEVEL SECURITY;

CREATE POLICY hospitals_tenant ON hospitals TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND id = app_hospital_id()))
  WITH CHECK (app_is_global() OR (app_scope() = 'hospital' AND id = app_hospital_id()));

CREATE POLICY hospital_slugs_tenant ON hospital_slugs TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()))
  WITH CHECK (app_is_global());

CREATE POLICY users_tenant ON users TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()))
  WITH CHECK (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()));

-- Child tables follow the visibility of their user (the sub-select is itself filtered by RLS).
CREATE POLICY user_roles_tenant ON user_roles TO medlink_app
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id))
  WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id));

CREATE POLICY sessions_tenant ON sessions TO medlink_app
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id))
  WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id));

CREATE POLICY one_time_links_tenant ON one_time_links TO medlink_app
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id))
  WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = user_id));

CREATE POLICY audit_log_read ON audit_log FOR SELECT TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()));

CREATE POLICY audit_log_write ON audit_log FOR INSERT TO medlink_app
  WITH CHECK (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()));
