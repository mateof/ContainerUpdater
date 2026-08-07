/**
 * Configuracion del proceso, validada al arrancar.
 *
 * Regla: si una variable esta mal, se falla aqui con un mensaje claro en vez de
 * dejar que reviente a las dos horas dentro del scheduler. En un NAS el usuario
 * solo ve `docker logs`, asi que el error tiene que explicarse solo.
 */
import { z } from 'zod';
import { isLocale } from '@cu/shared';

const booleanish = z
  .string()
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),

  CU_DATA_DIR: z.string().default('/data'),
  CU_PUBLIC_DIR: z.string().optional(),
  CU_DEFAULT_LOCALE: z.string().default('es'),
  TZ: z.string().default('UTC'),

  /** Clave maestra de 32 bytes en base64. Alternativa: CU_MASTER_PASSPHRASE. */
  CU_ENCRYPTION_KEY: z.string().optional(),
  CU_MASTER_PASSPHRASE: z.string().optional(),

  /** Solo se usan si no hay ningun usuario todavia. */
  CU_ADMIN_USER: z.string().optional(),
  CU_ADMIN_PASSWORD: z.string().optional(),

  /**
   * Forzar la cookie Secure. Sin esto se autodetecta por X-Forwarded-Proto,
   * porque en una LAN por HTTP plano una cookie Secure impide el login y el
   * sintoma (login que "no hace nada") es dificil de diagnosticar.
   */
  CU_SECURE_COOKIES: booleanish.optional(),
  CU_TRUST_PROXY: booleanish.default('true'),
  CU_SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(7),

  /**
   * Sin definir, se sondean los sockets habituales de Docker y Podman hasta
   * encontrar uno vivo. Antes habia aqui un valor fijo, que obligaba a
   * configurarlo a mano en cuanto el runtime no era Docker en su sitio de
   * siempre.
   */
  DOCKER_HOST: z.string().optional(),

  /**
   * Carpetas dentro de las cuales se acepta ejecutar compose. Todo YAML fuera
   * de aqui se rechaza aunque las labels del contenedor lo apunten.
   *
   * Sin definir, se deducen de donde estan los proyectos que declara el propio
   * Docker. Un valor por defecto fijo solo acertaba en una plataforma.
   */
  CU_COMPOSE_ROOTS: z.string().optional(),

  /**
   * Carpeta donde se crean los proyectos nuevos. Tiene que admitir ESCRITURA.
   *
   * Va aparte de CU_COMPOSE_ROOTS porque el montaje recomendado pone las
   * carpetas de proyectos en solo lectura, y esa sigue siendo la recomendacion:
   * asi un fallo aqui no puede sobrescribir un stack que ya funciona. Sin
   * definir, se usa la primera carpeta de proyectos que resulte escribible, que
   * normalmente sera ninguna y la creacion quedara desactivada hasta que se
   * monte una a proposito.
   */
  CU_PROJECTS_DIR: z.string().optional(),

  CU_DOCKER_BIN: z.string().default('docker'),
  CU_COMPOSE_TIMEOUT_MS: z.coerce.number().int().default(15 * 60_000),

  /** Montaje de solo lectura del /proc del host. Sin el, metricas aproximadas. */
  CU_HOST_PROC: z.string().default('/host/proc'),
  CU_DISK_PATHS: z.string().optional(),

  CU_TELEGRAM_BOT_TOKEN: z.string().optional(),

  CU_CHECK_CRON: z.string().default('0 */6 * * *'),
  CU_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type RawConfig = z.infer<typeof schema>;

export interface Config {
  env: 'development' | 'production' | 'test';
  isProduction: boolean;
  port: number;
  host: string;
  dataDir: string;
  publicDir: string;
  databaseFile: string;
  defaultLocale: 'es' | 'en';
  timezone: string;
  encryptionKey: string | undefined;
  masterPassphrase: string | undefined;
  adminUser: string | undefined;
  adminPassword: string | undefined;
  secureCookies: boolean | undefined;
  trustProxy: boolean;
  sessionDays: number;
  /** Sin valor, se sondea al arrancar. */
  dockerHost: string | undefined;
  /** Vacio significa deducirlos de los proyectos detectados. */
  composeRoots: string[];
  composeRootsExplicit: boolean;
  /** Sin valor, se busca una carpeta de proyectos escribible. */
  projectsDir: string | undefined;
  dockerBin: string;
  composeTimeoutMs: number;
  hostProc: string | null;
  diskPaths: string[];
  telegramToken: string | undefined;
  checkCron: string;
  logLevel: RawConfig['CU_LOG_LEVEL'];
  version: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuracion no valida:\n${details}`);
  }
  const raw = parsed.data;

  const dataDir = raw.CU_DATA_DIR;
  const locale = isLocale(raw.CU_DEFAULT_LOCALE) ? raw.CU_DEFAULT_LOCALE : 'es';

  return {
    env: raw.NODE_ENV,
    isProduction: raw.NODE_ENV === 'production',
    port: raw.PORT,
    host: raw.HOST,
    dataDir,
    publicDir: raw.CU_PUBLIC_DIR ?? new URL('../public', import.meta.url).pathname,
    databaseFile: `${dataDir}/containerupdater.db`,
    defaultLocale: locale,
    timezone: raw.TZ,
    encryptionKey: raw.CU_ENCRYPTION_KEY,
    masterPassphrase: raw.CU_MASTER_PASSPHRASE,
    adminUser: raw.CU_ADMIN_USER,
    adminPassword: raw.CU_ADMIN_PASSWORD,
    secureCookies: raw.CU_SECURE_COOKIES,
    trustProxy: raw.CU_TRUST_PROXY,
    sessionDays: raw.CU_SESSION_DAYS,
    dockerHost: raw.DOCKER_HOST,
    composeRoots: raw.CU_COMPOSE_ROOTS ? splitList(raw.CU_COMPOSE_ROOTS) : [],
    composeRootsExplicit: Boolean(raw.CU_COMPOSE_ROOTS),
    projectsDir: raw.CU_PROJECTS_DIR,
    dockerBin: raw.CU_DOCKER_BIN,
    composeTimeoutMs: raw.CU_COMPOSE_TIMEOUT_MS,
    hostProc: raw.CU_HOST_PROC || null,
    diskPaths: raw.CU_DISK_PATHS ? splitList(raw.CU_DISK_PATHS) : [],
    telegramToken: raw.CU_TELEGRAM_BOT_TOKEN,
    checkCron: raw.CU_CHECK_CRON,
    logLevel: raw.CU_LOG_LEVEL,
    version: process.env.CU_VERSION ?? '0.1.0',
  };
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
