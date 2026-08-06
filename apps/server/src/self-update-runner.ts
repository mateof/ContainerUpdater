/**
 * Ayudante de auto-actualizacion.
 *
 * Se ejecuta en un contenedor efimero aparte, porque ContainerUpdater no puede
 * recrearse a si mismo: en cuanto se para, el proceso que estaba haciendo la
 * actualizacion muere a mitad y deja el contenedor en un estado indeterminado.
 * Alguien tiene que sobrevivir al reinicio, y ese alguien no puede ser el que
 * se reinicia.
 *
 * Se lanza con la imagen VIEJA, la que ya se sabe que funciona: si se usara la
 * nueva y esa imagen estuviera rota, no habria nada capaz de dar marcha atras.
 *
 * Todo lo que hace queda en /data/self-update.log, porque mientras corre no hay
 * panel donde mirar y si algo sale mal ese fichero es la unica pista.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { DockerClient } from './docker/client.js';
import { DockerApi } from './docker/api.js';
import { buildCreateBody } from './docker/recreate.js';
import { createLogger } from './logger.js';

const execFileAsync = promisify(execFile);

const LOG_FILE = process.env.CU_SU_LOG ?? '/data/self-update.log';

function record(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  process.stdout.write(`${line}\n`);
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // Si /data no esta montado en el ayudante, al menos queda en docker logs.
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface RunnerConfig {
  mode: 'compose' | 'recreate';
  containerId: string;
  containerName: string;
  image: string;
  projectName: string;
  projectDir: string;
  configFiles: string[];
  service: string;
  dockerBin: string;
}

function readConfig(): RunnerConfig {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Falta la variable ${name}`);
    return value;
  };

  return {
    mode: (process.env.CU_SU_MODE ?? 'recreate') as 'compose' | 'recreate',
    containerId: required('CU_SU_CONTAINER_ID'),
    containerName: required('CU_SU_CONTAINER_NAME'),
    image: required('CU_SU_IMAGE'),
    projectName: process.env.CU_SU_PROJECT_NAME ?? '',
    projectDir: process.env.CU_SU_PROJECT_DIR ?? '',
    configFiles: (process.env.CU_SU_CONFIG_FILES ?? '').split(',').filter(Boolean),
    service: process.env.CU_SU_SERVICE ?? '',
    dockerBin: process.env.CU_DOCKER_BIN ?? 'docker',
  };
}

async function main(): Promise<void> {
  record('=== Auto-actualizacion de ContainerUpdater ===');

  const config = readConfig();
  const log = createLogger('info', 'self-update');
  const client = new DockerClient(process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock', log);
  await client.connect();
  const docker = new DockerApi(client, log);

  record(`Modo: ${config.mode}. Contenedor: ${config.containerName}. Imagen: ${config.image}`);

  // Se lee la configuracion ANTES de parar nada: despues de borrar el
  // contenedor ya no habria de donde sacarla.
  const original = await docker.inspectContainer(config.containerId);
  const oldImage = await docker.inspectImage(original.Image).catch(() => null);

  // Margen para que la peticion HTTP que disparo esto llegue a responder al
  // navegador antes de que el servidor desaparezca.
  record('Esperando 3 segundos a que el panel termine de responder');
  await sleep(3000);

  record('Parando el panel');
  await docker.stopContainer(config.containerId, 15).catch((error: Error) => {
    record(`Aviso al parar: ${error.message}`);
  });

  const backupName = `${config.containerName}__cu_old_${Date.now()}`;

  try {
    if (config.mode === 'compose') {
      await updateWithCompose(config);
    } else {
      await updateWithRecreate(docker, config, original, oldImage, backupName);
    }

    record('Comprobando que el panel nuevo responde');
    const healthy = await waitUntilHealthy(docker, config.containerName);

    if (healthy) {
      record('CORRECTO: el panel nuevo esta en marcha');
      // La copia de seguridad solo existe en modo recreate.
      await docker.removeContainer(backupName, true).catch(() => undefined);
      record('=== Auto-actualizacion completada ===');
      return;
    }

    record('ERROR: el panel nuevo no responde');
    if (config.mode === 'recreate') {
      await rollback(docker, config, backupName);
    } else {
      // En modo compose no hay marcha atras fiable: Compose ya borro el
      // contenedor anterior y volver atras exigiria cambiar la etiqueta del
      // YAML, que es del usuario y no nos corresponde tocar.
      record(
        'Sin rollback automatico en modo Compose. Revisa el proyecto en Container Manager: ' +
          'el contenedor existe pero no responde.',
      );
    }
  } catch (error) {
    record(`ERROR: ${(error as Error).message}`);
    if (config.mode === 'recreate') {
      await rollback(docker, config, backupName);
    }
    process.exitCode = 1;
  }
}

async function updateWithCompose(config: RunnerConfig): Promise<void> {
  record(`Aplicando con Docker Compose el proyecto ${config.projectName}`);

  const args = [
    'compose',
    '--project-name',
    config.projectName,
    '--project-directory',
    config.projectDir,
    ...config.configFiles.flatMap((file) => ['-f', file]),
    'up',
    '--detach',
    '--force-recreate',
    '--no-deps',
    config.service,
  ];

  const { stdout, stderr } = await execFileAsync(config.dockerBin, args, {
    cwd: config.projectDir,
    env: {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/tmp',
      DOCKER_HOST: process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock',
      COMPOSE_PROGRESS: 'plain',
      NO_COLOR: '1',
    },
    timeout: 10 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
  });

  for (const line of `${stderr}\n${stdout}`.split('\n')) {
    if (line.trim()) record(`  ${line.trim()}`);
  }
}

async function updateWithRecreate(
  docker: DockerApi,
  config: RunnerConfig,
  original: Awaited<ReturnType<DockerApi['inspectContainer']>>,
  oldImage: Awaited<ReturnType<DockerApi['inspectImage']>> | null,
  backupName: string,
): Promise<void> {
  record(`Renombrando el contenedor actual a ${backupName}`);
  await docker.renameContainer(config.containerId, backupName);

  record('Creando el contenedor nuevo');
  const body = buildCreateBody(original, oldImage, config.image);
  const newId = await docker.createContainer(config.containerName, body);

  // Las redes secundarias, antes de arrancar.
  const networks = Object.entries(original.NetworkSettings?.Networks ?? {});
  for (const [name, endpoint] of networks.slice(1)) {
    await docker.connectNetwork(name, newId, endpoint).catch((error: Error) => {
      record(`Aviso: no se ha podido conectar a la red ${name}: ${error.message}`);
    });
  }

  record('Arrancando el contenedor nuevo');
  await docker.startContainer(newId);
}

/**
 * Comprueba que el panel responde de verdad.
 *
 * Se ejecuta su propio healthcheck dentro del contenedor en vez de llamar por
 * red: desde el ayudante no se sabe en que red ni en que puerto quedo
 * publicado, y un exec no depende de nada de eso.
 */
async function waitUntilHealthy(docker: DockerApi, containerName: string): Promise<boolean> {
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const inspect = await docker.inspectContainer(containerName);
      if (!inspect.State.Running) {
        record(`  todavia no esta en marcha (${inspect.State.Status})`);
        continue;
      }
      if (inspect.RestartCount > 0) {
        record('  el contenedor esta reiniciandose en bucle');
        return false;
      }
      const health = inspect.State.Health?.Status;
      if (health === 'healthy') return true;
      if (health === undefined) {
        // Sin healthcheck declarado: basta con que se sostenga en marcha.
        await sleep(5000);
        const again = await docker.inspectContainer(containerName);
        if (again.State.Running && again.RestartCount === 0) return true;
      }
      record(`  esperando (${health ?? 'sin healthcheck'})`);
    } catch (error) {
      record(`  todavia no responde: ${(error as Error).message}`);
    }
  }

  return false;
}

async function rollback(
  docker: DockerApi,
  config: RunnerConfig,
  backupName: string,
): Promise<void> {
  record('Revirtiendo a la version anterior');
  try {
    await docker.stopContainer(config.containerName, 5).catch(() => undefined);
    await docker.removeContainer(config.containerName, true).catch(() => undefined);
    await docker.renameContainer(backupName, config.containerName);
    await docker.startContainer(config.containerName);
    record('CORRECTO: se ha restaurado la version anterior');
  } catch (error) {
    // El peor escenario posible. El mensaje tiene que decir exactamente que
    // hacer, porque quien lo lea no tendra panel donde mirar.
    record(
      `ERROR GRAVE: no se ha podido restaurar (${(error as Error).message}). ` +
        `Entra en Container Manager y arranca el contenedor "${backupName}", ` +
        `o vuelve a crear el proyecto.`,
    );
  }
}

main().catch((error: Error) => {
  record(`ERROR no controlado: ${error.message}`);
  process.exit(1);
});
