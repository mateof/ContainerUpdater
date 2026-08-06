/**
 * Deteccion de proyectos de Docker Compose a partir de las labels.
 *
 * Container Manager de Synology crea los proyectos con `docker compose`, asi
 * que los contenedores llevan las labels estandar y no hace falta hablar con
 * ninguna API propietaria de DSM.
 */
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ContainerListItem } from './types.js';

export const COMPOSE_LABELS = {
  project: 'com.docker.compose.project',
  workingDir: 'com.docker.compose.project.working_dir',
  configFiles: 'com.docker.compose.project.config_files',
  service: 'com.docker.compose.service',
  containerNumber: 'com.docker.compose.container-number',
  oneoff: 'com.docker.compose.oneoff',
} as const;

export interface ComposeMembership {
  projectName: string;
  workingDir: string;
  configFiles: string[];
  serviceName: string;
  /** Clave estable del proyecto. Ver la nota sobre colisiones. */
  key: string;
}

/**
 * Extrae la pertenencia a un proyecto, o null si el contenedor va suelto.
 *
 * Dos detalles que hay que acertar:
 *
 * 1. `config_files` puede traer VARIOS ficheros separados por comas cuando el
 *    stack se levanto con varios `-f`. Quedarse con la cadena entera y pasarla
 *    como un solo `-f` hace que compose no encuentre el fichero.
 *
 * 2. El nombre de proyecto NO identifica al proyecto. Container Manager lo
 *    deriva de la carpeta, asi que dos stacks en `.../a/docker` y `.../b/docker`
 *    se llaman los dos `docker`. Verificado en un entorno real. La clave tiene
 *    que ser (nombre, working_dir) o un `compose down` acabaria tumbando el
 *    stack equivocado.
 */
export function readComposeMembership(container: ContainerListItem): ComposeMembership | null {
  const labels = container.Labels ?? {};
  const projectName = labels[COMPOSE_LABELS.project];
  if (!projectName) return null;

  // Los contenedores de `compose run` no forman parte del stack declarado y no
  // se deben recrear con `up`.
  if ((labels[COMPOSE_LABELS.oneoff] ?? 'False').toLowerCase() === 'true') return null;

  const workingDir = labels[COMPOSE_LABELS.workingDir] ?? '';
  const configFiles = (labels[COMPOSE_LABELS.configFiles] ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

  return {
    projectName,
    workingDir,
    configFiles,
    serviceName: labels[COMPOSE_LABELS.service] ?? '',
    key: composeProjectKey(projectName, workingDir),
  };
}

export function composeProjectKey(projectName: string, workingDir: string): string {
  return `${projectName} ${workingDir}`;
}

export interface AccessibilityResult {
  accessible: boolean;
  /** Rutas reales tras resolver symlinks. Son las que se pasan a compose. */
  resolvedFiles: string[];
  resolvedWorkingDir: string | null;
  reason: string | null;
}

/**
 * Comprueba si el YAML del proyecto se puede leer desde dentro del contenedor.
 *
 * Es lo que decide la estrategia: si el fichero esta ahi, se actualiza con
 * compose igual que haria Container Manager; si no, toca recrear por API.
 *
 * `realpath` se resuelve ANTES de validar contra las carpetas permitidas. Al
 * reves, un enlace simbolico dentro de `/volume1/docker` que apunte a `/etc`
 * pasaria el filtro y acabariamos ejecutando compose sobre un fichero de fuera.
 */
export async function checkComposeAccessibility(
  membership: { workingDir: string; configFiles: string[] },
  allowedRoots: string[],
): Promise<AccessibilityResult> {
  if (!membership.workingDir || membership.configFiles.length === 0) {
    return {
      accessible: false,
      resolvedFiles: [],
      resolvedWorkingDir: null,
      reason: 'El contenedor no declara el directorio ni los ficheros del proyecto',
    };
  }

  const roots = await resolveRoots(allowedRoots);

  try {
    const resolvedWorkingDir = await realpath(membership.workingDir);
    if (!isInsideAllowedRoots(resolvedWorkingDir, roots)) {
      return {
        accessible: false,
        resolvedFiles: [],
        resolvedWorkingDir: null,
        reason: `El directorio ${membership.workingDir} queda fuera de las carpetas permitidas`,
      };
    }

    const resolvedFiles: string[] = [];
    for (const file of membership.configFiles) {
      const real = await realpath(file);
      if (!isInsideAllowedRoots(real, roots)) {
        return {
          accessible: false,
          resolvedFiles: [],
          resolvedWorkingDir: null,
          reason: `El fichero ${file} queda fuera de las carpetas permitidas`,
        };
      }
      await access(real, constants.R_OK);
      resolvedFiles.push(real);
    }

    return { accessible: true, resolvedFiles, resolvedWorkingDir, reason: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT'
        ? 'No se encuentra el fichero del proyecto dentro del contenedor. ' +
          'Monta la carpeta de proyectos con la misma ruta que en el NAS.'
        : `No se puede leer el fichero del proyecto (${code ?? (error as Error).message})`;
    return { accessible: false, resolvedFiles: [], resolvedWorkingDir: null, reason };
  }
}

/**
 * Resuelve las carpetas permitidas a rutas reales.
 *
 * Las rutas de los proyectos se comparan tras pasar por `realpath`, asi que las
 * raices tienen que estar resueltas tambien o la comparacion nunca cuadra
 * cuando la ruta permitida atraviesa un enlace simbolico. Ocurre de verdad:
 * en macOS `/var` es un enlace a `/private/var`, y en un NAS es facil que
 * `/volume1/docker` sea un enlace a otro volumen.
 *
 * Si una raiz no existe se conserva normalizada: no vale rechazarla en
 * silencio, porque entonces un error tipografico en la configuracion se
 * manifestaria como "no encuentro ningun proyecto" sin decir por que.
 */
async function resolveRoots(roots: string[]): Promise<string[]> {
  return Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return resolve(root);
      }
    }),
  );
}

export function isInsideAllowedRoots(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root + sep));
}
