-- MEDLINK migration 0009: public doctor profile pages (medlink.website/dr/{slug}), a separate company product
-- (owner's decision, 2026-11-08): the company writes every profile; doctors have no account and are not tied to a
-- hospital. The page shows a photo, name, specialty, an optional star rating set by the company, an "about" text,
-- a call button, social links and a ShamCash account. Only published profiles are public.

CREATE TABLE doctor_profiles (
  id          text PRIMARY KEY,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' AND slug NOT LIKE '%--%'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  specialty   text NULL CHECK (specialty IS NULL OR length(specialty) BETWEEN 1 AND 160),
  about       text NULL CHECK (about IS NULL OR length(about) BETWEEN 1 AND 3000),
  phone       text NULL CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{6,15}$'),
  verified    boolean NOT NULL DEFAULT false,
  -- NULL = no stars shown. Set by the company (owner's decision), in half stars.
  rating      numeric(2,1) NULL CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5 AND rating * 2 = trunc(rating * 2))),
  -- [{"kind": "instagram", "url": "https://..."}], validated by the API (https only).
  links       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 12),
  shamcash    text NULL CHECK (shamcash IS NULL OR length(shamcash) BETWEEN 1 AND 100),
  published   boolean NOT NULL DEFAULT false,
  -- The photo, resized by the console (JPEG or WebP, at most 400 KB). Bumped on every change: the public URL
  -- carries it, so browsers may cache a photo for good.
  photo       bytea NULL CHECK (photo IS NULL OR octet_length(photo) <= 409600),
  photo_type  text NULL CHECK (photo_type IS NULL OR photo_type IN ('image/jpeg', 'image/webp')),
  photo_rev   integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NULL REFERENCES users (id),
  CHECK ((photo IS NULL) = (photo_type IS NULL))
);
CREATE INDEX doctor_profiles_created ON doctor_profiles (created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON doctor_profiles TO medlink_app;
ALTER TABLE doctor_profiles ENABLE ROW LEVEL SECURITY;

-- The company manages profiles; the system scope (anonymous public pages) only reads them. Hospital sessions see none.
CREATE POLICY doctor_profiles_read ON doctor_profiles FOR SELECT TO medlink_app
  USING (app_scope() IN ('company', 'system'));
CREATE POLICY doctor_profiles_insert ON doctor_profiles FOR INSERT TO medlink_app
  WITH CHECK (app_scope() = 'company');
CREATE POLICY doctor_profiles_update ON doctor_profiles FOR UPDATE TO medlink_app
  USING (app_scope() = 'company') WITH CHECK (app_scope() = 'company');
CREATE POLICY doctor_profiles_delete ON doctor_profiles FOR DELETE TO medlink_app
  USING (app_scope() = 'company');

-- As in 0008: no access for Supabase's REST roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON doctor_profiles FROM anon, authenticated;
  END IF;
END $$;
