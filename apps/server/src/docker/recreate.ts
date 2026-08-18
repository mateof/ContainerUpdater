/**
 * Recreacion de un contenedor con una imagen nueva, sin Docker Compose.
 *
 * Es el camino de respaldo para contenedores cuyo YAML no es accesible desde
 * dentro de nuestro contenedor. La idea general es la de Watchtower, pero con
 * dos cosas que Watchtower no hace y que aqui importan: se copia la
 * configuracion de forma DIFERENCIAL respecto a la imagen vieja, y hay rollback
 * real si el contenedor nuevo no llega a arrancar bien.
 */
import type { DockerApi } from './api.js';
import type {
  ContainerInspect,
  CreateContainerBody,
  HostConfig,
  ImageInspect,
  NetworkAttachment,
} from './types.js';
import type { RegistryCredentials } from '../db/repositories/index.js';
import { localImageName, type ImageReference } from '../registry/reference.js';
import type { Logger } from '../logger.js';

export class RecreateUnsupportedError extends Error {
  constructor(readonly reason: string) {
    super(`No se puede recrear este contenedor con garantias: ${reason}`);
    this.name = 'RecreateUnsupportedError';
  }
}

export interface RecreateOptions {
  containerId: string;
  ref: ImageReference;
  credentials: RegistryCredentials | null;
  removeImageFirst: boolean;
  cleanupOldImage: boolean;
  /**
   * Saltarse la descarga porque la imagen correcta ya esta en disco.
   *
   * Existe por la vuelta atras, y por un fallo muy concreto que se vio
   * ejecutandola de verdad: la vuelta atras descarga la version vieja por
   * digest y le devuelve su etiqueta, pero acto seguido esto hacia un pull de
   * ESA MISMA etiqueta contra el registry, se traia otra vez la version nueva y
   * deshacia el trabajo. El contenedor acababa exactamente en la version de la
   * que se queria salir, y sin ningun error que lo delatara.
   */
  skipPull?: boolean;
  onProgress: (line: string) => void;
}

export interface RecreateResult {
  newContainerId: string;
  rolledBack: boolean;
}

/** Un volumen anonimo tiene por nombre 64 caracteres hexadecimales. */
const ANONYMOUS_VOLUME = /^[0-9a-f]{64}$/i;

export class ContainerRecreator {
  constructor(
    private readonly docker: DockerApi,
    private readonly log: Logger,
  ) {}

  /**
   * Casos que se rechazan de entrada porque no se pueden reproducir con
   * fiabilidad. Es preferible decirle al usuario que lo haga desde Container
   * Manager antes que dejarle un contenedor mal recreado.
   */
  assertSupported(container: ContainerInspect): void {
    const networkMode = container.HostConfig.NetworkMode ?? '';
    if (networkMode.startsWith('container:')) {
      throw new RecreateUnsupportedError(
        'comparte la pila de red de otro contenedor (network_mode: container:)',
      );
    }
    if ((container.HostConfig.Links ?? []).length > 0) {
      throw new RecreateUnsupportedError('usa enlaces heredados (--link)');
    }
    const labels = container.Config.Labels ?? {};
    if (labels['com.docker.swarm.service.id'] || labels['io.kubernetes.pod.name']) {
      throw new RecreateUnsupportedError('lo gestiona un orquestador (Swarm o Kubernetes)');
    }
  }

  async recreate(options: RecreateOptions): Promise<RecreateResult> {
    const { onProgress } = options;

    // El daemon no conoce la imagen por su referencia de registry: para Docker
    // Hub la guarda como `nginx:alpine`, no como
    // `registry-1.docker.io/library/nginx:alpine`. Usar la forma equivocada
    // hace que falle con "No such image" justo despues de un pull correcto.
    const localName = localImageName(options.ref);

    const container = await this.docker.inspectContainer(options.containerId);
    this.assertSupported(container);

    const originalName = container.Name.replace(/^\//, '');
    const oldImageId = container.Image;

    // La configuracion de la imagen VIEJA es imprescindible para el diff del
    // paso de construccion. Se lee antes de que el pull pueda moverla.
    const oldImage = await this.docker.inspectImage(oldImageId).catch(() => null);

    const backupName = `${originalName}__cu_old_${Date.now()}`;
    let renamed = false;
    let newContainerId: string | null = null;
    let started = false;

    try {
      if (options.removeImageFirst) {
        // Camino sin red de seguridad, solo si el usuario lo pide de forma
        // explicita. Hay que parar y borrar el contenedor antes porque una
        // imagen en uso no se puede eliminar, y a partir de ahi no hay
        // rollback: si el pull falla, no queda imagen a la que volver.
        onProgress('Modo forzado con borrado previo: no habra rollback disponible');
        await this.docker.stopContainer(container.Id, container.Config.StopTimeout ?? 10);
        await this.docker.removeContainer(container.Id, true);
        await this.docker.removeImage(localName, true).catch((error: Error) => {
          onProgress(`No se ha podido borrar la imagen: ${error.message}`);
        });
        await this.docker.pullImage(options.ref, options.credentials, onProgress);
      } else {
        // Camino normal: primero el pull. Si falla, no hemos tocado nada y el
        // servicio sigue en pie.
        if (options.skipPull) {
          onProgress('La imagen ya esta en disco: no se descarga nada');
        } else {
          onProgress(`Descargando ${options.ref.normalized}`);
          await this.docker.pullImage(options.ref, options.credentials, onProgress);
        }

        // Renombrar en lugar de borrar es lo que hace posible el rollback:
        // libera el nombre para el contenedor nuevo sin destruir el viejo.
        onProgress(`Renombrando el contenedor actual a ${backupName}`);
        await this.docker.renameContainer(container.Id, backupName);
        renamed = true;

        onProgress('Parando el contenedor actual');
        await this.docker.stopContainer(container.Id, container.Config.StopTimeout ?? 10);
      }

      const newImage = await this.docker.inspectImage(localName);
      const body = buildCreateBody(container, oldImage, localName);

      onProgress('Creando el contenedor nuevo');
      newContainerId = await this.docker.createContainer(originalName, body);

      // Las redes secundarias se conectan ANTES del start. Si se conectan
      // despues, el proceso arranca sin poder resolver a sus vecinos y muchas
      // aplicaciones fallan en el arranque y no lo reintentan.
      await this.#attachExtraNetworks(container, newContainerId, onProgress);

      onProgress('Arrancando el contenedor nuevo');
      await this.docker.startContainer(newContainerId);
      started = true;

      await this.#waitUntilHealthy(newContainerId, newImage, onProgress);

      onProgress('El contenedor nuevo funciona correctamente');

      if (renamed) {
        await this.docker.removeContainer(container.Id, true).catch((error: Error) => {
          onProgress(`Aviso: no se ha podido borrar el contenedor antiguo: ${error.message}`);
        });
      }

      if (options.cleanupOldImage && oldImage && oldImage.Id !== newImage.Id) {
        // Un 409 aqui significa que otro contenedor sigue usando la imagen, que
        // es perfectamente normal y no es un fallo del update.
        await this.docker.removeImage(oldImage.Id, false).catch(() => {
          onProgress('La imagen antigua sigue en uso por otro contenedor, no se borra');
        });
      }

      return { newContainerId, rolledBack: false };
    } catch (error) {
      const message = (error as Error).message;
      onProgress(`Fallo: ${message}`);

      if (!renamed) throw error;

      onProgress('Revirtiendo al contenedor anterior');
      const restored = await this.#rollback(
        container.Id,
        originalName,
        newContainerId,
        started,
        onProgress,
      );

      if (restored) {
        const rollbackError = new Error(message) as Error & { rolledBack?: boolean };
        rollbackError.rolledBack = true;
        throw rollbackError;
      }
      throw error;
    }
  }

  async #attachExtraNetworks(
    container: ContainerInspect,
    newContainerId: string,
    onProgress: (line: string) => void,
  ): Promise<void> {
    const networks = Object.entries(container.NetworkSettings?.Networks ?? {});
    // La primera ya se aplico en el create mediante NetworkingConfig.
    for (const [name, config] of networks.slice(1)) {
      try {
        await this.docker.connectNetwork(name, newContainerId, config);
        onProgress(`Conectado a la red ${name}`);
      } catch (error) {
        onProgress(`Aviso: no se ha podido conectar a la red ${name}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Puerta de salud.
   *
   * Comprobar solo "esta corriendo" no vale: un contenedor en bucle de
   * reinicio pasa esa prueba durante los pocos segundos que vive cada
   * iteracion. Si la imagen declara healthcheck se espera a `healthy`; si no,
   * se da un margen y se comprueba que no haya reiniciado.
   */
  async #waitUntilHealthy(
    containerId: string,
    image: ImageInspect,
    onProgress: (line: string) => void,
  ): Promise<void> {
    const hasHealthcheck = Boolean(
      image.Config?.Healthcheck?.Test && image.Config.Healthcheck.Test[0] !== 'NONE',
    );

    if (hasHealthcheck) {
      onProgress('Esperando a que el healthcheck pase a saludable');
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await sleep(3000);
        const state = (await this.docker.inspectContainer(containerId)).State;
        const status = state.Health?.Status;
        if (status === 'healthy') return;
        if (!state.Running && !state.Restarting) {
          throw new Error(`El contenedor se ha parado (codigo de salida ${state.ExitCode})`);
        }
        if (status === 'unhealthy' && (state.Health?.FailingStreak ?? 0) >= 3) {
          throw new Error('El healthcheck del contenedor nuevo falla de forma continuada');
        }
      }
      throw new Error('El healthcheck no ha pasado a saludable en 120 segundos');
    }

    onProgress('La imagen no define healthcheck: comprobando que se mantiene en marcha');
    await sleep(15_000);
    const inspect = await this.docker.inspectContainer(containerId);
    if (!inspect.State.Running) {
      throw new Error(`El contenedor no sigue en marcha (codigo de salida ${inspect.State.ExitCode})`);
    }
    if (inspect.RestartCount > 0) {
      throw new Error('El contenedor ha reiniciado nada mas arrancar');
    }
  }

  async #rollback(
    oldContainerId: string,
    originalName: string,
    newContainerId: string | null,
    newWasStarted: boolean,
    onProgress: (line: string) => void,
  ): Promise<boolean> {
    try {
      if (newContainerId) {
        if (newWasStarted) {
          await this.docker.stopContainer(newContainerId, 5).catch(() => undefined);
        }
        await this.docker.removeContainer(newContainerId, true).catch(() => undefined);
      }
      await this.docker.renameContainer(oldContainerId, originalName);
      await this.docker.startContainer(oldContainerId);
      onProgress('Se ha restaurado el contenedor anterior y esta en marcha');
      return true;
    } catch (error) {
      // Este es el peor escenario: ni el nuevo ni el viejo. El mensaje tiene
      // que decir exactamente donde esta el contenedor superviviente.
      this.log.error('Ha fallado el rollback', error);
      onProgress(
        `ERROR GRAVE: no se ha podido restaurar el contenedor anterior (${(error as Error).message}). ` +
          `Sigue existiendo como "${originalName}__cu_old_*", arrancalo desde Container Manager.`,
      );
      return false;
    }
  }
}

/**
 * Construye la configuracion del contenedor nuevo.
 *
 * Aqui esta el error clasico de las herramientas de auto-update: copiar
 * `Config.Env` tal cual del inspect. Ese array incluye las variables que
 * declaraba la imagen VIEJA, asi que si la version nueva cambia un valor por
 * defecto, el contenedor recreado se queda con el antiguo y nadie entiende por
 * que. Lo mismo vale para Cmd, Entrypoint, Labels y Volumes.
 *
 * La solucion es diferencial: se arrastra solo lo que no venia de la imagen
 * vieja, es decir, lo que puso el usuario.
 */
export function buildCreateBody(
  container: ContainerInspect,
  oldImage: ImageInspect | null,
  newImageRef: string,
): CreateContainerBody {
  const imageConfig = oldImage?.Config ?? {};

  const imageEnv = new Set(imageConfig.Env ?? []);
  const userEnv = (container.Config.Env ?? []).filter((entry) => !imageEnv.has(entry));

  const imageLabels = imageConfig.Labels ?? {};
  const userLabels: Record<string, string> = {};
  for (const [key, value] of Object.entries(container.Config.Labels ?? {})) {
    if (imageLabels[key] === value) continue;
    userLabels[key] = value;
  }

  // Cmd y Entrypoint solo se copian si difieren de los de la imagen vieja. Si
  // coinciden, dejarlos sin definir permite que la imagen nueva imponga los
  // suyos, que es justo lo que se espera al actualizar.
  const cmd = arraysEqual(container.Config.Cmd, imageConfig.Cmd) ? undefined : container.Config.Cmd;
  const entrypoint = arraysEqual(container.Config.Entrypoint, imageConfig.Entrypoint)
    ? undefined
    : container.Config.Entrypoint;

  const hostConfig = sanitizeHostConfig(container.HostConfig);

  // Los volumenes anonimos (nombre de 64 hex) no aparecen en Binds. Si no se
  // arrastran explicitamente en Mounts, el contenedor nuevo crea otros vacios y
  // los datos anteriores quedan huerfanos sin ningun aviso.
  const anonymousMounts = (container.Mounts ?? []).filter(
    (mount) => mount.Type === 'volume' && mount.Name && ANONYMOUS_VOLUME.test(mount.Name),
  );
  if (anonymousMounts.length > 0) {
    const existing = hostConfig.Mounts ?? [];
    const known = new Set(existing.map((m) => m.Destination));
    hostConfig.Mounts = [
      ...existing,
      ...anonymousMounts
        .filter((mount) => !known.has(mount.Destination))
        .map((mount) => ({
          Type: 'volume' as const,
          Source: mount.Name ?? '',
          Destination: mount.Destination,
          RW: mount.RW ?? true,
        })),
    ];
  }

  const networks = Object.entries(container.NetworkSettings?.Networks ?? {});
  const firstNetwork = networks[0];

  return {
    Hostname: container.Config.Hostname,
    Domainname: container.Config.Domainname,
    User: container.Config.User,
    Env: userEnv.length > 0 ? userEnv : undefined,
    Cmd: cmd ?? undefined,
    Entrypoint: entrypoint ?? undefined,
    Image: newImageRef,
    Labels: Object.keys(userLabels).length > 0 ? userLabels : undefined,
    WorkingDir: container.Config.WorkingDir || undefined,
    ExposedPorts: container.Config.ExposedPorts ?? undefined,
    StopSignal: container.Config.StopSignal,
    StopTimeout: container.Config.StopTimeout ?? undefined,
    Tty: container.Config.Tty,
    OpenStdin: container.Config.OpenStdin,
    AttachStdin: container.Config.AttachStdin,
    AttachStdout: container.Config.AttachStdout,
    AttachStderr: container.Config.AttachStderr,
    HostConfig: hostConfig,
    NetworkingConfig: firstNetwork
      ? { EndpointsConfig: { [firstNetwork[0]]: sanitizeEndpoint(firstNetwork[1]) } }
      : undefined,
  };
}

/**
 * Limpia la configuracion del host antes de reenviarla.
 *
 * El inspect devuelve TODOS los campos, incluidos los que el usuario nunca
 * configuro, rellenos con el valor que significa "sin establecer". Reenviarlos
 * tal cual no siempre es inocuo: verificado con crun sobre cgroup v2, un
 * `MemorySwappiness` que el propio daemon habia rellenado hace que el
 * contenedor nuevo no arranque, con el mensaje
 * "cannot set memory swappiness with cgroupv2".
 *
 * Omitir un campo no establecido es equivalente a enviarlo vacio y evita esa
 * clase entera de incompatibilidades entre runtimes.
 */
export function sanitizeHostConfig(hostConfig: HostConfig): HostConfig {
  const clean: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(hostConfig)) {
    // null significa "no configurado" en la respuesta del inspect.
    if (value === null) continue;
    clean[key] = value;
  }

  // El swappiness solo tiene sentido junto a un limite de memoria: sin limite,
  // el valor que devuelve el inspect lo ha puesto el daemon, no el usuario.
  // Verificado: Podman lo rellena con 0 y crun sobre cgroup v2 no soporta ese
  // parametro en absoluto, asi que el contenedor recreado no arranca. Se
  // conserva unicamente cuando hay limite y el valor es intencionado.
  const swappiness = clean.MemorySwappiness;
  const hasMemoryLimit = typeof clean.Memory === 'number' && clean.Memory > 0;
  if (swappiness === -1 || (!hasMemoryLimit && (swappiness === 0 || swappiness === undefined))) {
    delete clean.MemorySwappiness;
  }

  return clean as HostConfig;
}

/**
 * De la configuracion de red solo se conserva lo que el usuario declaro. La IP
 * asignada, el EndpointID y la MAC los adjudica el daemon: reenviarlos provoca
 * un conflicto de direccion ya en uso.
 */
function sanitizeEndpoint(config: NetworkAttachment): NetworkAttachment {
  return {
    Aliases: config.Aliases ?? undefined,
    IPAMConfig: config.IPAMConfig ?? undefined,
    Links: config.Links ?? undefined,
    DriverOpts: config.DriverOpts ?? undefined,
  };
}

function arraysEqual(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
