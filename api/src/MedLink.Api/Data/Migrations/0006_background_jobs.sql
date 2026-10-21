-- MEDLINK migration 0006: background jobs (automatic no-show, cleanup, retention).

-- ---------------------------------------------------------------- automatic no-show
-- At most one automatic no-show per booking, even if two API instances run the job at the same time.
CREATE UNIQUE INDEX attendance_events_one_auto ON attendance_events (booking_id) WHERE source = 'auto';

-- ---------------------------------------------------------------- retention
-- After the retention period, a correction's free-text reason is cleared (it may name the patient; owner's decision
-- pending, recommended in the Phase 9 report). The event itself stays: type, source, time and account.
ALTER TABLE attendance_events ADD COLUMN redacted_at timestamptz NULL;
ALTER TABLE attendance_events DROP CONSTRAINT attendance_events_check;
ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_correction_reason
  CHECK (source <> 'correction' OR reason IS NOT NULL OR redacted_at IS NOT NULL);

-- Events stay append-only: the only change allowed is clearing the reason (and stamping redacted_at), once.
CREATE FUNCTION attendance_events_redact_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.redacted_at IS NOT NULL OR NEW.reason IS NOT NULL OR NEW.redacted_at IS NULL
     OR (NEW.id, NEW.hospital_id, NEW.booking_id, NEW.type, NEW.source, NEW.at, NEW.received_at, NEW.actor_id, NEW.device_id, NEW.client_event_id)
        IS DISTINCT FROM (OLD.id, OLD.hospital_id, OLD.booking_id, OLD.type, OLD.source, OLD.at, OLD.received_at, OLD.actor_id, OLD.device_id, OLD.client_event_id) THEN
    RAISE EXCEPTION 'attendance events are append-only (only the reason can be redacted)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attendance_events_redact_only BEFORE UPDATE ON attendance_events
  FOR EACH ROW EXECUTE FUNCTION attendance_events_redact_only();
GRANT UPDATE (reason, redacted_at) ON attendance_events TO medlink_app;

-- ---------------------------------------------------------------- cleanup
-- Used or expired one-time links and old sessions are deleted after a while (the audit log keeps the history).
GRANT DELETE ON one_time_links, sessions TO medlink_app;

-- When each job last ran (one row per job), for the nightly schedule and for monitoring.
CREATE TABLE job_runs (
  job         text PRIMARY KEY CHECK (job IN ('no_show', 'cleanup', 'retention')),
  last_run_at timestamptz NOT NULL,
  last_count  integer NOT NULL
);
GRANT SELECT, INSERT, UPDATE ON job_runs TO medlink_app;
