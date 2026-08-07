/**
 * Punto de composicion: crea todas las piezas y las conecta.
 *
 * Se mantiene explicito, sin contenedor de inyeccion de dependencias: hay una
 * sola forma de montar la aplicacion y este fichero la documenta mejor que
 * cualquier decorador.
 */
import type { Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { openDatabase, type Db } from './db/index.js';
import { createRepositories, type Repositories } from './db/repositories/index.js';
import { Keyring } from './crypto/keyring.js';
import { DockerClient } from './docker/client.js';
import { readComposeMembership } from './docker/projects.js';
import { deriveComposeRoots, detectPlatform, findSocket, type PlatformInfo } from './platform.js';
import { DockerApi } from './docker/api.js';
import { ComposeRunner } from './docker/compose.js';
import { ProjectFilesService, resolveProjectsDir } from './services/project-files.js';
import { ContainerRecreator } from './docker/recreate.js';
import { AuthService } from './services/auth.js';
import { InventoryService } from './services/inventory.js';
import { CheckerService } from './services/checker.js';
import { UpdaterService } from './services/updater.js';
import { SelfUpdateService } from './services/self-update.js';
import { HostMetricsService } from './services/host.js';
import { MetricsService } from './services/metrics.js';
import { NotifierService } from './services/notifier.js';
import { Scheduler } from './scheduler/index.js';
import { TelegramBot } from './telegram/bot.js';

export interface AppContext {
  config: Config;
  log: Logger;
  db: Db;
  keyring: Keyring;
  repos: Repositories;
  docker: DockerApi;
  compose: ComposeRunner;
  projectFiles: ProjectFilesService;
  auth: AuthService;
  inventory: InventoryService;
  checker: CheckerService;
  updater: UpdaterService;
  selfUpdate: SelfUpdateService;
  metrics: MetricsService;
  host: HostMetricsService;
  notifier: NotifierService;
  scheduler: Scheduler;
  telegram: TelegramBot;
  /** Entorno detectado y rutas resueltas, para el panel de diagnostico. */
  runtime: {
    platform: PlatformInfo;
    dockerHost: string;
    socketReadable: boolean;
    composeRoots: string[];
    composeRootsExplicit: boolean;
    projectDirs: string[];
    projectsDir: string | null;
  };
  shutdown: () => Promise<void>;
}

export async function createApp(config: Config): Promise<AppContext> {
  const log = createLogger(config.logLevel);

  const db = openDatabase(config.databaseFile);

  const keyring = Keyring.create(db, {
    key: config.encryptionKey,
    passphrase: config.masterPassphrase,
  });
  if (!keyring.healthy) {
    log.warn(
      `Llavero bloqueado: ${keyring.reason}. Las credenciales de registry guardadas no se ` +
        'pueden leer. Los registries publicos siguen funcionando.',
    );
  }

  const repos = createRepositories(db, keyring);
  if (!keyring.healthy) repos.registries.markAllNeedingReauth();

  // Los ajustes persistidos mandan sobre el entorno, salvo la primera vez.
  if (repos.settings.getRaw('app.checkCron') === null) {
    repos.settings.update({ checkCron: config.checkCron, defaultLocale: config.defaultLocale });
  }

  /**
   * Resolucion del socket.
   *
   * Si no se ha configurado, se sondean los sitios habituales de Docker y de
   * Podman. Antes habia un valor fijo, que en cuanto el runtime no era Docker en
   * su ruta de siempre obligaba a configurarlo a mano sin ninguna pista.
   */
  const socket = config.dockerHost ? null : await findSocket();
  const dockerHost = config.dockerHost ?? (socket ? `unix://${socket.path}` : 'unix:///var/run/docker.sock');

  if (socket && !socket.readable) {
    log.warn(
      `Se ha encontrado ${socket.path} pero no se puede usar: es un problema de permisos, ` +
        'no de ruta. Revisa como esta montado el socket.',
    );
  } else if (socket) {
    log.info(`Socket detectado: ${socket.path}`);
  } else if (!config.dockerHost) {
    log.warn(
      'No se ha encontrado ningun socket de Docker ni de Podman. Comprueba el montaje ' +
        'del socket o define DOCKER_HOST.',
    );
  }

  const dockerClient = new DockerClient(dockerHost, log.child('docker'));
  const docker = new DockerApi(dockerClient, log.child('docker'));

  try {
    await dockerClient.connect();
  } catch (error) {
    // Sin Docker la app arranca igual y muestra el error en la interfaz. Es
    // mucho mas util que un contenedor en bucle de reinicio sin explicacion.
    log.error('No se ha podido conectar con Docker al arrancar', error);
  }

  const auth = new AuthService(repos, log.child('auth'), config.sessionDays);
  await auth.init();

  const bootstrap = await auth.bootstrap({
    username: config.adminUser,
    password: config.adminPassword,
    locale: config.defaultLocale,
  });
  if (bootstrap.created && bootstrap.generatedPassword) {
    log.info('='.repeat(64));
    log.info('  Usuario administrador creado');
    log.info(`  Usuario:     ${bootstrap.username}`);
    log.info(`  Contrasena:  ${bootstrap.generatedPassword}`);
    log.info('  Se te pedira cambiarla al entrar. Este mensaje no se repetira.');
    log.info('='.repeat(64));
  } else if (bootstrap.created) {
    log.info(`Usuario administrador "${bootstrap.username}" creado desde el entorno`);
  }

  /**
   * Carpetas donde se acepta ejecutar Compose.
   *
   * Si no se han configurado, se deducen de donde el propio Docker dice que
   * estan los proyectos, leyendo las labels de los contenedores. Es mas fiable
   * que una tabla de rutas por plataforma, porque no adivina: funciona igual en
   * un Synology, un Unraid o un portatil.
   *
   * Se hace ANTES de montar los servicios porque el inventario y el ejecutor de
   * Compose necesitan la lista ya resuelta.
   */
  let composeRoots = config.composeRoots;
  let projectDirs: string[] = [];

  if (dockerClient.connected) {
    try {
      const containers = await docker.listContainers(true);
      projectDirs = [
        ...new Set(
          containers
            .map((container) => readComposeMembership(container)?.workingDir)
            .filter((dir): dir is string => Boolean(dir)),
        ),
      ];

      if (!config.composeRootsExplicit) {
        composeRoots = await deriveComposeRoots(projectDirs);
        if (composeRoots.length > 0) {
          log.info(`Carpetas de proyectos detectadas: ${composeRoots.join(', ')}`);
        } else if (projectDirs.length > 0) {
          log.warn(
            'Hay proyectos de Compose pero sus carpetas no son accesibles desde aqui. ' +
              'Montalas con la misma ruta que en el sistema anfitrion para poder usar Compose.',
          );
        }
      }
    } catch (error) {
      log.warn('No se han podido deducir las carpetas de proyectos', error);
    }
  }

  const platform = await detectPlatform(projectDirs, dockerClient.versionInfo?.flavor ?? 'unknown');
  log.info(
    `Plataforma: ${platform.name}${platform.evidence ? ` (${platform.evidence})` : ''}` +
      `${platform.verified ? '' : ' [soporte no verificado]'}`,
  );

  /**
   * Carpeta donde se crean los proyectos nuevos.
   *
   * Se anade a las carpetas permitidas de Compose: si no, un proyecto creado
   * aqui no pasaria el filtro de rutas y no se podria levantar. Va aparte
   * porque esta tiene que admitir escritura y las otras, siguiendo la
   * recomendacion del montaje, no.
   */
  const projectsDir = await resolveProjectsDir(config.projectsDir, composeRoots);
  if (projectsDir && !composeRoots.includes(projectsDir)) {
    composeRoots = [...composeRoots, projectsDir];
  }
  if (projectsDir) {
    log.info(`Carpeta para proyectos nuevos: ${projectsDir}`);
  } else {
    log.info(
      'No hay ninguna carpeta con permiso de escritura, asi que no se pueden crear ' +
        'proyectos desde la aplicacion. Monta una y apuntala con CU_PROJECTS_DIR.',
    );
  }

  const projectFiles = new ProjectFilesService(projectsDir, repos, log.child('project-files'));

  const inventory = new InventoryService(docker, repos, composeRoots, log.child('inventory'));
  const checker = new CheckerService(repos, docker, log.child('checker'));

  const compose = new ComposeRunner(
    config.dockerBin,
    composeRoots,
    config.composeTimeoutMs,
    dockerHost,
    log.child('compose'),
  );
  const recreator = new ContainerRecreator(docker, log.child('recreate'));
  const updater = new UpdaterService(docker, repos, inventory, compose, recreator, log.child('updater'));

  const selfUpdate = new SelfUpdateService(
    docker,
    repos,
    inventory,
    compose,
    composeRoots,
    config.dockerBin,
    log.child('self-update'),
  );

  const host = new HostMetricsService(
    config.hostProc,
    config.diskPaths.length > 0 ? config.diskPaths : composeRoots.slice(0, 1),
    log.child('host'),
  );
  const metrics = new MetricsService(docker, inventory, host, repos, log.child('metrics'));

  const notifier = new NotifierService(repos, log.child('notifier'));

  const scheduler = new Scheduler({
    repos,
    checker,
    inventory,
    updater,
    notifier,
    metrics,
    timezone: config.timezone,
    log: log.child('scheduler'),
  });

  const telegram = new TelegramBot(
    config.telegramToken,
    repos,
    {
      inventory,
      checker,
      updater,
      metrics,
      docker,
      runCheckCycle: (trigger) => scheduler.runCheckCycle(trigger),
    },
    log.child('telegram'),
  );
  notifier.setChannel(telegram);

  // Los trabajos de actualizacion se difunden por SSE para que la interfaz
  // muestre el progreso en vivo sin sondear.
  updater.onJobUpdate((job) => {
    metrics.broadcast({ type: 'job-progress', payload: { job } });
  });

  // Aviso al terminar. Va aqui y no dentro del updater para que este no dependa
  // del notificador, y no en las rutas HTTP porque desde que los trabajos corren
  // en segundo plano la peticion ya ha respondido cuando el trabajo acaba.
  //
  // Se ignoran dos casos para no mandar el mismo aviso dos veces: las
  // automaticas las notifica el planificador con su propio resumen, y las
  // lanzadas desde Telegram ya reciben la respuesta del propio comando.
  updater.onJobFinished((job) => {
    if (job.trigger === 'auto' || job.trigger === 'telegram') return;

    if (job.status === 'success') {
      void notifier.notifyUpdateApplied({
        imageRef: job.imageRef,
        containerName: job.containerName ?? '',
        fromTag: job.fromTag,
        toTag: job.toTag,
        automatic: false,
      });
      return;
    }

    if (job.status === 'failed' || job.status === 'rolled-back') {
      void notifier.notifyFailure({
        imageRef: job.imageRef,
        error: job.error ?? 'error desconocido',
        rolledBack: job.status === 'rolled-back',
      });
    }
  });

  if (dockerClient.connected) {
    await inventory.refresh().catch((error: Error) => {
      log.error('Fallo el inventario inicial', error);
    });
  }

  await telegram.start();
  scheduler.start();

  const shutdown = async (): Promise<void> => {
    log.info('Cerrando...');
    scheduler.stop();
    metrics.stop();
    await telegram.stop();
    db.close();
  };

  return {
    config,
    log,
    db,
    keyring,
    repos,
    docker,
    compose,
    projectFiles,
    auth,
    inventory,
    checker,
    updater,
    selfUpdate,
    metrics,
    host,
    notifier,
    scheduler,
    telegram,
    runtime: {
      platform,
      dockerHost,
      socketReadable: socket?.readable ?? true,
      composeRoots,
      composeRootsExplicit: config.composeRootsExplicit,
      projectDirs,
      projectsDir,
    },
    shutdown,
  };
}
