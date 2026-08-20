/**
 * Inventario: lee del daemon el estado real y lo refleja en la base de datos.
 *
 * Es la fuente de la que beben el panel, el checker y el bot. Se refresca a
 * menudo porque es barato (dos llamadas al socket) y evita mostrar
 * contenedores que ya no existen.
 */
import { hostname } from 'node:os';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import type {
  ComposeProject,
  ContainerState,
  ContainerSummary,
  HealthState,
  ImageUsage,
  TrackedImage,
  UpdateStrategy,
} from '@cu/shared';
import { buildReleaseInfo, updateHold } from '@cu/shared';
import type { DockerApi } from '../docker/api.js';
import type { ContainerListItem, ImageListItem } from '../docker/types.js';
import {
  checkComposeAccessibility,
  composeProjectKey,
  readComposeMembership,
} from '../docker/projects.js';
import { COMPOSE_FILENAME, editability } from './project-files.js';
import { digestsForRepository, parseImageReference } from '../registry/reference.js';
import { OCI_REVISION, OCI_SOURCE } from '../registry/manifest.js';
import { defaultTrackMode } from '../registry/semver.js';
import { DEFAULT_POLICY, type Repositories } from '../db/repositories/index.js';
import type { Logger } from '../logger.js';

export interface InventorySnapshot {
  containers: ContainerSummary[];
  projects: ComposeProject[];
  images: TrackedImage[];
  selfContainerId: string | null;
}

export class InventoryService {
  #snapshot: InventorySnapshot = {
    containers: [],
    projects: [],
    images: [],
    selfContainerId: null,
  };
  #selfContainerId: string | null = null;
  #selfResolved = false;

  constructor(
    private readonly docker: DockerApi,
    private readonly repos: Repositories,
    private readonly composeRoots: string[],
    private readonly log: Logger,
  ) {}

  get snapshot(): InventorySnapshot {
    return this.#snapshot;
  }

  /**
   * Lista las imagenes leyendo el estado de la base de datos.
   *
   * No se sirve `snapshot.images` porque ese cache se construye al refrescar
   * desde Docker, mientras que el resultado de las comprobaciones lo escribe el
   * checker directamente en la base de datos. Servir el cache mostraria "sin
   * comprobar" justo despues de una comprobacion que si encontro novedades.
   * SQLite es local: leer aqui cuesta microsegundos.
   */
  listImages(): TrackedImage[] {
    const usage = new Map<string, string[]>();
    const runningUsage = new Map<string, string[]>();
    for (const container of this.#snapshot.containers) {
      const ref = container.imageRef;
      if (!ref) continue;
      const list = usage.get(ref);
      if (list) list.push(container.name);
      else usage.set(ref, [container.name]);

      if (container.state === 'running') {
        const live = runningUsage.get(ref);
        if (live) live.push(container.name);
        else runningUsage.set(ref, [container.name]);
      }
    }

    const settings = this.repos.settings.getAll();
    const policies = this.repos.inventory.getAllPolicies();

    return this.repos.inventory.listImages().map((row) => {
      const policy = policies.get(row.normalized_ref) ?? {
        imageRef: row.normalized_ref,
        ...DEFAULT_POLICY,
      };
      const status =
        row.source === 'pinned' ? 'pinned' : row.source === 'local-build' ? 'unknown' : row.status;

      const release = buildReleaseInfo({
        // El origen de la version instalada vale como respaldo: muchas imagenes
        // lo llevan igual en las dos, y sin el no habria enlace ninguno.
        sourceUrl: row.remote_source_url ?? row.local_source_url,
        localRevision: row.local_revision,
        remoteRevision: row.remote_revision,
        remoteVersion: row.remote_version,
        publishedAt: row.remote_created_at,
      });

      return {
      installedVersion: row.installed_version,
      installedVersionMethod: row.installed_version_method as TrackedImage['installedVersionMethod'],
      installedVersionAliases: parseJsonArray(row.installed_version_aliases ?? '[]'),
      ref: row.normalized_ref,
      host: row.host,
      repository: row.repository,
      tag: row.tag,
      imageId: row.image_id,
      architecture: row.architecture,
      os: row.os,
      variant: row.variant,
      localDigests: parseJsonArray(row.local_digests),
      source: row.source,
      sizeBytes: row.size_bytes,
      imageCreatedAt: row.image_created_at,
      status,
      remoteDigest: row.remote_digest,
      candidateTag: row.candidate_tag,
      lastCheckedAt: row.last_checked_at,
      lastError: row.last_error,
      inUseBy: usage.get(row.normalized_ref) ?? [],
      inUseByRunning: runningUsage.get(row.normalized_ref) ?? [],
      usage: usageOf(
        usage.get(row.normalized_ref) ?? [],
        runningUsage.get(row.normalized_ref) ?? [],
      ),
      policy,
      release,
      // Solo tiene sentido explicar la retencion de lo que de verdad iba a
      // actualizarse solo: en el resto seria una advertencia sobre algo que no
      // iba a pasar de todas formas.
      hold:
        status === 'update-available' && policy.autoUpdate && settings.autoUpdateEnabled
          ? updateHold({
              policy,
              settings,
              publishedAt: row.remote_created_at,
              now: Date.now(),
            })
          : null,
      canRollback: this.repos.history.findRollbackPoint(row.normalized_ref) !== null,
      };
    });
  }

  /**
   * Referencias con version nueva, leidas de la base de datos.
   *
   * Se consulta al servir y no se guarda en el snapshot por la misma razon que
   * `listImages` no sirve el cache: el estado lo escribe el COMPROBADOR
   * directamente en la base de datos, mientras que el snapshot se reconstruye
   * solo al refrescar el inventario. Servir el cache enseñaria el estado de
   * hace hasta cinco minutos.
   */
  #updatableRefs(): Set<string> {
    const refs = new Set<string>();
    for (const row of this.repos.inventory.listImages()) {
      if (row.status === 'update-available') refs.add(row.normalized_ref);
    }
    return refs;
  }

  /**
   * Contenedores con su estado de actualizacion al dia.
   *
   * El cruce va por `imageRef` (la referencia normalizada) y nunca por `image`,
   * que es lo que dice el daemon: comprobado en un entorno real, de 21
   * contenedores solo coincidian 3.
   */
  listContainers(): ContainerSummary[] {
    const updatable = this.#updatableRefs();
    return this.#snapshot.containers.map((container) => ({
      ...container,
      updateAvailable: container.imageRef !== null && updatable.has(container.imageRef),
    }));
  }

  /**
   * Proyectos con su cuenta de actualizaciones RECALCULADA.
   *
   * Existe por un fallo concreto: la tarjeta decia "2 actualizaciones" mientras
   * ninguno de sus servicios aparecia marcado, porque los dos numeros venian de
   * sitios distintos. La cuenta salia del snapshot, calculada al refrescar el
   * inventario y ademas ANTES de que ese mismo refresco reconciliara el estado
   * de las imagenes, asi que iba siempre un ciclo por detras; las marcas de cada
   * servicio salian de la lista de imagenes, que si se lee fresca.
   *
   * Al terminar de actualizar un proyecto el efecto era el peor posible: la
   * cabecera seguia anunciando actualizaciones pendientes y no habia ni una que
   * enseñar.
   *
   * Ahora las dos cosas salen del mismo sitio y no pueden discrepar.
   */
  listProjects(): ComposeProject[] {
    const updatable = this.#updatableRefs();
    return this.#snapshot.projects.map((project) => {
      const containers = project.containers.map((container) => ({
        ...container,
        updateAvailable: container.imageRef !== null && updatable.has(container.imageRef),
      }));
      return {
        ...project,
        containers,
        updatesAvailable: containers.filter((container) => container.updateAvailable).length,
      };
    });
  }

  get selfContainerId(): string | null {
    return this.#selfContainerId;
  }

  async refresh(): Promise<InventorySnapshot> {
    const startedAt = Date.now();

    const [containers, images] = await Promise.all([
      this.docker.listContainers(true),
      this.docker.listImages(),
    ]);

    await this.#resolveSelf(containers);

    const summaries = containers.map((container) => this.#toSummary(container));
    await this.#enrichStopped(summaries);

    // Las imagenes ANTES que los proyectos, y el orden no es indiferente:
    // `#syncImages` es quien reconcilia el estado tras una actualizacion (marca
    // al dia lo que ya tiene el digest nuevo), y `#buildProjects` cuenta cuantas
    // actualizaciones tiene cada proyecto leyendo justamente ese estado. Al
    // reves, la cuenta describia el mundo anterior a la actualizacion que se
    // acababa de aplicar.
    const trackedImages = this.#syncImages(images, containers);
    const projects = await this.#buildProjects(containers, summaries);

    // Se limpia lo que ya no existe. El margen de un segundo evita que una
    // fila escrita en este mismo ciclo se considere obsoleta.
    this.repos.inventory.pruneImagesNotSeenSince(startedAt - 1000);
    this.repos.inventory.pruneProjectsNotVerifiedSince(startedAt - 1000);

    this.#snapshot = {
      containers: summaries,
      projects,
      images: trackedImages,
      selfContainerId: this.#selfContainerId,
    };
    return this.#snapshot;
  }

  /**
   * Averigua cual de los contenedores somos nosotros.
   *
   * Hace falta para rechazar la auto-actualizacion: si nos actualizamos a
   * nosotros mismos, el proceso muere a mitad y deja el contenedor en un estado
   * indeterminado.
   *
   * Se prueban dos vias porque ninguna es fiable por si sola: el hostname
   * coincide con el id corto solo si nadie lo ha cambiado en el compose, y
   * `/proc/self/mountinfo` lleva el id en el path del overlay solo en algunos
   * runtimes.
   */
  async #resolveSelf(containers: ContainerListItem[]): Promise<void> {
    if (this.#selfResolved) return;
    this.#selfResolved = true;

    const host = hostname();
    const byHostname = containers.find((c) => c.Id.startsWith(host));
    if (byHostname) {
      this.#selfContainerId = byHostname.Id;
      this.log.debug(`Contenedor propio detectado por hostname: ${byHostname.Id.slice(0, 12)}`);
      return;
    }

    for (const file of ['/proc/self/mountinfo', '/proc/self/cgroup']) {
      try {
        const content = await readFile(file, 'utf8');
        const match = /\b([0-9a-f]{64})\b/.exec(content);
        if (match?.[1]) {
          const found = containers.find((c) => c.Id === match[1]);
          if (found) {
            this.#selfContainerId = found.Id;
            this.log.debug(`Contenedor propio detectado por ${file}`);
            return;
          }
        }
      } catch {
        // Fuera de un contenedor estos ficheros no existen o no dicen nada.
      }
    }

    this.log.debug('No se ha podido identificar el contenedor propio (probablemente fuera de Docker)');
  }

  /**
   * Completa los datos que el listado no trae, solo donde hacen falta.
   *
   * `/containers/json` no devuelve ni el codigo de salida ni el contador de
   * reinicios: hay que inspeccionar. Se inspecciona SOLO lo que no esta
   * corriendo o esta reiniciando, que en un NAS normal son dos o tres
   * contenedores, en vez de los veinticuatro. Es lo que separa "lo pare yo"
   * (codigo 0) de "se ha caido", y sin ese dato la vigilancia avisaria cada vez
   * que alguien para algo a proposito.
   */
  async #enrichStopped(summaries: ContainerSummary[]): Promise<void> {
    const suspicious = summaries.filter(
      (container) => container.state !== 'running' || container.health === 'unhealthy',
    );
    // Tope por si algun dia hay un monton de contenedores muertos: mejor
    // quedarse corto que convertir el refresco en cien peticiones.
    for (const container of suspicious.slice(0, 50)) {
      try {
        const inspect = await this.docker.inspectContainer(container.id);
        container.exitCode = inspect.State?.ExitCode ?? null;
        container.restartCount = inspect.RestartCount ?? 0;
        const startedAt = inspect.State?.StartedAt;
        if (startedAt) {
          const ms = Date.parse(startedAt);
          if (Number.isFinite(ms) && ms > 0) container.startedAt = ms;
        }
      } catch {
        // Un contenedor puede desaparecer entre el listado y el inspect. No es
        // un error: simplemente no habra dato.
      }
    }
  }

  #toSummary(container: ContainerListItem): ContainerSummary {
    const membership = readComposeMembership(container);
    const name = (container.Names[0] ?? '').replace(/^\//, '');

    return {
      id: container.Id,
      name,
      image: container.Image,
      imageRef: safeNormalize(container.Image),
      imageId: container.ImageID,
      state: normalizeState(container.State),
      status: container.Status,
      health: readHealth(container.Status),
      createdAt: container.Created * 1000,
      startedAt: null,
      restartCount: 0,
      exitCode: null,
      ports: (container.Ports ?? []).map((port) => ({
        ip: port.IP,
        privatePort: port.PrivatePort,
        publicPort: port.PublicPort,
        type: port.Type,
      })),
      projectKey: membership?.key ?? null,
      projectName: membership?.projectName ?? null,
      serviceName: membership?.serviceName ?? null,
      isSelf: container.Id === this.#selfContainerId,
      // Se rellena al servir, no aqui: el estado de las imagenes lo escribe el
      // comprobador en la base de datos y cambia sin que el inventario se
      // refresque.
      updateAvailable: false,
    };
  }

  async #buildProjects(
    containers: ContainerListItem[],
    summaries: ContainerSummary[],
  ): Promise<ComposeProject[]> {
    const grouped = new Map<
      string,
      { name: string; workingDir: string; configFiles: string[]; members: ContainerSummary[] }
    >();

    for (const [index, container] of containers.entries()) {
      const membership = readComposeMembership(container);
      const summary = summaries[index];
      if (!membership || !summary) continue;

      const existing = grouped.get(membership.key);
      if (existing) {
        existing.members.push(summary);
      } else {
        grouped.set(membership.key, {
          name: membership.projectName,
          workingDir: membership.workingDir,
          configFiles: membership.configFiles,
          members: [summary],
        });
      }
    }

    const imagesByRef = new Map(this.repos.inventory.listImages().map((row) => [row.normalized_ref, row]));
    const managedDirs = new Set(
      this.repos.managedProjects.listCreatedHere().map((row) => row.dir),
    );
    const projects: ComposeProject[] = [];

    for (const [key, group] of grouped) {
      const check = await checkComposeAccessibility(
        { workingDir: group.workingDir, configFiles: group.configFiles },
        this.composeRoots,
      );

      this.repos.inventory.upsertProject({
        name: group.name,
        workingDir: group.workingDir,
        configFiles: group.configFiles,
        yamlAccessible: check.accessible,
        error: check.reason,
      });

      let updatesAvailable = 0;
      for (const member of group.members) {
        const ref = safeNormalize(member.image);
        if (ref && imagesByRef.get(ref)?.status === 'update-available') updatesAvailable += 1;
      }

      const strategy: UpdateStrategy = check.accessible ? 'compose' : 'recreate';
      const edit = await editability({
        workingDir: group.workingDir,
        configFiles: group.configFiles,
        yamlAccessible: check.accessible,
      });

      projects.push({
        key,
        name: group.name,
        workingDir: group.workingDir,
        configFiles: group.configFiles,
        yamlAccessible: check.accessible,
        strategy,
        containers: group.members,
        updatesAvailable,
        managed: managedDirs.has(group.workingDir),
        editable: edit.editable,
        editableReason: edit.reason as ComposeProject['editableReason'],
      });
    }

    projects.push(...(await this.#pendingProjects(grouped)));

    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects;
  }

  /**
   * Proyectos creados aqui que todavia no tienen ningun contenedor.
   *
   * Los proyectos salen de las labels de los contenedores, asi que uno recien
   * creado (o uno cuyo primer arranque ha fallado) no aparece por ningun lado.
   * Sin esto quedaria invisible justo cuando hay que entrar a corregir el YAML,
   * que es cuando mas falta hace verlo.
   */
  async #pendingProjects(
    running: Map<string, { workingDir: string }>,
  ): Promise<ComposeProject[]> {
    const activeDirs = new Set([...running.values()].map((group) => group.workingDir));
    const pending: ComposeProject[] = [];

    for (const row of this.repos.managedProjects.list()) {
      if (activeDirs.has(row.dir)) continue;

      const composeFile = join(row.dir, COMPOSE_FILENAME);
      try {
        await access(composeFile, constants.R_OK);
      } catch {
        // Alguien ha borrado el fichero por fuera. Mostrar el proyecto solo
        // llevaria a que todas sus acciones fallasen sin explicar por que.
        continue;
      }

      const check = await checkComposeAccessibility(
        { workingDir: row.dir, configFiles: [composeFile] },
        this.composeRoots,
      );

      const edit = await editability({
        workingDir: row.dir,
        configFiles: [composeFile],
        yamlAccessible: check.accessible,
      });

      pending.push({
        key: composeProjectKey(row.name, row.dir),
        name: row.name,
        workingDir: row.dir,
        configFiles: [composeFile],
        yamlAccessible: check.accessible,
        strategy: check.accessible ? 'compose' : 'recreate',
        containers: [],
        updatesAvailable: 0,
        managed: true,
        editable: edit.editable,
        editableReason: edit.reason as ComposeProject['editableReason'],
      });
    }

    return pending;
  }

  /**
   * Sincroniza las imagenes.
   *
   * Se registran las que usa algun contenedor Y las que no usa ninguno. Las
   * segundas no se comprueban contra el registry (`inUse: false`), porque
   * preguntar por la version nueva de algo que nadie ejecuta gasta cuota para
   * nada, pero si se listan: son las que ocupan disco y las que el usuario
   * quiere poder borrar.
   */
  #syncImages(images: ImageListItem[], containers: ContainerListItem[]): TrackedImage[] {
    const usedRefs = new Map<string, string[]>();
    const runningRefs = new Map<string, string[]>();
    for (const container of containers) {
      const ref = safeNormalize(container.Image);
      if (!ref) continue;
      const name = (container.Names[0] ?? '').replace(/^\//, '');
      const list = usedRefs.get(ref);
      if (list) list.push(name);
      else usedRefs.set(ref, [name]);

      if (normalizeState(container.State) === 'running') {
        const live = runningRefs.get(ref);
        if (live) live.push(name);
        else runningRefs.set(ref, [name]);
      }
    }

    /**
     * Imagenes con etiqueta que no usa ningun contenedor.
     *
     * Se dejan fuera las colgantes (`<none>:<none>`, sin etiqueta util): no
     * tienen referencia con la que identificarlas, que es la clave primaria de
     * la tabla, y mostrarlas exigiria un modelo distinto. Para esas sigue
     * estando `docker image prune`.
     */
    for (const image of images) {
      for (const tag of image.RepoTags ?? []) {
        if (tag.endsWith('<none>') || tag.startsWith('<none>')) continue;
        const ref = safeNormalize(tag);
        if (ref && !usedRefs.has(ref)) usedRefs.set(ref, []);
      }
    }

    const byId = new Map(images.map((image) => [image.Id, image]));
    const byTag = new Map<string, ImageListItem>();
    for (const image of images) {
      for (const tag of image.RepoTags ?? []) {
        const normalized = safeNormalize(tag);
        if (normalized) byTag.set(normalized, image);
      }
    }

    const result: TrackedImage[] = [];
    const policies = this.repos.inventory.getAllPolicies();

    for (const [normalizedRef, usedBy] of usedRefs) {
      const parsed = parseImageReference(normalizedRef);
      const image = byTag.get(normalizedRef);
      const localDigests = digestsForRepository(image?.RepoDigests, parsed);

      // Sin digests de repositorio la imagen se construyo aqui: no hay nada
      // remoto con lo que compararla, y hacer pull bajaria una imagen ajena que
      // casualmente se llame igual en Docker Hub.
      const source = parsed.digest !== null
        ? 'pinned'
        : localDigests.length === 0
          ? 'local-build'
          : 'registry';

      this.repos.inventory.upsertImage({
        ref: normalizedRef,
        host: parsed.host,
        repository: parsed.repository,
        tag: parsed.tag,
        imageId: image?.Id ?? null,
        architecture: null,
        os: null,
        variant: null,
        localDigests,
        source,
        sizeBytes: image?.Size ?? null,
        imageCreatedAt: image ? image.Created * 1000 : null,
        // Las etiquetas OCI de la imagen instalada vienen ya en el listado, sin
        // un inspect por imagen. Son la mitad local de la comparacion de
        // commits que se le ofrece al usuario cuando hay version nueva.
        localSourceUrl: image?.Labels?.[OCI_SOURCE] ?? null,
        localRevision: image?.Labels?.[OCI_REVISION] ?? null,
        inUse: usedBy.length > 0,
      });

      // Al descubrir una imagen nueva se le asigna el modo de seguimiento que
      // corresponde a su etiqueta, en vez de dejar a todas en `digest`.
      if (!policies.has(normalizedRef)) {
        const policy = this.repos.inventory.getPolicy(normalizedRef);
        this.repos.inventory.savePolicy({ ...policy, trackMode: defaultTrackMode(parsed.tag) });
      }

      let row = this.repos.inventory.findImage(normalizedRef);
      if (!row) continue;

      /**
       * Reconciliacion del estado tras una actualizacion.
       *
       * El estado lo escribe el comprobador, asi que despues de actualizar una
       * imagen seguiria diciendo "actualizacion disponible" y el boton no
       * desapareceria hasta la siguiente comprobacion programada, que puede
       * tardar horas.
       *
       * Si el digest remoto que motivo el aviso ya esta entre los locales, la
       * actualizacion se aplico y no hay nada pendiente. Es una conclusion
       * exacta, no una suposicion, y no cuesta ninguna peticion al registry.
       */
      if (
        row.status === 'update-available' &&
        row.remote_digest &&
        localDigests.includes(row.remote_digest)
      ) {
        this.repos.inventory.recordCheck({
          ref: normalizedRef,
          status: 'up-to-date',
          remoteDigest: row.remote_digest,
          // El candidato de version deja de aplicar: si lo hubiera, la etiqueta
          // habria cambiado y esta seria otra referencia distinta.
          candidateTag: null,
          error: null,
        });
        row = this.repos.inventory.findImage(normalizedRef) ?? row;
      }

      result.push({
        ref: row.normalized_ref,
        host: row.host,
        repository: row.repository,
        tag: row.tag,
        imageId: row.image_id,
        architecture: row.architecture,
        os: row.os,
        variant: row.variant,
        localDigests,
        source: row.source,
        sizeBytes: row.size_bytes,
        imageCreatedAt: row.image_created_at,
        installedVersion: row.installed_version,
        installedVersionMethod: row.installed_version_method as TrackedImage['installedVersionMethod'],
        installedVersionAliases: parseJsonArray(row.installed_version_aliases ?? '[]'),
        release: buildReleaseInfo({
          sourceUrl: row.remote_source_url ?? row.local_source_url,
          localRevision: row.local_revision,
          remoteRevision: row.remote_revision,
          remoteVersion: row.remote_version,
          publishedAt: row.remote_created_at,
        }),
        hold: null,
        canRollback: this.repos.history.findRollbackPoint(normalizedRef) !== null,
        // Se lee de la fila, no de la heuristica local: la fila puede llevar
        // un `local-build` confirmado por el registry que no se debe perder.
        status:
          row.source === 'pinned' ? 'pinned' : row.source === 'local-build' ? 'unknown' : row.status,
        remoteDigest: row.remote_digest,
        candidateTag: row.candidate_tag,
        lastCheckedAt: row.last_checked_at,
        lastError: row.last_error,
        inUseBy: usedBy,
        inUseByRunning: runningRefs.get(normalizedRef) ?? [],
        usage: usageOf(usedBy, runningRefs.get(normalizedRef) ?? []),
        policy: this.repos.inventory.getPolicy(normalizedRef),
      });
    }

    void byId;

    result.sort((a, b) => a.ref.localeCompare(b.ref));
    return result;
  }
}

/**
 * Relacion de una imagen con los contenedores que la usan.
 *
 * Es lo que decide si se puede borrar y con que consecuencias, asi que se
 * calcula en un solo sitio y se reutiliza en los dos caminos que construyen
 * `TrackedImage` (el que lee de Docker y el que lee de la base de datos).
 */
export function usageOf(all: string[], running: string[]): ImageUsage {
  if (running.length > 0) return 'running';
  if (all.length > 0) return 'stopped';
  return 'orphan';
}

function parseJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function safeNormalize(reference: string): string | null {
  try {
    return parseImageReference(reference).normalized;
  } catch {
    return null;
  }
}

function normalizeState(state: string): ContainerState {
  const known: ContainerState[] = [
    'created',
    'running',
    'paused',
    'restarting',
    'removing',
    'exited',
    'dead',
  ];
  const lower = state.toLowerCase() as ContainerState;
  return known.includes(lower) ? lower : 'exited';
}

/** El estado de salud viene embebido en el texto de Status: "Up 2 hours (healthy)". */
function readHealth(status: string): HealthState {
  if (status.includes('(healthy)')) return 'healthy';
  if (status.includes('(unhealthy)')) return 'unhealthy';
  if (status.includes('(health: starting)')) return 'starting';
  return 'none';
}
