DROP TABLE IF EXISTS metrics_rollup;

CREATE TABLE metrics_rollup (
  bucket_ts      INTEGER NOT NULL,
  container_name TEXT    NOT NULL,
  project        TEXT,
  samples        INTEGER NOT NULL,
  cpu_samples    INTEGER NOT NULL,
  cpu_avg        REAL,
  cpu_max        REAL,
  mem_avg        REAL    NOT NULL,
  mem_max        REAL    NOT NULL,
  PRIMARY KEY (bucket_ts, container_name)
);

CREATE TABLE disk_rollup (
  bucket_ts              INTEGER NOT NULL,
  disk                   TEXT    NOT NULL,
  seconds                REAL    NOT NULL,
  read_bytes             REAL    NOT NULL,
  write_bytes            REAL    NOT NULL,
  read_ios               REAL    NOT NULL,
  write_ios              REAL    NOT NULL,
  flushes                REAL,
  attributed_read_bytes  REAL    NOT NULL,
  attributed_write_bytes REAL    NOT NULL,
  read_max_bps           REAL    NOT NULL,
  write_max_bps          REAL    NOT NULL,
  PRIMARY KEY (bucket_ts, disk)
);

CREATE TABLE disk_container_rollup (
  bucket_ts      INTEGER NOT NULL,
  disk           TEXT    NOT NULL,
  container_name TEXT    NOT NULL,
  project        TEXT,
  read_bytes     REAL    NOT NULL,
  write_bytes    REAL    NOT NULL,
  PRIMARY KEY (bucket_ts, disk, container_name)
);

CREATE TABLE disk_devices (
  name              TEXT PRIMARY KEY,
  watched           INTEGER,
  tbw_tb            REAL,
  written_tb        REAL,
  written_at        INTEGER,
  threshold_mb_min  REAL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE disk_alert_state (
  subject     TEXT PRIMARY KEY,
  kind        TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  alerted_at  INTEGER NOT NULL,
  rate_bps    REAL    NOT NULL
);
