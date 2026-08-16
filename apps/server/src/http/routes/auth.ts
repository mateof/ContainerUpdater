import type { FastifyInstance } from 'fastify';
import {
  changePasswordSchema,
  loginSchema,
  profileSchema,
  setupSchema,
  totpLoginSchema,
} from '@cu/shared';
import type { AppContext } from '../../app.js';
import { SESSION_COOKIE } from '../server.js';
import { TotpError } from '../../services/totp.js';

export async function registerAuthRoutes(fastify: FastifyInstance, app: AppContext): Promise<void> {
  /**
   * En una LAN por HTTP plano una cookie `Secure` no se envia nunca y el login
   * "no hace nada", sintoma dificil de diagnosticar. Por eso se autodetecta y
   * solo se fuerza si el usuario lo pide.
   */
  const cookieOptions = (request: { protocol: string; headers: Record<string, unknown> }) => ({
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure:
      app.config.secureCookies ??
      (request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https'),
    maxAge: app.config.sessionDays * 24 * 3600,
  });

  fastify.get('/api/auth/status', async () => ({
    needsSetup: app.auth.needsSetup,
    defaultLocale: app.repos.settings.defaultLocale(),
  }));

  /** Alta del primer usuario. Deja de existir en cuanto hay uno. */
  fastify.post('/api/setup', async (request, reply) => {
    if (!app.auth.needsSetup) {
      return reply.code(410).send({ error: 'setup-already-done' });
    }
    const input = setupSchema.parse(request.body);
    const hash = await app.auth.hashPassword(input.password);
    app.repos.users.create({
      username: input.username,
      passwordHash: hash,
      role: 'admin',
      locale: input.locale,
    });
    app.repos.history.audit({ actorType: 'system', actorId: null, action: 'setup.completed' });
    return { ok: true };
  });

  fastify.post(
    '/api/auth/login',
    {
      config: {
        // Ventana estrecha solo en el login. El resto de la API usa el limite
        // global, mucho mas laxo.
        rateLimit: { max: 5, timeWindow: '15 minutes' },
      },
    },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const result = await app.auth.login(input.username, input.password, {
        ip: request.ip,
        userAgent: String(request.headers['user-agent'] ?? ''),
      });

      if (!result.ok) {
        if (result.reason === 'locked') {
          return reply.code(429).send({
            error: 'locked',
            retryAfterMinutes: Math.ceil((result.retryAfterMs ?? 60_000) / 60_000),
          });
        }
        /*
         * Contrasena correcta, falta el segundo factor.
         *
         * No es un 401: no se ha rechazado nada, se ha completado el primer
         * paso. Va como 200 con un ticket para que la interfaz sepa que tiene
         * que pedir el codigo en vez de decir "credenciales incorrectas".
         */
        if (result.reason === 'totp-required') {
          return reply.send({
            needsTotp: true,
            ticket: app.totp.createTicket(result.user.id),
          });
        }
        return reply.code(401).send({ error: 'invalid-credentials' });
      }

      return reply
        .setCookie(SESSION_COOKIE, result.token, cookieOptions(request))
        .send({ user: app.repos.users.toCurrentUser(result.user) });
    },
  );

  /**
   * Segundo paso del login.
   *
   * Aqui es donde se crea la sesion: el paso de la contrasena no la crea, asi
   * que quien tenga la contrasena pero no el codigo no entra.
   *
   * Mismo limite de intentos que el primer paso. Sin el, un ticket valido
   * permitiria probar el millon de combinaciones de seis digitos.
   */
  fastify.post(
    '/api/auth/login/totp',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const input = totpLoginSchema.parse(request.body);

      let userId: number;
      let usedRecovery: boolean;
      try {
        ({ userId, usedRecovery } = app.totp.verifyTicket(input));
      } catch (error) {
        if (error instanceof TotpError) {
          return reply
            .code(error.code === 'ticket-expired' ? 440 : 401)
            .send({ error: error.code, message: error.message });
        }
        throw error;
      }

      const user = app.repos.users.findById(userId);
      if (!user) return reply.code(401).send({ error: 'invalid-credentials' });

      const session = app.auth.createSession(user.id, {
        ip: request.ip,
        userAgent: String(request.headers['user-agent'] ?? ''),
      });

      app.repos.history.audit({
        actorType: 'user',
        actorId: String(user.id),
        action: usedRecovery ? 'auth.login.recovery-code' : 'auth.login.totp',
        ip: request.ip,
      });

      return reply
        .setCookie(SESSION_COOKIE, session.token, cookieOptions(request))
        .send({
          user: app.repos.users.toCurrentUser(user),
          // Se avisa de que ha gastado uno: quedarse sin darse cuenta es como
          // quedarse sin llaves de repuesto sin saberlo.
          usedRecovery,
          recoveryCodesLeft: app.totp.status(user.id).recoveryCodesLeft,
        });
    },
  );

  fastify.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) app.auth.logout(token);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
  });

  fastify.get('/api/auth/me', { onRequest: [fastify.requireAuth] }, async (request) => ({
    user: app.repos.users.toCurrentUser(request.currentUser!),
  }));

  fastify.post(
    '/api/auth/password',
    { onRequest: [fastify.requireAuth] },
    async (request, reply) => {
      const input = changePasswordSchema.parse(request.body);
      const ok = await app.auth.changePassword(
        request.currentUser!.id,
        input.currentPassword,
        input.newPassword,
      );
      if (!ok) return reply.code(400).send({ error: 'invalid-current-password' });

      // Cambiar la contrasena revoca todas las sesiones, incluida esta: hay que
      // emitir una nueva o el usuario se quedaria fuera justo despues.
      const session = app.auth.createSession(request.currentUser!.id, {
        ip: request.ip,
        userAgent: String(request.headers['user-agent'] ?? ''),
      });
      return reply.setCookie(SESSION_COOKIE, session.token, cookieOptions(request)).send({ ok: true });
    },
  );

  fastify.put('/api/auth/profile', { onRequest: [fastify.requireAuth] }, async (request) => {
    const input = profileSchema.parse(request.body);
    if (input.locale) app.repos.users.setLocale(request.currentUser!.id, input.locale);
    const user = app.repos.users.findById(request.currentUser!.id)!;
    return { user: app.repos.users.toCurrentUser(user) };
  });
}
