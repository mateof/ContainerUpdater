-- Cuarentena, vuelta atras y vigilancia de contenedores.
--
-- Las tres cosas comparten migracion porque comparten origen: hacer que dejar
-- el auto-update encendido no de miedo. La cuarentena evita entrar en una
-- version recien salida, la vuelta atras arregla el caso en que aun asi sale
-- mal, y la vigilancia avisa de que salio mal aunque la actualizacion en si
-- terminara bien.

-- Horas que una version debe llevar publicada antes de que el auto-update la
-- aplique. NULL significa "usa el valor global de ajustes", que es distinto de
-- 0 ("sin cuarentena para esta imagen aunque el global diga otra cosa").
ALTER TABLE image_policies ADD COLUMN min_age_hours INTEGER;

-- Cuando se publico la version remota. Se descubre al detectar la novedad, no
-- en cada comprobacion: solo hace falta cuando hay algo nuevo que sopesar.
ALTER TABLE tracked_images ADD COLUMN remote_created_at INTEGER;

-- Etiquetas OCI de la version publicada y de la instalada. Con las dos
-- revisiones se construye la comparacion de commits.
ALTER TABLE tracked_images ADD COLUMN remote_source_url TEXT;
ALTER TABLE tracked_images ADD COLUMN remote_revision   TEXT;
ALTER TABLE tracked_images ADD COLUMN remote_version    TEXT;
ALTER TABLE tracked_images ADD COLUMN local_source_url  TEXT;
ALTER TABLE tracked_images ADD COLUMN local_revision    TEXT;

-- A donde volver si la actualizacion resulta estar rota.
--
-- Es un JSON array y no un digest suelto por la misma razon que `local_digests`:
-- una imagen puede tener el digest del indice y el del manifest de su
-- arquitectura, y no todos los registries sirven ambos por igual. Al revertir se
-- prueban en orden.
ALTER TABLE update_jobs ADD COLUMN rollback_digests TEXT;
ALTER TABLE update_jobs ADD COLUMN rollback_tag     TEXT;

-- Estado de vigilancia por contenedor.
--
-- Hace falta guardar estado porque los avisos son de TRANSICION, no de
-- situacion: "se ha caido" se manda una vez, no cada cinco minutos mientras
-- siga caido. Sin esta tabla, la unica alternativa seria deducirlo del historial
-- de notificaciones, que se purga por retencion y dejaria de avisar o avisaria
-- de mas segun el dia.
CREATE TABLE container_watch (
  -- El nombre y no el id: al recrear un contenedor el id cambia entero, y
  -- entonces cada actualizacion pareceria un contenedor nuevo que se ha caido.
  name            TEXT    PRIMARY KEY,
  last_state      TEXT    NOT NULL,
  last_health     TEXT    NOT NULL DEFAULT 'none',
  last_restarts   INTEGER NOT NULL DEFAULT 0,
  -- Que se ha avisado ya, para no repetir y para saber de que hay que anunciar
  -- la recuperacion. NULL = no hay aviso vivo.
  alerted_kind    TEXT,
  alerted_at      INTEGER,
  -- Momento a partir del cual se vuelve a vigilar. Lo pone el updater al tocar
  -- un contenedor: durante una actualizacion pasa por parado y recreado, y sin
  -- esto cada actualizacion dispararia una alarma de caida.
  muted_until     INTEGER,
  updated_at      INTEGER NOT NULL
);
