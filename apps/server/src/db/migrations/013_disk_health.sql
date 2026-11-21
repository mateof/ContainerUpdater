ALTER TABLE container_events ADD COLUMN source TEXT NOT NULL DEFAULT 'container';

CREATE TABLE tuning_rules (
  scope       TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  healthcheck TEXT,
  logging     TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE impact_probes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  container_id   TEXT    NOT NULL,
  container_name TEXT    NOT NULL,
  minutes        INTEGER NOT NULL,
  state          TEXT    NOT NULL,
  started_at     INTEGER NOT NULL,
  ends_at        INTEGER NOT NULL,
  finished_at    INTEGER,
  error          TEXT,
  result         TEXT
);
