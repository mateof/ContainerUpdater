# ContainerUpdater

*[English](README.md) · **Español***

Panel autoalojado para vigilar y actualizar las imágenes Docker de un **Synology
NAS con Container Manager**.

Container Manager no avisa de si existe una versión nueva de una imagen, y el
caso que más molesta es GHCR: un tag `latest` puede llevar meses obsoleto sin
ninguna señal en la interfaz de DSM. Esta aplicación lo resuelve, y de paso
reúne en un sitio lo que hasta ahora obligaba a entrar por SSH.

## Qué hace

- **Detecta actualizaciones** comparando el digest local contra el manifest del
  registry. Funciona con Docker Hub, GHCR (público y privado), lscr.io, quay.io
  y registries propios.
- **Sigue versiones semánticas** además de digests: avisa de que existe
  `postgres:18-alpine` cuando tienes `17-alpine`, sin proponerte saltos entre
  imágenes base distintas.
- **Actualiza y reinicia** el proyecto afectado, con Docker Compose cuando el
  YAML es accesible y recreando el contenedor por la API cuando no lo es.
- **Auto-actualización por imagen**: marcas las que quieres que se actualicen
  solas y el resto solo avisan.
- **Forzado**: vuelve a descargar y recrea aunque no haya novedad.
- **Rendimiento** del NAS y de cada contenedor, en vivo.
- **Bot de Telegram** restringido a las cuentas que autorices, que notifica sin
  repetirse y acepta comandos.
- **Crea proyectos** desde la web: pegas o subes un `docker-compose.yml` y su
  `.env`, y se crea la carpeta, se valida y se levanta.
- **Interfaz en español e inglés**, con tema claro y oscuro.

## Instalación en el NAS

1. Crea la carpeta `/volume1/docker/container-updater`.
2. Copia [docker-compose.example.yml](docker-compose.example.yml) como
   `docker-compose.yml` y [.env.example](.env.example) como `.env` dentro de esa
   carpeta.
3. Genera la clave de cifrado y ponla en el `.env`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   **Guarda una copia fuera del NAS.**
4. En Container Manager, crea un proyecto apuntando a esa carpeta.
5. Entra en `http://IP-DEL-NAS:8099`.

Si no pusiste `CU_ADMIN_PASSWORD`, la contraseña inicial se escribe una sola vez
en los logs: `docker logs container-updater`.

### Los dos montajes que hay que entender

```yaml
- /volume1/docker:/volume1/docker
- /proc:/host/proc:ro
```

El primero **tiene que ir con la misma ruta a ambos lados**. Los contenedores
que crea Container Manager llevan labels con rutas del NAS
(`/volume1/docker/n8n/docker-compose.yml`), y esas rutas solo resuelven dentro
del contenedor si el punto de montaje coincide exactamente. Montarlo en otro
sitio no rompe la aplicación, pero todos los proyectos pasarían a actualizarse
recreando el contenedor por API en vez de con Compose.

Va en **solo lectura** a propósito: Compose únicamente necesita leer el YAML.
Los volúmenes que declaren los servicios los resuelve el daemon del NAS y no
pasan por este montaje.

Va **sin `:ro`** para poder crear proyectos desde la web. Es la misma carpeta
donde ya viven tus stacks: los nuevos se crean ahí al lado, cada uno en su
subcarpeta, que es donde esperarías encontrarlos. Si no vas a crear proyectos
desde aquí, ponle `:ro`: Compose solo necesita **leer** el YAML, y los volúmenes
que declaren los servicios los resuelve el daemon del NAS sin pasar por este
montaje.

Que la aplicación no pise un stack tuyo no depende de este montaje sino del
código: se niega a crear sobre una carpeta que ya existe, y solo deja editar los
proyectos creados desde la web. El `:ro` es una capa de más, no la protección
principal.

Si aun así prefieres que la carpeta de tus stacks siga siendo de solo lectura y
además poder crear proyectos, monta las dos y apunta `CU_PROJECTS_DIR` a la
segunda:

```yaml
- /volume1/docker:/volume1/docker:ro
- /volume1/docker/proyectos:/volume1/docker/proyectos
```

El montaje de `/proc` es el que da las métricas reales del NAS. Sin él la
aplicación funciona, pero muestra métricas aproximadas derivadas de Docker y lo
indica en la interfaz.

Si tu volumen no es `volume1`, ajusta el montaje y `CU_COMPOSE_ROOTS`, que
acepta una lista separada por comas.

`CU_COMPOSE_ROOTS` y `DOCKER_HOST` son opcionales: sin definirlos, la aplicación
sondea los sockets habituales de Docker y de Podman y deduce las carpetas de
proyectos de lo que declaran los propios contenedores. Lo que ha detectado se ve
en **Ajustes → Entorno**, que es la primera pantalla a mirar cuando algo no
aparece. Para otros entornos (Linux, Podman, TrueNAS SCALE, Unraid), ver
[docs/PLATFORMS.es.md](docs/PLATFORMS.es.md).

## Seguridad

**El socket de Docker equivale a root en el NAS.** Quien llegue a esta
aplicación controla todos tus contenedores. Sin adornos:

- No abras su puerto en el router. Publícalo solo en la LAN.
- Si quieres acceso remoto, ponlo detrás del proxy inverso de DSM con HTTPS y un
  certificado, y activa `CU_SECURE_COOKIES=1`.
- La contraseña inicial se cambia obligatoriamente en el primer acceso.

Lo que hace la aplicación por su parte: contraseñas con Argon2id, sesiones con
cookie `httpOnly` y token opaco, límite de intentos por IP y por usuario con
espera creciente, respuesta de tiempo constante para no revelar qué usuarios
existen, credenciales de registry cifradas con AES-256-GCM, y CSP estricta.

### Si pierdes `CU_ENCRYPTION_KEY`

Las credenciales de registry guardadas son irrecuperables, por diseño. La
aplicación **arranca igual** en modo degradado: no borra nada, marca esos
registries como pendientes de credenciales, sigue comprobando los públicos y
muestra un aviso. Volver a introducirlas es una acción manual tuya; nunca se
borra nada de forma automática.

## Cómo decide actualizar

Para cada contenedor mira sus labels de Compose:

- **El YAML es accesible** → `docker compose up -d`, exactamente lo que haría
  Container Manager. Por defecto solo recrea el servicio afectado (`--no-deps`),
  porque casi nunca quieres tumbar la base de datos para actualizar el frontend.
  Antes valida el fichero con `compose config`, ya que Container Manager guarda
  las variables del proyecto en su propio almacén y puede no haber un `.env`.
- **No lo es** → recrea el contenedor por la API: descarga, renombra el viejo,
  crea el nuevo con la misma configuración, comprueba que arranca bien y solo
  entonces borra el anterior. Si el contenedor nuevo no levanta, **restaura el
  anterior automáticamente**.

Las actualizaciones se ejecutan **en segundo plano**. Al pulsar el botón la
petición vuelve al instante y el trabajo sigue por su cuenta: puedes cerrar el
diálogo, cambiar de pantalla o irte del navegador. En **Actualizaciones** se ve
el trabajo en curso con la salida del terminal en vivo, y si lanzas varios se
encolan y se ejecutan de uno en uno (dos invocaciones de Compose sobre el mismo
proyecto corromperían su estado).

Algunos contenedores se rechazan de entrada porque no se pueden reproducir con
garantías: los que comparten pila de red con otro (`network_mode: container:`),
los que usan `--link` heredado y los gestionados por Swarm o Kubernetes. La
aplicación lo dice y te remite a Container Manager en vez de intentarlo.

### Sobre "forzar"

Pediste borrar la imagen, descargarla de nuevo y refrescar. El orden literal
tiene un problema: no se puede borrar una imagen en uso, así que obliga a
destruir el contenedor antes, y deja una ventana en la que si la descarga falla
no queda imagen a la que volver.

Por eso el comportamiento por defecto de forzar es: descargar primero (lo que
refresca el digest local aunque el tag no cambie), recrear, y limpiar al final
la imagen vieja ya huérfana. El resultado que ves es el mismo y admite
restauración. El borrado literal previo sigue disponible como casilla marcable,
con el aviso de que ahí no hay red de seguridad, y solo desde la web: el bot no
lo ofrece.

### Actualizarse a sí misma

Sí puede, desde la pantalla de Imágenes. No lo hace el propio proceso, porque
moriría a mitad: lanza un **contenedor ayudante** que sobrevive al reinicio.

1. Descarga la imagen nueva mientras sigue funcionando y valida el proyecto. Si
   algo falla aquí, no se ha tocado nada.
2. Lanza el ayudante **con la imagen vieja**, la que ya se sabe que arranca.
3. El ayudante para el panel, lo recrea con la versión nueva y comprueba que
   responde. Si no responde, restaura la anterior.
4. La pantalla espera y se recarga sola cuando el panel vuelve.

**Hay unos 30 segundos sin panel.** Es inevitable: alguien tiene que sobrevivir
al reinicio y no puede ser el que se reinicia. Todo lo que hace el ayudante
queda en `/data/self-update.log`, que es lo que hay que mirar si algo sale mal.

Con Docker Compose **no hay vuelta atrás automática**: Compose borra el
contenedor anterior y volver requeriría cambiar la etiqueta del YAML, que es
tuyo. La interfaz lo avisa antes de que confirmes. Con recreación directa sí hay
restauración automática.

Desde el bot de Telegram no se ofrece: el panel se cae unos segundos y desde el
móvil no podrías ver qué ha pasado.

## Acciones sobre un servicio

En **Proyectos**, cada servicio tiene un menú con lo que normalmente harías por
SSH: recrear, reiniciar, parar, arrancar y descargar la imagen. Solo aparece
cuando el fichero del proyecto es accesible.

**Recrear** resuelve el caso típico de un servicio que se ha quedado colgado y
que arreglabas así:

```bash
cd /volume1/docker/medios
docker compose rm -f -s reproductor
docker compose up -d reproductor
```

Hace exactamente esos dos pasos, y no `up --force-recreate`, por un motivo
concreto: `--force-recreate` **también recrearía las dependencias**. Si tu
servicio va detrás de una VPN o depende de una base de datos, con esta secuencia
esas quedan intactas y solo se arrancan si estaban paradas.

Ejemplo de un proyecto donde la diferencia importa:

```yaml
# /volume1/docker/medios/docker-compose.yml
services:
  vpn:
    image: qmcgaw/gluetun:latest
    container_name: medios-vpn

  reproductor:
    image: ghcr.io/ejemplo/reproductor:latest
    container_name: medios-reproductor
    network_mode: service:vpn
    depends_on:
      - vpn
```

Recrear `reproductor` desde el panel no toca `vpn`. Un `--force-recreate` sí la
tumbaría, y con ella la conexión de todo lo que vaya por detrás.

Todas estas acciones pasan por la misma cola que las actualizaciones: se ejecutan
de una en una, quedan en el historial y puedes ver su salida en directo.

## Crear proyectos desde la web

En **Proyectos**, el botón **Nuevo proyecto** abre un editor con dos pestañas: el
`docker-compose.yml` y el `.env`. En las dos puedes escribir, pegar, subir un
fichero o arrastrarlo encima.

El nombre que le des hace dos cosas: nombra el proyecto de Compose y nombra su
carpeta. Por eso solo admite minúsculas, dígitos, guion y guion bajo.

```
/volume1/docker/reproductor/docker-compose.yml
/volume1/docker/reproductor/.env
```

Antes de dar nada por bueno se valida con el propio Compose, ya con los ficheros
en su sitio (que es lo único que permite resolver las `${VARIABLE}` contra el
`.env` de al lado). Si el fichero tiene un error se te dice cuál y no queda
ninguna carpeta a medias. Si marcas levantarlo, arranca en segundo plano y el
progreso se ve en **Actualizaciones**.

### Editar los que ya tienes

Desde el menú de los tres puntos de cada proyecto, **da igual quién lo creara**.
Se pueden editar los que hiciste en Container Manager o por SSH exactamente
igual que los creados aquí.

Lo que decide si se puede es lo que de verdad importa, no la procedencia:

- Que su fichero sea accesible desde el contenedor.
- Que sea **uno solo**. Con varios (`-f a.yml -f b.yml`) no está claro cuál
  habría que editar, y elegir uno por nuestra cuenta sería adivinar sobre tu
  configuración.
- Que su carpeta admita escritura, o sea que no esté montada con `:ro`.

Cuando no se puede, la ficha del proyecto dice cuál de las tres falla, en vez de
dejarte un botón apagado sin explicación.

Se respeta el nombre real del fichero: si tu proyecto usa `compose.yaml`, se
edita ese y no se crea un `docker-compose.yml` al lado que no leería nadie.

### Qué se hace con el `.env`

Compose tiene que leerlo en claro, y también lo necesita cualquier otro que
levante ese stack por SSH, así que **cifrarlo en disco no es una opción**: solo
esta aplicación podría arrancar el proyecto. Lo que sí se hace:

- Se escribe con permisos `0600`, legible solo por su propietario.
- En la ficha del proyecto, los valores cuya clave parece nombrar un secreto
  (`PASSWORD`, `TOKEN`, `SECRET`, `KEY`...) salen tapados, con un botón para
  mostrarlos **de uno en uno**.
- Cada guardado archiva la versión anterior **cifrada** en la base de datos, con
  el mismo sobre que las credenciales de registry, por si hay que volver atrás.
- Leer el fichero para editarlo y mostrar un valor concreto quedan los dos
  registrados en la auditoría.

## Ayuda dentro de la aplicación

El botón **Ayuda** de la barra lateral abre la documentación sin salir del panel,
con índice y buscador, en español e inglés. Cubre cómo se detectan las
actualizaciones, las acciones por servicio, los registries privados, el bot y qué
hacer cuando algo falla.

## Bot de Telegram

Créalo con [@BotFather](https://t.me/BotFather), pon el token en
`CU_TELEGRAM_BOT_TOKEN` y reinicia. En Ajustes, pulsa "Vincular una cuenta":
se genera un código de un solo uso que caduca en 10 minutos. Solo las cuentas de
esa lista pueden usar el bot; cualquier otra recibe una negativa y queda
registrada.

| Comando | Qué hace |
|---|---|
| `/imagenes` | Lista tus imágenes y su estado |
| `/estado` | CPU, memoria y resumen de contenedores |
| `/comprobar` | Busca actualizaciones ahora |
| `/actualizar <imagen>` | Actualiza esa imagen, con confirmación |
| `/forzar <imagen>` | La vuelve a descargar y recrea aunque no haya novedad |
| `/auto <imagen> on\|off` | Activa o desactiva la actualización automática |
| `/proyectos` | Proyectos y su estado |
| `/logs <contenedor> [n]` | Últimas líneas del registro |
| `/idioma es\|en` | Cambia el idioma de ese chat |

Los comandos tienen alias en inglés (`/images`, `/status`, `/check`, `/update`,
`/force`, `/projects`, `/language`).

Las notificaciones **no se repiten**: la clave de deduplicación incluye el
digest remoto, así que mientras `latest` apunte a la misma imagen no se vuelve a
avisar, pero en cuanto apunte a una nueva el aviso sale solo.

## Desarrollo

```bash
npm install
npm run dev:server   # API en :8099
npm run dev:web      # interfaz en :5173, con proxy a la API
npm test             # tests unitarios
npm run typecheck
```

Construir la imagen en local:

```bash
npm run docker:build     # solo tu arquitectura, tag container-updater:local
npm run docker:push      # amd64 + arm64 a GHCR, normalmente lo hace el workflow
```

## Publicación

La imagen se publica sola en `ghcr.io/mateof/container-updater`. **La versión del
`package.json` de la raíz es la que manda.** En cada push a `main`, el workflow:

1. Ejecuta typecheck, tests y build.
2. Lee la versión del `package.json`.
3. Si el tag `v{versión}` **no existe**, construye la imagen para `amd64` y
   `arm64`, la sube a GHCR y crea la release en GitHub.
4. Si **ya existe**, no publica nada y lo indica en el resumen de la ejecución.

No falla cuando la versión no cambia: un push que solo toca documentación no
debería pintar Actions en rojo, y acostumbrarse a ver fallos hace que se acaben
ignorando los de verdad.

Para publicar una versión nueva basta con subirla antes de mergear:

```bash
npm run version:patch    # corrección
npm run version:minor    # funcionalidad nueva
npm run version:major    # rompe configuración existente
```

Esos scripts tocan solo el `package.json` de la raíz y no crean tag; el tag lo
crea el workflow. La versión se inyecta en la imagen, así que la que muestra
Ajustes es la real.

No hace falta configurar ningún secreto: el workflow usa el `GITHUB_TOKEN` que
Actions ya proporciona. Solo asegúrate de que en **Settings → Actions → General →
Workflow permissions** esté marcado *Read and write permissions*.

Para republicar una versión ya subida (por ejemplo si una release salió mal),
lanza el workflow a mano desde la pestaña Actions marcando la casilla de forzar.

## Documentación

- [docs/ARCHITECTURE.es.md](docs/ARCHITECTURE.es.md): cómo está montado por
  dentro.
- [docs/SYNOLOGY.es.md](docs/SYNOLOGY.es.md): particularidades de DSM y problemas
  frecuentes.
- [docs/PLATFORMS.es.md](docs/PLATFORMS.es.md): compose por entorno para Linux,
  Podman, TrueNAS SCALE, Unraid y demás, y qué está comprobado de verdad.
- [docs/DECISIONS.es.md](docs/DECISIONS.es.md): por qué cada decisión técnica, y
  qué se descartó.

Cada documento está también en inglés, sin el sufijo `.es`.

## Licencia

MIT.
