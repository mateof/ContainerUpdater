-- Poder editar tambien los proyectos que no se crearon desde la aplicacion.
--
-- La version anterior solo dejaba editar lo creado aqui, y en un NAS real eso
-- es casi nada: los proyectos los hizo el usuario en Container Manager. Se
-- permite editar cualquiera cuyo YAML sea accesible y cuya carpeta admita
-- escritura, que es lo que de verdad determina si se puede.
--
-- Dos cambios en la tabla:
--
-- 1. `name` deja de ser UNIQUE. Container Manager deriva el nombre del proyecto
--    del nombre de la carpeta, asi que dos stacks distintos pueden llamarse los
--    dos `docker` (verificado en el entorno del usuario, ver ADR-004). Mientras
--    solo se registraban proyectos creados aqui, con nombre validado y unico,
--    la restriccion valia; en cuanto entran los de fuera, rechazaria el segundo
--    homonimo. La identidad pasa a ser el directorio, que si es unico.
--
-- 2. `created_here` distingue lo creado desde la aplicacion de lo que solo se
--    ha editado. Se usa para saber que proyectos hay que mostrar aunque
--    todavia no tengan contenedores: uno recien creado que no ha arrancado
--    tiene que seguir viendose, pero uno de fuera que ya no tiene contenedores
--    es que lo borro el usuario y no debe reaparecer.
--
-- SQLite no sabe quitar una restriccion UNIQUE, asi que se reconstruye la
-- tabla. Las claves foraneas estan en ON por pragma; se apagan durante la
-- operacion para que el borrado de la tabla vieja no arrastre las versiones
-- archivadas por su ON DELETE CASCADE.

PRAGMA foreign_keys = OFF;

CREATE TABLE managed_projects_new (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  dir          TEXT    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Todo lo que existia hasta ahora se creo desde la aplicacion.
  created_here INTEGER NOT NULL DEFAULT 1
);

INSERT INTO managed_projects_new (id, name, dir, created_at, updated_at, created_by, created_here)
  SELECT id, name, dir, created_at, updated_at, created_by, 1 FROM managed_projects;

DROP TABLE managed_projects;
ALTER TABLE managed_projects_new RENAME TO managed_projects;

CREATE INDEX idx_managed_projects_name ON managed_projects(name);

PRAGMA foreign_keys = ON;
