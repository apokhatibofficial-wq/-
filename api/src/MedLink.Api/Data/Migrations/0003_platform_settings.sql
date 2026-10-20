-- MEDLINK migration 0003: company-wide settings edited from the company console, and per-hospital
-- booking-rule overrides. Values chosen by the owner on 2026-10-20.

-- Exactly one row (id is always true).
CREATE TABLE platform_settings (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  default_timezone      text    NOT NULL DEFAULT 'Asia/Damascus' CHECK (length(default_timezone) BETWEEN 3 AND 64),
  booking_window_days   integer NOT NULL DEFAULT 14 CHECK (booking_window_days BETWEEN 1 AND 365),
  min_notice_min        integer NOT NULL DEFAULT 30 CHECK (min_notice_min BETWEEN 0 AND 1440),
  -- Phase 6 policies. Owner's decisions: patients cannot cancel online; no per-phone daily limit (0 = none).
  patient_can_cancel    boolean NOT NULL DEFAULT false,
  per_phone_daily_limit integer NOT NULL DEFAULT 0 CHECK (per_phone_daily_limit BETWEEN 0 AND 50),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            text NULL REFERENCES users (id)
);
INSERT INTO platform_settings (id) VALUES (true);

-- NULL = use the company-wide value.
ALTER TABLE hospitals
  ADD COLUMN booking_window_days integer NULL CHECK (booking_window_days IS NULL OR booking_window_days BETWEEN 1 AND 365),
  ADD COLUMN min_notice_min      integer NULL CHECK (min_notice_min IS NULL OR min_notice_min BETWEEN 0 AND 1440);

GRANT SELECT, UPDATE ON platform_settings TO medlink_app;
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;

-- Every signed-in scope may read the settings (hospitals need the effective booking rules);
-- only the company (and the auth/system pipeline) may change them.
CREATE POLICY platform_settings_read ON platform_settings FOR SELECT TO medlink_app
  USING (app_scope() IN ('company', 'system', 'hospital'));
CREATE POLICY platform_settings_write ON platform_settings FOR UPDATE TO medlink_app
  USING (app_scope() = 'company') WITH CHECK (app_scope() = 'company');

-- A hospital-scope session may update its own hospital row (settings), but never the fields the
-- company controls. Second layer behind the API's permission checks.
CREATE FUNCTION hospitals_company_fields_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_scope() = 'hospital' AND (
       NEW.booking_window_days IS DISTINCT FROM OLD.booking_window_days
    OR NEW.min_notice_min      IS DISTINCT FROM OLD.min_notice_min
    OR NEW.status              IS DISTINCT FROM OLD.status
    OR NEW.name_ar             IS DISTINCT FROM OLD.name_ar
    OR NEW.name_en             IS DISTINCT FROM OLD.name_en
    OR NEW.name_tr             IS DISTINCT FROM OLD.name_tr) THEN
    RAISE EXCEPTION 'field is managed by the company' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hospitals_company_fields_guard BEFORE UPDATE ON hospitals
  FOR EACH ROW EXECUTE FUNCTION hospitals_company_fields_guard();
