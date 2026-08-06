# Synology y DSM

Particularidades del NAS que condicionan el funcionamiento, y los problemas que
más probablemente te encuentres.

## Container Manager

Desde DSM 7.2, el paquete Docker se llama Container Manager y trae Compose
integrado. Los "proyectos" son stacks de Compose normales: los contenedores
llevan las labels estándar `com.docker.compose.*`, así que no hace falta hablar
con ninguna API propietaria de Synology.

Los proyectos viven normalmente en `/volume1/docker/<nombre>`.

### El nombre de proyecto no es único

Container Manager deriva el nombre del proyecto del nombre de la carpeta. Dos
stacks en `/repos/a/docker` y `/repos/b/docker` se llaman **los dos** `docker`.
Verificado en un entorno real con tres proyectos homónimos.

Por eso la aplicación identifica cada proyecto por `(nombre, directorio)`.
Agrupar solo por nombre haría que un `compose down` cayera en el stack
equivocado, que es un desastre difícil de deshacer.

### El proyecto puede aparecer como modificado

Después de que la aplicación ejecute Compose, Container Manager puede mostrar el
proyecto como cambiado fuera de su control. Suele reconciliarse solo. Por eso el
comportamiento por defecto es recrear únicamente el servicio afectado
(`--no-deps`), que toca lo mínimo.

### Las variables del proyecto no están en un .env

Container Manager guarda el entorno del proyecto en su propio almacén, así que
puede no haber ningún `.env` junto al YAML. Si el fichero referencia
`${DB_PASSWORD}` y esa variable no está disponible, `compose up` falla a mitad y
deja el stack a medio levantar.

Por eso siempre se ejecuta `compose config --quiet` antes de tocar nada: si
faltan variables, el fallo ocurre sin haber parado ningún contenedor y recibes un
error claro.

## Montajes

### La ruta tiene que coincidir

```yaml
- /volume1/docker:/volume1/docker:ro
```

Las labels de Compose guardan rutas del NAS. Dentro del contenedor solo resuelven
si el punto de montaje es idéntico. Con `-v /volume1/docker:/proyectos`, la
aplicación buscaría `/volume1/docker/n8n/docker-compose.yml` y no lo encontraría.

No es fatal: los proyectos pasarían a actualizarse recreando el contenedor por
API, que funciona pero deja la vista de Container Manager menos sincronizada. La
interfaz indica qué método usará cada proyecto y por qué.

Si tus proyectos están en `volume2`, ajusta el montaje y `CU_COMPOSE_ROOTS`, que
acepta una lista separada por comas.

### Solo lectura

Ese montaje puede y debe ir `:ro`. Compose únicamente necesita **leer** el YAML;
los volúmenes que declaren los servicios los resuelve el daemon del NAS y no
pasan por este montaje.

## Kernels antiguos y cgroup v1

Muchos modelos de Synology llevan kernels antiguos con cgroup v1, donde:

- `online_cpus` no existe en las estadísticas; hay que usar
  `percpu_usage.length`.
- El caché de memoria se llama `total_inactive_file` en vez de `inactive_file`.

La aplicación prueba ambos, así que funciona en los dos casos sin configurar
nada.

## Hibernación de discos

Si tienes la hibernación activada, cualquier lectura del sistema de ficheros los
despierta. Por eso:

- El intervalo de comprobación por defecto es de **6 horas**, no una hora.
- El uso de disco se mide cada 5 minutos, separado del muestreo de CPU.
- Las métricas en vivo no se escriben en la base de datos salvo que actives el
  histórico a mano.

## Proxy inverso de DSM

Si publicas la aplicación a través del proxy inverso de DSM, ten en cuenta que su
nginx **bufferiza** las respuestas por defecto, lo que corta el flujo de eventos
en vivo. La aplicación envía `X-Accel-Buffering: no` para desactivarlo, más un
latido cada 15 segundos para que ningún intermediario cierre por inactividad.

Si usas HTTPS a través del proxy, activa `CU_SECURE_COOKIES=1`. En una LAN por
HTTP plano **no lo actives**: la cookie `Secure` no se enviaría y el login
parecería no hacer nada.

## Métricas del NAS que no están

Las temperaturas de disco, el estado SMART y el del RAID **no** están en `/proc`:
viven en la API de DSM (`webapi/entry.cgi`) y requieren credenciales de DSM.
Quedan fuera del alcance de esta versión. La aplicación lo indica como no
disponible en vez de mostrar un dato inventado.

## Permisos

El compose de ejemplo usa `user: "0:0"`. El socket de Docker ya concede
privilegios equivalentes a root en el NAS, así que correr como root dentro del
contenedor no empeora la situación y evita una clase entera de incidencias.

Si prefieres no hacerlo, averigua el GID del grupo del socket y usa `group_add`:

```bash
stat -c %g /var/run/docker.sock
```

```yaml
user: "1026:100"
group_add:
  - "<el GID que devuelva el comando>"
```

Ese GID varía entre modelos y versiones de DSM, y cambia tras algunas
actualizaciones, así que tenlo presente si un día la aplicación deja de ver los
contenedores.

## Actualizar la propia aplicación

ContainerUpdater **no puede actualizarse a sí misma**: el proceso moriría a mitad
de su propia actualización. Lo detecta y lo rechaza.

Para actualizarla, desde Container Manager: detén el proyecto, cambia el tag de
la imagen en el `docker-compose.yml` y vuelve a construir. Tus datos están en
`/volume1/docker/container-updater/data` y no se tocan.
