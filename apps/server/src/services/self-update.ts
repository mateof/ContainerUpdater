/**
 * Auto-actualizacion de ContainerUpdater.
 *
 * No puede hacerse desde el propio proceso: al pararse el contenedor, el
 * proceso que estuviera actualizando muere a mitad. Se delega en un contenedor
 * efimero que sobrevive al reinicio (verificado: un contenedor lanzado por otro
 * sigue vivo aunque el que lo lanzo desaparezca, porque quien los gestiona es
 * el daemon).
 *
 * El reparto de responsabilidades es deliberado: aqui se hace todo lo que se
 * puede comprobar mientras la aplicacion sigue viva (descargar la imagen,
 * validar el proyecto, decidir la estrategia) y se deja al ayudante solo lo
 * imprescindible. Cuanto menos tenga que decidir el ayudante, menos puede
 * salir mal cuando ya no hay panel donde mirar.
 */
import type { UpdateStrategy } from '@cu/shared';
import { localImageName, parseImageReference } from '../registry/reference.js';
import { readComposeMembership } from '../docker/projects.js';
import { checkComposeAccessibility } from '../docker/projects.js';
import type { ComposeRunner } from '../docker/compose.js';
import type { DockerApi } from '../docker/api.js';
import type { InventoryService } from './inventory.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Logger } from '../logger.js';

export class SelfUpdateNotPossibleError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SelfUpdateNotPossibleError';
  }
}

export interface SelfUpdatePlan {
  possible: boolean;
  strategy: UpdateStrategy;
  containerName: string | null;
  imageRef: string | null;
  /** Advertencia que la interfaz debe mostrar antes de confirmar. */
  warning: string | null;
  reason: string | null;
}

export class SelfUpdateService {
  constructor(
    private readonly docker: DockerApi,
    private readonly repos: Repositories,
    private readonly inventory: InventoryService,
    private readonly compose: ComposeRunner,
    private readonly composeRoots: string[],
    private readonly dockerBin: string,
    private readonly log: Logger,
  ) {}

  /** Que pasaria si el usuario pulsara actualizar, sin llegar a hacerlo. */
  async plan(): Promise<SelfUpdatePlan> {
    const selfId = this.inventory.selfContainerId;

    if (!selfId) {
      return {
        possible: false,
        strategy: 'unsupported',
        containerName: null,
        imageRef: null,
        warning: null,
        reason:
          'No se ha podido identificar el contenedor propio. Esto ocurre cuando la aplicacion ' +
          'no corre dentro de Docker.',
      };
    }

    const container = this.inventory.snapshot.containers.find((entry) => entry.id === selfId);
    if (!container) {
      return {
        possible: false,
        strategy: 'unsupported',
        containerName: null,
        imageRef: null,
        warning: null,
        reason: 'No se encuentra el contenedor propio en el inventario',
      };
    }

    const raw = await this.docker.listContainers(true);
    const own = raw.find((entry) => entry.Id === selfId);
    const membership = own ? readComposeMembership(own) : null;

    let strategy: UpdateStrategy = 'recreate';
    let warning: string | null = null;

    if (membership) {
      const access = await checkComposeAccessibility(membership, this.composeRoots);
      if (access.accessible) {
        strategy = 'compose';
        // Se dice antes de pulsar, no despues de que falle: en modo Compose el
        // contenedor anterior lo borra Compose y no queda a donde volver.
        warning =
          'Con Docker Compose no hay vuelta atras automatica: si la version nueva no arranca, ' +
          'tendras que revisar el proyecto desde Container Manager.';
      }
    }

    return {
      possible: true,
      strategy,
      containerName: container.name,
      imageRef: container.image,
      warning,
      reason: null,
    };
  }

  /**
   * Descarga la imagen nueva y lanza el ayudante.
   *
   * Devuelve en cuanto el ayudante esta en marcha. A partir de ese momento este
   * proceso tiene los segundos contados.
   */
  async start(onProgress: (line: string) => void): Promise<{ helperId: string }> {
    const plan = await this.plan();
    if (!plan.possible || !plan.imageRef) {
      throw new SelfUpdateNotPossibleError(plan.reason ?? 'no es posible');
    }

    const selfId = this.inventory.selfContainerId!;
    const own = await this.docker.inspectContainer(selfId);
    const ref = parseImageReference(plan.imageRef);
    const localName = localImageName(ref);

    // 1. Descargar mientras seguimos vivos. Si falla aqui no se ha tocado nada
    //    y el panel sigue funcionando.
    onProgress(`Descargando ${ref.normalized}`);
    const credentials = this.repos.registries.getCredentials(ref.host);
    await this.docker.pullImage(ref, credentials, onProgress);

    // 2. Comprobar que la imagen esta de verdad ahi. Un ayudante que arranca
    //    para descubrir que no hay imagen es un panel caido para nada.
    const image = await this.docker.inspectImage(localName);
    onProgress(`Imagen lista: ${image.Id.slice(0, 19)}`);

    const raw = await this.docker.listContainers(true);
    const membership = readComposeMembership(raw.find((entry) => entry.Id === selfId)!);

    // 3. En modo Compose, validar el YAML ANTES de parar nada.
    if (plan.strategy === 'compose' && membership) {
      onProgress('Validando el fichero del proyecto');
      await this.compose.validate({
        projectName: membership.projectName,
        workingDir: membership.workingDir,
        configFiles: membership.configFiles,
      });
    }

    // 4. El ayudante hereda los montajes del padre: necesita el socket, y en
    //    modo Compose tambien las rutas del proyecto y /data para el log.
    const binds = [...(own.HostConfig.Binds ?? [])];
    const mounts = (own.Mounts ?? [])
      .filter((mount) => mount.Type === 'bind')
      .map((mount) => `${mount.Source}:${mount.Destination}${mount.RW === false ? ':ro' : ''}`);
    for (const bind of mounts) {
      if (!binds.some((existing) => existing.startsWith(`${bind.split(':')[0]}:`))) {
        binds.push(bind);
      }
    }

    const env = [
      `CU_SU_MODE=${plan.strategy}`,
      `CU_SU_CONTAINER_ID=${selfId}`,
      `CU_SU_CONTAINER_NAME=${own.Name.replace(/^\//, '')}`,
      `CU_SU_IMAGE=${localName}`,
      `CU_SU_PROJECT_NAME=${membership?.projectName ?? ''}`,
      `CU_SU_PROJECT_DIR=${membership?.workingDir ?? ''}`,
      `CU_SU_CONFIG_FILES=${(membership?.configFiles ?? []).join(',')}`,
      `CU_SU_SERVICE=${membership?.serviceName ?? ''}`,
      `CU_DOCKER_BIN=${this.dockerBin}`,
      `DOCKER_HOST=${process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock'}`,
      `TZ=${process.env.TZ ?? 'UTC'}`,
    ];

    // 5. El ayudante corre con la imagen VIEJA, la que ya se sabe que funciona.
    //    Usar la nueva significaria que una imagen rota se quedaria sin nadie
    //    capaz de dar marcha atras.
    const helperImage = own.Config.Image ?? localName;

    onProgress('Lanzando el ayudante de actualizacion');
    const helperId = await this.docker.createContainer(`cu-self-update-${Date.now()}`, {
      Image: helperImage,
      Entrypoint: ['/usr/bin/tini', '--'],
      Cmd: ['node', 'dist/self-update-runner.js'],
      Env: env,
      Labels: { 'com.containerupdater.role': 'self-update-helper' },
      HostConfig: {
        Binds: binds,
        // El ayudante se borra solo al terminar. Si algo va mal, su log queda
        // en /data/self-update.log, que es lo que hay que mirar despues.
        AutoRemove: true,
        RestartPolicy: { Name: 'no' },
        NetworkMode: own.HostConfig.NetworkMode,
      },
    });

    await this.docker.startContainer(helperId);

    this.repos.history.audit({
      actorType: 'system',
      actorId: null,
      action: 'self-update.started',
      detail: `${plan.strategy} -> ${localName}`,
    });

    onProgress('Ayudante en marcha. El panel se reiniciara en unos segundos.');
    this.log.warn('Auto-actualizacion en marcha: este proceso terminara enseguida');

    return { helperId };
  }
}
