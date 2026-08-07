/**
 * Creacion y edicion de los ficheros de un proyecto.
 *
 * Es la unica parte de la aplicacion que ESCRIBE en el disco del anfitrion, asi
 * que aqui se concentran las reglas que impiden que un fallo o una entrada
 * maliciosa acaben tocando lo que no debe:
 *
 * 1. Al CREAR, todo cuelga de una unica carpeta raiz. El nombre se valida con
 *    una expresion estricta ANTES de construir ninguna ruta, y despues la ruta
 *    resultante se comprueba con `realpath`: validar el nombre no basta si la
 *    carpeta resulta ser un enlace simbolico que apunta a otro sitio.
 * 2. Al EDITAR, la ruta no la elegimos nosotros: viene del proyecto, y ya ha
 *    pasado por `checkComposeAccessibility`, que resuelve enlaces y comprueba
 *    que caiga dentro de las carpetas permitidas. Aqui solo se escribe sobre
 *    ficheros que ya existen, nunca se crean rutas nuevas.
 * 3. El `.env` se escribe con permisos 0600. No se puede cifrar en disco porque
 *    Compose tiene que leerlo (y tambien si algun dia se levanta el stack por
 *    SSH), pero al menos no queda legible para el resto del sistema.
 *
 * Se puede editar cualquier proyecto cuyo YAML sea accesible y cuya carpeta
 * admita escritura, lo haya creado esta aplicacion o no. Limitarlo a lo creado
 * aqui dejaba la funcionalidad inservible en un NAS real, donde los proyectos
 * los hizo el usuario desde Container Manager.
 */
import { access, chmod, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { EnvEntry, ProjectFiles, ProjectsDirInfo } from '@cu/shared';
import type { Repositories } from '../db/repositories/index.js';
import type { Logger } from '../logger.js';

/** Igual que `projectNameSchema`, repetida aqui porque es la ultima defensa. */
const SAFE_PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** El fichero se llama siempre igual: no hay motivo para dejarlo elegir. */
export const COMPOSE_FILENAME = 'docker-compose.yml';
export const ENV_FILENAME = '.env';

export class ProjectFilesError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not-writable'
      | 'invalid-name'
      | 'already-exists'
      | 'not-found'
      | 'not-editable'
      | 'outside-root',
  ) {
    super(message);
    this.name = 'ProjectFilesError';
  }
}

/**
 * Un proyecto ya resuelto, listo para leer o escribir sus ficheros.
 *
 * Se recibe resuelto en vez de buscarlo por nombre porque los nombres
 * colisionan: Container Manager los deriva de la carpeta y dos stacks distintos
 * pueden llamarse los dos `docker` (ADR-004). El fichero se toma tal cual lo
 * declara el proyecto, que no siempre se llama `docker-compose.yml`.
 */
export interface ProjectTarget {
  name: string;
  dir: string;
  composeFile: string;
}

/**
 * Si los ficheros de un proyecto se pueden editar, y si no, por que.
 *
 * Se calcula para todos los proyectos al refrescar el inventario, de forma que
 * la interfaz pueda explicar cada caso en vez de dejar un boton apagado sin
 * motivo, que es exactamente lo que hacia antes.
 */
export async function editability(project: {
  workingDir: string;
  configFiles: string[];
  yamlAccessible: boolean;
}): Promise<{ editable: boolean; reason: string | null }> {
  if (!project.yamlAccessible) {
    return { editable: false, reason: 'yaml-not-accessible' };
  }
  // Con varios ficheros no esta claro cual editar, y elegir uno por nuestra
  // cuenta seria adivinar sobre la configuracion del usuario.
  if (project.configFiles.length !== 1) {
    return { editable: false, reason: 'multiple-files' };
  }
  try {
    await access(project.workingDir, constants.W_OK | constants.X_OK);
    await access(project.configFiles[0]!, constants.W_OK);
  } catch {
    return { editable: false, reason: 'read-only-mount' };
  }
  return { editable: true, reason: null };
}

/**
 * Claves cuyo valor no se muestra sin pedirlo.
 *
 * Es deliberadamente generosa: ocultar de mas solo cuesta un clic, mientras que
 * ocultar de menos derrama una contrasena en una captura de pantalla. Se mira
 * el nombre y no el valor, porque un valor no dice nada de si mismo.
 */
const SECRET_KEY = /(PASS|PWD|SECRET|TOKEN|_KEY|^KEY|APIKEY|CREDENTIAL|AUTH|SALT|PRIVATE|SESSION|COOKIE|DSN|CONN)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/**
 * Parsea un `.env` a pares.
 *
 * No pretende cubrir toda la gramatica de Compose (interpolacion, multilinea):
 * solo lo suficiente para presentarlo como una lista y decidir que ocultar. El
 * fichero se guarda TAL CUAL lo escribe el usuario, asi que lo que este parser
 * no entienda no se pierde ni se reescribe.
 */
export function parseEnv(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    // Comillas envolventes: se quitan solo para mostrar, no para guardar.
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }

    entries.push({ key, value, secret: isSecretKey(key) });
  }

  return entries;
}

/** Oculta los valores marcados como secreto, conservando una pista del largo. */
export function maskEnv(entries: EnvEntry[]): EnvEntry[] {
  return entries.map((entry) =>
    entry.secret ? { ...entry, value: '•'.repeat(Math.min(entry.value.length, 12)) } : entry,
  );
}

export class ProjectFilesService {
  constructor(
    private readonly root: string | null,
    private readonly repos: Repositories,
    private readonly log: Logger,
  ) {}

  /**
   * Estado de la carpeta raiz.
   *
   * La interfaz lo consulta para decidir si ofrecer siquiera la creacion: es
   * mucho mejor explicar por que no se puede que dejar pulsar un boton que
   * fallara con un error de permisos.
   */
  async dirInfo(): Promise<ProjectsDirInfo> {
    if (!this.root) {
      return {
        path: null,
        writable: false,
        reason:
          'No hay ninguna carpeta con permiso de escritura donde crear proyectos. Monta una ' +
          'y apuntala con CU_PROJECTS_DIR.',
      };
    }

    try {
      await mkdir(this.root, { recursive: true });
      await access(this.root, constants.W_OK | constants.X_OK);
      return { path: this.root, writable: true, reason: null };
    } catch {
      return {
        path: this.root,
        writable: false,
        reason:
          `La carpeta ${this.root} no admite escritura desde el contenedor. Suele ser que ` +
          'esta montada en solo lectura, o que el usuario del contenedor no es su propietario.',
      };
    }
  }

  /**
   * Resuelve y comprueba la carpeta de un proyecto.
   *
   * El `realpath` no es paranoia de manual: si alguien deja un enlace simbolico
   * con el nombre del proyecto apuntando fuera de la raiz, validar solo el
   * nombre lo dejaria pasar. Se resuelve el padre porque la carpeta del
   * proyecto puede no existir todavia.
   */
  async resolveDir(name: string): Promise<string> {
    if (!SAFE_PROJECT_NAME.test(name)) {
      throw new ProjectFilesError(`Nombre de proyecto no valido: ${name}`, 'invalid-name');
    }
    const info = await this.dirInfo();
    if (!info.path || !info.writable) {
      throw new ProjectFilesError(info.reason ?? 'No se puede escribir', 'not-writable');
    }

    const realRoot = await realpath(info.path);
    const target = resolve(realRoot, name);

    // Si ya existe, se resuelve del todo; si no, basta con que su padre siga
    // siendo la raiz.
    let check: string;
    try {
      check = await realpath(target);
    } catch {
      check = resolve(await realpath(dirname(target)), name);
    }

    if (check !== realRoot && !check.startsWith(`${realRoot}/`)) {
      throw new ProjectFilesError(
        `La carpeta del proyecto quedaria fuera de ${realRoot}`,
        'outside-root',
      );
    }
    return check;
  }

  async create(input: {
    name: string;
    compose: string;
    env?: string;
    actorUserId: number | null;
  }): Promise<{ dir: string; composeFile: string }> {
    const dir = await this.resolveDir(input.name);

    if (this.repos.managedProjects.findByDir(dir)) {
      throw new ProjectFilesError(`Ya hay un proyecto en ${dir}`, 'already-exists');
    }
    // Tambien se comprueba el disco: la carpeta puede existir de antes aunque
    // la aplicacion no sepa nada de ella, y pisarla seria destructivo.
    try {
      await stat(dir);
      throw new ProjectFilesError(`La carpeta ${dir} ya existe`, 'already-exists');
    } catch (error) {
      if (error instanceof ProjectFilesError) throw error;
      // No existe, que es lo que queremos.
    }

    await mkdir(dir, { recursive: true });

    const composeFile = join(dir, COMPOSE_FILENAME);
    await writeFile(composeFile, normalizeText(input.compose), { mode: 0o644 });

    const env = input.env;
    if (env !== undefined && env.trim()) {
      await this.#writeEnv(join(dir, ENV_FILENAME), env);
    }

    this.repos.managedProjects.create({
      name: input.name,
      dir,
      createdBy: input.actorUserId,
      createdHere: true,
    });

    return { dir, composeFile };
  }

  /**
   * Deshace una creacion que no ha llegado a buen puerto.
   *
   * Solo para eso. Se vuelve a comprobar que la carpeta cuelga de la raiz antes
   * de borrar nada, porque un borrado recursivo con una ruta equivocada es el
   * peor fallo posible en toda esta clase, y una comprobacion de mas cuesta
   * microsegundos.
   */
  async discard(dir: string): Promise<void> {
    const info = await this.dirInfo();
    if (!info.path) return;

    const realRoot = await realpath(info.path);
    const target = resolve(dir);
    if (target === realRoot || !target.startsWith(`${realRoot}/`)) {
      this.log.warn(`Se rechaza limpiar ${target}: queda fuera de ${realRoot}`);
      return;
    }
    await rm(target, { recursive: true, force: true });
  }

  /** Lee los ficheros de un proyecto, con los secretos ya ocultos. */
  async read(target: ProjectTarget): Promise<ProjectFiles> {
    let compose: string;
    try {
      compose = await readFile(target.composeFile, 'utf8');
    } catch {
      throw new ProjectFilesError(`No se encuentra ${target.composeFile}`, 'not-found');
    }

    let env: EnvEntry[] = [];
    let envExists = false;
    try {
      env = maskEnv(parseEnv(await readFile(join(target.dir, ENV_FILENAME), 'utf8')));
      envExists = true;
    } catch {
      // Sin .env, que es perfectamente valido.
    }

    let writable = false;
    try {
      await access(target.dir, constants.W_OK);
      writable = true;
    } catch {
      // Se muestra igual, pero solo de lectura.
    }

    return { name: target.name, dir: target.dir, compose, env, envExists, writable };
  }

  /**
   * Devuelve UNA variable en claro.
   *
   * De una en una a proposito: quien necesita copiar una contrasena la necesita
   * concreta, y asi cada revelado es un evento de auditoria con nombre propio
   * en vez de un volcado del fichero entero.
   */
  async revealEnvValue(target: ProjectTarget, key: string): Promise<string | null> {
    try {
      const entries = parseEnv(await readFile(join(target.dir, ENV_FILENAME), 'utf8'));
      return entries.find((entry) => entry.key === key)?.value ?? null;
    } catch {
      return null;
    }
  }

  /** Devuelve el `.env` completo en texto, para editarlo. */
  async readEnvRaw(target: ProjectTarget): Promise<string> {
    try {
      return await readFile(join(target.dir, ENV_FILENAME), 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Guarda los ficheros, archivando antes lo que habia.
   *
   * El archivado va primero: si falla la escritura, la copia sobra y no estorba;
   * si fuera al reves, un fallo entre escribir y archivar dejaria el cambio
   * aplicado y sin forma de volver atras, que es el caso que importa.
   *
   * Vale para cualquier proyecto, creado aqui o no. Para los de fuera se crea la
   * fila al vuelo, porque hace falta algo de lo que colgar las versiones
   * archivadas, pero NO se marca como creado aqui: eso cambiaria si tiene que
   * seguir apareciendo cuando se queda sin contenedores.
   */
  async update(input: {
    target: ProjectTarget;
    compose: string;
    env?: string;
    actorUserId: number | null;
  }): Promise<{ dir: string }> {
    const { target } = input;

    // Se comprueba aqui tambien, y no solo en la ruta HTTP: es la ultima linea
    // antes de escribir, y un fallo de permisos a medias dejaria el compose
    // guardado y el .env no.
    const previousCompose = await readFile(target.composeFile, 'utf8').catch(() => null);
    if (previousCompose === null) {
      throw new ProjectFilesError(`No se encuentra ${target.composeFile}`, 'not-found');
    }
    try {
      await access(target.composeFile, constants.W_OK);
    } catch {
      throw new ProjectFilesError(
        `${target.composeFile} no admite escritura desde aqui. Suele ser que la carpeta esta ` +
          'montada en solo lectura.',
        'not-writable',
      );
    }

    const row = this.repos.managedProjects.ensure({
      name: target.name,
      dir: target.dir,
      actorUserId: input.actorUserId,
    });

    const envFile = join(target.dir, ENV_FILENAME);

    if (previousCompose !== normalizeText(input.compose)) {
      this.#archive(row.id, 'compose', previousCompose, input.actorUserId);
    }

    if (input.env !== undefined) {
      const previousEnv = await readFile(envFile, 'utf8').catch(() => null);
      if (previousEnv !== null && previousEnv !== normalizeText(input.env)) {
        this.#archive(row.id, 'env', previousEnv, input.actorUserId);
      }
    }

    await writeFile(target.composeFile, normalizeText(input.compose), { mode: 0o644 });

    if (input.env !== undefined) {
      if (input.env.trim()) {
        await this.#writeEnv(envFile, input.env);
      } else {
        // Vaciarlo del todo se interpreta como quitarlo, que es lo que espera
        // quien borra todo el contenido del editor.
        await rm(envFile, { force: true });
      }
    }

    this.repos.managedProjects.touch(row.id);
    return { dir: target.dir };
  }

  /**
   * Borra el registro, nunca los ficheros.
   *
   * Dejar de gestionar un proyecto no puede significar destruir su YAML ni sus
   * datos: lo que se pierde es la posibilidad de editarlo desde aqui, y eso se
   * deshace volviendo a crearlo. Borrar en cascada seria irreversible desde un
   * boton de la interfaz.
   */
  forget(dir: string): void {
    const row = this.repos.managedProjects.findByDir(dir);
    if (row) this.repos.managedProjects.remove(row.id);
  }

  /**
   * Proyectos gestionados que todavia no tienen ningun contenedor.
   *
   * Son los que el inventario no puede ver, porque lo deduce de las labels de
   * los contenedores. Sin esto, un proyecto cuyo primer arranque falla se
   * volveria invisible justo cuando hay que entrar a arreglar el YAML.
   */
  async listPending(knownDirs: Set<string>): Promise<Array<{ name: string; dir: string; configFiles: string[] }>> {
    const pending: Array<{ name: string; dir: string; configFiles: string[] }> = [];

    for (const row of this.repos.managedProjects.listCreatedHere()) {
      if (knownDirs.has(row.dir)) continue;
      const composeFile = join(row.dir, COMPOSE_FILENAME);
      try {
        await access(composeFile, constants.R_OK);
        pending.push({ name: row.name, dir: row.dir, configFiles: [composeFile] });
      } catch {
        // El fichero ya no esta: alguien lo borro por fuera. Se omite en vez de
        // mostrar un proyecto fantasma sobre el que nada funcionaria.
        this.log.warn(`El proyecto ${row.name} ya no tiene ${COMPOSE_FILENAME}, se omite`);
      }
    }

    return pending;
  }

  async #writeEnv(path: string, content: string): Promise<void> {
    // El modo va en la creacion Y ademas se fuerza despues: si el fichero ya
    // existia, `writeFile` respeta sus permisos actuales y el `mode` se ignora,
    // con lo que un `.env` creado antes a mano seguiria siendo legible por todos.
    await writeFile(path, normalizeText(content), { mode: 0o600 });
    await chmod(path, 0o600);
  }

  #archive(projectId: number, kind: 'compose' | 'env', content: string, actorUserId: number | null): void {
    const stored = this.repos.managedProjects.archive({ projectId, kind, content, actorUserId });
    if (!stored) {
      this.log.warn(
        `No se ha podido archivar la version anterior de ${kind}: el llavero esta bloqueado. ` +
          'El cambio se guarda igual, pero sin copia a la que volver.',
      );
      return;
    }
    this.repos.managedProjects.prune(projectId, kind);
  }
}

/** Salto de linea final y sin CRLF: un YAML con \r rompe compose en Linux. */
function normalizeText(text: string): string {
  const body = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return body.endsWith('\n') ? body : `${body}\n`;
}

/**
 * Elige donde crear los proyectos.
 *
 * Se prefiere lo que diga el usuario. Si no dice nada, se busca una carpeta con
 * permiso de escritura entre las de proyectos ya detectadas, porque el montaje
 * recomendado las pone en SOLO LECTURA: lo normal es que no haya ninguna y la
 * funcionalidad quede desactivada hasta que se monte una a proposito, que es
 * exactamente el comportamiento que se quiere. Ir escribiendo por defecto en la
 * carpeta donde viven los stacks de produccion seria mucho peor.
 */
export async function resolveProjectsDir(
  explicit: string | undefined,
  composeRoots: string[],
): Promise<string | null> {
  if (explicit) return explicit;

  for (const root of composeRoots) {
    try {
      await access(root, constants.W_OK | constants.X_OK);
      return root;
    } catch {
      // Solo lectura, que es lo esperable.
    }
  }
  return null;
}

/** Reexportado para los tests, que comprueban que no se cuela nada raro. */
export { SAFE_PROJECT_NAME, readdir };
