-- MEDLINK migration 0005: doctor role, registered devices, attendance events (never deleted),
-- and a per-booking change sequence for Windows sync.

-- ---------------------------------------------------------------- doctor role
ALTER TABLE user_roles DROP CONSTRAINT user_roles_role_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('owner', 'support', 'viewer', 'hosp_admin', 'reception', 'scanner', 'doctor'));

-- Owner's decision (2026-10-20): a doctor sees only the appointments of their own department(s).
CREATE TABLE doctor_departments (
  user_id       text NOT NULL REFERENCES users (id),
  department_id text NOT NULL REFERENCES departments (id),
  hospital_id   text NOT NULL REFERENCES hospitals (id),
  PRIMARY KEY (user_id, department_id)
);

CREATE FUNCTION doctor_departments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.hospital_id = NEW.hospital_id)
     OR NOT EXISTS (SELECT 1 FROM departments d WHERE d.id = NEW.department_id AND d.hospital_id = NEW.hospital_id) THEN
    RAISE EXCEPTION 'user and department must belong to the hospital' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER doctor_departments_guard BEFORE INSERT OR UPDATE ON doctor_departments
  FOR EACH ROW EXECUTE FUNCTION doctor_departments_guard();

-- ---------------------------------------------------------------- devices (Windows PCs)
CREATE TABLE devices (
  id            text PRIMARY KEY CHECK (id ~ '^dev_[0-9A-HJKMNP-TV-Z]{26}$'),
  hospital_id   text NOT NULL REFERENCES hospitals (id),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  registered_by text NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NULL,
  last_seq      bigint NOT NULL DEFAULT 0,
  revoked_at    timestamptz NULL
);
CREATE INDEX devices_hospital ON devices (hospital_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- attendance events
-- Status is derived from these events (approved conflict policy). Events are never updated or deleted.
CREATE TABLE attendance_events (
  id              text PRIMARY KEY CHECK (id ~ '^att_[0-9A-HJKMNP-TV-Z]{26}$'),
  hospital_id     text NOT NULL REFERENCES hospitals (id),
  booking_id      text NOT NULL REFERENCES bookings (id),
  type            text NOT NULL CHECK (type IN ('arrived', 'no_show', 'waiting')),
  source          text NOT NULL CHECK (source IN ('qr', 'reception', 'auto', 'correction')),
  at              timestamptz NOT NULL,           -- when it happened (device clock for offline events)
  received_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id        text NULL REFERENCES users (id),
  device_id       text NULL REFERENCES devices (id),
  client_event_id uuid NULL UNIQUE,
  reason          text NULL CHECK (reason IS NULL OR length(reason) <= 300),
  CHECK (source <> 'correction' OR reason IS NOT NULL),
  CHECK (source = 'correction' OR type <> 'waiting'),
  CHECK ((source = 'auto') = (actor_id IS NULL))
);
CREATE INDEX attendance_events_booking ON attendance_events (booking_id, received_at);

CREATE FUNCTION attendance_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = NEW.booking_id AND b.hospital_id = NEW.hospital_id) THEN
    RAISE EXCEPTION 'booking does not belong to hospital' USING ERRCODE = '23503';
  END IF;
  IF NEW.device_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = NEW.device_id AND d.hospital_id = NEW.hospital_id) THEN
    RAISE EXCEPTION 'device does not belong to hospital' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attendance_events_guard BEFORE INSERT ON attendance_events
  FOR EACH ROW EXECUTE FUNCTION attendance_events_guard();

-- ---------------------------------------------------------------- bookings: review flag and sync sequence
ALTER TABLE bookings ADD COLUMN needs_review boolean NOT NULL DEFAULT false;
CREATE SEQUENCE booking_sync_seq;
ALTER TABLE bookings ADD COLUMN sync_seq bigint NOT NULL DEFAULT nextval('booking_sync_seq');
CREATE INDEX bookings_sync ON bookings (hospital_id, sync_seq);

-- Every change to a booking gets a new sequence number, so devices pull "everything after N".
CREATE FUNCTION bookings_touch_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.sync_seq := nextval('booking_sync_seq');
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_touch_seq BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_touch_seq();

-- ---------------------------------------------------------------- grants & RLS
GRANT SELECT, INSERT, DELETE ON doctor_departments TO medlink_app;
GRANT SELECT, INSERT, UPDATE ON devices TO medlink_app;
GRANT SELECT, INSERT ON attendance_events TO medlink_app;
GRANT USAGE ON SEQUENCE booking_sync_seq TO medlink_app;

ALTER TABLE doctor_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices            ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_events  ENABLE ROW LEVEL SECURITY;

CREATE POLICY doctor_departments_tenant ON doctor_departments TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()))
  WITH CHECK (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()));
CREATE POLICY devices_tenant ON devices TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()))
  WITH CHECK (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()));
CREATE POLICY attendance_events_tenant ON attendance_events TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()))
  WITH CHECK (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()));
