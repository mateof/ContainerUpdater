# Decisiones técnicas

*[English](DECISIONS.md)*

Por qué cada elección, y qué se descartó. El repo guarda el "qué"; esto guarda
el "por qué", que es lo que no se deduce leyendo el código.

## Hallazgos que condicionaron el diseño

Verificados en vivo contra los registries reales y contra el Docker local, no
supuestos. Varios contradicen lo que dice la documentación o lo que circula por
ahí.

| Hallazgo | Consecuencia |
|---|---|
| Los `HEAD` de manifest en Docker Hub **no** descuentan cuota | El camino caliente de detección sale gratis |
| El token de Docker Hub está acotado **por repositorio** | Caché por `(host, repo, scope)`, no global |
| `lscr.io` emite el challenge con `realm="https://ghcr.io/token"` | Hay que leer el realm de la cabecera; hardcodearlo rompe linuxserver.io |
| `quay.io` público responde 200 **sin challenge** | Hace falta la rama sin autenticación |
| GHCR devuelve **403**, no 401, para repositorio privado o inexistente | Distinguir "faltan credenciales" de "no existe" |
| `nginx:alpine` tiene **dos** `RepoDigests` | La comparación es de conjuntos, no de un string |
| Podman devuelve `precpu_stats` vacío con `stream=false` | La fórmula estándar de CPU% da basura |
| Tres proyectos de Compose distintos llamados **todos** `docker` | La clave del proyecto es `(nombre, directorio)` |
| Podman asigna `RepoDigests` a imágenes construidas en local | La heurística "sin digest es local" no sirve |
| Docker Hub responde 401 igual para privado que para inexistente | Se usa su API pública, que sí distingue 404 |
| Podman 5.4 da el `blkio` de `vda` (252:0) como `major: 0, minor: 252` | Los pares que no coinciden con ningún dispositivo se prueban invertidos |
| El `system_cpu_usage` de Podman 5.4 avanza un 5 % del reloj por CPU, no el tiempo de CPU del host que da Docker | Un contenedor parado salía al 98 %: un delta de sistema por debajo de una cuarta parte de lo esperado se descarta y se usa el reloj |

## Sesión con cookie, no JWT

El motivo decisivo es el flujo de métricas: `EventSource` no admite cabeceras, así
que con JWT habría que meter el token en la query string y acabaría en los logs
del proxy de DSM. Con cookie `httpOnly` funciona sin trabajo extra, es inmune a
exfiltración por XSS y revocar es borrar una fila.

Descartado JWT en `localStorage`: exfiltrable por XSS y sin revocación real salvo
manteniendo una lista negra, que es exactamente la tabla de sesiones que se
quería evitar.

## Argon2id vía `@node-rs/argon2`

Publica binarios precompilados para `linux-arm64-musl`, `linux-arm64-gnu`,
`linux-x64-musl` y `linux-x64-gnu`. Cero compilación tanto en Alpine como en
Debian y en las dos arquitecturas que hay que cubrir.

Descartado el paquete `argon2` clásico: usa node-gyp y obligaría a llevar
toolchain en la imagen final o a compilar emulado. Descartado bcrypt: trunca en
silencio a 72 bytes y es mucho menos duro en memoria.

## Envelope encryption con `node:crypto`

Una clave maestra del entorno envuelve una clave de datos generada en el primer
arranque. Rotar la maestra es re-envolver una clave, no re-cifrar cada fila.

El AAD ata cada ciphertext a su fila y a la versión de clave: sin él, copiar el
blob de un registry a otro en la base de datos descifraría el secreto del vecino.

Descartado libsodium: otra dependencia nativa que compilar en arm64 a cambio de
nada que AES-256-GCM no cubra. Descartado `crypto.createCipher`, obsoleto y con
IV derivado. Descartado AES-CBC, sin autenticación.

**Perder la clave no impide arrancar.** La aplicación entra en modo degradado, no
borra nada y avisa. Borrar es siempre una acción manual del usuario. Un arranque
fallido por no poder descifrar una credencial sería un fallo mucho peor que la
pérdida en sí.

## SQLite con WAL

Permite leer mientras se escribe, que es el patrón real: el planificador escribe
resultados mientras la interfaz consulta el inventario. `synchronous=NORMAL` en
vez de `FULL` porque un fsync por transacción castiga el disco del NAS y lo único
que se arriesga ante un corte de corriente es la última comprobación.

**Las métricas en vivo no van a disco.** Escribir cada pocos segundos por
contenedor despierta los discos continuamente para guardar datos que casi nadie
consulta. Buffer circular en memoria, y agregado a disco solo si el usuario
activa el histórico.

## SSE y no WebSocket

Flujo unidireccional, la cookie viaja sola, el navegador reconecta solo, y
atraviesa el proxy inverso de DSM sin configurar `Upgrade`, que es una fuente
clásica de "en local va y en el NAS no".

Descartado `stats?stream=true` mantenido abierto por contenedor: treinta
contenedores serían treinta conexiones permanentes y treinta mensajes por
segundo, muchísimo más de lo que hace falta para pintar una gráfica.

## Un solo muestreador, y solo si hay alguien mirando

Diez pestañas abiertas generan el mismo trabajo que una. Y con la pestaña oculta,
la interfaz cierra la conexión, con lo que el servidor deja de muestrear del
todo. En un NAS eso es la diferencia entre una aplicación que molesta y una que
no se nota.

## uPlot y no Recharts

uPlot dibuja sobre canvas: mil puntos son mil operaciones de dibujo, no mil nodos
del DOM. Las librerías basadas en SVG generan cientos de nodos por gráfica y con
treinta contenedores el navegador de un NAS se arrastra. 45 KB frente a bastante
más.

## Lector propio de `/proc`

Descartado `systeminformation`: lee rutas de `/proc` **fijas**, es decir las del
namespace del contenedor y no las del NAS. Devolvería la memoria y la CPU del
propio contenedor haciéndolas pasar por las del sistema, que es peor que no
mostrar nada. No admite prefijo, así que no hay forma de apuntarlo a
`/host/proc`.

Un lector propio son unas decenas de líneas, no tiene dependencias y dice la
verdad.

## croner

Cero dependencias, zona horaria y protección contra solapamientos de serie.
Descartados BullMQ y Agenda: exigen Redis o MongoDB para programar cuatro tareas
en un NAS. Descartado `node-cron`: sin protección de solapamiento.

## grammY con long polling

El NAS está detrás de NAT. Un webhook obligaría a abrir un puerto y a tener
certificado válido; el long polling solo hace HTTPS saliente.

`drop_pending_updates` al arrancar es importante: tras un reinicio del NAS,
Telegram tiene encolados los mensajes de mientras estuvo apagado, y sin esto el
bot ejecutaría un `/actualizar` de hace horas nada más levantarse.

Descartado telegraf (mantenimiento irregular) y node-telegram-bot-api (API
antigua, tipos pobres).

## HTML y no MarkdownV2 en Telegram

Las referencias de imagen llevan `.`, `-`, `_` y `/`, y MarkdownV2 obliga a
escapar cada uno de esos caracteres. Es una fuente garantizada de mensajes rotos.
En HTML solo hay tres caracteres que escapar.

## Deduplicación por digest

La clave es `sha256(canal|tipo|referencia|digest|chat)`. Como incluye el digest,
mientras `latest` apunte a la misma imagen no se vuelve a avisar, pero en cuanto
apunte a una nueva el aviso sale solo. Cumple los dos requisitos con un único
mecanismo.

Se **reserva la fila antes de enviar** y se borra si el envío falla. Enviar
primero y apuntar después perdería la marca si el proceso muere en medio y
avisaría dos veces.

## Nonces en los botones del bot

Los `callback_data` llevan un identificador de vida corta guardado en servidor, no
la acción en claro. Sin esto, un botón "Actualizar ahora" que quede en el
historial del chat podría pulsarse meses después y disparar una actualización que
nadie espera. Además, Telegram limita `callback_data` a 64 bytes y una referencia
de imagen se pasa de largo.

## `--no-deps` por defecto

Pediste "reiniciar el proyecto", pero en la práctica casi nunca quieres tumbar la
base de datos del stack para actualizar el frontend. Por defecto se recrea solo
el servicio afectado; recrear el proyecto entero está disponible como opción
explícita y avisa de lo que implica.

## Auto-actualización mediante un ayudante externo

Un proceso no puede recrear su propio contenedor: al pararlo, muere a mitad y
deja el contenedor en un estado indeterminado. La solución es delegar en un
contenedor efímero que sobrevive al reinicio (verificado: un contenedor lanzado
por otro sigue vivo aunque quien lo lanzó desaparezca, porque quien los gestiona
es el daemon).

Tres decisiones dentro de esto:

**El ayudante corre con la imagen VIEJA.** Es la que ya se sabe que arranca. Si
usara la nueva y esa imagen estuviera rota, no quedaría nadie capaz de dar
marcha atrás.

**Todo lo comprobable se hace antes.** La descarga, la verificación de que la
imagen existe de verdad y la validación del YAML ocurren mientras la aplicación
sigue en pie: si algo falla ahí, se devuelve un error normal y no ha pasado
nada. El ayudante recibe las decisiones ya tomadas, porque cuanto menos tenga
que decidir, menos puede salir mal cuando ya no hay panel donde mirar.

**El log va a `/data`, no a stdout.** Mientras el ayudante trabaja no hay
interfaz, y cuando termina se autoelimina. Un fichero persistente es lo único
que queda para diagnosticar.

Lo que **no** se resuelve: con Compose no hay rollback fiable. Compose borra el
contenedor anterior y volver atrás exigiría cambiar la etiqueta del YAML, que es
del usuario. Se avisa antes de confirmar en lugar de descubrirlo al fallar. Con
recreación directa sí hay restauración automática, verificada.

Tampoco se ofrece desde Telegram: el panel se cae unos segundos y desde el móvil
no se podría ver qué ha pasado.

## `bookworm-slim` y no Alpine

`better-sqlite3` se compila desde fuente, y builder y runtime tienen que
compartir libc o el `.node` no carga. glibc da un build más predecible que musl a
cambio de unos pocos MB.

Solo la etapa que compila código nativo se emula bajo QEMU; las de Vite y
TypeScript llevan `--platform=$BUILDPLATFORM`, porque son lo caro y emularlas
multiplica el tiempo de build.

## `react-router-dom` fijado a 7.18.2

Hay una advisory abierta sobre el modo RSC, que esta aplicación no usa (router
puramente de cliente, sin acciones de servidor). `npm audit` propone bajar a
7.11.0, pero esa versión arrastra **catorce** advisories antiguas en lugar de
una. La versión actual es la opción con menos exposición real.

Revisar cuando publiquen un parche hacia delante.

## Recrear un servicio en dos pasos, no con `--force-recreate`

La acción "recrear" ejecuta:

```bash
docker compose rm -f -s <servicio>
docker compose up -d <servicio>
```

y no el aparentemente equivalente `docker compose up -d --force-recreate
<servicio>`. La diferencia no es de estilo:

- `--force-recreate` recrea **también las dependencias** del servicio.
- La secuencia en dos pasos solo destruye el servicio pedido. Sus dependencias
  se quedan como están y `up` únicamente las arranca si estaban paradas.

En un stack donde un servicio va detrás de una VPN (`network_mode:
service:vpn`) o depende de una base de datos, `--force-recreate` tumbaría esa
VPN y con ella la conectividad de todo lo que cuelgue de ella. La secuencia
larga es lo que se hace a mano por algo.

Descartado `--no-deps` como alternativa: evita recrear las dependencias, pero
tampoco las arranca si estaban caídas, que es justo lo que se quiere al levantar
un servicio a mano.

## Las acciones de servicio comparten cola con las actualizaciones

Recrear, parar o arrancar un servicio va por la misma cola que un update, y
queda en el mismo historial. Son operaciones distintas conceptualmente, pero
comparten las dos propiedades que importan: no pueden solaparse sobre el mismo
proyecto sin corromper su estado, y conviene poder mirar después qué se hizo y
con qué salida.

Mantener dos colas independientes habría permitido que un recreate y un update
se pisaran, que es el fallo que la cola existía para evitar.

## Las operaciones de proyecto también pasaron a ser trabajos encolados

Levantar un proyecto ejecutaba Compose dentro de la petición HTTP. Era el mismo
error ya corregido en las actualizaciones: un stack grande tarda más de lo que
aguantan el navegador o el proxy de DSM, y mientras tanto no había forma de ver
por dónde iba. Ahora comparten cola, historial y salida en directo con el resto.

## Detección reactiva de imágenes locales

La heurística "sin `RepoDigests` es una imagen local" falla: Podman les asigna un
digest igualmente, y entonces se consultan contra Docker Hub, donde no existen, y
el usuario ve un "requiere autenticación" que no significa nada.

Se resuelve **reaccionando al resultado** en vez de adivinando: cuando el
registry confirma que el repositorio no existe, la imagen se marca como
construida en local y queda fuera de futuras comprobaciones. Se auto-corrige y el
mensaje explica lo que pasa de verdad.

## La creación de proyectos escribe en una carpeta aparte

El montaje recomendado pone la carpeta de proyectos en solo lectura, porque hasta
entonces solo hacía falta leer el YAML. Crear proyectos necesita escritura, y lo
evidente habría sido quitar el `:ro`.

Va en un montaje **aparte** por un motivo concreto: el riesgo de escribir no es
simétrico. Leer el fichero equivocado es inocuo; sobrescribir el compose de un
stack en producción no lo es. Limitar la escritura a una subcarpeta hace que un
fallo en el camino de creación no pueda alcanzar los stacks que ya funcionan, y
el coste es una línea más en el compose.

La consecuencia es que sin ese montaje la funcionalidad simplemente no está. Eso
también es deliberado: caer en silencio a escribir donde haya permiso sería lo
peor de ambos mundos.

## El `.env` no se cifra en disco

Compose tiene que leerlo en claro, y también lo necesita cualquier cosa que
levante el stack por SSH o desde Container Manager. Cifrarlo en disco significaría
que solo esta aplicación podría arrancar el proyecto, que es cambiar una
capacidad real por la apariencia de seguridad.

Lo que sí se hace es lo que de verdad se sostiene:

- Permisos `0600`, de forma que no quede legible para el resto del sistema.
- Los valores cuya clave parece nombrar un secreto salen tapados en la interfaz,
  y mostrar uno es una petición aparte y auditada para esa única variable, no un
  volcado del fichero.
- Cada guardado archiva la versión anterior cifrada en la base de datos, con el
  mismo sobre que las credenciales de registry. La copia de seguridad de un
  secreto sigue siendo un secreto.

Se consideró y se descartó materializar el fichero solo durante la ejecución de
Compose y borrarlo después: rompería cualquier uso fuera de la aplicación, y un
stack que no puedes arrancar por SSH es una trampa para quien lo herede.

## Se puede editar cualquier proyecto, no solo los creados aquí

La primera versión solo dejaba editar lo creado desde la aplicación, con el
argumento de que sobrescribir un fichero que escribió otro destruye la confianza.
Ese argumento no se sostiene: en un NAS personal ese "otro" es el propio usuario,
y la aplicación ya podía hacerle a esos proyectos cosas bastante más
destructivas (`down`, recrear servicios) que editar un fichero de texto.

El resultado práctico era que la funcionalidad quedaba inservible justo para
quien la necesitaba: en un NAS real todos los proyectos los hizo el usuario en
Container Manager, así que el botón salía siempre desactivado.

Ahora lo que decide es lo que de verdad determina si se puede escribir:

1. El YAML es accesible desde el contenedor.
2. Hay un único fichero de compose. Con varios no está claro cuál editar, y
   elegir uno sería adivinar sobre la configuración del usuario.
3. La carpeta admite escritura.

Los tres motivos viajan hasta la interfaz, que explica cuál falla en vez de dejar
un botón apagado sin decir nada, que es exactamente lo que hacía antes.

### Consecuencia en el modelo de datos

`managed_projects.name` dejó de ser UNIQUE. Mientras solo se registraban
proyectos creados aquí, con nombre validado, la restricción valía; en cuanto
entran los de fuera, rechazaría el segundo proyecto llamado `docker`, que es un
caso real y documentado (ADR-004). La identidad pasó a ser el directorio, y la
columna `created_here` distingue lo creado aquí, que hay que seguir mostrando
aunque no tenga contenedores, de lo que solo se ha editado.

Por lo mismo, los ficheros se direccionan por **clave de proyecto** y no por
nombre. Direccionar por nombre habría vuelto a pisar ADR-004 desde otra puerta.

## La cuarentena deja pasar lo que no sabe fechar

La espera antes de auto-actualizar necesita saber cuándo se publicó una versión.
Esa fecha no siempre está, y cuando está no siempre vale: las builds
reproducibles fijan `created` del blob de configuración a una constante, casi
siempre el epoch de Unix. Tomarla por buena haría que una imagen recién
publicada pareciera tener cincuenta años y la cuarentena la dejara pasar
siempre, que es justo lo contrario de lo que se pide.

De ahí que las fechas anteriores al año 2000 se descarten, y que para Docker Hub
se prefiera el `last_updated` de su API propia, que sí es fiable.

Queda el caso de no poder averiguarla. **Se deja pasar la actualización**, y se
dice en la interfaz. La alternativa (retener indefinidamente lo que no se puede
fechar) convertiría cualquier registry que no publique etiquetas OCI en un
auto-update que no funciona y que nadie sabe por qué. Un ajuste que a veces no
protege es peor que uno que no protege nunca solo si no lo cuenta; contándolo,
es la opción honesta.

## Volver atrás marca como ignorada la versión de la que se sale

Deshacer una actualización sin más duraría hasta la siguiente comprobación: el
comprobador volvería a ver que hay versión nueva y el auto-update la aplicaría
otra vez, probablemente esa misma noche. La función sería una trampa.

Por eso, al volver atrás, el digest del que se sale queda en `ignored_digest`.
Se ignora **ese digest concreto**, no la imagen: la siguiente versión que se
publique sí entrará, que es lo que se quiere. Es el mismo mecanismo que ya usaba
el botón de "ignorar esta versión" de los avisos de Telegram.

### Y por qué hace falta reetiquetar

La vuelta atrás descarga la versión vieja por digest y le devuelve su etiqueta
original antes de recrear. Sin ese paso no funcionaría con Compose, porque el
fichero del proyecto nombra la etiqueta (`image: algo:latest`) y no el digest:
mientras la etiqueta apunte a la versión nueva, levantar el proyecto la volvería
a traer.

Ese reetiquetado obligó además a añadir `skipPull` al recreador. La primera
versión reetiquetaba y acto seguido recreaba, y el recreador hacía un `pull` de
esa misma etiqueta contra el registry: se traía otra vez la versión nueva y
deshacía la vuelta atrás. El contenedor acababa exactamente en la versión de la
que se quería salir, el trabajo terminaba en "correcto" y no había ni un error en
el log. Se encontró ejecutando una vuelta atrás de verdad; ni el typecheck ni las
pruebas de tipos podían verlo.

## La vigilancia avisa de transiciones, no de situaciones

Un contenedor caído genera **un** aviso, no uno cada cinco minutos mientras siga
caído. Eso obliga a guardar estado, que es lo que hace la tabla
`container_watch`. Deducirlo del historial de notificaciones no vale: ese
historial se purga por retención, así que el mismo contenedor dejaría de avisar
o avisaría de más según el día.

Tres decisiones dentro de esa tabla:

- **La clave es el nombre, no el id.** Al recrear un contenedor (que es lo que
  hace cualquier actualización) el id cambia entero, y con el id cada
  actualización parecería un contenedor que desaparece y otro que nace.
- **Salir con código 0 no avisa.** Es una parada limpia, casi siempre alguien
  que lo paró a propósito. Avisar de eso sería avisar al usuario de lo que él
  mismo acaba de hacer, que es la forma más rápida de que apague los avisos.
- **El updater silencia lo que va a tocar.** Durante una actualización el
  contenedor pasa por parado, borrado y recreado. Sin ese silencio, cada
  actualización correcta dispararía una alarma de caída.

## Los volúmenes no se limpian en masa

Una imagen huérfana se vuelve a descargar; los datos de un volumen no vuelven.
Por eso la pantalla de espacio en disco lista los volúmenes sin usar de uno en
uno, con su tamaño y de qué proyecto vienen, y no ofrece ningún botón de
"limpiar todos". `docker volume prune` existe para quien quiera ese riesgo, y no
hace falta que lo demos hecho.

"No lo usa nadie" tampoco significa "sobra": puede ser justamente los datos de
algo que se paró en marzo y se quiere recuperar en octubre.

### Hacen falta dos llamadas al daemon

`/system/df` calcula los tamaños pero devuelve los volúmenes **sin** sus
etiquetas; `/volumes` trae las etiquetas pero no el tamaño. Comprobado en vivo
contra Podman. Cruzarlas es obligatorio para poder decir de qué proyecto viene
cada volumen, que es el dato que permite decidir si sobra.

El cruce tiene una trampa: `/system/df` devuelve `Labels: {}`, un objeto vacío y
no nulo, así que un `??` se queda con él y las etiquetas buenas no se usan nunca.
No falla nada; el dato sale en blanco.

## La copia de seguridad no lleva secretos

Ni contraseñas de registry, ni el secreto del segundo factor, ni passkeys. Un
fichero que se descarga y acaba en la carpeta de descargas, en un correo o en un
disco compartido no es sitio para eso, y todo lo omitido se vuelve a dar de alta
en unos minutos. Lo que de verdad cuesta rehacer, y es el núcleo de la copia, son
las políticas por imagen.

Los registries sí se exportan, sin su secreto, para saber cuáles hay que volver a
configurar: una lista de lo que falta vale más que nada.

**Los chats de Telegram se exportan pero no se restauran.** Dar de alta un chat
autorizado desde un fichero se saltaría el código de vinculación de un solo uso,
que no es burocracia: es la prueba de que quien pide el acceso controla ese chat.
Si bastara con importar un JSON, cualquiera que pudiera subir una copia se
añadiría a sí mismo como administrador del bot.

## El service worker es deliberadamente cobarde

Existe para una sola cosa: que la aplicación se pueda instalar en la pantalla de
inicio del móvil y arranque sin la barra del navegador. No pretende funcionar sin
conexión, porque un panel que gestiona contenedores en vivo sin servidor no sirve
de nada.

Tres reglas que evitan los desastres clásicos:

1. **Nunca toca `/api/`.** Ahí viven las mutaciones y el flujo SSE de métricas, y
   un worker que intercepte un `EventSource` lo rompe de formas muy difíciles de
   depurar.
2. **Solo cachea los assets con hash en el nombre.** Su contenido no cambia
   nunca, así que servirlos desde caché no puede dar una versión vieja.
3. **El HTML va siempre a la red primero.** Servir un index cacheado apuntaría a
   assets que ya no existen tras un despliegue, y dejaría la aplicación rota
   hasta una recarga forzada.

Se registra con `updateViaCache: 'none'` y con la versión en la URL, porque el
servidor sirve los estáticos con `immutable` a un año y el navegador compara el
script byte a byte: con la URL fija y el contenido idéntico, no llegaría a
actualizarse nunca.

## Escrituras en disco: la fuente de verdad es `/proc/diskstats`

La vigilancia de disco sale de un diagnóstico real en un Synology cuyo RAID 1 de
dos SSD escribía unos 170 MB/min por disco. Tres hallazgos de ese diagnóstico
marcan el diseño:

- **El mayor culpable no era un contenedor.** Emby, un paquete de DSM, suponía
  unos 80 MB/min. El segundo, unos 12 MB/min, eran los healthchecks: dockerd
  reescribe `config.v2.json` y `hostconfig.json` con fsync en cada sondeo, y eso
  no se atribuye a ningún contenedor. Una vista solo por contenedor no habría
  visto a ninguno de los dos.
- **Los bytes que escribe cada proceso no sirven para ordenar culpables.**
  dockerd marcaba 48 MB/min en `/proc/<pid>/io` tanto con el disco a 170 como a
  91. En btrfs lo caro son los fsync y los metadatos (IO media de unos 16 KB, el
  tamaño del nodo de metadatos), no los bytes que entrega un proceso.
- **Por eso la alarma sale de cada disco físico**, leído de `/proc/diskstats`, y
  el reparto por contenedor es secundario, con una serie explícita de "no
  atribuido": el total del disco menos lo que explican los contenedores.

`diskstats` se lee del `/proc` del host que ya se monta para las métricas del
sistema. Es memoria del kernel: leerlo no despierta ningún disco. El formato
cambia (14 campos en el kernel 4.4 de DSM, 18 con discards, 20 con flushes) y
los sectores ahí son siempre de 512 bytes, sea cual sea el tamaño real del
sector. Los flushes se guardan si el kernel los da y quedan a null en DSM.

Particiones, `md`, `dm-*`, `cachedev_*`, `loop`, `ram` y `zram` se distinguen
con el `/sys/class/block` del propio contenedor, que muestra los dispositivos
del host en solo lectura sin montar nada más (comprobado en Podman y en DSM).
Si no se puede leer, se usa la regla de nombres del kernel (`sata3p5` y
`nvme0n1p1` llevan `p` porque el nombre del disco acaba en cifra, `sda1` no) más
`/proc/mdstat`. Por defecto se vigilan los discos físicos.

### El reparto por contenedor es aproximado, a propósito

Comprobado en el NAS: kernel 4.4.302+, cgroup v1, `blkio` organizado en slices
de systemd y sin directorio `blkio/docker`. La escritura diferida de btrfs la
hacen hilos del kernel que cuentan para el cgroup raíz, no para el contenedor
que ensució las páginas. Así que `blkio` muy probablemente se queda corto, y la
vista tiene que seguir siendo útil aunque los contenedores sumen casi nada: los
totales por disco son exactos por sí solos, "no atribuido" se pinta como una
serie más y la interfaz dice que el reparto es aproximado.

Dos trampas en el reparto:

- **Los mismos bytes aparecen en varias capas.** Una escritura a `cachedev_5`
  pasa por LVM (`dm-8`), por `md3` y por el disco. Sumar las capas la contaría
  tres veces. Si `blkio` trae una entrada del propio disco, se usa esa; si no, la
  mayor de las capas que caen en ese disco. Se queda corto con un contenedor que
  escribe en dos volúmenes distintos del mismo disco sin entrada del disco, y es
  un coste aceptado.
- **Podman da mal los dispositivos.** Para `vda` (252:0) la API compatible
  devuelve `major: 0, minor: 252`. Si un par no coincide con ningún dispositivo,
  se prueba el par invertido.

El reparto se guarda **por disco** y no como un total por contenedor: en un
RAID 1 cada miembro recibe de verdad la escritura entera, y una cifra única por
contenedor obligaría a elegir entre partirla por la mitad o duplicarla.

### Los miembros de un RAID 1 no se suman

Cada miembro escribe los mismos bytes, así que cada disco se mide y se estima con
sus propios contadores. La vida útil es por disco físico: dos SSD a 120 MB/min
cada uno se gastan a 120, no a 240.

### Un recolector en segundo plano, contra "solo si alguien mira"

Una alerta que solo funciona con una pestaña abierta no es una alerta. El
recolector es una excepción deliberada a la regla de arriba: solo corre si el
usuario activa la vigilancia de disco (o el histórico), muestrea cada 60
segundos y no cada 5, lee contadores acumulados y pide a Docker las `stats` con
`one-shot`, porque solo necesita contadores y no dos muestras. El muestreo de 5
segundos del panel en vivo sigue como estaba.

Los ritmos son deltas sobre el tiempo medido de verdad con un reloj monotónico,
nunca sobre el intervalo configurado, así que un tick que llega tarde no infla
ni desinfla nada. Un contador que baja (un contenedor reiniciado, un contador
que vuelve a cero) cuenta lo acumulado desde cero. Un contenedor creado dentro
del intervalo, que es lo que produce cada actualización, cuenta desde cero en vez
de perder su primer minuto. Un disco que desaparece se olvida, y si vuelve
empieza una línea base nueva.

### Tramos de cinco minutos, como mucho una transacción cada cinco minutos

La casilla "Guardar histórico en disco" no guardaba nada: el acumulador se
vaciaba cada cinco minutos sin un solo `INSERT`. Además su tabla usaba como
clave el id del contenedor, que cambia en cada actualización. La migración 011
la vuelve a crear con el nombre del contenedor como clave, por lo mismo que
`container_watch`, y como nunca recibió una fila, borrarla no pierde nada.

Cada tramo se escribe en una sola transacción al empezar el siguiente, más el
tramo a medias al cerrar, que se fusiona con un upsert si vuelve dentro de los
mismos cinco minutos. Escribir más a menudo desgastaría justo el SSD que se
vigila y despertaría los discos del NAS. Se guardan totales y segundos cubiertos
en vez de medias, para que la media de cualquier rango siga siendo exacta aunque
haya huecos; el máximo es la muestra más alta del tramo.

Sin histórico, las últimas 24 horas viven en memoria y la interfaz dice que los
datos salen de ahí.

### Avisos sobre una media sostenida, con margen para recuperarse

Como el vigilante: un aviso al pasar el umbral y otro al recuperarse, con el
estado en `disk_alert_state` para que un reinicio ni lo repita ni lo pierda. Se
compara la media de los últimos N minutos, no cada lectura: el NAS tiene un
ciclo de 30 segundos que un umbral por lectura convertiría en ruido. Para
recuperarse hay que bajar del 90 % del umbral, así que un ritmo que ronda el
umbral no alterna entre aviso y recuperación.

### La configuración de cada disco va en su propia tabla

El TBW, los terabytes ya escritos, el umbral propio y si se vigila viven en
`disk_devices`, no en los ajustes. La pantalla de Ajustes detecta cambios sin
guardar comparando valores primitivos, y un objeto por disco parecería siempre
modificado. Además encaja mejor entre las secciones que se aplican al momento.

"Ya escritos" lleva la fecha en que se introdujo: desde ahí, si hay histórico,
lo que se mide se suma encima. DSM no sabe leer el desgaste de todos los SSD
(en los Lexar NS100 da `remain_life: -1`), así que preguntarlo es la única
fuente fiable.
