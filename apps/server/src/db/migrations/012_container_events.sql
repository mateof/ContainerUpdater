CREATE TABLE container_events (
  at             INTEGER NOT NULL,
  container_name TEXT    NOT NULL,
  project        TEXT,
  kind           TEXT    NOT NULL,
  exit_code      INTEGER,
  PRIMARY KEY (at, container_name, kind)
);
