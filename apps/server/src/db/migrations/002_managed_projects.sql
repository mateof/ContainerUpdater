-- Proyectos creados desde la aplicacion y respaldo de sus ficheros.

-- ---------------------------------------------------------------------------
-- Proyectos gestionados
-- ---------------------------------------------------------------------------
--
-- Existe por un motivo concreto: el inventario deduce los proyectos de las
-- labels de los CONTENEDORES, asi que un proyecto recien creado que todavia no
-- se ha levantado (o cuyo arranque ha fallado) no existiria para la aplicacion
-- y no habria forma de volver a el para corregir el YAML. Esta tabla es lo que
-- lo mantiene visible.
--
-- Tambien es lo que distingue lo que podemos editar de lo que no: los ficheros
-- de un proyecto creado en Container Manager o por SSH solo se leen.

CREATE TABLE managed_projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL UNIQUE,
  dir          TEXT    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- Versiones anteriores de los ficheros
-- ---------------------------------------------------------------------------
--
-- Cada guardado archiva aqui lo que habia antes, para poder volver atras tras
-- una edicion desafortunada.
--
-- El contenido va CIFRADO con el mismo sobre que las credenciales de registry.
-- No es un adorno: el `.env` de un stack lleva contrasenas de bases de datos y
-- tokens de API, y la copia de seguridad de un secreto sigue siendo un secreto.
-- El fichero en disco no se puede cifrar porque Compose tiene que leerlo, pero
-- esta copia si, y es la que se acumula con el tiempo.
--
-- Si el llavero esta bloqueado, el archivado se omite y se registra: es
-- preferible perder el historial que impedir guardar.

CREATE TABLE project_file_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES managed_projects(id) ON DELETE CASCADE,
  -- 'compose' | 'env'
  kind         TEXT    NOT NULL,
  content_ct   TEXT    NOT NULL,
  iv           TEXT    NOT NULL,
  tag          TEXT    NOT NULL,
  key_version  INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_project_versions ON project_file_versions(project_id, kind, created_at DESC);
