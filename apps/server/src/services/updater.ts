/**
 * Aplicacion de actualizaciones.
 *
 * Estrategia hibrida: si el proyecto de compose es accesible se actualiza con
 * `docker compose`, que es exactamente lo que haria Container Manager y lo deja
 * consistente con su vista. Si no lo es, se recrea el contenedor por la API.
 *
 * Los trabajos se ejecutan de uno en uno a nivel global. Dos invocaciones
 * concurrentes de compose sobre el mismo proyecto corrompen su estado, y un NAS
 * tampoco tiene CPU para dos descargas en paralelo.
 */
import type { RecreateScope, UpdateJob, UpdateMode, UpdateStrategy } from '@cu/shared';
import { ComposeRunner, ComposeError, UnsafePathError } from '../docker/compose.js';
import { ContainerRecreator, RecreateUnsupportedError } from '../docker/recreate.js';
import { parseImageReference } from '../registry/reference.js';
import { readComposeMembership } from '../docker/projects.js';
import type { DockerApi } from '../docker/api.js';
import type { Repositories } from '../db/repositories/index.js';
import type { InventoryService } from './inventory.js';
import type { Logger } from '../logger.js';

export class SelfUpdateRejectedError extends Error {
  constructor() {
    super(
      'ContainerUpdater no puede actualizarse a si mismo: el proceso moriria a mitad. ' +
        'Hazlo desde Container Manager.',
    );
    this.name = 'SelfUpdateRejectedError';
  }
}

export class UpdateInProgressError extends Error {
  constructor() {
    super('Ya hay una actualizacion en curso');
    this.name = 'UpdateInProgressError';
  }
}

export interface UpdateRequest {
  imageRef: string;
  mode: UpdateMode;
  scope?: RecreateScope;
  removeImageFirst?: boolean;
  targetTag?: string;
  trigger: 'manual' | 'auto' | 'telegram';
  actorUserId?: number | null;
  actorChatId?: number | null;
}

export type JobListener = (job: UpdateJob) => void;

/**
 * Tope de trabajos en espera. Un NAS no va a actualizar cincuenta imagenes de
 * golpe, y sin tope un bucle de reintentos podria llenar la cola sin que nadie
 * se entere.
 */
const MAX_QUEUE = 20;

interface QueuedEntry {
  jobId: number;
  request: UpdateRequest;
  plan: Awaited<ReturnType<UpdaterService['planFor']>>;
  resolve: (job: UpdateJob) => void;
  reject: (error: unknown) => void;
}

export class UpdaterService {
  #busy = false;
  #currentJobId: number | null = null;
  readonly #queue: QueuedEntry[] = [];
  readonly #listeners = new Set<JobListener>();
  readonly #finishListeners = new Set<JobListener>();

  constructor(
    private readonly docker: DockerApi,
    private readonly repos: Repositories,
    private readonly inventory: InventoryService,
    private readonly compose: ComposeRunner,
    private readonly recreator: ContainerRecreator,
    private readonly log: Logger,
  ) {}

  get busy(): boolean {
    return this.#busy;
  }

  /** Trabajos en espera, sin contar el que se esta ejecutando. */
  get queued(): number {
    return this.#queue.length;
  }

  get currentJobId(): number | null {
    return this.#currentJobId;
  }

  /** Se dispara en cada cambio de un trabajo, incluida cada linea de log. */
  onJobUpdate(listener: JobListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Se dispara una unica vez por trabajo, cuando termina.
   *
   * Existe aparte de `onJobUpdate` para que quien avise por Telegram no tenga
   * que filtrar estados ni llevar la cuenta de lo ya notificado. Tambien evita
   * que el updater dependa del notificador.
   */
  onJobFinished(listener: JobListener): () => void {
    this.#finishListeners.add(listener);
    return () => this.#finishListeners.delete(listener);
  }

  #emit(jobId: number): void {
    if (this.#listeners.size === 0) return;
    const job = this.repos.history.getJob(jobId);
    if (!job) return;
    for (const listener of this.#listeners) {
      try {
        listener(job);
      } catch (error) {
        this.log.warn('Un oyente de trabajos ha fallado', error);
      }
    }
  }

  /**
   * Decide como se puede actualizar una imagen y por que.
   *
   * Se expone aparte porque la interfaz necesita mostrarlo antes de que el
   * usuario pulse nada: no es lo mismo avisar de que algo no se puede
   * actualizar que dejar que lo intente y falle.
   */
  async planFor(imageRef: string): Promise<{
    strategy: UpdateStrategy;
    containerId: string | null;
    containerName: string | null;
    serviceName: string | null;
    projectKey: string | null;
    reason: string | null;
  }> {
    const snapshot = this.inventory.snapshot;
    const target = snapshot.containers.find(
      (container) => safeRef(container.image) === imageRef,
    );

    if (!target) {
      return {
        strategy: 'unsupported',
        containerId: null,
        containerName: null,
        serviceName: null,
        projectKey: null,
        reason: 'Ningun contenedor en marcha usa esta imagen',
      };
    }

    if (target.isSelf) {
      return {
        strategy: 'unsupported',
        containerId: target.id,
        containerName: target.name,
        serviceName: target.serviceName,
        projectKey: target.projectKey,
        reason: 'self',
      };
    }

    const project = target.projectKey
      ? snapshot.projects.find((p) => p.key === target.projectKey)
      : undefined;

    if (project?.yamlAccessible) {
      return {
        strategy: 'compose',
        containerId: target.id,
        containerName: target.name,
        serviceName: target.serviceName,
        projectKey: target.projectKey,
        reason: null,
      };
    }

    try {
      const inspect = await this.docker.inspectContainer(target.id);
      this.recreator.assertSupported(inspect);
    } catch (error) {
      if (error instanceof RecreateUnsupportedError) {
        return {
          strategy: 'unsupported',
          containerId: target.id,
          containerName: target.name,
          serviceName: target.serviceName,
          projectKey: target.projectKey,
          reason: error.reason,
        };
      }
    }

    return {
      strategy: 'recreate',
      containerId: target.id,
      containerName: target.name,
      serviceName: target.serviceName,
      projectKey: target.projectKey,
      reason: project ? project.strategy === 'recreate' ? 'El fichero del proyecto no es accesible' : null : null,
    };
  }

  /**
   * Encola una actualizacion y devuelve inmediatamente.
   *
   * Un update puede tardar varios minutos (descargar una imagen grande por la
   * linea de casa no es rapido), asi que la peticion HTTP no puede quedarse
   * esperando: el navegador o el proxy inverso de DSM cortarian antes. Se
   * devuelve el trabajo ya creado y el progreso viaja por SSE.
   *
   * `done` permite a quien si necesite el resultado (el auto-update del
   * planificador, el bot) esperar sin bloquear a los demas.
   *
   * La validacion del plan se hace ANTES de encolar: si la imagen no se puede
   * actualizar, el usuario tiene que enterarse al pulsar el boton, no dos
   * minutos despues al mirar el historial.
   */
  async enqueue(request: UpdateRequest): Promise<{ job: UpdateJob; done: Promise<UpdateJob> }> {
    const plan = await this.planFor(request.imageRef);
    if (plan.reason === 'self') throw new SelfUpdateRejectedError();
    if (plan.strategy === 'unsupported') {
      throw new RecreateUnsupportedError(plan.reason ?? 'configuracion no reproducible');
    }

    // Tope de cola: si algo va mal y se acumulan peticiones, es mejor rechazar
    // que dejar al NAS con cincuenta actualizaciones pendientes.
    if (this.#queue.length >= MAX_QUEUE) throw new UpdateInProgressError();

    const imageRow = this.repos.inventory.findImage(request.imageRef);

    const jobId = this.repos.history.createJob({
      imageRef: request.imageRef,
      containerId: plan.containerId,
      containerName: plan.containerName,
      projectKey: plan.projectKey,
      mode: request.mode,
      strategy: plan.strategy,
      trigger: request.trigger,
      actorUserId: request.actorUserId ?? null,
      actorChatId: request.actorChatId ?? null,
      fromDigest: imageRow?.remote_digest ?? null,
      fromTag: imageRow?.tag ?? null,
    });

    let resolveDone!: (job: UpdateJob) => void;
    let rejectDone!: (error: unknown) => void;
    const done = new Promise<UpdateJob>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // Sin esto, un trabajo que falla y cuyo `done` nadie espera genera un
    // unhandledRejection que tumbaria el proceso.
    done.catch(() => undefined);

    this.#queue.push({ jobId, request, plan, resolve: resolveDone, reject: rejectDone });
    this.#emit(jobId);

    void this.#drainQueue();

    const job = this.repos.history.getJob(jobId);
    if (!job) throw new Error('No se ha podido crear el trabajo');
    return { job, done };
  }

  /**
   * Procesa la cola de uno en uno.
   *
   * En serie a proposito: dos invocaciones concurrentes de compose sobre el
   * mismo proyecto corrompen su estado, y un NAS tampoco tiene ancho de banda
   * ni CPU para dos descargas a la vez.
   */
  async #drainQueue(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;

    try {
      for (;;) {
        const entry = this.#queue.shift();
        if (!entry) break;

        this.#currentJobId = entry.jobId;
        try {
          const job = await this.#execute(entry.jobId, entry.request, entry.plan);
          entry.resolve(job);
          for (const listener of this.#finishListeners) {
            try {
              listener(job);
            } catch (error) {
              this.log.warn('Un oyente de fin de trabajo ha fallado', error);
            }
          }
        } catch (error) {
          entry.reject(error);
          const job = this.repos.history.getJob(entry.jobId);
          if (job) {
            for (const listener of this.#finishListeners) {
              try {
                listener(job);
              } catch (listenerError) {
                this.log.warn('Un oyente de fin de trabajo ha fallado', listenerError);
              }
            }
          }
        } finally {
          this.#currentJobId = null;
        }
      }
    } finally {
      this.#busy = false;
    }
  }

  /** Compatibilidad: encola y espera. Lo usan el auto-update y el bot. */
  async update(request: UpdateRequest): Promise<UpdateJob> {
    const { done } = await this.enqueue(request);
    return done;
  }

  async #execute(
    jobId: number,
    request: UpdateRequest,
    plan: Awaited<ReturnType<UpdaterService['planFor']>>,
  ): Promise<UpdateJob> {
    const imageRow = this.repos.inventory.findImage(request.imageRef);
    const policy = this.repos.inventory.getPolicy(request.imageRef);

    this.repos.history.markJobRunning(jobId);
    this.#emit(jobId);

    const progress = (line: string) => {
      this.repos.history.appendJobLog(jobId, line);
      this.#emit(jobId);
    };

    try {
      const targetTag = request.targetTag ?? imageRow?.candidate_tag ?? null;

      if (plan.strategy === 'compose') {
        await this.#runCompose(request, plan, progress, targetTag);
      } else {
        await this.#runRecreate(request, plan, policy, progress, targetTag);
      }

      this.repos.history.finishJob(jobId, {
        status: 'success',
        toTag: targetTag,
        toDigest: imageRow?.remote_digest ?? null,
      });
      progress('Actualizacion completada');

      // Tras actualizar, el inventario cambia: hay contenedor e imagen nuevos.
      await this.inventory.refresh().catch((error: Error) => {
        this.log.warn('No se ha podido refrescar el inventario tras actualizar', error);
      });
    } catch (error) {
      const rolledBack = (error as { rolledBack?: boolean }).rolledBack === true;
      const message = describeError(error);
      this.repos.history.finishJob(jobId, {
        status: rolledBack ? 'rolled-back' : 'failed',
        error: message,
      });
      progress(message);
      this.#emit(jobId);
      throw error;
    } finally {
      // El flag de ocupado lo gestiona el procesador de la cola, no cada
      // trabajo: si lo liberara aqui, el siguiente podria arrancar en paralelo.
      this.#emit(jobId);
    }

    const job = this.repos.history.getJob(jobId);
    if (!job) throw new Error('No se ha podido leer el trabajo recien terminado');
    return job;
  }

  async #runCompose(
    request: UpdateRequest,
    plan: Awaited<ReturnType<UpdaterService['planFor']>>,
    progress: (line: string) => void,
    targetTag: string | null,
  ): Promise<void> {
    const project = this.inventory.snapshot.projects.find((p) => p.key === plan.projectKey);
    if (!project) throw new Error('No se encuentra el proyecto del contenedor');

    if (targetTag) {
      // Cambiar de etiqueta implica editar el YAML, que es del usuario. Se
      // avisa en vez de reescribirlo por nuestra cuenta.
      progress(
        `Hay una version nueva (${targetTag}), pero la etiqueta esta fijada en el fichero del ` +
          'proyecto. Cambiala en Container Manager y vuelve a aplicar.',
      );
    }

    const target = {
      projectName: project.name,
      workingDir: project.workingDir,
      configFiles: project.configFiles,
    };
    const scope = request.scope ?? this.repos.inventory.getPolicy(request.imageRef).recreateScope;

    progress('Validando el fichero del proyecto');
    await this.compose.validate(target);

    progress('Aplicando cambios con Docker Compose');
    await this.compose.up(target, {
      scope,
      serviceName: plan.serviceName ?? undefined,
      forceRecreate: request.mode === 'force',
      onOutput: progress,
    });
  }

  async #runRecreate(
    request: UpdateRequest,
    plan: Awaited<ReturnType<UpdaterService['planFor']>>,
    policy: ReturnType<Repositories['inventory']['getPolicy']>,
    progress: (line: string) => void,
    targetTag: string | null,
  ): Promise<void> {
    if (!plan.containerId) throw new Error('No hay contenedor que recrear');

    const baseRef = parseImageReference(request.imageRef);
    // En modo semver el destino es otra etiqueta, no la misma.
    const ref = targetTag
      ? parseImageReference(`${baseRef.host}/${baseRef.repository}:${targetTag}`)
      : baseRef;

    const credentials = this.repos.registries.getCredentials(ref.host);

    await this.recreator.recreate({
      containerId: plan.containerId,
      ref,
      credentials,
      // El borrado previo solo ocurre si el usuario lo marca Y ademas esta
      // forzando. En una actualizacion normal no tiene sentido perder la red de
      // seguridad.
      removeImageFirst: request.mode === 'force' && (request.removeImageFirst ?? policy.removeImageOnForce),
      cleanupOldImage: policy.cleanupOldImage,
      onProgress: progress,
    });
  }

  /**
   * Reinicia o vuelve a aplicar un proyecto entero. Es lo que el usuario
   * entiende por "refrescar el proyecto".
   */
  async applyProject(projectKey: string, restartOnly: boolean): Promise<void> {
    if (this.#busy) throw new UpdateInProgressError();

    const project = this.inventory.snapshot.projects.find((p) => p.key === projectKey);
    if (!project) throw new Error('No se encuentra el proyecto');
    if (!project.yamlAccessible) {
      throw new UnsafePathError('El fichero del proyecto no es accesible desde el contenedor');
    }
    if (project.containers.some((container) => container.isSelf)) {
      throw new SelfUpdateRejectedError();
    }

    this.#busy = true;
    try {
      const target = {
        projectName: project.name,
        workingDir: project.workingDir,
        configFiles: project.configFiles,
      };
      await this.compose.validate(target);
      if (restartOnly) {
        await this.compose.restart(target, { scope: 'project' });
      } else {
        await this.compose.up(target, { scope: 'project' });
      }
      await this.inventory.refresh();
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Aplica las actualizaciones de las imagenes marcadas como automaticas.
   *
   * Se ejecutan en serie a proposito: la cola global ya lo impone, pero
   * hacerlo explicito evita que un fallo en la primera aborte el resto.
   */
  async runAutoUpdates(): Promise<UpdateJob[]> {
    const settings = this.repos.settings.getAll();
    if (!settings.autoUpdateEnabled) return [];

    const applied: UpdateJob[] = [];
    const images = this.repos.inventory
      .listImages()
      .filter((row) => row.status === 'update-available');

    for (const row of images) {
      const policy = this.repos.inventory.getPolicy(row.normalized_ref);
      if (!policy.autoUpdate) continue;
      if (policy.pausedUntil && policy.pausedUntil > Date.now()) continue;
      if (policy.ignoredDigest && policy.ignoredDigest === row.remote_digest) continue;

      try {
        const job = await this.update({
          imageRef: row.normalized_ref,
          mode: 'update',
          trigger: 'auto',
        });
        applied.push(job);
      } catch (error) {
        if (error instanceof SelfUpdateRejectedError) {
          this.log.info(`Se omite la auto-actualizacion de ${row.normalized_ref}: es esta misma app`);
          continue;
        }
        this.log.error(`Fallo la auto-actualizacion de ${row.normalized_ref}`, error);
        const job = this.repos.history.listJobs(1)[0];
        if (job) applied.push(job);
      }
    }

    return applied;
  }
}

function safeRef(image: string): string | null {
  try {
    return parseImageReference(image).normalized;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  if (error instanceof UnsafePathError) return error.message;
  if (error instanceof RecreateUnsupportedError) return error.message;

  const message = (error as Error).message ?? 'Error desconocido';
  const explained = explainDockerError(message);

  if (error instanceof ComposeError) return `Docker Compose ha fallado: ${explained}`;
  return explained;
}

/**
 * Traduce errores del daemon que son crípticos pero tienen una causa muy
 * concreta y una solución conocida.
 *
 * El mensaje original se conserva: si alguien busca el texto exacto en internet
 * tiene que poder encontrarlo. Lo que se añade es qué hacer al respecto.
 */
export function explainDockerError(message: string): string {
  // Ocurre en cuanto un NAS acumula una docena larga de proyectos: cada uno crea
  // su red y `compose down` no las borra, asi que se agotan los rangos.
  if (/non-overlapping IPv4 address pool/i.test(message)) {
    return (
      `${message}\n\n` +
      'Docker se ha quedado sin rangos de direcciones para crear redes nuevas. ' +
      'Suele deberse a redes huerfanas de proyectos que ya no existen: ejecuta ' +
      '"docker network prune" para borrarlas. Si el problema vuelve, amplia ' +
      '"default-address-pools" en la configuracion del daemon (ver docs/SYNOLOGY.md).'
    );
  }

  if (/no space left on device/i.test(message)) {
    return (
      `${message}\n\n` +
      'No queda espacio en el volumen de Docker. Libera con "docker image prune -a" ' +
      'y revisa el tamano de los logs de los contenedores.'
    );
  }

  if (/port is already allocated|address already in use/i.test(message)) {
    return (
      `${message}\n\n` +
      'El puerto ya lo esta usando otro contenedor o proceso del NAS. Puede que el ' +
      'contenedor anterior no llegara a pararse: revisalo en Container Manager.'
    );
  }

  return message;
}

/** Reexportado para que las rutas HTTP puedan distinguir el caso. */
export { RecreateUnsupportedError };

/** Se usa en el bot para resolver el servicio de un contenedor. */
export { readComposeMembership };
