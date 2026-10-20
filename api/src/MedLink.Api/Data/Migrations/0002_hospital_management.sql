-- MEDLINK migration 0002: departments, weekly schedules, closures; absolute session lifetime.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- sessions: hard 7-day limit
ALTER TABLE sessions ADD COLUMN absolute_expires_at timestamptz;
UPDATE sessions SET absolute_expires_at = created_at + interval '7 days';
ALTER TABLE sessions ALTER COLUMN absolute_expires_at SET NOT NULL;

-- ---------------------------------------------------------------- departments
-- Never deleted (bookings will reference them); deactivated instead.
CREATE TABLE departments (
  id          text PRIMARY KEY CHECK (id ~ '^dep_[0-9A-HJKMNP-TV-Z]{26}$'),
  hospital_id text NOT NULL REFERENCES hospitals (id),
  name_ar     text NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 120),
  name_en     text NULL     CHECK (name_en IS NULL OR length(name_en) <= 120),
  name_tr     text NULL     CHECK (name_tr IS NULL OR length(name_tr) <= 120),
  active      boolean NOT NULL DEFAULT true,
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX departments_hospital ON departments (hospital_id, sort);
CREATE UNIQUE INDEX departments_name_unique ON departments (hospital_id, lower(btrim(name_ar)));

-- ---------------------------------------------------------------- weekly schedules
-- weekday: 0 = Sunday … 6 = Saturday (as JavaScript's Date.getDay()). Times are minutes after
-- midnight in the hospital's own time zone. Two blocks of one department never overlap on a day.
CREATE TABLE schedules (
  id            text PRIMARY KEY CHECK (id ~ '^sch_[0-9A-HJKMNP-TV-Z]{26}$'),
  hospital_id   text NOT NULL REFERENCES hospitals (id),
  department_id text NOT NULL REFERENCES departments (id),
  weekday       smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min     integer NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min       integer NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  slot_minutes  integer NOT NULL CHECK (slot_minutes BETWEEN 5 AND 240),
  capacity      integer NOT NULL CHECK (capacity BETWEEN 1 AND 100),
  CHECK (end_min - start_min >= slot_minutes),
  EXCLUDE USING gist (department_id WITH =, weekday WITH =, int4range(start_min, end_min) WITH &&)
);
CREATE INDEX schedules_department ON schedules (department_id, weekday);

-- A schedule's hospital must be its department's hospital.
CREATE FUNCTION schedules_hospital_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM departments d WHERE d.id = NEW.department_id AND d.hospital_id = NEW.hospital_id) THEN
    RAISE EXCEPTION 'department does not belong to hospital' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER schedules_hospital_guard BEFORE INSERT OR UPDATE ON schedules
  FOR EACH ROW EXECUTE FUNCTION schedules_hospital_guard();

-- ---------------------------------------------------------------- closures
-- department_id NULL = the whole hospital is closed that day.
CREATE TABLE closures (
  id            text PRIMARY KEY CHECK (id ~ '^clo_[0-9A-HJKMNP-TV-Z]{26}$'),
  hospital_id   text NOT NULL REFERENCES hospitals (id),
  department_id text NULL REFERENCES departments (id),
  date          date NOT NULL,
  reason        text NULL CHECK (reason IS NULL OR length(reason) <= 200),
  created_by    text NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (hospital_id, department_id, date)
);

CREATE FUNCTION closures_hospital_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.department_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM departments d WHERE d.id = NEW.department_id AND d.hospital_id = NEW.hospital_id) THEN
    RAISE EXCEPTION 'department does not belong to hospital' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER closures_hospital_guard BEFORE INSERT OR UPDATE ON closures
  FOR EACH ROW EXECUTE FUNCTION closures_hospital_guard();

-- ---------------------------------------------------------------- grants & RLS
GRANT SELECT, INSERT, UPDATE ON departments TO medlink_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON schedules, closures TO medlink_app;

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules   ENABLE ROW LEVEL SECURITY;
ALTER TABLE closures    ENABLE ROW LEVEL SECURITY;

CREATE POLICY departments_tenant ON departments TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()))
  WITH CHECK (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()));

CREATE POLICY schedules_tenant ON schedules TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()))
  WITH CHECK (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()));

CREATE POLICY closures_tenant ON closures TO medlink_app
  USING (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()))
  WITH CHECK (app_is_global() OR (app_scope() = 'hospital' AND hospital_id = app_hospital_id()));
