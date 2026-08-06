# Arquitectura

Monorepo con npm workspaces. Un único contenedor sirve la API y la interfaz
desde el mismo origen, lo que permite usar cookies de sesión sin CORS.

```
packages/shared/     esquemas zod, tipos DTO y catalogo i18n (web + bot)
apps/server/         Fastify + SQLite + Docker + registries + Telegram
apps/web/            React + Vite, servido por el propio backend
```

El catálogo de traducciones vive en `packages/shared` a propósito: lo consumen
la web y el bot, de manera que no pueden desincronizarse y el bot habla el
idioma que el usuario eligió en la interfaz.

## Flujo de una comprobación

```
cron (croner)
  → InventoryService.refresh()      lee contenedores e imagenes del socket
  → CheckerService.runCheck()       consulta los registries
  → NotifierService                 avisa por Telegram, sin repetir
  → UpdaterService.runAutoUpdates() aplica lo marcado como automatico
```

## Detección de actualizaciones

`apps/server/src/registry/`

El camino caliente es **un solo `HEAD` por imagen**. Verificado contra Docker
Hub: los HEAD de manifest no descuentan cuota, así que comprobar veinte imágenes
cada seis horas sale gratis.

1. **Normalizar** (`reference.ts`). `nginx:alpine` pasa a
   `registry-1.docker.io/library/nginx:alpine`. El namespace `library/` implícito
   solo aplica a Docker Hub; un componente es un host y no parte del repositorio
   si lleva un punto, dos puntos o es `localhost`.

2. **Autenticar por challenge** (`auth.ts`). Ante un 401 se lee
   `WWW-Authenticate` y se pide el token al `realm` **que indique la cabecera**.
   Esto no se puede hardcodear: `lscr.io` responde con
   `realm="https://ghcr.io/token"`, es decir, el registry al que pides la imagen
   y el que emite el token son hosts distintos. También existe la rama sin
   challenge (quay.io público responde 200 directamente) y la rama `Basic` de los
   registries con htpasswd.

   Los tokens se cachean por `(host, repositorio, scope)`. Verificado: el token
   de Docker Hub está acotado a un repositorio, y reutilizar el de
   `library/nginx` para pedir `library/postgres` devuelve 401.

3. **Comparar digests** (`manifest.ts`). `RepoDigests` es una **lista** y puede
   contener tanto el digest del índice OCI como el del manifest de la
   arquitectura local: verificado, `nginx:alpine` tiene dos. Se compara contra el
   conjunto entero. Si el digest del índice coincide, no hay novedad y ahí acaba
   el 95% de los casos. Solo si no coincide se descarga el cuerpo del índice y se
   busca el hijo de la plataforma local, descartando las entradas de atestación
   con plataforma `unknown`.

4. **Versiones** (`semver.ts`), cuando la política lo pide. Las etiquetas se
   agrupan por "sabor": `17-alpine` solo se compara con `NN-alpine`, nunca con
   `17-bookworm` ni con `17` a secas, y el prefijo `v` del tag original se
   conserva en la propuesta. Las etiquetas parciales como `8.2` se vigilan en
   ambos modos, porque son a la vez ancla y móvil, y son informaciones distintas.

### Imágenes que no se pueden comprobar

Las construidas en la máquina no tienen nada remoto con lo que compararse, y
hacer pull bajaría una imagen ajena que casualmente se llame igual en Docker Hub.

La heurística de "sin `RepoDigests` es local" no basta: Podman les asigna un
digest local igualmente. Por eso la detección es **reactiva**: cuando el registry
confirma que el repositorio no existe (la API pública de Docker Hub sí distingue
404 de privado, a diferencia del endpoint del registry, que devuelve 401 para
ambos), la imagen se marca como `local-build` y queda fuera de futuras
comprobaciones. Esa marca sobrevive a los refrescos del inventario.

## Actualización

`apps/server/src/docker/{compose,recreate}.ts`

**Compose** cuando el YAML es accesible. `execFile` con `shell: false`, nombres
validados y rutas resueltas con `realpath` **antes** de comprobarlas contra las
carpetas permitidas: al revés, un enlace simbólico dentro de `/volume1/docker`
apuntando fuera pasaría el filtro. El entorno del subproceso es explícito y
mínimo, sin heredar el del proceso, que contiene la clave de cifrado y el token
de Telegram.

**Recreate** cuando no lo es. Dos cosas que las herramientas de este tipo suelen
hacer mal:

- Copiar `Config.Env` tal cual fija los valores por defecto de la imagen
  **vieja**, así que si la versión nueva cambia uno, el contenedor recreado se
  queda con el antiguo. Se hace un diff contra la configuración de esa imagen y
  solo se arrastra lo que puso el usuario. Igual con `Cmd`, `Entrypoint` y
  `Labels`.
- Los volúmenes anónimos (nombre de 64 hex) no aparecen en `Binds`. Si no se
  copian explícitamente, el contenedor nuevo crea otros vacíos y los datos
  quedan huérfanos en silencio.

Las redes secundarias se conectan **antes** del arranque: después, la aplicación
levanta sin poder resolver a sus vecinos y muchas fallan al inicio sin
reintentar.

La puerta de salud espera a `healthy` si la imagen declara healthcheck; si no,
espera y comprueba que no haya reiniciado, porque un contenedor en bucle de
reinicio pasa un `¿está corriendo?` ingenuo. Si algo falla, se restaura el
contenedor anterior, que sigue existiendo porque se renombró en vez de borrarse.

## Métricas

`apps/server/src/docker/stats.ts` y `services/{host,metrics}.ts`

La fórmula habitual de CPU% usa `precpu_stats` como muestra anterior. Verificado:
con `stream=false`, Podman devuelve ese bloque vacío y dockerd lo deja vacío en
la primera lectura. Por eso se guarda la muestra anterior propia y `precpu_stats`
se trata como una pista opcional. Cadena de fallbacks para el número de CPUs:
`online_cpus`, luego `percpu_usage.length` (cgroup v1, kernels antiguos de
Synology), luego el `NCPU` del daemon.

La memoria resta el caché de fichero (`inactive_file` en cgroup v2,
`total_inactive_file` en v1). Sin restarlo los contenedores aparentan consumir el
triple.

Del host se lee `/host/proc` con un lector propio. Se descartó
`systeminformation`: lee rutas de `/proc` fijas, o sea las del contenedor y no
las del NAS, y devolvería datos del contenedor haciéndolos pasar por los del
sistema. Se usa `MemAvailable` y no `MemFree`, porque con caché de ficheros
`MemFree` es engañosamente bajo. Los discos se muestrean cada cinco minutos: `df`
despierta los discos hibernados.

**Un solo muestreador global**, no uno por cliente, y solo corre si hay alguien
mirando. La interfaz cierra el `EventSource` al ocultarse la pestaña, con lo que
el servidor deja de muestrear por completo.

Transporte por SSE y no WebSocket: el flujo es unidireccional, `EventSource`
manda la cookie sin trabajo extra, reconecta solo y atraviesa el proxy inverso
de DSM sin configurar `Upgrade`. Requiere `X-Accel-Buffering: no`, o el nginx de
DSM lo bufferiza y los eventos llegan a trompicones.

## Datos

SQLite con WAL y `synchronous=NORMAL`. Migraciones por `PRAGMA user_version`.

Las métricas en vivo **no** van a disco: escribir cada pocos segundos por
contenedor castiga los discos del NAS. Viven en un buffer circular en memoria y
solo se agregan a disco si el usuario activa el histórico.

La clave de un proyecto de Compose es `(nombre, working_dir)`, no el nombre.
Verificado en un entorno real: Container Manager deriva el nombre de la carpeta,
así que dos stacks distintos pueden llamarse ambos `docker`, y agrupar por nombre
haría que un `compose down` cayera en el equivocado.

## Cifrado

`crypto/keyring.ts`. Envelope encryption con `node:crypto`: una clave maestra del
entorno envuelve una clave de datos generada en el primer arranque. Rotar la
maestra es re-envolver una clave, no re-cifrar cada fila.

AES-256-GCM con IV nuevo en cada escritura y un AAD que ata el ciphertext a su
fila y versión de clave, de forma que copiar el blob de un registry a otro falle
la autenticación en vez de descifrar el secreto del vecino.
