/**
 * Arranque del proceso.
 */
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { buildServer } from './http/server.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Antes de tener logger: se escribe directamente para que el mensaje salga
    // en `docker logs`, que es lo unico que vera el usuario.
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
    return;
  }

  const app = await createApp(config);
  const server = await buildServer(app);

  try {
    await server.listen({ port: config.port, host: config.host });
    app.log.info(`Escuchando en http://${config.host}:${config.port}`);
  } catch (error) {
    app.log.fatal('No se ha podido abrir el puerto', error);
    await app.shutdown();
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    // Una segunda senal durante el cierre no debe reentrar y dejar la base de
    // datos a medio cerrar.
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info(`Recibido ${signal}`);
    // Tope de seguridad: si algo se queda colgado, el contenedor debe morir
    // igualmente en vez de esperar al SIGKILL de Docker.
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();

    await server.close().catch(() => undefined);
    await app.shutdown().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    app.log.error('Promesa rechazada sin capturar', reason);
  });
  process.on('uncaughtException', (error) => {
    app.log.fatal('Excepcion no capturada', error);
    void shutdown('uncaughtException');
  });
}

void main();
