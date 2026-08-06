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
import { DockerApi } from './docker/api.js';
import { ComposeRunner } from './docker/compose.js';
import { ContainerRecreator } from './docker/recreate.js';
import { AuthService } from './services/auth.js';
import { InventoryService } from './services/inventory.js';
import { CheckerService } from './services/checker.js';
import { UpdaterService } from './services/updater.js';
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
  auth: AuthService;
  inventory: InventoryService;
  checker: CheckerService;
  updater: UpdaterService;
  metrics: MetricsService;
  host: HostMetricsService;
  notifier: NotifierService;
  scheduler: Scheduler;
  telegram: TelegramBot;
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

  const dockerClient = new DockerClient(config.dockerHost, log.child('docker'));
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

  const inventory = new InventoryService(docker, repos, config.composeRoots, log.child('inventory'));
  const checker = new CheckerService(repos, docker, log.child('checker'));

  const compose = new ComposeRunner(
    config.dockerBin,
    config.composeRoots,
    config.composeTimeoutMs,
    config.dockerHost,
    log.child('compose'),
  );
  const recreator = new ContainerRecreator(docker, log.child('recreate'));
  const updater = new UpdaterService(docker, repos, inventory, compose, recreator, log.child('updater'));

  const host = new HostMetricsService(
    config.hostProc,
    config.diskPaths.length > 0 ? config.diskPaths : defaultDiskPaths(config),
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
    auth,
    inventory,
    checker,
    updater,
    metrics,
    host,
    notifier,
    scheduler,
    telegram,
    shutdown,
  };
}

/**
 * Sin rutas de disco configuradas se usa la primera carpeta de proyectos, que
 * en un Synology es donde vive lo que le interesa al usuario.
 */
function defaultDiskPaths(config: Config): string[] {
  return config.composeRoots.slice(0, 1);
}
