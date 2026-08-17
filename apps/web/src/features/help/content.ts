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
      { type: 'h', text: 'Imagenes que se pueden borrar' },
      {
        type: 'p',
        text: 'Cada imagen dice su relacion con los contenedores, y solo se etiqueta cuando NO esta en uso, que es lo que interesa mirar para limpiar:',
      },
      {
        type: 'ul',
        items: [
          'Sin usar: no la usa ningun contenedor. Solo ocupa disco y se puede borrar sin romper nada.',
          'Solo parados: hay contenedores que la usan pero ninguno en marcha. Borrarla los deja sin poder arrancar, asi que se nombran antes de confirmar.',
          'En uso: hay algo en marcha. No se ofrece borrarla, porque Docker se negaria igualmente.',
        ],
      },
      {
        type: 'p',
        text: 'Los filtros Sin usar y Solo con parados dejan a la vista justo lo que se puede limpiar. La opcion de borrar esta en el menu de los tres puntos de cada imagen.',
      },
      {
        type: 'note',
        tone: 'info',
        title: 'Las imagenes sin usar no se comprueban',
        text: 'Se listan para poder borrarlas, pero no se pregunta al registry si tienen version nueva: gastaria peticiones (y cuota de Docker Hub) por algo que no ejecuta nadie.',
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
    id: 'dosfactores',
    title: 'Verificacion en dos pasos',
    blocks: [
      {
        type: 'p',
        text: 'Un codigo de seis digitos que cambia cada 30 segundos, ademas de la contrasena. Se activa desde Ajustes y es opcional: sin activarlo no cambia nada.',
      },
      {
        type: 'p',
        text: 'Funciona con Google Authenticator, Microsoft Authenticator, Bitwarden, 1Password, Aegis y cualquier otra aplicacion que siga el estandar. No hace falta elegir cual: se emite lo que todas entienden igual.',
      },
      { type: 'h', text: 'Como se activa' },
      {
        type: 'ul',
        items: [
          'En Ajustes, Activar. Salen tres formas de pasarlo a tu aplicacion.',
          'Desde el movil: pulsa "Abrir en mi aplicacion". El sistema te ofrece las aplicaciones OTP que tengas instaladas y la que elijas se configura sola. Es la unica via que sirve si estas viendo el panel EN el movil, porque ahi no puedes escanear tu propia pantalla.',
          'Desde el ordenador: escanea el codigo QR con el movil.',
          'Si nada de lo anterior funciona, teclea la clave a mano.',
          'Despues escribe el codigo que te muestre la aplicacion.',
          'Hasta que no escribes un codigo valido NO se activa nada: asi nadie se queda fuera por no haber llegado a escanear.',
          'Al terminar salen diez codigos de recuperacion. Es la unica vez que se ven.',
        ],
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'Guarda los codigos de recuperacion FUERA del NAS',
        text: 'Son la via de entrada si pierdes el movil. Guardarlos en el propio NAS no sirve de nada: si el NAS falla es justo cuando los necesitas. Cada uno vale una sola vez, y en Ajustes se ve cuantos quedan.',
      },
      { type: 'h', text: 'Detalles que evitan sorpresas' },
      {
        type: 'ul',
        items: [
          'Un codigo no vale dos veces, aunque en el movil siga en pantalla.',
          'Se admite un margen de 30 segundos arriba y abajo, por si el reloj del movil va desfasado.',
          'Desactivarlo o generar codigos nuevos pide la contrasena: no basta con tener la sesion abierta.',
          'Entrar con passkey no pide ademas el codigo: un passkey ya combina el dispositivo y tu huella o PIN.',
        ],
      },
      {
        type: 'note',
        tone: 'info',
        title: 'Si pierdes la clave de cifrado',
        text: 'El secreto se guarda cifrado con CU_ENCRYPTION_KEY. Si esa clave se pierde, el segundo factor no se puede comprobar y se OMITE, entrando solo con la contrasena, en vez de dejarte fuera del panel para siempre. Queda registrado como error en el log y conviene desactivarlo y volver a activarlo.',
      },
    ],
  },
  {
    id: 'passkeys',
    title: 'Entrar con passkey',
    blocks: [
      {
        type: 'p',
        text: 'Un passkey deja entrar con la huella, la cara, el PIN del equipo o un gestor como Bitwarden, sin escribir la contrasena. Se anaden desde Ajustes.',
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'No funcionan entrando por la IP del NAS',
        text: 'No es una limitacion de esta aplicacion sino del navegador, y son dos condiciones a la vez: hace falta HTTPS (o localhost), y ademas el sitio tiene que identificarse con un NOMBRE DE DOMINIO. Una IP no vale ni siquiera con HTTPS. Por eso, entrando por http://192.168.x.x el boton no aparece.',
      },
      { type: 'h', text: 'Que hace falta' },
      {
        type: 'p',
        text: 'Llegar por un nombre de dominio servido con HTTPS. En un Synology, eso es el proxy inverso de DSM con un certificado. Si tu proxy no reenvia las cabeceras X-Forwarded, define ademas estas dos variables:',
      },
      { type: 'code', text: 'CU_RP_ID: nas.ejemplo.com\nCU_RP_ORIGIN: https://nas.ejemplo.com' },
      { type: 'h', text: 'Con Bitwarden' },
      {
        type: 'p',
        text: 'Funciona sin nada especial: no se pide attestation, se aceptan ES256 y RS256, y no se restringe el tipo de autenticador. Tampoco se exige PIN ni credencial descubrible obligatoria, que es lo que suele dejar fuera a los gestores.',
      },
      {
        type: 'p',
        text: 'Bitwarden devuelve siempre el contador de firmas a cero. Eso normalmente delataria una llave clonada, asi que solo se rechaza cuando el contador venia siendo mayor que cero y deja de avanzar.',
      },
      {
        type: 'note',
        tone: 'info',
        title: 'La contrasena no se quita nunca',
        text: 'Los passkeys se anaden, no sustituyen. Si pierdes el autenticador, o entras por la IP del NAS donde no estan disponibles, la contrasena es la via que siempre esta. Quedarse fuera del panel que gestiona todos tus contenedores seria bastante peor que teclearla.',
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
      { type: 'h', text: 'Images you can delete' },
      {
        type: 'p',
        text: 'Each image says how it relates to the containers, and it is only labelled when it is NOT in use, which is what matters when cleaning up:',
      },
      {
        type: 'ul',
        items: [
          'Unused: no container uses it. It only takes up disk and can be deleted without breaking anything.',
          'Stopped only: containers use it but none is running. Deleting it leaves them unable to start, so they are named before you confirm.',
          'In use: something is running. Deleting is not offered, because Docker would refuse anyway.',
        ],
      },
      {
        type: 'p',
        text: 'The Unused and Stopped only filters leave exactly what can be cleaned up in view. The delete option is in the three-dot menu of each image.',
      },
      {
        type: 'note',
        tone: 'info',
        title: 'Unused images are not checked',
        text: 'They are listed so you can delete them, but the registry is not asked whether they have a new version: that would spend requests (and Docker Hub quota) on something nobody runs.',
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
    id: 'dosfactores',
    title: 'Two-step verification',
    blocks: [
      {
        type: 'p',
        text: 'A six-digit code that changes every 30 seconds, on top of the password. You turn it on under Settings and it is optional: leave it off and nothing changes.',
      },
      {
        type: 'p',
        text: 'It works with Google Authenticator, Microsoft Authenticator, Bitwarden, 1Password, Aegis and any other app that follows the standard. No need to pick one: what is issued is what they all read the same way.',
      },
      { type: 'h', text: 'Turning it on' },
      {
        type: 'ul',
        items: [
          'Under Settings, Turn on. Three ways to get it into your app appear.',
          'From a phone: tap "Open in my app". The system offers whichever OTP apps you have installed and the one you pick sets itself up. This is the only route that works when you are viewing the panel ON the phone, since you cannot scan your own screen.',
          'From a computer: scan the QR code with your phone.',
          'If neither works, type the key by hand.',
          'Then enter the code your app shows.',
          'Nothing is turned on until you enter a valid code, so nobody gets locked out for not having scanned.',
          'You then get ten recovery codes. That is the only time they are shown.',
        ],
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'Keep the recovery codes OFF the NAS',
        text: 'They are your way in if you lose your phone. Keeping them on the NAS itself is useless: if the NAS is down is exactly when you need them. Each works once, and Settings shows how many are left.',
      },
      { type: 'h', text: 'Details that avoid surprises' },
      {
        type: 'ul',
        items: [
          'A code cannot be used twice, even if your phone still shows it.',
          'A 30-second margin either side is allowed, in case your phone clock drifts.',
          'Turning it off or generating new codes asks for your password: having the session open is not enough.',
          'Signing in with a passkey does not also ask for the code: a passkey already combines the device with your fingerprint or PIN.',
        ],
      },
      {
        type: 'note',
        tone: 'info',
        title: 'If you lose the encryption key',
        text: 'The secret is stored encrypted with CU_ENCRYPTION_KEY. If that key is lost, the second factor cannot be checked and is SKIPPED, letting you in with the password alone, rather than locking you out of the panel forever. It is logged as an error and you should turn it off and on again.',
      },
    ],
  },
  {
    id: 'passkeys',
    title: 'Signing in with a passkey',
    blocks: [
      {
        type: 'p',
        text: 'A passkey lets you sign in with your fingerprint, face, device PIN or a manager such as Bitwarden, without typing the password. You add them under Settings.',
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'They do not work when you come in through the NAS IP',
        text: 'This is not a limitation of the app but of the browser, and it is two conditions at once: HTTPS is required (or localhost), and the site must identify itself with a DOMAIN NAME. An IP does not qualify even over HTTPS. That is why the button does not appear on http://192.168.x.x.',
      },
      { type: 'h', text: 'What you need' },
      {
        type: 'p',
        text: 'To arrive through a domain name served over HTTPS. On a Synology that means the DSM reverse proxy with a certificate. If your proxy does not forward the X-Forwarded headers, also set these two variables:',
      },
      { type: 'code', text: 'CU_RP_ID: nas.example.com\nCU_RP_ORIGIN: https://nas.example.com' },
      { type: 'h', text: 'With Bitwarden' },
      {
        type: 'p',
        text: 'It works with nothing special: no attestation is requested, ES256 and RS256 are both accepted, and the authenticator type is not restricted. Neither a PIN nor a mandatory discoverable credential is required, which is what usually shuts managers out.',
      },
      {
        type: 'p',
        text: 'Bitwarden always reports a signature counter of zero. That would normally suggest a cloned key, so a key is only rejected when its counter had been above zero and stops advancing.',
      },
      {
        type: 'note',
        tone: 'info',
        title: 'The password is never removed',
        text: 'Passkeys are added, not a replacement. If you lose the authenticator, or come in through the NAS IP where they are unavailable, the password is the way that is always there. Being locked out of the panel that manages all your containers would be considerably worse than typing it.',
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

const gl: HelpSection[] = [
  {
    id: 'intro',
    title: 'Que fai esta aplicacion',
    blocks: [
      {
        type: 'p',
        text: 'Vixia as imaxes de Docker que tes despregadas e avisa cando sae unha version nova. Desde aqui podes actualizalas, recrear servizos, ver o rendemento do NAS e manexalo todo desde Telegram.',
      },
      { type: 'p', text: 'A idea e non ter que entrar por SSH para as tarefas do dia a dia.' },
      { type: 'h', text: 'As catro pantallas' },
      {
        type: 'ul',
        items: [
          'Panel: rendemento do sistema e resumo do que hai.',
          'Contedores: estado, metricas en vivo, rexistros e detalle de cada un.',
          'Imaxes: que version tes, se hai unha nova e como queres vixiala.',
          'Proxectos: os teus stacks de Compose, con accions por servizo.',
        ],
      },
    ],
  },
  {
    id: 'deteccion',
    title: 'Como detecta as actualizacions',
    blocks: [
      {
        type: 'p',
        text: 'Compara o identificador (digest) da imaxe que tes co que publica o registry. Se non coinciden, hai version nova. E exacto: non se fia de datas nin de numeros de version.',
      },
      { type: 'h', text: 'Duas formas de vixiar' },
      {
        type: 'ul',
        items: [
          'Por digest: detecta que unha etiqueta movil como latest apunta agora a outra imaxe. E o adecuado para latest, stable ou alpine.',
          'Por version: busca etiquetas cun numero mais alto. E o adecuado se fixaches algo como 1.4.2.',
        ],
      },
      {
        type: 'p',
        text: 'As etiquetas parciais como 8.2 vixianse das duas formas, porque son a un tempo fixas (dentro de 8.2) e movibles (pode sair 8.3), e son cousas distintas.',
      },
      {
        type: 'note',
        tone: 'info',
        title: 'Ao comparar versions non se mesturan sabores',
        text: 'Unha etiqueta 20-alpine so se compara con outras NN-alpine, nunca con 20-bookworm nin con 20 a secas: son imaxes distintas ainda que o numero se pareza.',
      },
      { type: 'h', text: 'Imaxes que se poden borrar' },
      {
        type: 'p',
        text: 'Cada imaxe di a sua relacion cos contedores, e so se etiqueta cando NON esta en uso, que e o que interesa mirar para limpar:',
      },
      {
        type: 'ul',
        items: [
          'Sen usar: non a usa ningun contedor. So ocupa disco e pode borrarse sen romper nada.',
          'So parados: hai contedores que a usan pero ningun en marcha. Borrala deixaos sen poder arrincar, asi que se nomean antes de confirmar.',
          'En uso: hai algo en marcha. Non se ofrece borrala, porque Docker negariase igualmente.',
        ],
      },
      {
        type: 'p',
        text: 'Os filtros Sen usar e So con parados deixan a vista xustamente o que se pode limpar. A opcion de borrar esta no menu dos tres puntos de cada imaxe.',
      },
      {
        type: 'note',
        tone: 'info',
        title: 'As imaxes sen usar non se comproban',
        text: 'Listanse para poder borralas, pero non se pregunta ao registry se tenen version nova: gastaria peticions (e cota de Docker Hub) por algo que non executa ninguen.',
      },
      { type: 'h', text: 'Imaxes que non se poden comprobar' },
      {
        type: 'p',
        text: 'Se construiches unha imaxe no propio NAS, non existe en ningun registry co que comparala. A aplicacion detectao soa e deixa de consultala, en vez de dar un erro cada vez.',
      },
    ],
  },
  {
    id: 'actualizar',
    title: 'Actualizar unha imaxe',
    blocks: [
      {
        type: 'p',
        text: 'Preme Actualizar na imaxe. O traballo corre en segundo plano: podes pechar o dialogo e seguir ao teu. En Actualizacions ves o progreso e a saida do terminal en directo.',
      },
      { type: 'h', text: 'Actualizar fronte a forzar' },
      {
        type: 'ul',
        items: [
          'Actualizar: so actua se hai unha version nova.',
          'Forzar: volve descargar e recrea ainda que non haxa novidade. Util cando algo quedou en mal estado.',
        ],
      },
      { type: 'h', text: 'Alcance' },
      {
        type: 'p',
        text: 'Por defecto so se recrea o servizo desa imaxe. Case nunca queres tumbar a base de datos do stack para actualizar o frontal, asi que recrear o proxecto enteiro e unha opcion aparte que hai que escoller a man.',
      },
      {
        type: 'note',
        tone: 'info',
        title: 'Se algo sae mal desfaise so',
        text: 'Cando a aplicacion recrea un contedor pola sua conta, se a version nova non arrinca restaura a anterior automaticamente. Con Docker Compose non pode: Compose borra o contedor anterior e non hai a onde volver.',
      },
    ],
  },
  {
    id: 'auto',
    title: 'Actualizacion automatica',
    blocks: [
      {
        type: 'p',
        text: 'Cada imaxe decide se quere actualizarse soa, desde o seu menu ou desde a sua ficha. Hai ademais un interruptor xeral en Axustes que as desactiva todas de golpe.',
      },
      {
        type: 'p',
        text: 'Nas que vixias por version podes limitar ata onde salta soa: so parches, ata version menor, ou sen limite.',
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'Con criterio',
        text: 'Actualizar soa unha base de datos pode requirir migrar os datos. Para eses servizos convén deixar so o aviso e aplicalo ti cando poidas miralo.',
      },
    ],
  },
  {
    id: 'servicios',
    title: 'Accions sobre un servizo',
    blocks: [
      {
        type: 'p',
        text: 'En Proxectos, cada servizo ten un menu coas operacions que normalmente farias por SSH. So aparece se o ficheiro do proxecto e accesible.',
      },
      {
        type: 'ul',
        items: [
          'Recrear: elimina o contedor e creao de novo coa mesma configuracion.',
          'Reiniciar: para e arrinca, sen recrear nada.',
          'Parar e arrincar: o que esperas.',
          'Descargar imaxe: baixaa sen tocar o contedor.',
        ],
      },
      { type: 'h', text: 'Recrear equivale a isto' },
      { type: 'p', text: 'Se un servizo queda en mal estado e o arranxabas asi por consola:' },
      {
        type: 'code',
        text: 'cd /volume1/docker/medios\ndocker compose rm -f -s reprodutor\ndocker compose up -d reprodutor',
      },
      { type: 'p', text: 'Iso e exactamente o que fai Recrear, cos mesmos dous pasos.' },
      {
        type: 'note',
        tone: 'info',
        title: 'As dependencias non se tocan',
        text: 'Usase esa secuencia e non "up --force-recreate" precisamente por isto: --force-recreate tamen recrearia as dependencias. Se o teu servizo vai detras dunha VPN ou depende dunha base de datos, esas seguen intactas e so se arrincan se estaban paradas.',
      },
    ],
  },
  {
    id: 'proyectos',
    title: 'Proxectos e como se actualizan',
    blocks: [
      { type: 'p', text: 'Cada proxecto amosa o metodo que usara para actualizarse, e son dous:' },
      {
        type: 'ul',
        items: [
          'Docker Compose: o ficheiro do proxecto e accesible. Actualizase igual que o farias ti, e Container Manager segue vendoo ben.',
          'Recreacion directa: o ficheiro non e accesible. Recrease o contedor copiando a sua configuracion actual.',
        ],
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'Se todo sae como Recreacion directa',
        text: 'Enton o montaxe do cartafol non esta ben. Ten que ir coa mesma ruta a ambos lados, por exemplo /volume1/docker:/volume1/docker, porque as etiquetas dos contedores gardan rutas do sistema anfitrion.',
      },
    ],
  },
  {
    id: 'registries',
    title: 'Imaxes privadas',
    blocks: [
      {
        type: 'p',
        text: 'Para as imaxes que precisan autenticacion, engade as credenciais en Axustes, apartado Registries.',
      },
      {
        type: 'ul',
        items: [
          'GHCR (ghcr.io): un token persoal de GitHub con permiso read:packages.',
          'Docker Hub: o teu usuario e un token de acceso, non o contrasinal da conta.',
          'Un registry propio: usuario e contrasinal normais.',
        ],
      },
      {
        type: 'p',
        text: 'As credenciais gardanse cifradas e nunca se amosan de volta. Podes probar a conexion antes de gardar.',
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'A clave de cifrado',
        text: 'Gardanse cifradas con CU_ENCRYPTION_KEY. Se perdes esa clave, non se poden recuperar: a aplicacion segue funcionando e avisa, pero hai que volver introducilas. Garda unha copia fora do NAS.',
      },
    ],
  },
  {
    id: 'telegram',
    title: 'Bot de Telegram',
    blocks: [
      {
        type: 'p',
        text: 'Avisa cando sae unha version nova e permite actualizar desde o movil. So poden usalo as contas que autorices desde Axustes.',
      },
      {
        type: 'p',
        text: 'Para vincular unha conta, xerase un codigo dun so uso que caduca en 10 minutos.',
      },
      { type: 'h', text: 'Comandos' },
      {
        type: 'code',
        text: '/imagenes        lista as tuas imaxes\n/estado          rendemento e resumo\n/comprobar       busca actualizacions agora\n/actualizar X    actualiza esa imaxe\n/forzar X        volvea descargar e recrea\n/auto X on|off   actualizacion automatica\n/proyectos       proxectos e o seu estado\n/logs X [n]      ultimas linas do rexistro',
      },
      {
        type: 'p',
        text: 'Os avisos non se repiten: mentres unha etiqueta apunte a mesma imaxe non se volve notificar, pero en canto apunte a outra o aviso sae so.',
      },
    ],
  },
  {
    id: 'crear',
    title: 'Crear un proxecto',
    blocks: [
      {
        type: 'p',
        text: 'Desde Proxectos, o boton Novo proxecto abre un editor con duas lapelas: o docker-compose.yml e o .env. Nas duas podes escribir directamente, pegar, subir un ficheiro ou arrastralo enriba.',
      },
      {
        type: 'p',
        text: 'O nome que lle deas fai duas cousas: da nome ao proxecto de Compose e da nome ao seu cartafol. Por iso so admite minusculas, dixitos, guion e guion baixo.',
      },
      { type: 'code', text: '/volume1/docker/reprodutor/docker-compose.yml\n/volume1/docker/reprodutor/.env' },
      {
        type: 'p',
        text: 'Ao crealo validase co propio Compose antes de dar nada por bo. Se o ficheiro ten un erro, dicheseche cal (Compose adoita senalar a lina) e non queda ningun cartafol a medias. Se marcas levantalo, arrinca en segundo plano e o progreso vese en Actualizacions, igual que unha actualizacion.',
      },
      {
        type: 'p',
        text: 'E o MESMO cartafol onde xa viven os teus stacks. Os proxectos novos crease ali ao lado, cada un no seu subcartafol, que e onde esperarias encontralos.',
      },
      { type: 'h', text: 'O cartafol ten que admitir escritura' },
      {
        type: 'p',
        text: 'E o unico que hai que cambiar: quitarlle o :ro ao montaxe do cartafol de proxectos. Non fai falta CU_PROJECTS_DIR, que so serve se queres que os proxectos novos vaian a outro sitio distinto.',
      },
      { type: 'code', text: 'volumes:\n  - /volume1/docker:/volume1/docker' },
      {
        type: 'note',
        tone: 'info',
        title: 'Un stack teu non se pode pisar',
        text: 'Non depende do montaxe senon do codigo: crear un proxecto sobre un cartafol que xa existe rexeitase, e so se poden editar os proxectos creados desde aqui. O :ro e unha capa mais, non a proteccion principal. Sen ningun cartafol escribible todo o demais funciona igual e o boton de crear sae desactivado explicando por que.',
      },
      { type: 'h', text: 'Editar os que xa tes' },
      {
        type: 'p',
        text: 'No menu dos tres puntos de cada proxecto tes Editar ficheiros, da igual quen o creara. Os que fixeches en Container Manager ou por SSH editanse igual que os creados aqui. Ao gardar podes volver aplicar o proxecto para que os cambios xurdan efecto, ou deixalo para logo.',
      },
      { type: 'p', text: 'O que decide se se pode editar non e quen o creou, senon tres cousas:' },
      {
        type: 'ul',
        items: [
          'Que o seu ficheiro sexa accesible desde o contedor.',
          'Que sexa un so. Con varios non esta claro cal habria que editar, e escollelo por ti seria adivinar sobre a tua configuracion.',
          'Que o seu cartafol admita escritura, ou sexa que non estea montado con :ro.',
        ],
      },
      {
        type: 'p',
        text: 'Cando non se pode, a ficha do proxecto di cal das tres falla. Respectase ademais o nome real do ficheiro: se o teu proxecto usa compose.yaml, editase ese.',
      },
      { type: 'h', text: 'Que pasa co .env' },
      {
        type: 'ul',
        items: [
          'Gardase con permisos 0600, ou sexa lexible so polo seu propietario.',
          'Na ficha do proxecto, os valores cuxa clave parece un segredo saen tapados, cun boton para amosalos dun en un.',
          'Cada vez que se garda, a version anterior queda cifrada na base de datos por se hai que volver atras.',
          'Ler o ficheiro para editalo e amosar un valor concreto quedan os dous rexistrados na auditoria.',
        ],
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'En disco non pode ir cifrado',
        text: 'Compose ten que ler o .env en claro, e tamen o precisa se algun dia levantas ese stack por SSH. Cifralo en disco significaria que so esta aplicacion poderia arrincar o proxecto, que e peor remedio que enfermidade.',
      },
    ],
  },
  {
    id: 'dosfactores',
    title: 'Verificacion en dous pasos',
    blocks: [
      {
        type: 'p',
        text: 'Un codigo de seis dixitos que cambia cada 30 segundos, ademais do contrasinal. Activase desde Axustes e e opcional: sen activalo non cambia nada.',
      },
      {
        type: 'p',
        text: 'Funciona con Google Authenticator, Microsoft Authenticator, Bitwarden, 1Password, Aegis e calquera outra aplicacion que siga o estandar. Non fai falta escoller cal: emitese o que todas entenden igual.',
      },
      { type: 'h', text: 'Como se activa' },
      {
        type: 'ul',
        items: [
          'En Axustes, Activar. Saen tres formas de pasalo a tua aplicacion.',
          'Desde o movil: preme "Abrir na mina aplicacion". O sistema ofrececheche as aplicacions OTP que tenas instaladas e a que escollas configurase soa. E a unica via que serve se estas vendo o panel NO movil, porque ali non podes escanear a tua propia pantalla.',
          'Desde o ordenador: escanea o codigo QR co movil.',
          'Se nada do anterior funciona, teclea a clave a man.',
          'Despois escribe o codigo que che amose a aplicacion.',
          'Ata que non escribes un codigo valido NON se activa nada: asi ninguen queda fora por non ter chegado a escanear.',
          'Ao rematar saen dez codigos de recuperacion. E a unica vez que se ven.',
        ],
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'Garda os codigos de recuperacion FORA do NAS',
        text: 'Son a via de entrada se perdes o movil. Gardalos no propio NAS non serve de nada: se o NAS falla e xustamente cando os precisas. Cada un vale unha soa vez, e en Axustes vese cantos quedan.',
      },
      { type: 'h', text: 'Detalles que evitan sorpresas' },
      {
        type: 'ul',
        items: [
          'Un codigo non vale dúas veces, ainda que no movil siga en pantalla.',
          'Admitese unha marxe de 30 segundos arriba e abaixo, por se o reloxo do movil vai desfasado.',
          'Desactivalo ou xerar codigos novos pide o contrasinal: non abonda con ter a sesion aberta.',
          'Entrar con passkey non pide ademais o codigo: unha passkey xa combina o dispositivo e a tua pegada ou PIN.',
        ],
      },
      {
        type: 'note',
        tone: 'info',
        title: 'Se perdes a clave de cifrado',
        text: 'O segredo gardase cifrado con CU_ENCRYPTION_KEY. Se esa clave se perde, o segundo factor non se pode comprobar e OMITESE, entrando so co contrasinal, en vez de deixarte fora do panel para sempre. Queda rexistrado como erro no log e convén desactivalo e volver activalo.',
      },
    ],
  },
  {
    id: 'passkeys',
    title: 'Entrar con passkey',
    blocks: [
      {
        type: 'p',
        text: 'Unha passkey deixa entrar coa pegada, a cara, o PIN do equipo ou un xestor como Bitwarden, sen escribir o contrasinal. Engadense desde Axustes.',
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'Non funcionan entrando pola IP do NAS',
        text: 'Non e unha limitacion desta aplicacion senon do navegador, e son duas condicions a un tempo: fai falta HTTPS (ou localhost), e ademais o sitio ten que identificarse cun NOME DE DOMINIO. Unha IP non vale nin sequera con HTTPS. Por iso, entrando por http://192.168.x.x o boton non aparece.',
      },
      { type: 'h', text: 'Que fai falta' },
      {
        type: 'p',
        text: 'Chegar por un nome de dominio servido con HTTPS. Nun Synology, iso e o proxy inverso de DSM cun certificado. Se o teu proxy non reenvia as cabeceiras X-Forwarded, define ademais estas duas variables:',
      },
      { type: 'code', text: 'CU_RP_ID: nas.exemplo.com\nCU_RP_ORIGIN: https://nas.exemplo.com' },
      { type: 'h', text: 'Con Bitwarden' },
      {
        type: 'p',
        text: 'Funciona sen nada especial: non se pide attestation, aceptanse ES256 e RS256, e non se restrinxe o tipo de autenticador. Tampouco se esixe PIN nin credencial descubrible obrigatoria, que e o que adoita deixar fora aos xestores.',
      },
      {
        type: 'p',
        text: 'Bitwarden devolve sempre o contador de sinaturas a cero. Iso normalmente delataria unha chave clonada, asi que so se rexeita cando o contador vina sendo maior que cero e deixa de avanzar.',
      },
      {
        type: 'note',
        tone: 'info',
        title: 'O contrasinal non se quita nunca',
        text: 'As passkeys engadense, non substituen. Se perdes o autenticador, ou entras pola IP do NAS onde non estan dispoñibles, o contrasinal e a via que sempre esta. Quedar fora do panel que xestiona todos os teus contedores seria bastante peor que teclealo.',
      },
    ],
  },
  {
    id: 'entorno',
    title: 'Onde pode funcionar',
    blocks: [
      {
        type: 'p',
        text: 'A aplicacion non fala co teu NAS, fala con Docker. Por iso funciona igual nun Synology, nun servidor Linux, con Podman ou no teu portatil: o unico que cambia dun sitio a outro e onde esta o socket e onde viven os proxectos.',
      },
      {
        type: 'p',
        text: 'As duas cousas detectanse soas ao arrincar. O socket buscase nos sitios habituais de Docker e de Podman, e os cartafoles de proxectos deducense do que declaran os propios contedores. Non fai falta configurar nada agas que o teu montaxe sexa peculiar.',
      },
      { type: 'h', text: 'Axustes, Contorno' },
      {
        type: 'p',
        text: 'E a primeira pantalla que mirar cando algo non aparece. Di que socket esta usando, que cartafoles acepta e cantos proxectos pode manexar fronte a cantos ve. Esa diferenza e exactamente o que che falta por montar.',
      },
      {
        type: 'ul',
        items: [
          'Comprobado de verdade: Synology DSM 7, Docker en Linux, Podman (tamen en macOS).',
          'Deberia funcionar, sen probar: TrueNAS SCALE 24.10 ou superior, Unraid, OpenMediaVault.',
          'Imposible: TrueNAS CORE, FreeNAS e pfSense. Son FreeBSD, e ali Docker non existe.',
        ],
      },
      {
        type: 'note',
        tone: 'info',
        title: 'A marca de "sen comprobar" e informacion, non un aviso',
        text: 'Significa que o soporte esta deducido da documentacion desa plataforma e ninguen o probou ali. Deberia funcionar. Se non o fai, e xustamente o fallo que interesa conecer.',
      },
      { type: 'h', text: 'As duas formas de actualizar' },
      {
        type: 'p',
        text: 'Se o ficheiro YAML do proxecto e accesible, usase Compose, que respecta exactamente o que hai escrito. Se non o e, copiase a configuracion do contedor que esta correndo sobre a imaxe nova, con volta atras automatica se non arrinca.',
      },
      {
        type: 'p',
        text: 'A segunda funciona ben, pero reproduce o que esta en marcha e non o que pon o ficheiro. Se alguen o editou e non volveu levantar o stack, ese cambio non se aplica.',
      },
      {
        type: 'note',
        tone: 'warn',
        title: 'A ruta ten que coincidir aos dous lados',
        text: 'Montar o cartafol de proxectos noutro sitio dentro do contedor fai que se perda a estratexia boa. As rutas que gardan os contedores son as do sistema anfitrion, e so resolven aqui se o punto de montaxe e identico. E dicir, /srv/stacks:/srv/stacks e non /srv/stacks:/proxectos.',
      },
    ],
  },
  {
    id: 'problemas',
    title: 'Cando algo vai mal',
    blocks: [
      { type: 'h', text: 'Non aparece ningun contedor' },
      {
        type: 'p',
        text: 'Mira Axustes, Contorno. Se o socket sae como non utilizable, esta montado pero faltan permisos: e un problema de como o montaches, non da ruta. Se non sae ningun, non se montou.',
      },
      { type: 'h', text: 'Unha actualizacion queda atascada' },
      {
        type: 'p',
        text: 'En Actualizacions, mira a saida en vivo. Se leva un tempo sen escribir nada, preme Deter e reintentao. Pode ser simplemente unha imaxe grande cunha conexion lenta.',
      },
      { type: 'h', text: 'Non hai rangos de IP dispoñibles' },
      {
        type: 'p',
        text: 'Cada proxecto crea a sua propia rede e Docker repartelas dun conxunto limitado. Ademais, ao baixar un proxecto a sua rede queda ali. Limpase asi:',
      },
      { type: 'code', text: 'docker network prune -f' },
      { type: 'h', text: 'O registry pide autenticacion' },
      {
        type: 'p',
        text: 'Ou a imaxe e privada e faltan credenciais, ou o repositorio non existe. Se a construiches no NAS, a aplicacion detectarao soa e deixara de consultala.',
      },
      { type: 'h', text: 'As metricas do sistema son aproximadas' },
      {
        type: 'p',
        text: 'Falta o montaxe de so lectura de /proc. Sen el amosanse datos derivados de Docker, e a propia interface indicao.',
      },
    ],
  },
];

const BY_LOCALE: Record<Locale, HelpSection[]> = { es, en, gl };

/**
 * La ayuda del idioma pedido.
 *
 * Con un mapa y no con condicionales anidados: al anadir el tercer idioma, un
 * `locale === 'en' ? en : es` habria devuelto castellano para galego sin que
 * nada fallara, y la ayuda se habria quedado en otro idioma en silencio.
 */
export function helpSections(locale: Locale): HelpSection[] {
  return BY_LOCALE[locale] ?? es;
}
