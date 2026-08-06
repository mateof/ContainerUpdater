-- Esquema inicial de ContainerUpdater.
-- Todas las marcas de tiempo son epoch en milisegundos (INTEGER).

-- ---------------------------------------------------------------------------
-- Identidad
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT    NOT NULL,
  role                 TEXT    NOT NULL DEFAULT 'admin',
  locale               TEXT    NOT NULL DEFAULT 'es',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         INTEGER,
  last_login_at        INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

-- Solo se guarda sha256(token). Si alguien lee la base de datos no obtiene
-- sesiones utilizables, unicamente su huella.
CREATE TABLE sessions (
  id           TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  rotated_from TEXT,
  user_agent   TEXT,
  ip           TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE INDEX ix_sessions_user ON sessions(user_id, expires_at);
CREATE INDEX ix_sessions_expiry ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Registries. El secreto va cifrado con AES-256-GCM (ver crypto/keyring.ts).
-- ---------------------------------------------------------------------------

CREATE TABLE registries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  host             TEXT    NOT NULL UNIQUE,
  auth_type        TEXT    NOT NULL DEFAULT 'anonymous',
  username         TEXT,
  secret_ct        BLOB,
  secret_iv        BLOB,
  secret_tag       BLOB,
  key_version      INTEGER NOT NULL DEFAULT 1,
  status           TEXT    NOT NULL DEFAULT 'untested',
  last_error       TEXT,
  rate_remaining   INTEGER,
  rate_total       INTEGER,
  last_verified_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Inventario
-- ---------------------------------------------------------------------------

CREATE TABLE tracked_images (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_ref   TEXT    NOT NULL UNIQUE,
  host             TEXT    NOT NULL,
  repository       TEXT    NOT NULL,
  tag              TEXT    NOT NULL,
  image_id         TEXT,
  architecture     TEXT,
  os               TEXT,
  variant          TEXT,
  -- JSON array: una imagen puede tener el digest del indice Y el del manifest
  -- de su arquitectura. Comparar contra un solo string da falsos positivos.
  local_digests    TEXT    NOT NULL DEFAULT '[]',
  source           TEXT    NOT NULL DEFAULT 'registry',
  size_bytes       INTEGER,
  image_created_at INTEGER,
  status           TEXT    NOT NULL DEFAULT 'unknown',
  remote_digest    TEXT,
  candidate_tag    TEXT,
  last_checked_at  INTEGER,
  last_error       TEXT,
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL
);
CREATE INDEX ix_images_status ON tracked_images(status);
CREATE INDEX ix_images_host ON tracked_images(host);

-- El nombre de proyecto NO es unico: Container Manager genera el nombre a
-- partir de la carpeta, asi que dos stacks en .../a/docker y .../b/docker se
-- llaman ambos "docker". La clave real es (nombre, working_dir); agrupar solo
-- por nombre haria que un `compose down` cayera en el stack equivocado.
CREATE TABLE compose_projects (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_name     TEXT    NOT NULL,
  working_dir      TEXT    NOT NULL,
  config_files     TEXT    NOT NULL DEFAULT '[]',
  yaml_accessible  INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  last_verified_at INTEGER,
  created_at       INTEGER NOT NULL,
  UNIQUE (project_name, working_dir)
);

-- ---------------------------------------------------------------------------
-- Politicas por imagen
-- ---------------------------------------------------------------------------

CREATE TABLE image_policies (
  image_ref            TEXT    PRIMARY KEY,
  auto_update          INTEGER NOT NULL DEFAULT 0,
  track_mode           TEXT    NOT NULL DEFAULT 'digest',
  semver_channel       TEXT    NOT NULL DEFAULT 'minor',
  notify               INTEGER NOT NULL DEFAULT 1,
  recreate_scope       TEXT    NOT NULL DEFAULT 'service',
  remove_image_on_force INTEGER NOT NULL DEFAULT 0,
  cleanup_old_image    INTEGER NOT NULL DEFAULT 1,
  paused_until         INTEGER,
  ignored_digest       TEXT,
  updated_at           INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Historial de comprobaciones
-- ---------------------------------------------------------------------------

CREATE TABLE check_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger        TEXT    NOT NULL DEFAULT 'schedule',
  status         TEXT    NOT NULL DEFAULT 'running',
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  images_checked INTEGER NOT NULL DEFAULT 0,
  updates_found  INTEGER NOT NULL DEFAULT 0,
  errors         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_runs_started ON check_runs(started_at DESC);

CREATE TABLE check_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES check_runs(id) ON DELETE CASCADE,
  image_ref     TEXT    NOT NULL,
  local_digest  TEXT,
  remote_digest TEXT,
  has_update    INTEGER NOT NULL DEFAULT 0,
  candidate_tag TEXT,
  http_status   INTEGER,
  duration_ms   INTEGER,
  error         TEXT,
  checked_at    INTEGER NOT NULL
);
CREATE INDEX ix_results_image ON check_results(image_ref, checked_at DESC);
CREATE INDEX ix_results_run ON check_results(run_id);

-- ---------------------------------------------------------------------------
-- Trabajos de actualizacion
-- ---------------------------------------------------------------------------

CREATE TABLE update_jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  image_ref      TEXT    NOT NULL,
  container_id   TEXT,
  container_name TEXT,
  project_key    TEXT,
  mode           TEXT    NOT NULL DEFAULT 'update',
  strategy       TEXT    NOT NULL DEFAULT 'compose',
  trigger        TEXT    NOT NULL DEFAULT 'manual',
  actor_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_chat_id  INTEGER,
  status         TEXT    NOT NULL DEFAULT 'queued',
  from_digest    TEXT,
  to_digest      TEXT,
  from_tag       TEXT,
  to_tag         TEXT,
  log            TEXT    NOT NULL DEFAULT '',
  error          TEXT,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER
);
CREATE INDEX ix_jobs_created ON update_jobs(created_at DESC);
CREATE INDEX ix_jobs_status ON update_jobs(status);

-- ---------------------------------------------------------------------------
-- Deduplicacion de notificaciones
-- ---------------------------------------------------------------------------

-- dedupe_key = sha256(canal|tipo|ref|digest). Como incluye el digest, un
-- `latest` que apunte a una imagen genuinamente nueva vuelve a notificar, pero
-- el mismo digest no se anuncia dos veces.
CREATE TABLE notifications_sent (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key  TEXT    NOT NULL UNIQUE,
  channel     TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  image_ref   TEXT,
  digest      TEXT,
  chat_id     INTEGER,
  message_id  INTEGER,
  reserved_at INTEGER NOT NULL,
  sent_at     INTEGER
);
CREATE INDEX ix_notifications_ref ON notifications_sent(image_ref);

-- ---------------------------------------------------------------------------
-- Telegram
-- ---------------------------------------------------------------------------

CREATE TABLE telegram_users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id        INTEGER NOT NULL UNIQUE,
  tg_user_id     INTEGER,
  username       TEXT,
  first_name     TEXT,
  role           TEXT    NOT NULL DEFAULT 'operator',
  linked_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  locale         TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  linked_at      INTEGER NOT NULL,
  last_seen_at   INTEGER
);

-- Solo se guarda el hash del codigo, nunca el codigo. Un solo uso garantizado
-- por `UPDATE ... WHERE used_at IS NULL`.
CREATE TABLE telegram_link_codes (
  code_hash    TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER,
  used_by_chat INTEGER
);

-- ---------------------------------------------------------------------------
-- Varios
-- ---------------------------------------------------------------------------

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tag_cache (
  host       TEXT NOT NULL,
  repository TEXT NOT NULL,
  tags       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (host, repository)
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX ix_audit_created ON audit_log(created_at DESC);

-- Solo se escribe si el usuario activa el historico. Por defecto las metricas
-- viven en memoria: escribir cada pocos segundos despierta los discos del NAS.
CREATE TABLE metrics_rollup (
  bucket_ts    INTEGER NOT NULL,
  container_id TEXT    NOT NULL,
  cpu_avg      REAL,
  cpu_max      REAL,
  mem_avg      REAL,
  mem_max      REAL,
  PRIMARY KEY (bucket_ts, container_id)
);
