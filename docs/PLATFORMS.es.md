# Plataformas

*[English](PLATFORMS.md) · **Español***

ContainerUpdater no habla con Synology, ni con TrueNAS, ni con Unraid. Habla con la API de
Docker. Todo lo que cambia entre una plataforma y otra son tres cosas: **dónde está el socket**,
**dónde viven los proyectos de Compose** y **si `/proc` del anfitrión es accesible**. Las tres se
detectan solas desde la versión 0.6.0, así que en la mayoría de sitios basta con montar el socket
y arrancar.

Este documento explica qué se detecta, qué está comprobado de verdad y cómo es el compose de cada
entorno.

---

## Qué detecta sola la aplicación

Al arrancar hace tres cosas antes de montar nada:

1. **Busca el socket** entre los sitios habituales: `/var/run/docker.sock`, `/run/docker.sock`,
   `/run/podman/podman.sock`, `$XDG_RUNTIME_DIR/podman/podman.sock` y
   `/var/run/podman/podman.sock`. Comprueba que se pueda leer **y escribir**, no solo que el
   fichero exista, porque un socket montado sin permisos es el fallo más común al desplegar y así
   se puede decir con claridad que el problema son los permisos y no la ruta.

2. **Deduce las carpetas de proyectos** leyendo las labels `com.docker.compose.project.working_dir`
   de los contenedores que ya hay. Esto es mejor que una tabla de rutas por plataforma porque no
   adivina nada: es donde el propio Docker dice que están los stacks. De cada proyecto se queda con
   su carpeta padre, se descartan las que no sean accesibles desde dentro del contenedor y las que
   ya cuelguen de otra permitida.

3. **Identifica la plataforma** combinando esas rutas, los volúmenes montados y lo que responde el
   daemon.

Todo eso se ve en **Ajustes → Entorno**. Es la primera pantalla que hay que mirar cuando algo no
aparece: dice qué socket usa, qué carpetas acepta y cuántos proyectos puede manejar frente a
cuántos ve.

Definir `DOCKER_HOST` o `CU_COMPOSE_ROOTS` desactiva la detección correspondiente. Se sigue
pudiendo hacer, y sigue siendo lo recomendable si tu montaje es peculiar.

---

## Estado del soporte

Se distingue lo comprobado de lo deducido de la documentación de cada plataforma, y la propia
interfaz lo marca con una etiqueta. Dar por verificado lo que no se ha probado engaña justo cuando
algo falla.

| Entorno | Estado | Estrategia de actualización |
|---|---|---|
| Synology DSM 7.x (Container Manager) | Comprobado | Compose |
| Docker en Linux o macOS | Comprobado | Compose |
| Podman 4.x y 5.x | Comprobado | Compose o recreate |
| TrueNAS SCALE 24.10 o superior | Declarado, sin probar | Compose |
| Unraid 6.12+ | Declarado, sin probar | Recreate (ver más abajo) |
| OpenMediaVault 6/7 | Declarado, sin probar | Compose |
| TrueNAS CORE, FreeNAS, pfSense | **No soportado** | — |

Sobre TrueNAS CORE y FreeNAS: no es una limitación de esta aplicación. Son FreeBSD, y Docker no
existe en FreeBSD porque depende de cgroups y namespaces del kernel de Linux. Lo más parecido son
las jails, que son otro modelo. Si quieres correr esto en un TrueNAS CORE, la vía es una VM Linux
dentro del propio TrueNAS, y entonces la aplicación gestiona los contenedores **de esa VM**, no las
jails del anfitrión.

---

## Las dos estrategias de actualización

Conviene entenderlo antes de mirar los compose, porque es lo que decide si un montaje concreto
merece la pena.

**Compose.** Se usa cuando el YAML del proyecto es accesible desde dentro del contenedor. Es la
buena: respeta exactamente lo que hay escrito en el fichero, incluidas dependencias, redes y
variables.

**Recreate.** Se usa cuando no lo es. Lee la configuración del contenedor que está corriendo, la
copia sobre la imagen nueva y lo levanta, con rollback automático si no arranca. Funciona bien,
pero reproduce lo que hay **en marcha**, no lo que hay escrito en el YAML. Si alguien editó el
fichero y no ha vuelto a levantar el stack, ese cambio no se aplica.

Que se use una u otra depende de un solo detalle: **que el YAML esté montado en la misma ruta que
en el anfitrión**. Las labels contienen rutas del sistema anfitrión y solo resuelven dentro del
contenedor si el punto de montaje coincide exactamente.

---

## Docker en Linux

El caso más simple. No hace falta configurar nada más que el socket y los datos:

```yaml
services:
  container-updater:
    image: ghcr.io/mateof/container-updater:latest
    restart: unless-stopped
    ports:
      - "8099:8080"
    environment:
      TZ: Europe/Madrid
      CU_ENCRYPTION_KEY: ${CU_ENCRYPTION_KEY}
      CU_PROJECTS_DIR: /srv/stacks/propios
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
      # Donde tengas tus stacks, con la misma ruta a ambos lados.
      - /srv/stacks:/srv/stacks:ro
      # Escritura solo aqui, para poder crear proyectos desde la web.
      - /srv/stacks/propios:/srv/stacks/propios
      - /proc:/host/proc:ro
```

Si tus proyectos están repartidos (por ejemplo `/srv/stacks` y `/home/ana/proyectos`), monta los
dos con su ruta real. La detección se encarga del resto.

Sobre `user`: por defecto el contenedor corre como root, que no empeora nada porque el socket ya
concede privilegios equivalentes a root en el anfitrión. Si prefieres no hacerlo, usa `group_add`
con el GID del grupo `docker`:

```yaml
    user: "1000:1000"
    group_add:
      - "988"   # getent group docker | cut -d: -f3
```

---

## Podman

Podman implementa la API de Docker, así que funciona sin adaptaciones. Dos detalles que sí
importan:

**El socket hay que activarlo.** No está por defecto:

```bash
# Rootful, que es lo que suele querer un servidor.
sudo systemctl enable --now podman.socket

# Rootless, si prefieres que los contenedores sean de tu usuario.
systemctl --user enable --now podman.socket
```

**En rootless, el socket va por `$XDG_RUNTIME_DIR`** y el contenedor necesita verlo:

```yaml
services:
  container-updater:
    image: ghcr.io/mateof/container-updater:latest
    restart: unless-stopped
    # Sin esto, SELinux bloquea el acceso al socket en Fedora y RHEL. El sintoma
    # es un "permission denied" al arrancar aunque los permisos parezcan bien.
    security_opt:
      - label=disable
    ports:
      - "8099:8080"
    environment:
      TZ: Europe/Madrid
      CU_ENCRYPTION_KEY: ${CU_ENCRYPTION_KEY}
      # En rootless conviene ser explicito: la deteccion mira XDG_RUNTIME_DIR,
      # que dentro del contenedor no es el mismo que fuera.
      DOCKER_HOST: unix:///run/podman/podman.sock
    volumes:
      - /run/user/1000/podman/podman.sock:/run/podman/podman.sock
      - ./data:/data
      - /home/ana/proyectos:/home/ana/proyectos:ro
      - /proc:/host/proc:ro
```

Con `podman-compose` en vez del plugin de Docker, define `CU_DOCKER_BIN: podman`.

Un aviso concreto: Podman rellena `RepoDigests` también en imágenes construidas en local, cosa que
Docker no hace. La aplicación lo detecta sola en cuanto el registry confirma que ese repositorio no
existe, marca la imagen como construida localmente y deja de consultarla. La primera comprobación
puede aparecer como fallida antes de que eso ocurra; es normal y se corrige solo.

---

## Synology DSM 7.x

Cubierto en detalle en [SYNOLOGY.md](SYNOLOGY.md). El resumen: los proyectos de Container Manager
viven bajo `/volume1/docker` (o el volumen que uses) y hay que montar esa carpeta con la misma
ruta. Ver el fichero [docker-compose.example.yml](../docker-compose.example.yml) en la raíz.

---

## TrueNAS SCALE

A partir de la versión 24.10 (Electric Eel), TrueNAS SCALE sustituyó Kubernetes por Docker. Eso es
lo que hace posible el soporte: en las versiones anteriores, basadas en k3s, no hay un socket de
Docker con el que hablar.

Los stacks desplegados desde la interfaz de aplicaciones viven bajo `/mnt/.ix-apps`, que es un
dataset gestionado por el sistema. **No los toques desde aquí**: TrueNAS los reconcilia con su
propia configuración y sobrescribirá lo que hagas. Lo razonable es usar la aplicación para tus
propios stacks, en un dataset aparte:

```yaml
services:
  container-updater:
    image: ghcr.io/mateof/container-updater:latest
    restart: unless-stopped
    ports:
      - "8099:8080"
    environment:
      TZ: Europe/Madrid
      CU_ENCRYPTION_KEY: ${CU_ENCRYPTION_KEY}
      # Tus stacks, no los de la interfaz de aplicaciones. Definirlo explicito
      # evita que la deteccion incluya /mnt/.ix-apps al ver contenedores de ahi.
      CU_COMPOSE_ROOTS: /mnt/tanque/stacks
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /mnt/tanque/aplicaciones/container-updater:/data
      - /mnt/tanque/stacks:/mnt/tanque/stacks:ro
      - /proc:/host/proc:ro
```

Las aplicaciones desplegadas desde la interfaz seguirán apareciendo en la lista de contenedores e
imágenes, con sus métricas y sus avisos de versión nueva. Simplemente no se actualizan desde aquí:
para eso está el gestor de aplicaciones de TrueNAS, que es quien tiene la última palabra.

---

## Unraid

Unraid gestiona sus contenedores con plantillas XML, no con Compose. Salvo que uses el plugin de
Docker Compose de la comunidad, **no habrá labels de Compose** y por lo tanto no hay carpetas de
proyectos que deducir. La aplicación lo maneja: sin YAML accesible pasa a recreate, que es
exactamente el caso para el que existe esa estrategia.

```yaml
services:
  container-updater:
    image: ghcr.io/mateof/container-updater:latest
    restart: unless-stopped
    ports:
      - "8099:8080"
    environment:
      TZ: Europe/Madrid
      CU_ENCRYPTION_KEY: ${CU_ENCRYPTION_KEY}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /mnt/user/appdata/container-updater:/data
      - /proc:/host/proc:ro
```

Consecuencia importante: al recrear un contenedor se reproduce su configuración **en marcha**, no
la plantilla de Unraid. Si luego editas la plantilla desde la interfaz de Unraid y le das a aplicar,
manda la plantilla. Ambas cosas conviven, pero conviene saber cuál gana en cada caso.

Si usas el plugin de Compose, monta la carpeta de tus stacks igual que en Linux y pasarás a la
estrategia buena.

---

## OpenMediaVault

Con el plugin `openmediavault-compose`, los stacks viven donde lo hayas configurado, típicamente
bajo `/srv/dev-disk-by-uuid-.../compose`. Es un Debian con Docker estándar, así que sirve el
compose de Linux montando esa ruta.

---

## macOS y Windows con Docker Desktop

Funciona para desarrollo y para gestionar contenedores locales, con una limitación que no tiene
arreglo: **las métricas del sistema no serán las de tu máquina**. Docker Desktop corre los
contenedores dentro de una VM Linux, así que `/proc` es el de esa VM. La aplicación lo detecta y lo
indica en la interfaz en vez de mostrar números inventados.

```yaml
services:
  container-updater:
    image: ghcr.io/mateof/container-updater:latest
    ports:
      - "8099:8080"
    environment:
      CU_ENCRYPTION_KEY: ${CU_ENCRYPTION_KEY}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
      - /Users/ana/proyectos:/Users/ana/proyectos:ro
```

En Windows con WSL2, monta el socket como `//var/run/docker.sock:/var/run/docker.sock` y usa rutas
de WSL, no rutas `C:\`.

---

## Diagnóstico

**Ajustes → Entorno** responde a las preguntas en el orden en que suelen surgir:

| Lo que ves | Lo que significa |
|---|---|
| Socket con etiqueta "automático" | Se encontró sondeando. Si no es el que quieres, define `DOCKER_HOST`. |
| "El socket existe pero no se puede usar" | Está montado pero faltan permisos. Es un problema del montaje, no de la ruta. |
| Proyectos manejables menor que los detectados | Esos proyectos se ven pero su carpeta no está montada aquí, o no con la misma ruta. Se actualizarán por recreate. |
| Carpetas de proyectos vacío | No hay contenedores con labels de Compose, o ninguna de sus carpetas es accesible. |
| Plataforma "Sin comprobar" | El soporte está deducido de la documentación de esa plataforma, no probado en ella. Debería funcionar; si no lo hace, es un fallo que interesa conocer. |
| Métricas del sistema no disponibles | Falta `/proc:/host/proc:ro`. La aplicación funciona igual, con métricas aproximadas. |
| No se pueden crear proyectos | No hay ninguna carpeta con permiso de escritura. Monta una y apúntala con `CU_PROJECTS_DIR`. |

---

## Sobre los plugins

La pregunta natural al ver esta lista es si no convendría un sistema de extensiones, con un plugin
por plataforma. La respuesta corta es que no, y la razón es que **la abstracción que buscaría ese
sistema ya existe: es la API de Docker**.

Todas las plataformas soportadas exponen la misma API. Un plugin por plataforma no aportaría
comportamiento nuevo, solo tres constantes distintas (socket, rutas, marcadores) envueltas en una
interfaz, un cargador y un contrato que mantener. Eso es más código, más superficie de fallo y una
vía de ejecución de código arbitrario dentro de un proceso que tiene el socket de Docker, a cambio
de nada que no resuelvan ya la detección automática y dos variables de entorno.

Donde sí tendría sentido una extensión es en lo que **no** es Docker: leer temperaturas de disco y
estado del RAID en DSM, integrar el gestor de aplicaciones de TrueNAS, notificar por algo que no sea
Telegram. Eso es funcionalidad genuinamente distinta por plataforma, y es donde se miraría primero
si alguna vez hace falta.
