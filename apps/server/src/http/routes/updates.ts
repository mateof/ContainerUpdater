import type { FastifyInstance } from 'fastify';
import {
  imageDeleteSchema,
  imagePolicySchema,
  serviceActionSchema,
  updateRequestSchema,
} from '@cu/shared';
import { localImageName, parseImageReference } from '../../registry/reference.js';
import type { AppContext } from '../../app.js';
import {
  RecreateUnsupportedError,
  SelfUpdateRejectedError,
  UpdateInProgressError,
} from '../../services/updater.js';

export async function registerUpdateRoutes(
  fastify: FastifyInstance,
  app: AppContext,
): Promise<void> {
  fastify.put('/api/images/:ref/policy', { onRequest: [fastify.requireOperator] }, async (request) => {
    const ref = decodeURIComponent((request.params as { ref: string }).ref);
    const patch = imagePolicySchema.parse(request.body);
    const current = app.repos.inventory.getPolicy(ref);
    const updated = { ...current, ...patch, imageRef: ref };
    app.repos.inventory.savePolicy(updated);

    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'image.policy.updated',
      target: ref,
      detail: JSON.stringify(patch),
      ip: request.ip,
    });

    return { policy: updated };
  });

  /**
   * Borra una imagen local.
   *
   * Las reglas salen de lo que hace Docker, no de una preferencia:
   *
   * - Con algun contenedor EN MARCHA, el daemon se niega y hace bien. Se
   *   rechaza aqui antes de intentarlo, para poder explicarlo.
   * - Con contenedores PARADOS, el daemon tambien se niega salvo que se fuerce.
   *   Forzar borra la imagen y deja esos contenedores inservibles: no podran
   *   volver a arrancar. Por eso hay que pedirlo explicitamente y la interfaz
   *   nombra los contenedores afectados antes de confirmar.
   * - Sin contenedores, se borra sin mas.
   *
   * La propia imagen de la aplicacion queda cubierta por la primera regla: su
   * contenedor esta en marcha por definicion mientras se atiende esta peticion.
   */
  fastify.delete('/api/images/:ref', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const ref = decodeURIComponent((request.params as { ref: string }).ref);
    const { force } = imageDeleteSchema.parse(request.query ?? {});

    const image = app.inventory.listImages().find((candidate) => candidate.ref === ref);
    if (!image) return reply.code(404).send({ error: 'not-found' });

    if (image.usage === 'running') {
      return reply
        .code(409)
        .send({ error: 'image-in-use', containers: image.inUseByRunning });
    }
    if (image.usage === 'stopped' && !force) {
      // No es un error, es una confirmacion que falta: la interfaz usa esta
      // lista para decir exactamente que contenedores se quedaran inservibles.
      return reply.code(409).send({ error: 'needs-force', containers: image.inUseBy });
    }

    try {
      // El daemon conoce la imagen por su nombre local, no por la referencia
      // normalizada. Confundirlos ya rompio el recreate una vez.
      await app.docker.removeImage(localImageName(parseImageReference(ref)), force);
    } catch (error) {
      return reply
        .code(422)
        .send({ error: 'delete-failed', message: (error as Error).message });
    }

    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'image.deleted',
      target: ref,
      detail: force ? 'forzado' : null,
      ip: request.ip,
    });

    await app.inventory.refresh().catch(() => undefined);
    return { ok: true };
  });

  fastify.get('/api/images/:ref/plan', { onRequest: [fastify.requireAuth] }, async (request) => {
    const ref = decodeURIComponent((request.params as { ref: string }).ref);
    return { plan: await app.updater.planFor(ref) };
  });

  fastify.post('/api/images/:ref/check', { onRequest: [fastify.requireAuth] }, async (request) => {
    const ref = decodeURIComponent((request.params as { ref: string }).ref);
    const summary = await app.checker.runCheck('manual', { refs: [ref] });
    await app.notifier.notifyUpdatesAvailable(summary.outcomes);
    return { run: summary.run, outcome: summary.outcomes[0] ?? null };
  });

  fastify.post('/api/images/:ref/update', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const ref = decodeURIComponent((request.params as { ref: string }).ref);
    const input = updateRequestSchema.parse(request.body ?? {});

    try {
      // Se encola y se responde de inmediato: una actualizacion puede tardar
      // varios minutos y mantener la peticion abierta acabaria en un timeout
      // del navegador o del proxy inverso de DSM. El progreso viaja por SSE y
      // se puede seguir desde la pantalla de Actualizaciones.
      const { job } = await app.updater.enqueue({
        imageRef: ref,
        mode: input.mode,
        scope: input.scope,
        removeImageFirst: input.removeImageFirst,
        targetTag: input.targetTag,
        trigger: 'manual',
        actorUserId: request.currentUser!.id,
      });

      app.repos.history.audit({
        actorType: 'user',
        actorId: String(request.currentUser!.id),
        action: `image.${input.mode}`,
        target: ref,
        ip: request.ip,
      });

      // 202: aceptado y en marcha, pero todavia sin terminar.
      return reply.code(202).send({ job, queued: app.updater.queued });
    } catch (error) {
      // Los errores que se detectan ANTES de encolar si se devuelven aqui, con
      // un codigo propio cada uno para que la interfaz los explique en vez de
      // mostrar un 500 generico. Lo que falle durante la ejecucion viaja por
      // SSE y queda en el historial.
      if (error instanceof SelfUpdateRejectedError) {
        return reply.code(409).send({ error: 'self-update-rejected' });
      }
      if (error instanceof UpdateInProgressError) {
        return reply.code(409).send({ error: 'update-in-progress' });
      }
      if (error instanceof RecreateUnsupportedError) {
        return reply.code(422).send({ error: 'recreate-unsupported', reason: error.reason });
      }
      return reply.code(500).send({ error: 'update-failed', message: (error as Error).message });
    }
  });

  // -- Auto-actualizacion ---------------------------------------------------

  fastify.get('/api/self-update/plan', { onRequest: [fastify.requireAuth] }, async () => ({
    plan: await app.selfUpdate.plan(),
  }));

  /**
   * Lanza la auto-actualizacion.
   *
   * Este proceso se para pocos segundos despues de responder, asi que la
   * respuesta se envia ANTES de que el ayudante empiece a trabajar: si se
   * esperase, el cliente veria la conexion cortada y no sabria si llego a
   * lanzarse o no.
   */
  fastify.post('/api/self-update', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const plan = await app.selfUpdate.plan();
    if (!plan.possible) {
      return reply.code(422).send({ error: 'self-update-not-possible', reason: plan.reason });
    }

    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'self-update.requested',
      ip: request.ip,
    });

    try {
      // La descarga y las validaciones se hacen aqui, con el panel todavia en
      // pie: si algo falla, se devuelve un error normal y no ha pasado nada.
      await app.selfUpdate.start((line: string) => app.log.info(`[self-update] ${line}`));
      return reply.code(202).send({ started: true, strategy: plan.strategy });
    } catch (error) {
      app.log.error('No se ha podido iniciar la auto-actualizacion', error);
      return reply
        .code(500)
        .send({ error: 'self-update-failed', message: (error as Error).message });
    }
  });

  /**
   * Acciones de Compose sobre un servicio concreto.
   *
   * Cubre lo que si no habria que hacer por SSH: recrear un servicio, pararlo,
   * arrancarlo o descargar su imagen sin tocar el resto del proyecto.
   */
  fastify.post(
    // La clave del proyecto y el servicio van en el cuerpo, no en la ruta.
    // Aquella clave es `nombre + directorio de trabajo`, y en un NAS esas rutas
    // son largas: al codificarlas en la URL se supera el limite y el servidor
    // responde 414 sin llegar al codigo. Verificado.
    '/api/projects/service-action',
    { onRequest: [fastify.requireOperator] },
    async (request, reply) => {
      const body = serviceActionSchema.parse(request.body);

      try {
        const { job } = await app.updater.enqueueServiceAction({
          projectKey: body.projectKey,
          serviceName: body.serviceName,
          action: body.action,
          actorUserId: request.currentUser!.id,
        });

        app.repos.history.audit({
          actorType: 'user',
          actorId: String(request.currentUser!.id),
          action: `service.${body.action}`,
          target: `${body.projectKey} / ${body.serviceName}`,
          ip: request.ip,
        });

        return reply.code(202).send({ job, queued: app.updater.queued });
      } catch (error) {
        if (error instanceof SelfUpdateRejectedError) {
          return reply.code(409).send({ error: 'self-update-rejected' });
        }
        if (error instanceof UpdateInProgressError) {
          return reply.code(409).send({ error: 'update-in-progress' });
        }
        return reply
          .code(422)
          .send({ error: 'service-action-failed', message: (error as Error).message });
      }
    },
  );

  fastify.post('/api/checks/run', { onRequest: [fastify.requireAuth] }, async (_request, reply) => {
    if (app.checker.running) return reply.code(409).send({ error: 'check-in-progress' });
    // No se espera al final: una comprobacion completa puede tardar y la
    // interfaz sigue el progreso por SSE.
    void app.scheduler.runCheckCycle('manual');
    return { started: true };
  });

  fastify.get('/api/checks/runs', { onRequest: [fastify.requireAuth] }, async () => ({
    runs: app.repos.history.listRuns(50),
  }));

  fastify.get('/api/updates/jobs', { onRequest: [fastify.requireAuth] }, async () => ({
    jobs: app.repos.history.listJobs(50),
  }));

  fastify.get('/api/updates/jobs/:id', { onRequest: [fastify.requireAuth] }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const job = app.repos.history.getJob(id);
    if (!job) return reply.code(404).send({ error: 'not-found' });
    return { job };
  });

  /** Detiene un trabajo atascado o que ya no interesa. */
  fastify.post(
    '/api/updates/jobs/:id/cancel',
    { onRequest: [fastify.requireOperator] },
    async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      const job = app.repos.history.getJob(id);
      if (!job) return reply.code(404).send({ error: 'not-found' });

      const result = app.updater.cancel(id);
      app.repos.history.audit({
        actorType: 'user',
        actorId: String(request.currentUser!.id),
        action: 'update.cancelled',
        target: job.imageRef,
        detail: result.cancelled ? 'ok' : (result.reason ?? 'no'),
        ip: request.ip,
      });

      if (!result.cancelled) {
        return reply.code(409).send({ error: 'cannot-cancel', reason: result.reason });
      }
      return { cancelled: true };
    },
  );

  /**
   * Vuelve a lanzar un trabajo que fallo o se cancelo.
   *
   * Se crea uno nuevo en vez de reabrir el anterior: el historial tiene que
   * conservar que hubo un intento fallido y por que.
   */
  fastify.post(
    '/api/updates/jobs/:id/retry',
    { onRequest: [fastify.requireOperator] },
    async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      const previous = app.repos.history.getJob(id);
      if (!previous) return reply.code(404).send({ error: 'not-found' });

      if (previous.status === 'running' || previous.status === 'queued') {
        return reply.code(409).send({ error: 'still-active' });
      }

      try {
        const { job } = await app.updater.enqueue({
          imageRef: previous.imageRef,
          mode: previous.mode,
          trigger: 'manual',
          actorUserId: request.currentUser!.id,
        });
        return reply.code(202).send({ job });
      } catch (error) {
        if (error instanceof SelfUpdateRejectedError) {
          return reply.code(409).send({ error: 'self-update-rejected' });
        }
        if (error instanceof UpdateInProgressError) {
          return reply.code(409).send({ error: 'update-in-progress' });
        }
        if (error instanceof RecreateUnsupportedError) {
          return reply.code(422).send({ error: 'recreate-unsupported', reason: error.reason });
        }
        return reply.code(500).send({ error: 'retry-failed', message: (error as Error).message });
      }
    },
  );
}
