-- Que version tienes instalada de verdad.
--
-- Con una etiqueta rodante (`latest`) el nombre no dice nada y en pantalla solo
-- quedaba el digest, que es exacto pero ilegible. La version se averigua
-- preguntando al registry que OTRAS etiquetas apuntan al mismo digest: si
-- `latest` y `v3.7.2` son el mismo contenido, tu `latest` es v3.7.2.
--
-- No se usan las etiquetas OCI de la imagen para esto. Comprobado sobre 18
-- imagenes reales: `mongo:8.2` declara `org.opencontainers.image.version=24.04`
-- y `redis/redis-stack:7.4.0-v0` declara 22.04, porque heredan la etiqueta de
-- su base de Ubuntu sin sobrescribirla. Enseñar eso seria peor que no enseñar
-- nada, porque parece un dato bueno.
ALTER TABLE tracked_images ADD COLUMN installed_version TEXT;

-- Como se averiguo: 'tag' (la propia etiqueta ya nombraba la version), 'hub' o
-- 'registry'. La interfaz lo usa para no repetir un dato que ya esta a la vista.
ALTER TABLE tracked_images ADD COLUMN installed_version_method TEXT;

-- Para que digest se resolvio.
--
-- Es lo que evita enseñar una version rancia: al actualizar la imagen cambia el
-- digest, y si este no coincide con el actual, el valor guardado se descarta y
-- se vuelve a resolver. Sin esta columna, tras actualizar `latest` seguiria
-- diciendo la version vieja hasta que alguien se acordara de limpiarla.
ALTER TABLE tracked_images ADD COLUMN installed_version_for TEXT;
