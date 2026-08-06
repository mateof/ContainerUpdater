# Decisiones técnicas

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

## Detección reactiva de imágenes locales

La heurística "sin `RepoDigests` es una imagen local" falla: Podman les asigna un
digest igualmente, y entonces se consultan contra Docker Hub, donde no existen, y
el usuario ve un "requiere autenticación" que no significa nada.

Se resuelve **reaccionando al resultado** en vez de adivinando: cuando el
registry confirma que el repositorio no existe, la imagen se marca como
construida en local y queda fuera de futuras comprobaciones. Se auto-corrige y el
mensaje explica lo que pasa de verdad.
