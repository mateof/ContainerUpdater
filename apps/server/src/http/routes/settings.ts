import type { FastifyInstance } from 'fastify';
import { registrySchema, settingsSchema } from '@cu/shared';
import type { AppContext } from '../../app.js';
import { RegistryClient } from '../../registry/manifest.js';
import { parseImageReference } from '../../registry/reference.js';
import { NeedsCredentialsError } from '../../registry/auth.js';

export async function registerSettingsRoutes(
  fastify: FastifyInstance,
  app: AppContext,
): Promise<void> {
  fastify.get('/api/settings', { onRequest: [fastify.requireAuth] }, async () => ({
    settings: app.repos.settings.getAll(),
  }));

  fastify.put('/api/settings', { onRequest: [fastify.requireOperator] }, async (request) => {
    const patch = settingsSchema.parse(request.body);
    const previous = app.repos.settings.getAll();
    const settings = app.repos.settings.update(patch);

    // Cambiar el cron sin reprogramar dejaria el ajuste guardado pero sin
    // efecto hasta el siguiente reinicio.
    if (patch.checkCron && patch.checkCron !== previous.checkCron) {
      app.scheduler.reschedule();
    }

    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'settings.updated',
      detail: JSON.stringify(patch),
      ip: request.ip,
    });

    return { settings, nextCheckAt: app.scheduler.nextCheckAt };
  });

  // -- Registries -----------------------------------------------------------

  fastify.get('/api/registries', { onRequest: [fastify.requireAuth] }, async () => ({
    registries: app.repos.registries.list(),
    keyringHealthy: app.keyring.healthy,
  }));

  fastify.post('/api/registries', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    if (!app.keyring.healthy) return reply.code(503).send({ error: 'keyring-locked' });

    const input = registrySchema.parse(request.body);
    if (app.repos.registries.findByHost(input.host)) {
      return reply.code(409).send({ error: 'already-exists' });
    }

    const id = app.repos.registries.create(input);
    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'registry.created',
      target: input.host,
      ip: request.ip,
    });
    return { id };
  });

  fastify.put('/api/registries/:id', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    if (!app.keyring.healthy) return reply.code(503).send({ error: 'keyring-locked' });

    const id = Number((request.params as { id: string }).id);
    const input = registrySchema.partial().parse(request.body);
    app.repos.registries.update(id, {
      name: input.name,
      authType: input.authType,
      username: input.username,
      secret: input.secret,
    });
    return { ok: true };
  });

  fastify.delete('/api/registries/:id', { onRequest: [fastify.requireOperator] }, async (request) => {
    const id = Number((request.params as { id: string }).id);
    app.repos.registries.remove(id);
    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'registry.deleted',
      target: String(id),
      ip: request.ip,
    });
    return { ok: true };
  });

  /**
   * Prueba las credenciales contra una imagen real de ese host.
   *
   * Consultar `/v2/` a secas no vale: muchos registries lo dejan abierto y
   * responden 200 sin comprobar nada, asi que una credencial invalida pasaria
   * por buena.
   */
  fastify.post('/api/registries/:id/test', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const registry = app.repos.registries.list().find((r) => r.id === id);
    if (!registry) return reply.code(404).send({ error: 'not-found' });

    const sample = app.repos.inventory.listImages().find((image) => image.host === registry.host);
    if (!sample) {
      return reply.code(400).send({ error: 'no-image-to-test', host: registry.host });
    }

    const credentials = app.repos.registries.getCredentials(registry.host);
    const client = new RegistryClient();

    try {
      const head = await client.headManifest(parseImageReference(sample.normalized_ref), credentials);
      if (!head.digest) {
        app.repos.registries.setStatus(registry.host, 'error', `HTTP ${head.status}`);
        return reply.code(400).send({ error: 'test-failed', status: head.status });
      }
      app.repos.registries.setStatus(registry.host, 'ok', null);
      return { ok: true, testedWith: sample.normalized_ref };
    } catch (error) {
      const message =
        error instanceof NeedsCredentialsError
          ? 'Las credenciales no son validas o no dan acceso a ese repositorio'
          : (error as Error).message;
      app.repos.registries.setStatus(registry.host, 'error', message);
      return reply.code(400).send({ error: 'test-failed', message });
    }
  });

  /**
   * Borra las credenciales ilegibles tras perder la clave maestra. Siempre a
   * peticion explicita del usuario: nunca se dispara sola.
   */
  fastify.post('/api/registries/forget-secrets', { onRequest: [fastify.requireOperator] }, async (request) => {
    const cleared = app.repos.registries.forgetAllSecrets();
    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'registry.secrets.forgotten',
      detail: String(cleared),
      ip: request.ip,
    });
    return { cleared };
  });

  // -- Telegram -------------------------------------------------------------

  fastify.get('/api/telegram', { onRequest: [fastify.requireAuth] }, async () => ({
    configured: app.telegram.configured,
    running: app.telegram.ready,
    botUsername: app.telegram.username,
    error: app.telegram.lastError,
    users: app.repos.telegram.listUsers(),
  }));

  fastify.post('/api/telegram/link-code', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    if (!app.telegram.configured) return reply.code(400).send({ error: 'telegram-not-configured' });

    const { code, expiresAt } = app.repos.telegram.createLinkCode(request.currentUser!.id);
    const username = app.telegram.username;

    return {
      code,
      expiresAt,
      deepLink: username ? `https://t.me/${username}?start=${code}` : null,
    };
  });

  fastify.delete('/api/telegram/users/:id', { onRequest: [fastify.requireOperator] }, async (request) => {
    const id = Number((request.params as { id: string }).id);
    app.repos.telegram.revoke(id);
    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'telegram.revoked',
      target: String(id),
      ip: request.ip,
    });
    return { ok: true };
  });
}
