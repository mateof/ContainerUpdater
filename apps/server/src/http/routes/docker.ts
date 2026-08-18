import type { FastifyInstance } from 'fastify';
import { logsQuerySchema } from '@cu/shared';
import type { AppContext } from '../../app.js';

export async function registerDockerRoutes(
  fastify: FastifyInstance,
  app: AppContext,
): Promise<void> {
  fastify.get('/api/status', { onRequest: [fastify.requireAuth] }, async () => {
    const info = app.docker.client.versionInfo;
    return {
      version: app.config.version,
      keyringHealthy: app.keyring.healthy,
      keyringReason: app.keyring.reason,
      dockerConnected: app.docker.client.connected,
      dockerApiVersion: info?.apiVersion ?? null,
      dockerFlavor: info?.flavor ?? 'unknown',
      selfContainerId: app.inventory.selfContainerId,
      lastCheckAt: app.repos.settings.getNumber('last_check_at'),
      nextCheckAt: app.scheduler.nextCheckAt,
      checkRunning: app.checker.running,
      updateRunning: app.updater.busy,
      updateQueued: app.updater.queued,
      currentJobId: app.updater.currentJobId,
      updatesAvailable: app.repos.inventory.countUpdatesAvailable(),
      telegram: { configured: app.telegram.configured, running: app.telegram.ready },
    };
  });

  /**
   * Diagnostico del entorno.
   *
   * Responde a la pregunta que la gente se hace cuando algo no aparece: donde
   * cree la aplicacion que esta, que socket usa y que carpetas puede tocar. Sin
   * esto, un montaje mal puesto se manifiesta como "no detecta mis proyectos"
   * sin ninguna pista de por que.
   */
  fastify.get('/api/runtime', { onRequest: [fastify.requireAuth] }, async () => {
    const info = app.docker.client.versionInfo;
    const hostAvailable = await app.host.available();

    return {
      platform: app.runtime.platform,
      runtime: {
        flavor: info?.flavor ?? 'unknown',
        version: info?.version ?? null,
        apiVersion: info?.apiVersion ?? null,
        connected: app.docker.client.connected,
      },
      socket: {
        path: app.runtime.dockerHost,
        readable: app.runtime.socketReadable,
        detected: !app.config.dockerHost,
      },
      compose: {
        roots: app.runtime.composeRoots,
        explicit: app.runtime.composeRootsExplicit,
        // Cuantos proyectos se ven frente a cuantos se pueden manejar con
        // Compose: la diferencia entre ambos numeros es exactamente lo que
        // falta por montar.
        projectsFound: app.runtime.projectDirs.length,
        projectsUsable: app.inventory.snapshot.projects.filter((p) => p.yamlAccessible).length,
      },
      metrics: {
        hostProcPath: app.config.hostProc,
        hostProcAvailable: hostAvailable,
      },
    };
  });

  fastify.get('/api/containers', { onRequest: [fastify.requireAuth] }, async () => ({
    containers: app.inventory.listContainers(),
  }));

  fastify.get('/api/containers/:id', { onRequest: [fastify.requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return { container: await app.docker.inspectContainer(id) };
    } catch {
      return reply.code(404).send({ error: 'not-found' });
    }
  });

  fastify.get('/api/containers/:id/logs', { onRequest: [fastify.requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const { tail } = logsQuerySchema.parse(request.query);
    return { logs: await app.docker.containerLogs(id, tail) };
  });

  for (const action of ['start', 'stop', 'restart'] as const) {
    fastify.post(
      `/api/containers/:id/${action}`,
      { onRequest: [fastify.requireOperator] },
      async (request, reply) => {
        const { id } = request.params as { id: string };

        // Pararse a uno mismo dejaria la peticion sin responder y el panel
        // inaccesible hasta que alguien lo arranque desde Container Manager.
        if (id === app.inventory.selfContainerId && action !== 'start') {
          return reply.code(400).send({ error: 'self-container' });
        }

        if (action === 'start') await app.docker.startContainer(id);
        else if (action === 'stop') await app.docker.stopContainer(id);
        else await app.docker.restartContainer(id);

        app.repos.history.audit({
          actorType: 'user',
          actorId: String(request.currentUser!.id),
          action: `container.${action}`,
          target: id,
          ip: request.ip,
        });

        await app.inventory.refresh();
        return { ok: true };
      },
    );
  }

  fastify.get('/api/images', { onRequest: [fastify.requireAuth] }, async () => ({
    images: app.inventory.listImages(),
  }));

  fastify.get('/api/projects', { onRequest: [fastify.requireAuth] }, async () => ({
    // Recalculado, no el snapshot: ver `listProjects`. Servir el cache hacia
    // que la tarjeta anunciara actualizaciones que ya no existian.
    projects: app.inventory.listProjects(),
  }));

  fastify.post('/api/inventory/refresh', { onRequest: [fastify.requireAuth] }, async () => {
    await app.inventory.refresh();
    return {
      containers: app.inventory.listContainers(),
      images: app.inventory.listImages(),
      projects: app.inventory.listProjects(),
    };
  });
}
