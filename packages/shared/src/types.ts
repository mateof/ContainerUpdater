import type { Locale } from './i18n/index.js';

/**
 * Tipos de dominio compartidos entre servidor, web y bot.
 *
 * Regla: aqui solo van formas de datos que cruzan la frontera HTTP. Los tipos
 * internos del servidor (filas de SQLite, respuestas crudas del socket de
 * Docker) viven en sus propios modulos y se mapean antes de salir.
 */

// ---------------------------------------------------------------------------
// Imagenes y actualizaciones
// ---------------------------------------------------------------------------

/**
 * De donde sale una imagen. Determina si tiene sentido comprobar updates.
 *
 * - `registry`: bajada de un registry, tiene RepoDigests, se puede comparar.
 * - `local-build`: construida en la maquina (`docker build`). No tiene digest
 *   remoto con el que comparar y hacer pull bajaria una imagen ajena que
 *   casualmente se llame igual en Docker Hub. Se excluye de los checks.
 * - `pinned`: la referencia lleva `@sha256:...`, asi que por definicion no
 *   cambia nunca.
 */
export type ImageSource = 'registry' | 'local-build' | 'pinned';

export type UpdateStatus =
  | 'up-to-date'
  | 'update-available'
  | 'unknown'
  | 'pinned'
  | 'error';

/** Como se vigila una imagen. Ver `docs/ARCHITECTURE.md`. */
export type TrackMode = 'digest' | 'semver' | 'both';

/** Hasta donde puede saltar solo el auto-update. */
export type SemverChannel = 'patch' | 'minor' | 'major';

/** Que se recrea al actualizar: solo el servicio o el proyecto entero. */
export type RecreateScope = 'service' | 'project';

export interface ImagePolicy {
  imageRef: string;
  autoUpdate: boolean;
  trackMode: TrackMode;
  semverChannel: SemverChannel;
  notify: boolean;
  recreateScope: RecreateScope;
  /** Borrar la imagen local ANTES del pull en un force. Sin rollback posible. */
  removeImageOnForce: boolean;
  /** Limpiar la imagen vieja huerfana despues de un update correcto. */
  cleanupOldImage: boolean;
  /** Silencia los avisos hasta esta fecha (epoch ms). */
  pausedUntil: number | null;
  /** Digest concreto que el usuario decidio ignorar. */
  ignoredDigest: string | null;
  /**
   * Horas que una version debe llevar publicada antes de que el auto-update la
   * aplique.
   *
   * Es lo que hace que dejar el auto-update encendido no de miedo: la mayoria
   * de releases rotas se corrigen en dos o tres dias, y con 72 aqui te las
   * saltas sin enterarte. Solo afecta al auto-update; actualizar a mano nunca
   * se bloquea.
   *
   * `null` hereda el valor global de ajustes, que es distinto de `0`: cero
   * significa "esta imagen entra en cuanto sale, diga lo que diga el global".
   */
  minAgeHours: number | null;
}

/**
 * Por que una imagen con novedad no se ha actualizado sola.
 *
 * Se guarda y se muestra porque el silencio es peor que la espera: sin esto,
 * una imagen marcada como automatica que no se mueve parece una averia.
 */
export type HoldReason =
  /** Todavia no ha cumplido la cuarentena de su politica. */
  | 'quarantine'
  /** Hay ventana de mantenimiento y ahora mismo estamos fuera. */
  | 'maintenance-window';

export interface UpdateHold {
  reason: HoldReason;
  /** Cuando dejara de estar retenida, si se puede saber. */
  until: number | null;
}

/**
 * Relacion de una imagen con los contenedores del sistema.
 *
 * - `running`: algun contenedor que la usa esta en marcha. No se puede borrar.
 * - `stopped`: hay contenedores pero ninguno en marcha. Borrarla exige forzar y
 *   deja esos contenedores inservibles, asi que se avisa nombrandolos.
 * - `orphan`: no la usa ningun contenedor. Se puede borrar sin consecuencias.
 */
export type ImageUsage = 'running' | 'stopped' | 'orphan';

export interface TrackedImage {
  ref: string;
  host: string;
  repository: string;
  tag: string;
  imageId: string | null;
  architecture: string | null;
  os: string | null;
  variant: string | null;
  localDigests: string[];
  source: ImageSource;
  sizeBytes: number | null;
  imageCreatedAt: number | null;
  status: UpdateStatus;
  /** Digest remoto del indice cuando hay novedad. */
  remoteDigest: string | null;
  /** Tag mas alto disponible en modo semver, si lo hay. */
  candidateTag: string | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  /** Nombres de los contenedores que la usan, en marcha o no. */
  inUseBy: string[];
  /** De los anteriores, cuales estan en marcha. Decide si se puede borrar. */
  inUseByRunning: string[];
  usage: ImageUsage;
  policy: ImagePolicy;
  /** Que trae la version publicada. null si no se ha podido averiguar. */
  release: ReleaseInfo | null;
  /** Por que no se ha aplicado sola, cuando hay novedad y es automatica. */
  hold: UpdateHold | null;
  /** Si hay una version anterior a la que se puede volver. */
  canRollback: boolean;
}

/**
 * De donde viene una imagen y que cambia respecto a la que tienes.
 *
 * Sale de las etiquetas OCI del blob de configuracion, que ya se descarga al
 * detectar una novedad. Antes esa informacion pasaba por delante y se tiraba.
 */
export interface ReleaseInfo {
  /** `org.opencontainers.image.source`, normalmente el repositorio de codigo. */
  sourceUrl: string | null;
  /** Commit de la version que tienes instalada. */
  localRevision: string | null;
  /** Commit de la version publicada. */
  remoteRevision: string | null;
  /** `org.opencontainers.image.version` de la publicada. */
  remoteVersion: string | null;
  /** Cuando se publico la version remota, si se ha podido averiguar. */
  publishedAt: number | null;
  /** Comparacion entre ambos commits, solo cuando el origen la admite. */
  compareUrl: string | null;
  /** Listado de releases del proyecto, como recurso de segunda opcion. */
  releasesUrl: string | null;
}

/** Punto al que se puede volver tras una actualizacion ya aplicada. */
export interface RollbackPoint {
  /** Trabajo que dejo este punto. */
  jobId: number;
  imageRef: string;
  /**
   * Digests de la version anterior, en orden de preferencia.
   *
   * Es una lista porque `RepoDigests` puede traer el del indice y el del
   * manifest de la arquitectura, y no todos los registries sirven ambos.
   */
  digests: string[];
  tag: string | null;
  /** Cuando se aplico la actualizacion que se puede deshacer. */
  appliedAt: number;
  /** Digest actual, el que se marcara como ignorado al volver atras. */
  currentDigest: string | null;
}

// ---------------------------------------------------------------------------
// Contenedores y proyectos
// ---------------------------------------------------------------------------

export type ContainerState =
  | 'created'
  | 'running'
  | 'paused'
  | 'restarting'
  | 'removing'
  | 'exited'
  | 'dead';

export type HealthState = 'healthy' | 'unhealthy' | 'starting' | 'none';

export interface ContainerSummary {
  id: string;
  name: string;
  /** Lo que dice el daemon, tal cual. Es lo que se muestra. */
  image: string;
  /**
   * La misma imagen ya normalizada, o null si no se ha podido interpretar.
   *
   * Existe porque `image` y la referencia con la que se identifica una imagen
   * en la pantalla de Imagenes NO son la misma cadena: el daemon dice
   * `docker.io/prom/prometheus:v2.53.0` y la normalizada es
   * `registry-1.docker.io/prom/prometheus:v2.53.0`. Comprobado contra un
   * entorno real: de 21 contenedores solo coincidian 3, asi que cruzar las dos
   * pantallas por `image` fallaba en casi todos.
   */
  imageRef: string | null;
  imageId: string;
  state: ContainerState;
  status: string;
  health: HealthState;
  createdAt: number;
  startedAt: number | null;
  restartCount: number;
  /**
   * Codigo con el que salio, cuando ya no corre.
   *
   * Es lo que separa "lo pare yo" de "se ha caido": salir con 0 es una parada
   * limpia y no merece aviso, salir con otra cosa si. Solo se consulta para los
   * contenedores que no estan en marcha, que son pocos.
   */
  exitCode: number | null;
  ports: Array<{ ip?: string; privatePort: number; publicPort?: number; type: string }>;
  /** Clave compuesta del proyecto compose, null si el contenedor va suelto. */
  projectKey: string | null;
  projectName: string | null;
  serviceName: string | null;
  /** true si es la propia app. No se puede auto-actualizar. */
  isSelf: boolean;
}

export type UpdateStrategy = 'compose' | 'recreate' | 'unsupported';

export interface ComposeProject {
  /**
   * `nombre` y `directorio de trabajo` unidos por un espacio. La clave es
   * compuesta porque los nombres colisionan: ver ADR-004. Se trata como
   * opaca, nadie la vuelve a partir, que es lo que permite que el
   * separador sea un simple espacio pese a que las rutas los admiten.
   */
  key: string;
  name: string;
  workingDir: string;
  configFiles: string[];
  /** Si el YAML se puede leer desde dentro del contenedor. Decide la estrategia. */
  yamlAccessible: boolean;
  strategy: UpdateStrategy;
  containers: ContainerSummary[];
  updatesAvailable: number;
  /** Creado desde esta aplicacion. Se muestra tal cual, no decide nada. */
  managed: boolean;
  /**
   * Si sus ficheros se pueden editar desde aqui.
   *
   * Depende de lo que de verdad importa (que el YAML sea accesible, que sea uno
   * solo y que la carpeta admita escritura), no de quien lo creo. Antes solo se
   * dejaba editar lo creado aqui, lo que dejaba la funcionalidad inservible en
   * un NAS donde los proyectos los hizo el usuario en Container Manager.
   */
  editable: boolean;
  /** Por que no se puede editar, para poder explicarlo en vez de apagar un boton. */
  editableReason: 'yaml-not-accessible' | 'multiple-files' | 'read-only-mount' | null;
}

// ---------------------------------------------------------------------------
// Ficheros de un proyecto
// ---------------------------------------------------------------------------

/**
 * Una variable del `.env`.
 *
 * El valor viaja oculto cuando la clave parece nombrar un secreto. Verlo en
 * claro es una peticion aparte que queda auditada, para que abrir el panel no
 * derrame todas las contrasenas del NAS en la pantalla.
 */
export interface EnvEntry {
  key: string;
  value: string;
  secret: boolean;
}

export interface ProjectFiles {
  name: string;
  dir: string;
  compose: string;
  env: EnvEntry[];
  envExists: boolean;
  /** Si la carpeta admite escritura desde aqui. Sin esto solo se puede leer. */
  writable: boolean;
}

/** Estado de la carpeta donde se crean los proyectos nuevos. */
export interface ProjectsDirInfo {
  path: string | null;
  writable: boolean;
  /** Por que no se puede crear, cuando no se puede. */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Trabajos de actualizacion
// ---------------------------------------------------------------------------

/**
 * Que hace un trabajo.
 *
 * Los dos primeros actualizan la imagen; el resto son operaciones sobre un
 * servicio que no la tocan. Comparten cola e historial a proposito: todo lo que
 * recrea o para un contenedor debe ejecutarse de uno en uno y quedar
 * registrado, sea cual sea el motivo.
 */
export type UpdateMode =
  | 'update'
  | 'force'
  /** Elimina el contenedor y lo vuelve a crear, sin descargar nada. */
  | 'recreate'
  | 'restart'
  | 'stop'
  | 'start'
  /** Descarga la imagen sin tocar el contenedor. */
  | 'pull'
  /** Vuelve a la version anterior a la ultima actualizacion. */
  | 'revert'
  /** Sobre el proyecto entero, no sobre un servicio. */
  | 'up'
  | 'down';

/** Operaciones que actuan sobre un servicio concreto de un proyecto. */
export const SERVICE_ACTIONS = ['recreate', 'restart', 'stop', 'start', 'pull'] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/** Operaciones sobre el proyecto entero. */
export const PROJECT_ACTIONS = ['update', 'up', 'restart', 'down'] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

export type JobTrigger = 'manual' | 'auto' | 'telegram';
export type JobStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'rolled-back'
  | 'skipped';

export interface UpdateJob {
  id: number;
  imageRef: string;
  containerId: string | null;
  containerName: string | null;
  projectKey: string | null;
  mode: UpdateMode;
  strategy: UpdateStrategy;
  trigger: JobTrigger;
  status: JobStatus;
  fromDigest: string | null;
  toDigest: string | null;
  fromTag: string | null;
  toTag: string | null;
  log: string;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

// ---------------------------------------------------------------------------
// Comprobaciones
// ---------------------------------------------------------------------------

export interface CheckRun {
  id: number;
  trigger: JobTrigger | 'schedule';
  status: 'running' | 'ok' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  imagesChecked: number;
  updatesFound: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Segundo factor
// ---------------------------------------------------------------------------

export interface TotpStatus {
  enabled: boolean;
  /** Cuantos codigos de recuperacion quedan sin usar. */
  recoveryCodesLeft: number;
}

/** Lo que hace falta para dar de alta el segundo factor. */
export interface TotpEnrollment {
  /** Para teclearlo a mano cuando no se puede escanear. */
  secret: string;
  uri: string;
  /** SVG ya renderizado en el servidor: el navegador no calcula nada. */
  qr: string;
}

// ---------------------------------------------------------------------------
// Passkeys
// ---------------------------------------------------------------------------

export interface PasskeySummary {
  id: number;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/**
 * Por que este origen no admite passkeys, cuando no los admite.
 *
 * Las dos razones las impone el navegador: WebAuthn exige contexto seguro y un
 * identificador de sitio que sea un dominio. Se distinguen porque la solucion
 * es distinta: una pide HTTPS, la otra pide un nombre.
 */
export type PasskeyUnavailableReason = 'insecure-origin' | 'ip-address';

export interface PasskeySupport {
  available: boolean;
  reason: PasskeyUnavailableReason | null;
  rpId: string;
  origin: string;
  /** Si hay alguna registrada. Sin ninguna, no se ofrece entrar con passkey. */
  anyRegistered: boolean;
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

export type RegistryAuthType = 'anonymous' | 'basic' | 'token';
export type RegistryStatus = 'ok' | 'needs-reauth' | 'error' | 'untested';

export interface RegistryConfig {
  id: number;
  name: string;
  host: string;
  authType: RegistryAuthType;
  username: string | null;
  /** El secreto nunca sale del servidor. Esto solo dice si hay uno guardado. */
  hasSecret: boolean;
  status: RegistryStatus;
  lastVerifiedAt: number | null;
  /** Cuota restante reportada por el registry, si la publica. */
  rateLimitRemaining: number | null;
  rateLimitTotal: number | null;
}

// ---------------------------------------------------------------------------
// Metricas
// ---------------------------------------------------------------------------

export interface ContainerMetrics {
  id: string;
  name: string;
  /** null en la primera muestra: no hay delta con el que calcular. */
  cpuPercent: number | null;
  memoryUsed: number;
  memoryLimit: number;
  memoryPercent: number;
  netRxRate: number;
  netTxRate: number;
  blockReadRate: number | null;
  blockWriteRate: number | null;
  pids: number | null;
  ts: number;
}

export interface HostMetrics {
  cpuPercent: number | null;
  cpuPerCore: number[];
  memTotal: number;
  memAvailable: number;
  memUsed: number;
  swapTotal: number;
  swapUsed: number;
  loadAvg: [number, number, number];
  uptimeSeconds: number;
  ncpu: number;
  /** Vacio si no se pudo leer sin despertar discos. */
  disks: Array<{ path: string; total: number; used: number; available: number }>;
  /** De donde salen los datos. La UI lo explica en vez de fingir precision. */
  source: 'host-proc' | 'docker-fallback' | 'unavailable';
  ts: number;
}

export interface MetricsSnapshot {
  host: HostMetrics;
  containers: ContainerMetrics[];
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export interface TelegramUser {
  id: number;
  chatId: number;
  username: string | null;
  firstName: string | null;
  role: 'admin' | 'operator' | 'viewer';
  locale: Locale | null;
  active: boolean;
  linkedAt: number;
  lastSeenAt: number | null;
}

export interface TelegramLinkCode {
  code: string;
  deepLink: string;
  expiresAt: number;
}

export interface TelegramStatus {
  configured: boolean;
  running: boolean;
  botUsername: string | null;
  error: string | null;
  users: TelegramUser[];
}

// ---------------------------------------------------------------------------
// Ajustes y sesion
// ---------------------------------------------------------------------------

/**
 * Reexportado desde el modulo de i18n, que es donde se define.
 *
 * Antes habia aqui una copia con la misma union escrita a mano. Coincidian por
 * casualidad, asi que TypeScript las trataba como equivalentes y nadie lo noto
 * hasta que se anadio un tercer idioma y las dos dejaron de cuadrar. El conjunto
 * de idiomas es exactamente el conjunto de catalogos, asi que se define alli y
 * no puede discrepar.
 */
export type { Locale };

export interface AppSettings {
  checkCron: string;
  autoUpdateEnabled: boolean;
  notifyOnUpdateAvailable: boolean;
  notifyOnUpdateApplied: boolean;
  notifyOnFailure: boolean;
  /** Un contenedor que se cae o entra en bucle de reinicios. */
  notifyOnContainerDown: boolean;
  /** Y cuando vuelve solo, para poder dejar de preocuparse. */
  notifyOnContainerRecovered: boolean;
  /**
   * Reinicios seguidos que hacen falta para considerarlo un bucle.
   *
   * Un contenedor que reinicia una vez puede ser un pico de memoria puntual.
   * Tres seguidos en la misma ventana ya no lo es.
   */
  restartLoopThreshold: number;
  /**
   * Cuarentena por defecto, en horas, para las imagenes sin politica propia.
   *
   * 0 la desactiva. Se aplica solo al auto-update.
   */
  defaultMinAgeHours: number;
  /** Limitar el auto-update a una franja horaria. */
  maintenanceWindowEnabled: boolean;
  /** Hora local de inicio y fin, 0-23. Si fin < inicio, la franja cruza medianoche. */
  maintenanceStartHour: number;
  maintenanceEndHour: number;
  metricsIntervalSeconds: number;
  metricsHistoryEnabled: boolean;
  historyRetentionDays: number;
  registryConcurrency: number;
  defaultLocale: Locale;
  allowTelegramGroups: boolean;
}

export interface CurrentUser {
  id: number;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  locale: Locale;
  mustChangePassword: boolean;
}

/** Estado global que la UI necesita para decidir que avisos mostrar. */
export interface SystemStatus {
  version: string;
  /** false si no se pudo descifrar el llavero: modo degradado. */
  keyringHealthy: boolean;
  dockerConnected: boolean;
  dockerApiVersion: string | null;
  dockerFlavor: 'docker' | 'podman' | 'unknown';
  selfContainerId: string | null;
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  checkRunning: boolean;
  updatesAvailable: number;
  telegram: { configured: boolean; running: boolean };
}

// ---------------------------------------------------------------------------
// Almacenamiento
// ---------------------------------------------------------------------------

/**
 * Un volumen que no usa ningun contenedor.
 *
 * Ojo con la lectura facil: "no lo usa nadie" no quiere decir "sobra". Puede
 * ser justamente los datos de algo que paraste en marzo y quieres recuperar en
 * octubre. Por eso aqui no hay limpieza masiva, solo borrado de uno en uno.
 */
export interface UnusedVolume {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: number | null;
  /** Tamano en disco. null cuando el daemon no lo calcula. */
  sizeBytes: number | null;
  /** Nombre del proyecto compose que lo creo, si lo dicen sus etiquetas. */
  projectName: string | null;
}

export interface StorageUsage {
  images: { total: number; reclaimable: number; count: number };
  containers: { total: number; count: number };
  volumes: { total: number; reclaimable: number; count: number };
  buildCache: { total: number; reclaimable: number; count: number };
  /** Volumenes concretos que no usa nadie, para poder decidir uno a uno. */
  unusedVolumes: UnusedVolume[];
  /** El daemon no siempre publica todo. Lo que falte va a null y se dice. */
  partial: boolean;
}

// ---------------------------------------------------------------------------
// Copia de seguridad
// ---------------------------------------------------------------------------

/**
 * Contenido exportable.
 *
 * Deliberadamente NO lleva secretos: ni contrasenas de registry, ni el secreto
 * del segundo factor, ni passkeys. Un fichero de copia que se pueda descargar y
 * dejar en cualquier carpeta no es sitio para eso, y todo lo omitido se vuelve a
 * dar de alta en minutos. Lo que de verdad cuesta rehacer son las politicas.
 */
export interface BackupFile {
  version: 1;
  createdAt: number;
  appVersion: string;
  settings: AppSettings;
  policies: ImagePolicy[];
  /** Sin el secreto: solo host, tipo y usuario, para saber que volver a poner. */
  registries: Array<Omit<RegistryConfig, 'id' | 'status' | 'lastVerifiedAt' | 'rateLimitRemaining' | 'rateLimitTotal'>>;
  telegramUsers: Array<Pick<TelegramUser, 'chatId' | 'username' | 'role' | 'locale'>>;
}

export interface RestoreReport {
  settings: boolean;
  policies: number;
  registries: number;
  telegramUsers: number;
  /** Lo que se ha omitido y por que, para que no parezca que se aplico todo. */
  skipped: string[];
}

// ---------------------------------------------------------------------------
// Eventos SSE
// ---------------------------------------------------------------------------

export type ServerEvent =
  | { type: 'metrics'; payload: MetricsSnapshot }
  | { type: 'metrics-snapshot'; payload: { history: MetricsSnapshot[] } }
  | { type: 'job-progress'; payload: { job: UpdateJob } }
  | { type: 'check-progress'; payload: { run: CheckRun; currentImage: string | null } }
  | { type: 'check-done'; payload: { run: CheckRun } }
  | { type: 'inventory-changed'; payload: Record<string, never> }
  | { type: 'notice'; payload: { level: 'info' | 'warn' | 'error'; messageKey: string } }
  | {
      type: 'container-alert';
      payload: { name: string; kind: 'down' | 'restart-loop' | 'unhealthy' | 'recovered' };
    };
