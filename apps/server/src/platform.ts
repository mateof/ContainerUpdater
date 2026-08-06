/**
 * Deteccion del entorno donde corre la aplicacion.
 *
 * Esto existe porque los valores por defecto razonables cambian por completo
 * entre un Synology, un TrueNAS, un Unraid y un portatil con Podman, y obligar
 * a configurarlos a mano en cada sitio es una fuente de "no me detecta nada" sin
 * ninguna pista de por que.
 *
 * Dos limitaciones que condicionan el diseno:
 *
 * 1. La aplicacion corre DENTRO de un contenedor, asi que los ficheros que
 *    identifican al sistema anfitrion (`/etc/synoinfo.conf`, `/etc/unraid-version`)
 *    no se ven salvo que alguien los monte. Solo se puede mirar lo que si esta
 *    montado.
 * 2. Lo unico que se conoce con certeza es lo que responde el daemon y las rutas
 *    que declaran los propios contenedores en sus labels de Compose. Eso ultimo
 *    resulta ser la senal mas fiable: no es una suposicion sobre la plataforma,
 *    es donde el sistema dice que estan sus proyectos.
 */
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';

export type PlatformId =
  | 'synology'
  | 'truenas'
  | 'unraid'
  | 'omv'
  | 'linux'
  | 'podman'
  | 'unknown';

export interface PlatformInfo {
  id: PlatformId;
  name: string;
  /** Como se ha llegado a esa conclusion, para poder mostrarlo. */
  evidence: string | null;
  /**
   * Si el soporte esta comprobado de verdad o solo declarado a partir de la
   * documentacion de la plataforma. Se muestra tal cual: dar por verificado lo
   * que no se ha probado es peor que no decir nada.
   */
  verified: boolean;
}

/**
 * Sockets donde suele escuchar un runtime, en orden de probabilidad.
 *
 * El de Docker va primero porque es el caso mayoritario. Los de Podman
 * despues, y el rootless al final porque depende de la sesion del usuario.
 */
export function candidateSockets(env: NodeJS.ProcessEnv = process.env): string[] {
  const runtimeDir = env.XDG_RUNTIME_DIR;
  return [
    '/var/run/docker.sock',
    '/run/docker.sock',
    '/run/podman/podman.sock',
    ...(runtimeDir ? [`${runtimeDir}/podman/podman.sock`] : []),
    '/var/run/podman/podman.sock',
  ];
}

/**
 * Busca un socket de runtime utilizable.
 *
 * Se comprueba que se pueda LEER Y ESCRIBIR, no solo que el fichero exista: un
 * socket montado sin permisos es el fallo mas comun al desplegar, y detectarlo
 * aqui permite decirlo con claridad en vez de fallar despues en cada llamada.
 */
export async function findSocket(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string; readable: boolean } | null> {
  for (const candidate of candidateSockets(env)) {
    try {
      const info = await stat(candidate);
      if (!info.isSocket()) continue;
      try {
        await access(candidate, constants.R_OK | constants.W_OK);
        return { path: candidate, readable: true };
      } catch {
        // Existe pero no se puede usar: se devuelve igualmente para poder
        // explicar que el problema son los permisos y no la ruta.
        return { path: candidate, readable: false };
      }
    } catch {
      // No existe: se prueba el siguiente.
    }
  }
  return null;
}

/** Marcadores visibles desde dentro del contenedor cuando se monta el volumen. */
const MARKERS: Array<{ path: string; id: PlatformId; name: string; verified: boolean }> = [
  { path: '/volume1', id: 'synology', name: 'Synology DSM', verified: true },
  { path: '/mnt/user', id: 'unraid', name: 'Unraid', verified: false },
  { path: '/mnt/.ix-apps', id: 'truenas', name: 'TrueNAS SCALE', verified: false },
  { path: '/srv/dev-disk-by-uuid', id: 'omv', name: 'OpenMediaVault', verified: false },
];

/**
 * Deduce la plataforma.
 *
 * Se combinan tres senales, de mas a menos fiable: las rutas que declaran los
 * proyectos de Compose, los volumenes montados y el propio runtime.
 */
export async function detectPlatform(
  projectDirs: string[],
  flavor: 'docker' | 'podman' | 'unknown',
): Promise<PlatformInfo> {
  // 1. Las rutas de los proyectos. Es la senal mas fuerte porque no es una
  //    suposicion: es donde el sistema dice que estan sus stacks.
  for (const dir of projectDirs) {
    if (dir.startsWith('/volume')) {
      return {
        id: 'synology',
        name: 'Synology DSM',
        evidence: `proyectos en ${dir}`,
        verified: true,
      };
    }
    if (dir.startsWith('/mnt/user/')) {
      return { id: 'unraid', name: 'Unraid', evidence: `proyectos en ${dir}`, verified: false };
    }
    if (dir.startsWith('/mnt/.ix-apps') || /^\/mnt\/[^/]+\/ix-/.test(dir)) {
      return {
        id: 'truenas',
        name: 'TrueNAS SCALE',
        evidence: `proyectos en ${dir}`,
        verified: false,
      };
    }
  }

  // 2. Volumenes montados dentro del contenedor.
  for (const marker of MARKERS) {
    try {
      const info = await stat(marker.path);
      if (info.isDirectory()) {
        return {
          id: marker.id,
          name: marker.name,
          evidence: `${marker.path} esta montado`,
          verified: marker.verified,
        };
      }
    } catch {
      // No esta montado.
    }
  }

  // 3. El runtime, que al menos distingue Podman de Docker.
  if (flavor === 'podman') {
    return { id: 'podman', name: 'Podman', evidence: 'lo indica el daemon', verified: true };
  }
  if (flavor === 'docker') {
    return { id: 'linux', name: 'Docker', evidence: 'lo indica el daemon', verified: true };
  }

  return { id: 'unknown', name: 'Desconocido', evidence: null, verified: false };
}

/**
 * Deriva las carpetas donde se acepta ejecutar Compose a partir de donde estan
 * los proyectos de verdad.
 *
 * Es mejor que una tabla de rutas por plataforma: funciona igual en un Synology,
 * en un Unraid o en un portatil, porque no adivina nada.
 *
 * La regla es: se sube al directorio padre SOLO cuando ese padre agrupa dos o
 * mas proyectos; si no, se usa la carpeta del proyecto tal cual. Subir siempre
 * parecia mas comodo (asi un stack nuevo en la misma carpeta funciona sin
 * reiniciar) pero se comporta fatal en cuanto alguien tiene un proyecto suelto:
 * probado contra una maquina real con diez proyectos, uno de ellos colgando
 * directamente del home, la lista entera colapsaba en el home del usuario y se
 * llevaba por delante a los otros nueve. Con la regla de agrupacion se mantiene
 * la comodidad donde importa (en un NAS todos los stacks cuelgan de la misma
 * carpeta, asi que sigue saliendo esa carpeta) sin ese efecto.
 *
 * Sobre seguridad: estas rutas son el filtro que impide ejecutar Compose fuera
 * de sitio, y aqui salen de labels que controla quien creo el contenedor. No
 * amplia el riesgo de forma significativa (quien puede poner labels arbitrarias
 * ya tiene el socket, o sea control total de la maquina), pero por si acaso solo
 * se aceptan rutas que existan y sean legibles, y el resultado se muestra en el
 * diagnostico para que se vea. Definir CU_COMPOSE_ROOTS desactiva esta
 * deduccion por completo.
 */
export async function deriveComposeRoots(projectDirs: string[]): Promise<string[]> {
  const dirs = [...new Set(projectDirs.filter((dir) => dir && dir.startsWith('/')))];

  const siblings = new Map<string, number>();
  for (const dir of dirs) {
    const parent = dirname(dir);
    siblings.set(parent, (siblings.get(parent) ?? 0) + 1);
  }

  const candidates = new Set<string>();
  for (const dir of dirs) {
    const parent = dirname(dir);
    // La raiz del sistema como carpeta permitida equivaldria a no tener filtro.
    const groups = (siblings.get(parent) ?? 0) >= 2 && parent !== '/' && parent !== '.';
    candidates.add(groups ? parent : dir);
  }

  const usable: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      usable.push(candidate);
    } catch {
      // Declarada por un contenedor pero no montada aqui: inutil.
    }
  }

  // Se descartan las que ya cuelgan de otra permitida, para no repetir.
  return usable
    .sort((a, b) => a.length - b.length)
    .filter((path, index, all) => !all.slice(0, index).some((other) => path.startsWith(`${other}/`)));
}
