/**
 * Rutas del segundo factor.
 *
 * El QR se genera en el SERVIDOR como SVG. Es lo que evita meter un generador de
 * QR en el bundle del navegador por una pantalla que se usa una vez en la vida
 * del panel, y el SVG resultante son unos pocos kilobytes que viajan ya
 * renderizados.
 */
import type { FastifyInstance } from 'fastify';
import { renderSVG } from 'uqr';
import { totpCodeSchema, totpDisableSchema } from '@cu/shared';
import type { AppContext } from '../../app.js';
import { TotpError } from '../../services/totp.js';

export async function registerTotpRoutes(
  fastify: FastifyInstance,
  app: AppContext,
): Promise<void> {
  /** Si lo tiene activo y cuantos codigos de recuperacion le quedan. */
  fastify.get('/api/auth/totp', { onRequest: [fastify.requireAuth] }, async (request) =>
    app.totp.status(request.currentUser!.id),
  );

  /**
   * Empieza el alta: secreto nuevo, QR y la clave para teclearla a mano.
   *
   * Todavia no queda activo: hace falta confirmar con un codigo. Guardar el
   * secreto y darlo por bueno dejaria fuera a quien no llegara a escanear.
   */
  fastify.post('/api/auth/totp/start', { onRequest: [fastify.requireAuth] }, async (request, reply) => {
    try {
      const { secret, uri } = app.totp.startEnrollment({
        userId: request.currentUser!.id,
        username: request.currentUser!.username,
      });

      return {
        secret,
        uri,
        // `renderSVG` devuelve el SVG entero; se manda tal cual para pintarlo
        // sin que el navegador tenga que calcular nada.
        qr: renderSVG(uri, { border: 2 }),
      };
    } catch (error) {
      if (error instanceof TotpError) {
        return reply.code(409).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  /**
   * Confirma el alta con un codigo y devuelve los codigos de recuperacion.
   *
   * Es la UNICA vez que se muestran: se guardan hasheados y despues ya no se
   * pueden volver a ensenar.
   */
  fastify.post('/api/auth/totp/confirm', { onRequest: [fastify.requireAuth] }, async (request, reply) => {
    const { code } = totpCodeSchema.parse(request.body);
    try {
      const { recoveryCodes } = app.totp.confirmEnrollment({
        userId: request.currentUser!.id,
        code,
      });

      app.repos.history.audit({
        actorType: 'user',
        actorId: String(request.currentUser!.id),
        action: 'totp.enabled',
        ip: request.ip,
      });

      return { recoveryCodes };
    } catch (error) {
      if (error instanceof TotpError) {
        return reply.code(400).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  /**
   * Desactivarlo exige la contrasena.
   *
   * Sin ella, quien pillara una sesion abierta podria quitar el segundo factor
   * de un clic, que es justo lo que el segundo factor deberia impedir.
   */
  fastify.post('/api/auth/totp/disable', { onRequest: [fastify.requireAuth] }, async (request, reply) => {
    const { password } = totpDisableSchema.parse(request.body);

    if (!(await app.auth.verifyPassword(request.currentUser!.id, password))) {
      return reply.code(401).send({ error: 'invalid-password' });
    }

    app.totp.disable(request.currentUser!.id);
    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'totp.disabled',
      ip: request.ip,
    });

    return { ok: true };
  });

  /** Genera codigos nuevos e invalida los anteriores. Tambien pide contrasena. */
  fastify.post('/api/auth/totp/recovery', { onRequest: [fastify.requireAuth] }, async (request, reply) => {
    const { password } = totpDisableSchema.parse(request.body);

    if (!(await app.auth.verifyPassword(request.currentUser!.id, password))) {
      return reply.code(401).send({ error: 'invalid-password' });
    }

    try {
      const recoveryCodes = app.totp.regenerateRecoveryCodes(request.currentUser!.id);
      app.repos.history.audit({
        actorType: 'user',
        actorId: String(request.currentUser!.id),
        action: 'totp.recovery-regenerated',
        ip: request.ip,
      });
      return { recoveryCodes };
    } catch (error) {
      if (error instanceof TotpError) {
        return reply.code(400).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });
}
