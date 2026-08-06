import type { FastifyInstance } from 'fastify';
import { imagePolicySchema, updateRequestSchema } from '@cu/shared';
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

  fastify.post('/api/projects/:key/apply', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const key = decodeURIComponent((request.params as { key: string }).key);
    const { restartOnly } = (request.body ?? {}) as { restartOnly?: boolean };

    try {
      await app.updater.applyProject(key, restartOnly === true);
      app.repos.history.audit({
        actorType: 'user',
        actorId: String(request.currentUser!.id),
        action: restartOnly ? 'project.restart' : 'project.up',
        target: key,
        ip: request.ip,
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof SelfUpdateRejectedError) {
        return reply.code(409).send({ error: 'self-update-rejected' });
      }
      if (error instanceof UpdateInProgressError) {
        return reply.code(409).send({ error: 'update-in-progress' });
      }
      return reply.code(500).send({ error: 'project-apply-failed', message: (error as Error).message });
    }
  });

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
}
