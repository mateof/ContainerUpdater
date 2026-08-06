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

## "No hay rangos de IP disponibles"

```
could not find an available, non-overlapping IPv4 address pool
among the defaults to assign to the network
```

Es el error más habitual en un NAS con muchos proyectos, y no tiene nada que ver
con esta aplicación: le pasa a cualquier stack que intente arrancar.

**Por qué ocurre.** Cada proyecto de Compose crea su propia red, y Docker las
reparte de unos rangos limitados: `172.17.0.0/12` troceado en `/16` (16 redes) y
`192.168.0.0/16` en `/20` (16 más). Con una docena larga de proyectos se agotan.
Además, `docker compose down` **deja la red creada**, así que se acumulan redes
huérfanas de proyectos que ya no existen.

### Solución inmediata

```bash
docker network prune -f
```

Borra las redes que no usa ningún contenedor. En la mayoría de los casos con
esto basta, porque casi todas las acumuladas son huérfanas.

Para ver cuántas hay y qué rango ocupa cada una:

```bash
docker network ls | wc -l
docker network ls --format '{{.Name}}' | while read -r n; do
  printf '%-40s %s\n' "$n" "$(docker network inspect "$n" \
    --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}')"
done
```

### Solución permanente

Ampliar los rangos que reparte Docker. En DSM, edita
`/var/packages/ContainerManager/etc/dockerd.json` (por SSH como root) y añade:

```json
{
  "default-address-pools": [
    { "base": "10.200.0.0/16", "size": 24 }
  ]
}
```

Eso da 256 redes en lugar de 32. Reinicia Container Manager después.

Elige una base que **no** choque con tu LAN ni con la VPN: si tu red doméstica
es `192.168.1.0/24`, no uses `192.168.0.0/16` como base o perderás acceso al NAS
desde algunos equipos.

### Por qué el compose de ejemplo lleva `network_mode: bridge`

ContainerUpdater no necesita una red propia: habla con Docker por el socket, que
es un fichero, y solo necesita salida a internet para consultar los registries.
Usar la red bridge que ya existe evita gastar uno de esos rangos escasos. Si
prefieres aislarla, quita esa línea y Compose le creará su red.

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

Se puede desde la pantalla de Imágenes: lanza un contenedor ayudante que la
recrea, porque el propio proceso moriría a mitad. Hay unos 30 segundos sin
panel, y el detalle de lo que ocurra queda en `/data/self-update.log`.

Si algo sale mal y el panel no vuelve:

```bash
# El log del ayudante dice exactamente en qué paso falló
cat /volume1/docker/container-updater/data/self-update.log

# ¿Quedó una copia del contenedor anterior?
docker ps -a | grep container-updater

# Si existe un container-updater__cu_old_..., arráncalo:
docker rename container-updater__cu_old_XXXX container-updater
docker start container-updater
```

También puedes actualizarla a mano desde Container Manager, que sigue siendo la
vía más segura: detén el proyecto, cambia el tag de la imagen en el
`docker-compose.yml` y reconstruye. Tus datos están en
`/volume1/docker/container-updater/data` y no se tocan en ningún caso.

**Con Compose no hay vuelta atrás automática.** Compose borra el contenedor
anterior, así que si la versión nueva no arranca hay que corregirlo desde
Container Manager. La interfaz lo avisa antes de confirmar.
