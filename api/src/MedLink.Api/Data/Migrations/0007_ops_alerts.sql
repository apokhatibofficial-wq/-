-- MEDLINK migration 0007: the results of the server's backup scripts, so the API can email the owner (Phase 12).

-- One row per check. The scripts (infra/backup) write it as the database owner; the API only reads it and records
-- when it last sent an alert. Messages are technical (file names, sizes, reasons), never personal data.
CREATE TABLE ops_checks (
  name       text PRIMARY KEY CHECK (name IN ('backup', 'restore_test')),
  ok         boolean NOT NULL,
  message    text NOT NULL CHECK (length(message) <= 500),
  at         timestamptz NOT NULL,
  last_ok_at timestamptz NOT NULL,
  alerted_at timestamptz NULL
);
GRANT SELECT ON ops_checks TO medlink_app;
GRANT UPDATE (alerted_at) ON ops_checks TO medlink_app;

-- Until the first run, the deployment counts as the last good one: 8 hours without a backup is already an alert.
INSERT INTO ops_checks (name, ok, message, at, last_ok_at)
VALUES ('backup', true, 'no backup has run yet', now(), now()),
       ('restore_test', true, 'no restore test has run yet', now(), now());
