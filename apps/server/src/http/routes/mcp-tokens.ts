import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MCP_SCOPES, isMcpScope, type McpScope } from '@cu/shared';
import type { AppContext } from '../../app.js';

const createSchema = z.object({
  name: z.string().min(1).max(60),
  scopes: z.array(z.enum(MCP_SCOPES)).min(1),
  /** Dias hasta caducar. Sin valor, no caduca. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
});

export async function registerMcpTokenRoutes(
  fastify: FastifyInstance,
  app: AppContext,
): Promise<void> {
  fastify.get('/api/mcp/tokens', { onRequest: [fastify.requireOperator] }, async () => ({
    tokens: app.repos.mcp.list(),
  }));

  /**
   * Crea un token y devuelve el secreto UNA vez.
   *
   * No se puede volver a consultar: se guarda hasheado, igual que las sesiones.
   * Es la unica respuesta de toda la API que devuelve un secreto en claro, y por
   * eso queda auditada con sus permisos.
   */
  fastify.post('/api/mcp/tokens', { onRequest: [fastify.requireOperator] }, async (request) => {
    const input = createSchema.parse(request.body);
    const scopes = input.scopes.filter(isMcpScope) as McpScope[];

    const { token, secret } = app.repos.mcp.create({
      name: input.name,
      scopes,
      userId: request.currentUser!.id,
      expiresAt: input.expiresInDays ? Date.now() + input.expiresInDays * 86_400_000 : null,
    });

    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'mcp.token.created',
      target: token.name,
      detail: scopes.join(','),
      ip: request.ip,
    });

    return { token, secret };
  });

  fastify.delete('/api/mcp/tokens/:id', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!app.repos.mcp.revoke(id)) return reply.code(404).send({ error: 'not-found' });

    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'mcp.token.revoked',
      target: String(id),
      ip: request.ip,
    });

    return { ok: true };
  });
}
