/**
 * Esquemas zod compartidos. El servidor los usa para validar la entrada y la
 * web para validar los formularios, de forma que las reglas no se dupliquen y
 * no se puedan desincronizar.
 */
import { z } from 'zod';

export const localeSchema = z.enum(['es', 'en']);

export const trackModeSchema = z.enum(['digest', 'semver', 'both']);
export const semverChannelSchema = z.enum(['patch', 'minor', 'major']);
export const recreateScopeSchema = z.enum(['service', 'project']);
export const updateModeSchema = z.enum(['update', 'force']);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

/**
 * Minimo de 12 caracteres en vez de los 8 habituales: esta app tiene acceso al
 * socket de Docker, que equivale a root en el NAS. No se imponen reglas de
 * composicion (mayusculas, simbolos) porque empujan a patrones predecibles;
 * la longitud es lo que de verdad aporta entropia.
 */
export const passwordSchema = z
  .string()
  .min(12, 'password.tooShort')
  .max(256, 'password.tooLong');

export const setupSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'username.invalidChars'),
  password: passwordSchema,
  locale: localeSchema.default('es'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

// ---------------------------------------------------------------------------
// Politicas de imagen
// ---------------------------------------------------------------------------

export const imagePolicySchema = z.object({
  autoUpdate: z.boolean().optional(),
  trackMode: trackModeSchema.optional(),
  semverChannel: semverChannelSchema.optional(),
  notify: z.boolean().optional(),
  recreateScope: recreateScopeSchema.optional(),
  removeImageOnForce: z.boolean().optional(),
  cleanupOldImage: z.boolean().optional(),
  pausedUntil: z.number().int().nullable().optional(),
  ignoredDigest: z.string().nullable().optional(),
});

export const updateRequestSchema = z.object({
  mode: updateModeSchema.default('update'),
  scope: recreateScopeSchema.optional(),
  /**
   * Borrado literal de la imagen antes del pull. Se acepta solo desde la web
   * (el bot nunca lo manda) porque deja una ventana sin rollback posible.
   */
  removeImageFirst: z.boolean().default(false),
  /** Tag concreto al que saltar en modo semver. Si falta, se usa el candidato. */
  targetTag: z.string().max(128).optional(),
});

/**
 * Borrado de una imagen.
 *
 * `force` no es un atajo: es lo que hace falta cuando quedan contenedores
 * parados que la usan, y borrarla los deja sin poder arrancar. Va como
 * parametro explicito para que nadie lo mande sin querer.
 */
export const imageDeleteSchema = z.object({
  force: z
    .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
    .transform((value) => value === true || value === '1' || value === 'true')
    .default(false),
});

/**
 * La clave del proyecto viaja en el cuerpo y no en la ruta: es `nombre +
 * directorio`, y las rutas de un NAS son lo bastante largas como para que la
 * URL codificada supere el limite y el servidor devuelva 414.
 */
export const serviceActionSchema = z.object({
  projectKey: z.string().min(1).max(1024),
  serviceName: z.string().min(1).max(255),
  action: z.enum(['recreate', 'restart', 'stop', 'start', 'pull']),
});

/**
 * Nombre de un proyecto creado desde aqui.
 *
 * Es a la vez el nombre del proyecto de Compose y el de su carpeta, asi que la
 * validacion es la mas restrictiva de las dos. Se prohibe empezar por `-`
 * (Compose lo tomaria por una opcion) y cualquier cosa que parezca una ruta:
 * es el unico dato del que sale un nombre de directorio.
 */
export const projectNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'minusculas, digitos, guion y guion bajo; ha de empezar por letra o digito');

/** Tope de tamano de los ficheros. Un compose legitimo no se acerca. */
const FILE_MAX = 256 * 1024;

export const projectCreateSchema = z.object({
  name: projectNameSchema,
  compose: z.string().min(1).max(FILE_MAX),
  env: z.string().max(FILE_MAX).optional(),
  /** Levantarlo nada mas crearlo. */
  start: z.boolean().default(true),
});

/**
 * Los ficheros se direccionan por CLAVE DE PROYECTO, no por nombre.
 *
 * Los nombres colisionan: Container Manager los deriva de la carpeta y dos
 * stacks distintos pueden llamarse los dos `docker` (ADR-004). Y va en el
 * cuerpo, no en la ruta, por el mismo motivo que en `serviceActionSchema`.
 */
export const projectFilesReadSchema = z.object({
  projectKey: z.string().min(1).max(1024),
});

export const projectFilesUpdateSchema = z.object({
  projectKey: z.string().min(1).max(1024),
  compose: z.string().min(1).max(FILE_MAX),
  env: z.string().max(FILE_MAX).optional(),
  /** Volver a aplicar el proyecto tras guardar. */
  apply: z.boolean().default(false),
});

export const projectActionSchema = z.object({
  projectKey: z.string().min(1).max(1024),
  action: z.enum(['up', 'restart', 'down']),
});

/** Ver en claro una sola variable, no el fichero entero. */
export const envRevealSchema = z.object({
  projectKey: z.string().min(1).max(1024),
  key: z.string().min(1).max(255),
});

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

export const registrySchema = z.object({
  name: z.string().min(1).max(64),
  host: z
    .string()
    .min(1)
    .max(255)
    // Host de registry: dominio con puerto opcional, o localhost.
    .regex(/^(localhost|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)(:\d{1,5})?$/i, 'registry.invalidHost'),
  authType: z.enum(['anonymous', 'basic', 'token']),
  username: z.string().max(255).optional(),
  /** Contrasena o PAT. Se cifra antes de tocar disco. */
  secret: z.string().max(4096).optional(),
});

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

/**
 * Cron de 5 campos. No se valida la semantica aqui (croner lo hara al
 * programarlo), solo la forma, para dar un error de formulario inmediato.
 */
export const cronSchema = z
  .string()
  .min(9)
  .max(120)
  .regex(/^(\S+\s+){4}\S+$/, 'settings.invalidCron');

export const settingsSchema = z.object({
  checkCron: cronSchema.optional(),
  autoUpdateEnabled: z.boolean().optional(),
  notifyOnUpdateAvailable: z.boolean().optional(),
  notifyOnUpdateApplied: z.boolean().optional(),
  notifyOnFailure: z.boolean().optional(),
  // Por debajo de 2s el muestreo cuesta mas CPU de la que mide en un NAS.
  metricsIntervalSeconds: z.number().int().min(2).max(60).optional(),
  metricsHistoryEnabled: z.boolean().optional(),
  historyRetentionDays: z.number().int().min(1).max(365).optional(),
  registryConcurrency: z.number().int().min(1).max(10).optional(),
  defaultLocale: localeSchema.optional(),
  allowTelegramGroups: z.boolean().optional(),
});

export const profileSchema = z.object({
  locale: localeSchema.optional(),
});

// ---------------------------------------------------------------------------
// Contenedores
// ---------------------------------------------------------------------------

export const logsQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(2000).default(200),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type SetupInput = z.infer<typeof setupSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ImagePolicyInput = z.infer<typeof imagePolicySchema>;
export type UpdateRequestInput = z.infer<typeof updateRequestSchema>;
export type RegistryInput = z.infer<typeof registrySchema>;
export type SettingsInput = z.infer<typeof settingsSchema>;
