import type { FastifyInstance } from 'fastify';
import {
  applyTuningSchema,
  impactStartSchema,
  logRatesSchema,
  ruleKeySchema,
  saveContainerRulesSchema,
  saveRuleSchema,
} from '@cu/shared';
import type { AppContext } from '../../app.js';
import { ImpactError } from '../../services/disk-health/impact.js';

export async function registerDiskHealthRoutes(fastify: FastifyInstance, app: AppContext): Promise<void> {
  const audit = (request: { currentUser?: { id: number } | null; ip: string }, action: string, target: string, detail?: string) =>
    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action,
      target,
      detail,
      ip: request.ip,
    });

  fastify.get('/api/disk-health', { onRequest: [fastify.requireAuth] }, async () => ({
    overview: await app.diskHealth.overview(),
  }));

  fastify.put('/api/disk-health/rules', { onRequest: [fastify.requireOperator] }, async (request) => {
    const input = saveRuleSchema.parse(request.body);
    app.diskHealth.saveRule(input.scope, [input.key], input.rule);
    audit(request, 'disk-health.rule.saved', `${input.scope}:${input.key}`, JSON.stringify(input.rule));
    return { rules: app.diskHealth.rules() };
  });

  fastify.post('/api/disk-health/rules/containers', { onRequest: [fastify.requireOperator] }, async (request) => {
    const input = saveContainerRulesSchema.parse(request.body);
    app.diskHealth.saveRule('container', input.containers, input.rule);
    audit(request, 'disk-health.rule.saved', `container:${input.containers.join(',')}`, JSON.stringify(input.rule));
    return { rules: app.diskHealth.rules() };
  });

  fastify.post('/api/disk-health/rules/delete', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const input = ruleKeySchema.parse(request.body);
    if (!app.diskHealth.deleteRule(input.scope, input.key)) return reply.code(404).send({ error: 'not-found' });
    audit(request, 'disk-health.rule.deleted', `${input.scope}:${input.key}`);
    return { rules: app.diskHealth.rules() };
  });

  fastify.post('/api/disk-health/apply', { onRequest: [fastify.requireOperator] }, async (request) => {
    const input = applyTuningSchema.parse(request.body);
    const results = await app.diskHealth.apply({
      containerIds: input.containerIds,
      recreate: input.recreate,
      actorUserId: request.currentUser!.id,
    });
    audit(
      request,
      'disk-health.applied',
      results.map((result) => result.name).join(','),
      JSON.stringify({ recreate: input.recreate, outcomes: results.map((result) => result.outcome) }),
    );
    return { results };
  });

  fastify.get('/api/disk-health/mounts', { onRequest: [fastify.requireAuth] }, async () => ({
    mounts: await app.diskHealth.mounts(),
  }));

  fastify.post('/api/disk-health/log-rates', { onRequest: [fastify.requireAuth] }, async (request) => {
    const input = logRatesSchema.parse(request.body ?? {});
    return { logRates: await app.diskHealth.logRates(input.minutes) };
  });

  fastify.get('/api/disk-health/impact', { onRequest: [fastify.requireAuth] }, async () => app.impact.status());

  fastify.post('/api/disk-health/impact', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const input = impactStartSchema.parse(request.body);
    try {
      const probe = await app.impact.start(input);
      audit(request, 'disk-health.impact.started', probe.containerName, `${input.minutes} min`);
      return { probe };
    } catch (error) {
      if (error instanceof ImpactError) return reply.code(409).send({ error: error.code });
      throw error;
    }
  });

  fastify.post('/api/disk-health/impact/cancel', { onRequest: [fastify.requireOperator] }, async (request) => {
    const probe = await app.impact.cancel();
    if (probe) audit(request, 'disk-health.impact.cancelled', probe.containerName);
    return { probe };
  });
}
