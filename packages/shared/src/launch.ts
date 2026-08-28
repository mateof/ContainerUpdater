/**
 * Opciones de arranque de un proyecto.
 *
 * Lo que se ofrece y lo que NO es la decision importante de este fichero.
 *
 * **No hay un campo libre de argumentos.** Seria lo mas flexible y lo pidio el
 * usuario como posibilidad, pero un texto libre acaba en la linea de ordenes de
 * `docker compose`, y ahi `--project-directory /etc` o `--file /cualquier/cosa`
 * cambian a que apunta todo. No es inyeccion de consola (los procesos se lanzan
 * sin shell), pero si control total sobre lo que se ejecuta desde un formulario
 * de la web. A cambio se ofrecen las opciones que de verdad se usan, cada una
 * con su casilla, mas variables de entorno, que es el 90% del caso real.
 */

/** Interruptores de `docker compose up` que merece la pena exponer. */
export interface LaunchFlags {
  /** `--build`: reconstruye las imagenes que se construyen en local. */
  build?: boolean;
  /** `--remove-orphans`: borra contenedores del proyecto que ya no estan en el fichero. */
  removeOrphans?: boolean;
  /** `--wait`: no da por terminado hasta que los servicios esten sanos. */
  wait?: boolean;
  /** `--force-recreate`: recrea aunque no haya cambiado nada. */
  forceRecreate?: boolean;
  /** `--pull never`: no consultar el registry. Util sin conexion. */
  noPull?: boolean;
}

export interface LaunchOptions extends LaunchFlags {
  /** Perfiles de Compose a activar. */
  profiles?: string[];
  /** Variables de entorno para esta ejecucion, sin tocar el `.env`. */
  env?: Record<string, string>;
}

/**
 * Nombre valido de variable de entorno.
 *
 * El de POSIX: letras, digitos y guion bajo, sin empezar por digito. Se valida
 * porque estas variables van al entorno de un proceso, y un nombre con `=` o con
 * espacios produce cosas dificiles de diagnosticar.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Nombres que NO se aceptan aunque sean validos.
 *
 * Redefinir `PATH` o `DOCKER_HOST` desde un formulario cambiaria que binario se
 * ejecuta o contra que daemon, que no es lo que nadie quiere decir al escribir
 * "una variable de entorno para mi contenedor".
 */
const RESERVADAS = new Set([
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'COMPOSE_FILE',
  'COMPOSE_PROJECT_NAME',
  'COMPOSE_PROJECT_DIR',
  'LD_PRELOAD',
  'NODE_OPTIONS',
]);

export type EnvIssue =
  | { key: string; reason: 'invalid-name' }
  | { key: string; reason: 'reserved' };

/** Separa lo aceptable de lo que hay que rechazar, diciendo por que. */
export function validateEnv(env: Record<string, string>): {
  accepted: Record<string, string>;
  issues: EnvIssue[];
} {
  const accepted: Record<string, string> = {};
  const issues: EnvIssue[] = [];

  for (const [key, value] of Object.entries(env)) {
    const nombre = key.trim();
    if (!nombre) continue;
    if (!ENV_NAME.test(nombre)) {
      issues.push({ key: nombre, reason: 'invalid-name' });
      continue;
    }
    if (RESERVADAS.has(nombre.toUpperCase())) {
      issues.push({ key: nombre, reason: 'reserved' });
      continue;
    }
    accepted[nombre] = value;
  }

  return { accepted, issues };
}

/**
 * Nombre valido de perfil.
 *
 * Compose los acepta con letras, digitos, guiones, guiones bajos y puntos. Se
 * comprueba porque van como argumento y un nombre que empiece por `-` se leeria
 * como una opcion mas.
 */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isValidProfile(name: string): boolean {
  return PROFILE_NAME.test(name);
}

/**
 * Convierte las opciones en argumentos de `docker compose`.
 *
 * Los perfiles van ANTES del subcomando: `compose --profile x up`, no
 * `compose up --profile x`. Es donde los espera Compose y es un error facil de
 * cometer, porque el resto de opciones de arranque van despues.
 */
export function launchArgs(options: LaunchOptions): { before: string[]; after: string[] } {
  const before: string[] = [];
  for (const profile of options.profiles ?? []) {
    if (isValidProfile(profile)) before.push('--profile', profile);
  }

  const after: string[] = [];
  if (options.build) after.push('--build');
  if (options.removeOrphans) after.push('--remove-orphans');
  if (options.forceRecreate) after.push('--force-recreate');
  if (options.wait) after.push('--wait');

  return { before, after };
}
