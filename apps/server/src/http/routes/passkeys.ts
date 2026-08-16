/**
 * Rutas de passkeys.
 *
 * El reto se guarda contra una cookie propia y efimera, no contra la sesion:
 * durante el login todavia no hay sesion, y hace falta poder atar la respuesta
 * del autenticador al reto que se emitio para ese navegador. Sin eso, dos
 * personas entrando a la vez se pisarian el reto.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { passkeyNameSchema, passkeyRegisterSchema, passkeyLoginSchema } from '@cu/shared';
import type { AppContext } from '../../app.js';
import { PasskeyError, describeRelyingParty } from '../../services/passkeys.js';
import { SESSION_COOKIE } from '../server.js';

const CHALLENGE_COOKIE = 'cu_wa';

export async function registerPasskeyRoutes(
  fastify: FastifyInstance,
  app: AppContext,
): Promise<void> {
  const cookieOptions = (request: FastifyRequest) => ({
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure:
      app.config.secureCookies ??
      (request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https'),
    maxAge: app.config.sessionDays * 24 * 3600,
  });

  /** El sitio, tal y como lo ve el navegador que esta haciendo la peticion. */
  const rpFor = (request: FastifyRequest) =>
    describeRelyingParty({
      host: String(request.headers['x-forwarded-host'] ?? request.headers.host ?? ''),
      proto: String(request.headers['x-forwarded-proto'] ?? request.protocol),
      configuredId: app.config.rpId,
      configuredOrigin: app.config.rpOrigin,
    });

  /**
   * Clave efimera del navegador, para atar el reto a quien lo pidio.
   *
   * Se emite al pedir las opciones y se lee al verificar. Dura lo que el reto.
   */
  const browserKey = (request: FastifyRequest, reply: FastifyReply): string => {
    const existing = request.cookies[CHALLENGE_COOKIE];
    if (existing) return existing;
    const fresh = randomBytes(16).toString('base64url');
    reply.setCookie(CHALLENGE_COOKIE, fresh, { ...cookieOptions(request), maxAge: 600 });
    return fresh;
  };

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof PasskeyError) {
      return reply.code(error.code === 'not-available' ? 400 : 401).send({
        error: error.code,
        message: error.message,
      });
    }
    throw error;
  };

  /**
   * Si este origen admite passkeys, y si no, por que.
   *
   * La interfaz lo consulta antes de ofrecer nada: un boton que falla con un
   * error del navegador no explica que hace falta HTTPS con un nombre de
   * dominio, y ese es exactamente el punto donde la gente se atasca.
   */
  fastify.get('/api/auth/passkey/support', async (request) => {
    const rp = rpFor(request);
    return {
      available: rp.usable,
      reason: rp.reason,
      rpId: rp.id,
      origin: rp.origin,
      // Sin ninguna registrada no tiene sentido ofrecer el boton de entrar.
      anyRegistered: app.repos.passkeys.anyRegistered(),
    };
  });

  // -- Registro, con sesion abierta ------------------------------------------

  fastify.post(
    '/api/auth/passkey/register/options',
    { onRequest: [fastify.requireAuth] },
    async (request, reply) => {
      try {
        const options = await app.passkeys.registrationOptions({
          userId: request.currentUser!.id,
          username: request.currentUser!.username,
          rp: rpFor(request),
          sessionKey: browserKey(request, reply),
        });
        return reply.send(options);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  fastify.post(
    '/api/auth/passkey/register/verify',
    { onRequest: [fastify.requireAuth] },
    async (request, reply) => {
      const input = passkeyRegisterSchema.parse(request.body);
      try {
        const result = await app.passkeys.verifyRegistration({
          userId: request.currentUser!.id,
          response: input.response as never,
          name: input.name,
          rp: rpFor(request),
          sessionKey: browserKey(request, reply),
        });

        app.repos.history.audit({
          actorType: 'user',
          actorId: String(request.currentUser!.id),
          action: 'passkey.registered',
          target: result.name,
          ip: request.ip,
        });

        return reply.send({ ok: true });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  // -- Login, sin sesion ------------------------------------------------------

  fastify.post(
    '/api/auth/passkey/login/options',
    // Mismo limite que el login con contrasena: es la misma puerta.
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      try {
        const options = await app.passkeys.authenticationOptions({
          rp: rpFor(request),
          sessionKey: browserKey(request, reply),
        });
        return reply.send(options);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  fastify.post(
    '/api/auth/passkey/login/verify',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = passkeyLoginSchema.parse(request.body);

      try {
        const { userId } = await app.passkeys.verifyAuthentication({
          response: input.response as never,
          rp: rpFor(request),
          sessionKey: browserKey(request, reply),
        });

        const user = app.repos.users.findById(userId);
        if (!user) return reply.code(401).send({ error: 'unknown-credential' });

        const session = app.auth.createSession(user.id, {
          ip: request.ip,
          userAgent: String(request.headers['user-agent'] ?? ''),
        });

        app.repos.history.audit({
          actorType: 'user',
          actorId: String(user.id),
          action: 'auth.login.passkey',
          ip: request.ip,
        });

        return reply
          .setCookie(SESSION_COOKIE, session.token, cookieOptions(request))
          .clearCookie(CHALLENGE_COOKIE, { path: '/' })
          .send({ user: app.repos.users.toCurrentUser(user) });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  // -- Gestion ---------------------------------------------------------------

  fastify.get('/api/auth/passkeys', { onRequest: [fastify.requireAuth] }, async (request) => ({
    passkeys: app.repos.passkeys.listForUser(request.currentUser!.id).map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    })),
  }));

  fastify.delete('/api/auth/passkeys/:id', { onRequest: [fastify.requireAuth] }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid-id' });

    // Se pasa el usuario para que nadie pueda borrar la llave de otro con solo
    // adivinar un identificador.
    if (!app.repos.passkeys.remove(id, request.currentUser!.id)) {
      return reply.code(404).send({ error: 'not-found' });
    }

    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'passkey.removed',
      target: String(id),
      ip: request.ip,
    });

    return { ok: true };
  });

  fastify.put('/api/auth/passkeys/:id', { onRequest: [fastify.requireAuth] }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const { name } = passkeyNameSchema.parse(request.body);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid-id' });

    if (!app.repos.passkeys.rename(id, request.currentUser!.id, name)) {
      return reply.code(404).send({ error: 'not-found' });
    }
    return { ok: true };
  });
}
