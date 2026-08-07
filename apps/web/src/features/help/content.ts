/**
 * Contenido de la ayuda dentro de la aplicacion.
 *
 * Va aparte del catalogo i18n general a proposito: son parrafos largos, y
 * mezclarlos con las etiquetas de botones haria ese fichero inmanejable. Aqui
 * cada seccion es una unidad que se traduce entera.
 *
 * El formato es deliberadamente pobre (parrafos, listas, bloques de codigo y
 * avisos) para poder pintarlo sin traer un renderizador de Markdown al bundle.
 */
import type { Locale } from '@cu/shared';

export type Block =
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'code'; text: string }
  | { type: 'note'; tone: 'info' | 'warn'; title: string; text: string }
  | { type: 'h'; text: string };

export interface HelpSection {
  id: string;
  title: string;
  blocks: Block[];
}

const es: HelpSection[] = [
  {
    id: 'intro',
    title: 'Que hace esta aplicacion',
    blocks: [
      {
        type: 'p',
        text: 'Vigila las imagenes de Docker que tienes desplegadas y avisa cuando sale una version nueva. Desde aqui puedes actualizarlas, recrear servicios, ver el rendimiento del NAS y manejarlo todo desde Telegram.',
      },
      {
        type: 'p',
        text: 'La idea es no tener que entrar por SSH para las tareas del dia a dia.',
      },
      { type: 'h', text: 'Las cuatro pantallas' },
      {
        type: 'ul',
        items: [
          'Panel: rendimiento del sistema y resumen de lo que hay.',
          'Contenedores: estado, metricas en vivo, registros y detalle de cada uno.',
          'Imagenes: que version tienes, si hay una nueva y como quieres vigilarla.',
          'Proyectos: tus stacks de Compose, con acciones por servicio.',
        ],
      },
    ],
  },
  {
    id: 'deteccion',
    title: 'Como detecta las actualizaciones',
    blocks: [
      {
        type: 'p',
        text: 'Compara el identificador (digest) de la imagen que tienes con el que publica el registry. Si no coinciden, hay version nueva. Es exacto: no se fia de fechas ni de numeros de version.',
      },
      { type: 'h', text: 'Dos formas de vigilar' },
      {
        type: 'ul',
        items: [
          'Por digest: detecta que una etiqueta movil como latest apunta ahora a otra imagen. Es lo adecuado para latest, stable o alpine.',
          'Por version: busca etiquetas con un numero mas alto. Es lo adecuado si has fijado algo como 1.4.2.',
        ],
      },
      {
        type: 'p',
        text: 'Las etiquetas parciales como 8.2 se vigilan de las dos formas, porque son a la vez fijas (dentro de 8.2) y moviles (puede salir 8.3), y son cosas distintas.',
      },
      {
        type: 'note',
        tone: 'info',
        title: 'Al comparar versiones no se mezclan sabores',
        text: 'Una etiqueta 20-alpine solo se compara con otras NN-alpine, nunca con 20-bookworm ni con 20 a secas: son imagenes distintas aunque el numero se parezca.',
      },
      { type: 'h', text: 'Imagenes que no se pueden comprobar' },
      {
        type: 'p',
        text: 'Si construiste una imagen en el propio NAS, no existe en ningun registry con el que compararla. La aplicacion lo detecta sola y deja de consultarla, en vez de dar un error cada vez.',
      },
    ],
  },
  {
    id: 'actualizar',
    title: 'Actualizar una imagen',
    blocks: [
      {
        type: 'p',
        text: 'Pulsa Actualizar en la imagen. El trabajo corre en segundo plano: puedes cerrar el dialogo y seguir a lo tuyo. En Actualizaciones ves el progreso y la salida del terminal en directo.',
      },
      { type: 'h', text: 'Actualizar frente a forzar' },
      {
        type: 'ul',
        items: [
          'Actualizar: solo actua si hay una version nueva.',
          'Forzar: vuelve a descargar y recrea aunque no haya novedad. Util cuando algo se ha quedado en mal estado.',
        ],
      },
      { type: 'h', text: 'Alcance' },
      {
        type: 'p',
        text: 'Por defecto solo se recrea el servicio de esa imagen. Casi nunca quieres tumbar la base de datos del stack para actualizar el frontal, asi que recrear el proyecto entero es una opcion aparte que hay que elegir a mano.',
      },
      {
        type: 'note',
        tone: 'info',
        title: 'Si algo sale mal se deshace solo',
        text: 'Cuando la aplicacion recrea un contenedor por su cuenta, si la version nueva no arranca restaura la anterior automaticamente. Con Docker Compose no puede: Compose borra el contenedor anterior y no hay a donde volver.',
      },
    ],
  },
  {
    id: 'auto',
    title: 'Actualizacion automatica',
    blocks: [
      {
        type: 'p',
        text: 'Cada imagen decide si quiere actualizarse sola, desde su menu o desde su ficha. Hay ademas un interruptor general en Ajustes que las desactiva todas de golpe.',
      },
      {
        type: 'p',
        text: 'En las que vigilas por version puedes limitar hasta donde salta sola: solo parches, hasta version menor, o sin limite.',
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'Con criterio',
        text: 'Actualizar sola una base de datos puede requerir migrar los datos. Para esos servicios conviene dejar solo el aviso y aplicarlo tu cuando puedas mirarlo.',
      },
    ],
  },
  {
    id: 'servicios',
    title: 'Acciones sobre un servicio',
    blocks: [
      {
        type: 'p',
        text: 'En Proyectos, cada servicio tiene un menu con las operaciones que normalmente harias por SSH. Solo aparece si el fichero del proyecto es accesible.',
      },
      {
        type: 'ul',
        items: [
          'Recrear: elimina el contenedor y lo crea de nuevo con la misma configuracion.',
          'Reiniciar: para y arranca, sin recrear nada.',
          'Parar y arrancar: lo que esperas.',
          'Descargar imagen: la baja sin tocar el contenedor.',
        ],
      },
      { type: 'h', text: 'Recrear equivale a esto' },
      {
        type: 'p',
        text: 'Si un servicio se queda en mal estado y lo arreglabas asi por consola:',
      },
      {
        type: 'code',
        text: 'cd /volume1/docker/medios\ndocker compose rm -f -s reproductor\ndocker compose up -d reproductor',
      },
      {
        type: 'p',
        text: 'Eso es exactamente lo que hace Recrear, con los mismos dos pasos.',
      },
      {
        type: 'note',
        tone: 'info',
        title: 'Las dependencias no se tocan',
        text: 'Se usa esa secuencia y no "up --force-recreate" precisamente por esto: --force-recreate tambien recrearia las dependencias. Si tu servicio va detras de una VPN o depende de una base de datos, esas siguen intactas y solo se arrancan si estaban paradas.',
      },
    ],
  },
  {
    id: 'proyectos',
    title: 'Proyectos y como se actualizan',
    blocks: [
      {
        type: 'p',
        text: 'Cada proyecto muestra el metodo que usara para actualizarse, y son dos:',
      },
      {
        type: 'ul',
        items: [
          'Docker Compose: el fichero del proyecto es accesible. Se actualiza igual que lo harias tu, y Container Manager lo sigue viendo bien.',
          'Recreacion directa: el fichero no es accesible. Se recrea el contenedor copiando su configuracion actual.',
        ],
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'Si todo sale como Recreacion directa',
        text: 'Es que falta el montaje de la carpeta de proyectos, o no esta con la misma ruta a ambos lados. Las etiquetas de Compose guardan rutas del NAS y solo funcionan si coinciden exactamente. Lo tienes en el fichero de ejemplo del repositorio.',
      },
    ],
  },
  {
    id: 'registries',
    title: 'Imagenes privadas',
    blocks: [
      {
        type: 'p',
        text: 'Para las imagenes que requieren autenticacion, anade las credenciales del registry en Ajustes. Se guardan cifradas.',
      },
      {
        type: 'ul',
        items: [
          'GHCR: usa un token personal de GitHub con permiso read:packages.',
          'Docker Hub: tu usuario y un token de acceso, no la contrasena de la cuenta.',
          'Registry propio: usuario y contrasena normales.',
        ],
      },
      {
        type: 'p',
        text: 'El boton Probar conexion verifica contra una imagen real de ese servidor, no solo que el servidor responda.',
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'La clave de cifrado',
        text: 'Las credenciales se cifran con CU_ENCRYPTION_KEY. Guarda una copia fuera del NAS: si la pierdes, la aplicacion sigue funcionando y avisando de los registries publicos, pero tendras que volver a introducir las privadas.',
      },
    ],
  },
  {
    id: 'telegram',
    title: 'Bot de Telegram',
    blocks: [
      {
        type: 'p',
        text: 'Crea un bot con @BotFather, pon su token en la variable CU_TELEGRAM_BOT_TOKEN y reinicia. Luego, en Ajustes, pulsa Vincular una cuenta.',
      },
      {
        type: 'p',
        text: 'Se genera un codigo de un solo uso que caduca en diez minutos. Solo las cuentas de esa lista pueden usar el bot; a cualquier otra le contesta que no tiene acceso.',
      },
      { type: 'h', text: 'Comandos' },
      {
        type: 'code',
        text: '/imagenes      lista tus imagenes y su estado\n/estado        rendimiento y resumen\n/comprobar     busca actualizaciones ahora\n/actualizar <imagen>\n/forzar <imagen>\n/auto <imagen> on|off\n/proyectos\n/logs <contenedor> [lineas]\n/idioma es|en',
      },
      {
        type: 'p',
        text: 'Los avisos no se repiten: mientras una etiqueta apunte a la misma imagen no se vuelve a notificar, pero en cuanto apunte a otra el aviso sale solo.',
      },
    ],
  },
  {
    id: 'crear',
    title: 'Crear un proyecto',
    blocks: [
      {
        type: 'p',
        text: 'Desde Proyectos, el boton Nuevo proyecto abre un editor con dos pestanas: el docker-compose.yml y el .env. En las dos puedes escribir directamente, pegar, subir un fichero o arrastrarlo encima.',
      },
      {
        type: 'p',
        text: 'El nombre que le des hace dos cosas: da nombre al proyecto de Compose y da nombre a su carpeta. Por eso solo admite minusculas, digitos, guion y guion bajo.',
      },
      { type: 'code', text: '/volume1/docker/reproductor/docker-compose.yml\n/volume1/docker/reproductor/.env' },
      {
        type: 'p',
        text: 'Al crearlo se valida con el propio Compose antes de dar nada por bueno. Si el fichero tiene un error, se te dice cual (Compose suele senalar la linea) y no queda ninguna carpeta a medias. Si marcas levantarlo, arranca en segundo plano y el progreso se ve en Actualizaciones, igual que una actualizacion.',
      },
      {
        type: 'p',
        text: 'Es la MISMA carpeta donde ya viven tus stacks. Los proyectos nuevos se crean ahi al lado, cada uno en su subcarpeta, que es donde esperarias encontrarlos.',
      },
      { type: 'h', text: 'La carpeta tiene que admitir escritura' },
      {
        type: 'p',
        text: 'Es lo unico que hay que cambiar: quitarle el :ro al montaje de la carpeta de proyectos. No hace falta CU_PROJECTS_DIR, que solo sirve si quieres que los proyectos nuevos vayan a otro sitio distinto.',
      },
      { type: 'code', text: 'volumes:\n  - /volume1/docker:/volume1/docker' },
      {
        type: 'note',
        tone: 'info',
        title: 'Un stack tuyo no se puede pisar',
        text: 'No depende del montaje sino del codigo: crear un proyecto sobre una carpeta que ya existe se rechaza, y solo se pueden editar los proyectos creados desde aqui. El :ro es una capa de mas, no la proteccion principal. Sin ninguna carpeta escribible todo lo demas funciona igual y el boton de crear sale desactivado explicando por que.',
      },
      { type: 'h', text: 'Editar los que ya tienes' },
      {
        type: 'p',
        text: 'En el menu de los tres puntos de cada proyecto tienes Editar ficheros, da igual quien lo creara. Los que hiciste en Container Manager o por SSH se editan igual que los creados aqui. Al guardar puedes volver a aplicar el proyecto para que los cambios surtan efecto, o dejarlo para luego.',
      },
      {
        type: 'p',
        text: 'Lo que decide si se puede editar no es quien lo creo, sino tres cosas:',
      },
      {
        type: 'ul',
        items: [
          'Que su fichero sea accesible desde el contenedor.',
          'Que sea uno solo. Con varios no esta claro cual habria que editar, y elegirlo por ti seria adivinar sobre tu configuracion.',
          'Que su carpeta admita escritura, o sea que no este montada con :ro.',
        ],
      },
      {
        type: 'p',
        text: 'Cuando no se puede, la ficha del proyecto dice cual de las tres falla. Se respeta ademas el nombre real del fichero: si tu proyecto usa compose.yaml, se edita ese.',
      },
      { type: 'h', text: 'Que pasa con el .env' },
      {
        type: 'ul',
        items: [
          'Se guarda con permisos 0600, o sea legible solo por su propietario.',
          'En la ficha del proyecto, los valores cuya clave parece un secreto salen tapados, con un boton para mostrarlos de uno en uno.',
          'Cada vez que se guarda, la version anterior queda cifrada en la base de datos por si hay que volver atras.',
          'Leer el fichero para editarlo y mostrar un valor concreto quedan los dos registrados en la auditoria.',
        ],
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'En disco no puede ir cifrado',
        text: 'Compose tiene que leer el .env en claro, y tambien lo necesita si algun dia levantas ese stack por SSH. Cifrarlo en disco significaria que solo esta aplicacion podria arrancar el proyecto, que es peor remedio que enfermedad.',
      },
    ],
  },
  {
    id: 'entorno',
    title: 'Donde puede funcionar',
    blocks: [
      {
        type: 'p',
        text: 'La aplicacion no habla con tu NAS, habla con Docker. Por eso funciona igual en un Synology, en un servidor Linux, con Podman o en tu portatil: lo unico que cambia entre un sitio y otro es donde esta el socket y donde viven los proyectos.',
      },
      {
        type: 'p',
        text: 'Las dos cosas se detectan solas al arrancar. El socket se busca en los sitios habituales de Docker y de Podman, y las carpetas de proyectos se deducen de lo que declaran los propios contenedores. No hace falta configurar nada salvo que tu montaje sea peculiar.',
      },
      { type: 'h', text: 'Ajustes, Entorno' },
      {
        type: 'p',
        text: 'Es la primera pantalla que mirar cuando algo no aparece. Dice que socket esta usando, que carpetas acepta y cuantos proyectos puede manejar frente a cuantos ve. Esa diferencia es exactamente lo que te falta por montar.',
      },
      {
        type: 'ul',
        items: [
          'Comprobado de verdad: Synology DSM 7, Docker en Linux, Podman.',
          'Deberia funcionar, sin probar: TrueNAS SCALE 24.10 o superior, Unraid, OpenMediaVault.',
          'Imposible: TrueNAS CORE, FreeNAS y pfSense. Son FreeBSD, y ahi Docker no existe.',
        ],
      },
      {
        type: 'note',
        tone: 'info',
        title: 'La marca de "sin comprobar" es informacion, no un aviso',
        text: 'Significa que el soporte esta deducido de la documentacion de esa plataforma y nadie lo ha probado alli. Deberia funcionar. Si no lo hace, es justo el fallo que interesa conocer.',
      },
      { type: 'h', text: 'Las dos formas de actualizar' },
      {
        type: 'p',
        text: 'Si el fichero YAML del proyecto es accesible, se usa Compose, que respeta exactamente lo que hay escrito. Si no lo es, se copia la configuracion del contenedor que esta corriendo sobre la imagen nueva, con vuelta atras automatica si no arranca.',
      },
      {
        type: 'p',
        text: 'La segunda funciona bien, pero reproduce lo que esta en marcha y no lo que pone el fichero. Si alguien lo edito y no ha vuelto a levantar el stack, ese cambio no se aplica.',
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'La ruta tiene que coincidir a los dos lados',
        text: 'Montar la carpeta de proyectos en otro sitio dentro del contenedor hace que se pierda la estrategia buena. Las rutas que guardan los contenedores son las del sistema anfitrion, y solo resuelven aqui si el punto de montaje es identico. Es decir, /srv/stacks:/srv/stacks y no /srv/stacks:/proyectos.',
      },
    ],
  },
  {
    id: 'problemas',
    title: 'Cuando algo va mal',
    blocks: [
      { type: 'h', text: 'No aparece ningun contenedor' },
      {
        type: 'p',
        text: 'Mira Ajustes, Entorno. Si el socket sale como no utilizable, esta montado pero faltan permisos: es un problema de como lo has montado, no de la ruta. Si no sale ninguno, no se ha montado.',
      },
      { type: 'h', text: 'Una actualizacion se queda atascada' },
      {
        type: 'p',
        text: 'En Actualizaciones, mira la salida en vivo. Si lleva un rato sin escribir nada, pulsa Detener y reintentalo. Puede ser simplemente una imagen grande con una conexion lenta.',
      },
      { type: 'h', text: 'No hay rangos de IP disponibles' },
      {
        type: 'p',
        text: 'Cada proyecto crea su propia red y Docker las reparte de un conjunto limitado. Ademas, al bajar un proyecto su red se queda ahi. Se limpia asi:',
      },
      { type: 'code', text: 'docker network prune -f' },
      { type: 'h', text: 'El registry pide autenticacion' },
      {
        type: 'p',
        text: 'O la imagen es privada y faltan credenciales, o el repositorio no existe. Si la construiste en el NAS, la aplicacion lo detectara sola y dejara de consultarla.',
      },
      { type: 'h', text: 'Las metricas del sistema son aproximadas' },
      {
        type: 'p',
        text: 'Falta el montaje de solo lectura de /proc. Sin el se muestran datos derivados de Docker, y la propia interfaz lo indica.',
      },
    ],
  },
];

const en: HelpSection[] = [
  {
    id: 'intro',
    title: 'What this app does',
    blocks: [
      {
        type: 'p',
        text: 'It watches the Docker images you have deployed and tells you when a new version is out. From here you can update them, recreate services, see how the NAS is doing, and drive it all from Telegram.',
      },
      { type: 'p', text: 'The point is not having to SSH in for day-to-day tasks.' },
      { type: 'h', text: 'The four screens' },
      {
        type: 'ul',
        items: [
          'Dashboard: system performance and a summary of what is there.',
          'Containers: state, live metrics, logs and per-container detail.',
          'Images: which version you have, whether a new one exists, and how you want it watched.',
          'Projects: your Compose stacks, with per-service actions.',
        ],
      },
    ],
  },
  {
    id: 'deteccion',
    title: 'How updates are detected',
    blocks: [
      {
        type: 'p',
        text: 'It compares the identifier (digest) of the image you have with the one the registry publishes. If they differ, there is a new version. That is exact: it does not rely on dates or version numbers.',
      },
      { type: 'h', text: 'Two ways to watch' },
      {
        type: 'ul',
        items: [
          'By digest: catches a moving tag like latest now pointing at a different image. Right for latest, stable or alpine.',
          'By version: looks for tags with a higher number. Right if you pinned something like 1.4.2.',
        ],
      },
      {
        type: 'p',
        text: 'Partial tags such as 8.2 are watched both ways, because they are pinned (within 8.2) and moving (8.3 may appear) at the same time, and those are different things.',
      },
      {
        type: 'note',
        tone: 'info',
        title: 'Version comparison does not mix flavours',
        text: 'A 20-alpine tag is only compared against other NN-alpine tags, never against 20-bookworm or plain 20: those are different images even though the number looks alike.',
      },
      { type: 'h', text: 'Images that cannot be checked' },
      {
        type: 'p',
        text: 'If you built an image on the NAS itself, there is nothing in any registry to compare it against. The app works that out by itself and stops querying it, rather than erroring every time.',
      },
    ],
  },
  {
    id: 'actualizar',
    title: 'Updating an image',
    blocks: [
      {
        type: 'p',
        text: 'Press Update on the image. The job runs in the background: you can close the dialog and carry on. Under Updates you see the progress and the terminal output live.',
      },
      { type: 'h', text: 'Update versus force' },
      {
        type: 'ul',
        items: [
          'Update: only acts when there is a new version.',
          'Force: pulls again and recreates even with no changes. Useful when something ended up in a bad state.',
        ],
      },
      { type: 'h', text: 'Scope' },
      {
        type: 'p',
        text: 'By default only the service using that image is recreated. You rarely want to take the stack database down to update the frontend, so recreating the whole project is a separate choice you make on purpose.',
      },
      {
        type: 'note',
        tone: 'info',
        title: 'It rolls back on its own',
        text: 'When the app recreates a container itself and the new version does not start, it restores the previous one automatically. With Docker Compose it cannot: Compose deletes the previous container and there is nothing to go back to.',
      },
    ],
  },
  {
    id: 'auto',
    title: 'Automatic updates',
    blocks: [
      {
        type: 'p',
        text: 'Each image decides whether it updates itself, from its menu or its detail sheet. There is also a master switch in Settings that turns them all off at once.',
      },
      {
        type: 'p',
        text: 'For images watched by version you can cap how far it jumps on its own: patches only, up to minor, or no limit.',
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'Use judgement',
        text: 'Auto-updating a database may require migrating data. For those services it is better to keep only the notification and apply it yourself when you can watch it.',
      },
    ],
  },
  {
    id: 'servicios',
    title: 'Per-service actions',
    blocks: [
      {
        type: 'p',
        text: 'Under Projects, each service has a menu with the operations you would normally do over SSH. It only shows up when the project file is reachable.',
      },
      {
        type: 'ul',
        items: [
          'Recreate: removes the container and creates it again with the same configuration.',
          'Restart: stops and starts, without recreating anything.',
          'Stop and start: what you would expect.',
          'Pull image: downloads it without touching the container.',
        ],
      },
      { type: 'h', text: 'Recreate is equivalent to this' },
      {
        type: 'p',
        text: 'If a service ended up in a bad state and you used to fix it from a shell like this:',
      },
      {
        type: 'code',
        text: 'cd /volume1/docker/media\ndocker compose rm -f -s player\ndocker compose up -d player',
      },
      { type: 'p', text: 'That is exactly what Recreate does, in the same two steps.' },
      {
        type: 'note',
        tone: 'info',
        title: 'Dependencies are left alone',
        text: 'That sequence is used instead of "up --force-recreate" precisely for this: --force-recreate would recreate the dependencies too. If your service sits behind a VPN or depends on a database, those stay untouched and are only started if they were down.',
      },
    ],
  },
  {
    id: 'proyectos',
    title: 'Projects and how they update',
    blocks: [
      { type: 'p', text: 'Each project shows the method it will use, and there are two:' },
      {
        type: 'ul',
        items: [
          'Docker Compose: the project file is reachable. It updates the same way you would, and Container Manager keeps seeing it correctly.',
          'Direct recreate: the file is not reachable. The container is recreated by copying its current configuration.',
        ],
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'If everything says Direct recreate',
        text: 'The projects folder mount is missing, or it is not mounted at the same path on both sides. Compose labels store NAS paths and only resolve when they match exactly. The example file in the repository has it.',
      },
    ],
  },
  {
    id: 'registries',
    title: 'Private images',
    blocks: [
      {
        type: 'p',
        text: 'For images that need authentication, add the registry credentials under Settings. They are stored encrypted.',
      },
      {
        type: 'ul',
        items: [
          'GHCR: use a GitHub personal access token with read:packages.',
          'Docker Hub: your username and an access token, not the account password.',
          'Own registry: plain username and password.',
        ],
      },
      {
        type: 'p',
        text: 'The Test connection button checks against a real image from that host, not just that the host answers.',
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'The encryption key',
        text: 'Credentials are encrypted with CU_ENCRYPTION_KEY. Keep a copy off the NAS: if you lose it the app keeps working and watching public registries, but you will have to enter the private ones again.',
      },
    ],
  },
  {
    id: 'telegram',
    title: 'Telegram bot',
    blocks: [
      {
        type: 'p',
        text: 'Create a bot with @BotFather, put its token in CU_TELEGRAM_BOT_TOKEN and restart. Then, under Settings, press Link an account.',
      },
      {
        type: 'p',
        text: 'A single-use code is generated and expires in ten minutes. Only accounts on that list can use the bot; anyone else is told they have no access.',
      },
      { type: 'h', text: 'Commands' },
      {
        type: 'code',
        text: '/images        list your images and their status\n/status        performance and summary\n/check         look for updates now\n/update <image>\n/force <image>\n/auto <image> on|off\n/projects\n/logs <container> [lines]\n/language es|en',
      },
      {
        type: 'p',
        text: 'Notifications do not repeat: while a tag points at the same image nothing is sent again, but as soon as it points at a different one the notification goes out by itself.',
      },
    ],
  },
  {
    id: 'crear',
    title: 'Creating a project',
    blocks: [
      {
        type: 'p',
        text: 'Under Projects, the New project button opens an editor with two tabs: the docker-compose.yml and the .env. In both you can type straight in, paste, upload a file or drop one on top.',
      },
      {
        type: 'p',
        text: 'The name you give it does two things: it names the Compose project and it names its folder. That is why it only accepts lowercase, digits, dash and underscore.',
      },
      { type: 'code', text: '/volume1/docker/player/docker-compose.yml\n/volume1/docker/player/.env' },
      {
        type: 'p',
        text: 'On creation it is validated with Compose itself before anything is taken as good. If the file has an error you are told which one (Compose usually points at the line) and no half-made folder is left behind. If you tick bring it up, it starts in the background and progress shows under Updates, same as an update.',
      },
      {
        type: 'p',
        text: 'It is the SAME folder your stacks already live in. New projects are created right beside them, each in its own subfolder, which is where you would expect to find them.',
      },
      { type: 'h', text: 'The folder has to be writable' },
      {
        type: 'p',
        text: 'That is the only thing to change: drop the :ro from the projects folder mount. CU_PROJECTS_DIR is not needed, and only helps if you want new projects to land somewhere else.',
      },
      { type: 'code', text: 'volumes:\n  - /volume1/docker:/volume1/docker' },
      {
        type: 'note',
        tone: 'info',
        title: 'One of your stacks cannot be overwritten',
        text: 'That does not come from the mount but from the code: creating a project over a folder that already exists is refused, and only projects created here can be edited. The :ro is one more layer, not the main protection. With no writable folder at all everything else works the same and the create button comes up disabled saying why.',
      },
      { type: 'h', text: 'Editing the ones you already have' },
      {
        type: 'p',
        text: 'The three-dot menu on each project has Edit files, regardless of who created it. The ones you made in Container Manager or over SSH edit just like the ones created here. When you save you can re-apply the project so the changes take effect, or leave it for later.',
      },
      {
        type: 'p',
        text: 'What decides whether you can edit is not who created it, but three things:',
      },
      {
        type: 'ul',
        items: [
          'That its file is reachable from inside the container.',
          'That there is only one. With several it is not clear which to edit, and picking for you would be guessing about your configuration.',
          'That its folder is writable, meaning it is not mounted with :ro.',
        ],
      },
      {
        type: 'p',
        text: 'When you cannot, the project card says which of the three is failing. The real filename is respected too: if your project uses compose.yaml, that is what gets edited.',
      },
      { type: 'h', text: 'What happens to the .env' },
      {
        type: 'ul',
        items: [
          'It is saved with 0600 permissions, meaning only its owner can read it.',
          'On the project card, values whose key looks like a secret come up covered, with a button to show them one at a time.',
          'Every time it is saved, the previous version is kept encrypted in the database in case you need to go back.',
          'Reading the file to edit it and showing a particular value both go into the audit log.',
        ],
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'It cannot be encrypted on disk',
        text: 'Compose has to read the .env in the clear, and so does anything else if you ever bring that stack up over SSH. Encrypting it on disk would mean only this app could start the project, which is a worse cure than the disease.',
      },
    ],
  },
  {
    id: 'entorno',
    title: 'Where it can run',
    blocks: [
      {
        type: 'p',
        text: 'The app does not talk to your NAS, it talks to Docker. That is why it works the same on a Synology, a Linux server, with Podman or on your laptop: the only thing that changes from one place to another is where the socket lives and where the projects are.',
      },
      {
        type: 'p',
        text: 'Both are worked out at startup. The socket is looked for in the usual Docker and Podman places, and the project folders are derived from what the containers themselves declare. Nothing needs configuring unless your setup is unusual.',
      },
      { type: 'h', text: 'Settings, Environment' },
      {
        type: 'p',
        text: 'That is the first screen to check when something is missing. It says which socket is in use, which folders are accepted, and how many projects can be handled versus how many are visible. That gap is exactly what you have left to mount.',
      },
      {
        type: 'ul',
        items: [
          'Actually verified: Synology DSM 7, Docker on Linux, Podman.',
          'Should work, untested: TrueNAS SCALE 24.10 or newer, Unraid, OpenMediaVault.',
          'Impossible: TrueNAS CORE, FreeNAS and pfSense. They are FreeBSD, and Docker does not exist there.',
        ],
      },
      {
        type: 'note',
        tone: 'info',
        title: 'The "unverified" mark is information, not a warning',
        text: 'It means support was derived from that platform documentation and nobody has tried it there. It should work. If it does not, that is exactly the kind of bug worth hearing about.',
      },
      { type: 'h', text: 'The two ways of updating' },
      {
        type: 'p',
        text: 'If the project YAML file is reachable, Compose is used, which respects exactly what is written there. If it is not, the configuration of the running container is copied onto the new image, with an automatic rollback if it fails to start.',
      },
      {
        type: 'p',
        text: 'The second one works fine, but it reproduces what is running rather than what the file says. If someone edited it and has not brought the stack back up, that change is not applied.',
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'The path has to match on both sides',
        text: 'Mounting the projects folder somewhere else inside the container loses the good strategy. The paths containers record are host paths, and they only resolve here if the mount point is identical. That is, /srv/stacks:/srv/stacks and not /srv/stacks:/projects.',
      },
    ],
  },
  {
    id: 'problemas',
    title: 'When something goes wrong',
    blocks: [
      { type: 'h', text: 'No containers show up' },
      {
        type: 'p',
        text: 'Check Settings, Environment. If the socket comes up as unusable, it is mounted but permissions are missing: that is about how you mounted it, not about the path. If none shows up at all, it was not mounted.',
      },
      { type: 'h', text: 'An update is stuck' },
      {
        type: 'p',
        text: 'Under Updates, check the live output. If nothing has been written for a while, press Stop and try again. It may simply be a large image over a slow link.',
      },
      { type: 'h', text: 'No IP address pools available' },
      {
        type: 'p',
        text: 'Each project creates its own network and Docker hands them out from a limited set. On top of that, taking a project down leaves its network behind. Clean them up with:',
      },
      { type: 'code', text: 'docker network prune -f' },
      { type: 'h', text: 'The registry asks for authentication' },
      {
        type: 'p',
        text: 'Either the image is private and credentials are missing, or the repository does not exist. If you built it on the NAS, the app will work that out and stop querying it.',
      },
      { type: 'h', text: 'System metrics are approximate' },
      {
        type: 'p',
        text: 'The read-only /proc mount is missing. Without it, figures derived from Docker are shown, and the interface says so.',
      },
    ],
  },
];

export function helpSections(locale: Locale): HelpSection[] {
  return locale === 'en' ? en : es;
}
