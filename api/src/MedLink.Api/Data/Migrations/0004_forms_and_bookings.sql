-- MEDLINK migration 0004: booking-form versions and drafts; bookings and their answers.

-- ---------------------------------------------------------------- form versions (immutable)
CREATE TABLE form_versions (
  id                    text PRIMARY KEY CHECK (id ~ '^frm_[0-9A-HJKMNP-TV-Z]{26}$'),
  hospital_id           text NOT NULL REFERENCES hospitals (id),
  version               integer NOT NULL CHECK (version >= 1),
  schema_json           jsonb NOT NULL,
  published_by          text NULL REFERENCES users (id),
  published_at          timestamptz NOT NULL DEFAULT now(),
  restored_from_version integer NULL,
  -- [added, edited, removed, reordered] compared with the version it replaced
  change_summary_json   jsonb NOT NULL DEFAULT '[0,0,0,0]'::jsonb,
  UNIQUE (hospital_id, version)
);

CREATE TABLE hospital_active_form (
  hospital_id     text PRIMARY KEY REFERENCES hospitals (id),
  form_version_id text NOT NULL REFERENCES form_versions (id)
);

-- The active version must belong to the same hospital.
CREATE FUNCTION active_form_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM form_versions v WHERE v.id = NEW.form_version_id AND v.hospital_id = NEW.hospital_id) THEN
    RAISE EXCEPTION 'form version does not belong to hospital' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER active_form_guard BEFORE INSERT OR UPDATE ON hospital_active_form
  FOR EACH ROW EXECUTE FUNCTION active_form_guard();

CREATE TABLE form_drafts (
  hospital_id  text PRIMARY KEY REFERENCES hospitals (id),
  schema_json  jsonb NOT NULL,
  base_version integer NOT NULL DEFAULT 0,
  updated_by   text NULL REFERENCES users (id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- bookings
CREATE TABLE bookings (
  id              text PRIMARY KEY CHECK (id ~ '^bkg_[0-9A-HJKMNP-TV-Z]{26}$'),
  hospital_id     text NOT NULL REFERENCES hospitals (id),
  ref             text NOT NULL UNIQUE CHECK (ref ~ '^ML-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$'),
  department_id   text NOT NULL REFERENCES departments (id),
  slot_start      timestamptz NOT NULL,
  seat_no         integer NOT NULL CHECK (seat_no BETWEEN 1 AND 100),
  -- Personal data; cleared by the retention job (anonymized_at set), so nullable.
  patient_name    text NULL CHECK (patient_name IS NULL OR length(btrim(patient_name)) BETWEEN 2 AND 80),
  phone           text NULL CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{7,15}$'),
  form_version_id text NULL REFERENCES form_versions (id),
  status          text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'arrived', 'no_show', 'cancelled')),
  arrived_at      timestamptz NULL,
  qr_token_hash   bytea NOT NULL UNIQUE CHECK (length(qr_token_hash) = 32),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 64),
  request_hash    bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  cancelled_at    timestamptz NULL,
  cancelled_by    text NULL REFERENCES users (id),
  cancel_reason   text NULL CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 300),
  anonymized_at   timestamptz NULL,
  CHECK (patient_name IS NOT NULL OR anonymized_at IS NOT NULL),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  UNIQUE (hospital_id, idempotency_key)
);
-- One patient per seat. A cancelled booking frees its seat.
CREATE UNIQUE INDEX bookings_one_per_seat ON bookings (hospital_id, department_id, slot_start, seat_no) WHERE status <> 'cancelled';
CREATE INDEX bookings_day ON bookings (hospital_id, slot_start);
CREATE INDEX bookings_phone ON bookings (hospital_id, phone) WHERE phone IS NOT NULL;

CREATE FUNCTION bookings_hospital_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM departments d WHERE d.id = NEW.department_id AND d.hospital_id = NEW.hospital_id) THEN
    RAISE EXCEPTION 'department does not belong to hospital' USING ERRCODE = '23503';
  END IF;
  IF NEW.form_version_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM form_versions v WHERE v.id = NEW.form_version_id AND v.hospital_id = NEW.hospital_id) THEN
    RAISE EXCEPTION 'form version does not belong to hospital' USING ERRCODE = '23503';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.hospital_id <> OLD.hospital_id OR NEW.ref <> OLD.ref OR NEW.qr_token_hash <> OLD.qr_token_hash) THEN
    RAISE EXCEPTION 'booking identity is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_hospital_guard BEFORE INSERT OR UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_hospital_guard();

CREATE TABLE booking_answers (
  booking_id  text NOT NULL REFERENCES bookings (id),
  hospital_id text NOT NULL REFERENCES hospitals (id),
  question_id text NOT NULL CHECK (question_id ~ '^[a-z0-9]{1,24}$'),
  value_json  jsonb NOT NULL,
  PRIMARY KEY (booking_id, question_id)
);

-- ---------------------------------------------------------------- grants & RLS
-- Published versions are never edited: INSERT and SELECT only.
GRANT SELECT, INSERT ON form_versions TO medlink_app;
GRANT SELECT, INSERT, UPDATE ON hospital_active_form TO medlink_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON form_drafts TO medlink_app;
GRANT SELECT, INSERT, UPDATE ON bookings TO medlink_app;
-- DELETE is for the retention job (answers are deleted, bookings kept anonymised).
GRANT SELECT, INSERT, DELETE ON booking_answers TO medlink_app;

ALTER TABLE form_versions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE hospital_active_form ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_drafts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_answers      ENABLE ROW LEVEL SECURITY;

CREATE POLICY form_versions_tenant ON form_versions TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()))
  WITH CHECK (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()));
CREATE POLICY hospital_active_form_tenant ON hospital_active_form TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()))
  WITH CHECK (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()));
CREATE POLICY form_drafts_tenant ON form_drafts TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()))
  WITH CHECK (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()));
CREATE POLICY bookings_tenant ON bookings TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()))
  WITH CHECK (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()));
CREATE POLICY booking_answers_tenant ON booking_answers TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()))
  WITH CHECK (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()));
