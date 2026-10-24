-- MEDLINK migration 0008: what the API needs when it runs as a Supabase Edge Function (owner's decision, 2026-10-24):
-- rate limits kept in the database (function instances share no memory), the first-owner and recovery commands as
-- SQL functions (run in the Supabase SQL editor instead of a server terminal), and closing Supabase's automatic
-- REST API (roles anon and authenticated) over MEDLINK's tables. Harmless on a plain PostgreSQL server.

-- ---------------------------------------------------------------- rate limits
-- One row per key and 10-second bucket; a request is allowed while the last 60 seconds hold fewer than the limit.
CREATE TABLE rate_limits (
  key    text NOT NULL CHECK (length(key) <= 200),
  bucket timestamptz NOT NULL,
  count  integer NOT NULL,
  PRIMARY KEY (key, bucket)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits TO medlink_app;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY rate_limits_app ON rate_limits TO medlink_app USING (true) WITH CHECK (true);

-- Checks every key, then counts the request against all of them, or against none if one is full.
CREATE FUNCTION rate_limit_take(p_keys text[], p_limits integer[]) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  i    integer;
  used bigint;
  b    timestamptz := to_timestamp(floor(extract(epoch FROM clock_timestamp()) / 10) * 10);
BEGIN
  FOR i IN 1 .. coalesce(array_length(p_keys, 1), 0) LOOP
    PERFORM pg_advisory_xact_lock(7240100, hashtext(p_keys[i]));
    SELECT coalesce(sum(count), 0) INTO used FROM rate_limits WHERE key = p_keys[i] AND bucket > b - interval '60 seconds';
    IF used >= p_limits[i] THEN
      RETURN false;
    END IF;
  END LOOP;
  FOR i IN 1 .. coalesce(array_length(p_keys, 1), 0) LOOP
    INSERT INTO rate_limits (key, bucket, count) VALUES (p_keys[i], b, 1)
    ON CONFLICT (key, bucket) DO UPDATE SET count = rate_limits.count + 1;
  END LOOP;
  RETURN true;
END $$;
REVOKE EXECUTE ON FUNCTION rate_limit_take(text[], integer[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rate_limit_take(text[], integer[]) TO medlink_app;

-- ---------------------------------------------------------------- owner commands (SQL editor)
-- Random IDs and tokens without extensions: gen_random_uuid() is cryptographically random (two of them: 244 bits).
CREATE FUNCTION medlink_random_bytes() RETURNS bytea LANGUAGE sql VOLATILE AS $$
  SELECT decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex')
$$;

CREATE FUNCTION medlink_new_id(prefix text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT prefix || string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', get_byte(x.b, i) % 32 + 1, 1), '' ORDER BY i)
  FROM (SELECT medlink_random_bytes() AS b) x, generate_series(0, 25) i
$$;

-- Issues a single-use link like the API does, and returns its address.
CREATE FUNCTION medlink_issue_link(p_user_id text, p_purpose text, p_web_url text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  token text := rtrim(translate(encode(medlink_random_bytes(), 'base64'), '+/', '-_'), '=');
BEGIN
  UPDATE one_time_links SET expires_at = now() WHERE user_id = p_user_id AND used_at IS NULL AND expires_at > now();
  INSERT INTO one_time_links (id, user_id, purpose, token_hash, expires_at)
  VALUES (medlink_new_id('otl_'), p_user_id, p_purpose, sha256(convert_to(token, 'UTF8')),
          now() + CASE p_purpose WHEN 'setup' THEN interval '30 minutes' WHEN 'reset' THEN interval '1 hour' ELSE interval '24 hours' END);
  RETURN rtrim(p_web_url, '/') || '/link#t=' || token;
END $$;

-- The first company owner: no password, a 30-minute setup link. Refuses once any company user exists.
--   SELECT medlink_bootstrap_admin('you@example.com');
CREATE FUNCTION medlink_bootstrap_admin(p_email text, p_admin_web_url text DEFAULT 'https://admin.medlink.website')
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  uid text := medlink_new_id('usr_');
  url text;
BEGIN
  PERFORM pg_advisory_xact_lock(7240002);
  IF EXISTS (SELECT 1 FROM users WHERE scope = 'company') THEN
    RAISE EXCEPTION 'A company user already exists. bootstrap-admin can only run once.';
  END IF;
  IF p_email IS NULL OR position('@' IN p_email) = 0 OR length(p_email) > 254 THEN
    RAISE EXCEPTION 'not an email address';
  END IF;
  INSERT INTO users (id, scope, email) VALUES (uid, 'company', btrim(p_email));
  INSERT INTO user_roles (user_id, role) VALUES (uid, 'owner');
  url := medlink_issue_link(uid, 'setup', p_admin_web_url);
  INSERT INTO audit_log (actor_id, hospital_id, action, target) VALUES (NULL, NULL, 'bootstrap_admin', uid);
  RETURN url;
END $$;

-- Recovery for a company user who lost their password or phone (for example the only owner): revokes all sessions and
-- returns a 1-hour reset link (a setup link if the account was never set up). Give it to the person only after
-- checking who they are, in person or by a known phone number.
--   SELECT medlink_reset_company_user('them@example.com');
CREATE FUNCTION medlink_reset_company_user(p_email text, p_admin_web_url text DEFAULT 'https://admin.medlink.website')
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  u   record;
  url text;
BEGIN
  SELECT id, status INTO u FROM users WHERE email = btrim(p_email) AND scope = 'company' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No company user with that email.'; END IF;
  IF u.status = 'disabled' THEN RAISE EXCEPTION 'That company user is disabled.'; END IF;
  UPDATE sessions SET revoked_at = now(), revoke_reason = 'cli_reset' WHERE user_id = u.id AND revoked_at IS NULL;
  url := medlink_issue_link(u.id, CASE WHEN u.status = 'pending' THEN 'setup' ELSE 'reset' END, p_admin_web_url);
  INSERT INTO audit_log (actor_id, hospital_id, action, target) VALUES (NULL, NULL, 'company_user_reset_cli', u.id);
  RETURN url;
END $$;

REVOKE EXECUTE ON FUNCTION medlink_random_bytes(), medlink_new_id(text), medlink_issue_link(text, text, text),
  medlink_bootstrap_admin(text, text), medlink_reset_company_user(text, text) FROM PUBLIC;

-- ---------------------------------------------------------------- Supabase: no automatic REST API over these tables
-- Supabase gives its API roles (anon, authenticated) rights on new objects in "public". MEDLINK uses none of that:
-- remove them, now and for objects created later by the migration owner.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
  END IF;
END $$;
