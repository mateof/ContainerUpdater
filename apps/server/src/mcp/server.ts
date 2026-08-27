/**
 * Punto de entrada de MCP.
 *
 * Transporte HTTP sin sesion: cada peticion crea su servidor, responde y se
 * cierra. Es lo que encaja con un token, porque no hay nada que recordar entre
 * llamadas y no queda estado que limpiar si el cliente desaparece a media
 * conversacion.
 *
 * La autenticacion es un token propio por cabecera `Authorization`, no la cookie
 * de sesion. Son cosas distintas a proposito: la cookie identifica a una persona
 * delante de un navegador, con su segundo factor y su caducidad; el token
 * identifica a un programa, lleva permisos recortados y se puede revocar sin
 * echar a nadie de su sesion.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { McpToken } from '@cu/shared';
import type { AppContext } from '../app.js';
import { toolsForScopes } from './tools.js';

export async function registerMcpRoutes(fastify: FastifyInstance, app: AppContext): Promise<void> {
  /**
   * Lee el token de la cabecera.
   *
   * Se acepta `Authorization: Bearer <token>` y tambien la cabecera suelta
   * `X-CU-Token`, porque no todos los clientes de MCP dejan poner cabeceras
   * arbitrarias con el mismo nombre y esta es la salida habitual.
   */
  function readToken(header: string | undefined, alt: string | undefined): string | null {
    if (header?.startsWith('Bearer ')) return header.slice(7).trim();
    if (alt) return alt.trim();
    return null;
  }

  fastify.all('/api/mcp', async (request, reply) => {
    const secret = readToken(
      request.headers.authorization,
      request.headers['x-cu-token'] as string | undefined,
    );

    if (!secret) {
      return reply
        .code(401)
        .header('www-authenticate', 'Bearer realm="ContainerUpdater MCP"')
        .send({ error: 'unauthorized' });
    }

    const token: McpToken | null = app.repos.mcp.resolve(secret);
    if (!token) {
      app.repos.history.audit({
        actorType: 'system',
        actorId: null,
        action: 'mcp.auth.failed',
        ip: request.ip,
      });
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // Sin permisos no hay nada que ofrecer, y dejarlo entrar solo produciria una
    // conversacion en la que el modelo no encuentra ninguna herramienta.
    if (token.scopes.length === 0) {
      return reply.code(403).send({ error: 'no-scopes' });
    }

    app.repos.mcp.touch(token.id);

    const server = new McpServer(
      { name: 'containerupdater', version: app.config.version },
      {
        instructions:
          'Gestiona contenedores Docker de esta maquina. Antes de proponer puertos para algo ' +
          'nuevo, consulta list_ports. Las operaciones que recrean contenedores devuelven un ' +
          'jobId que se consulta con get_job.',
      },
    );

    for (const tool of toolsForScopes(token.scopes)) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.inputSchema },
        async (args: Record<string, unknown>) => {
          try {
            const resultado = await tool.run(app, args ?? {});
            app.repos.history.audit({
              actorType: 'system',
              actorId: `mcp:${token.name}`,
              action: `mcp.${tool.name}`,
              detail: JSON.stringify(args ?? {}).slice(0, 400),
              ip: request.ip,
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify(resultado, null, 2) }] };
          } catch (error) {
            // El error viaja como resultado y no como excepcion del protocolo:
            // asi el modelo lo lee, entiende que fallo y puede corregir, en vez
            // de recibir un fallo de transporte que no le dice nada.
            return {
              isError: true,
              content: [{ type: 'text' as const, text: (error as Error).message }],
            };
          }
        },
      );
    }

    const transport = new StreamableHTTPServerTransport({
      // Sin sesiones: ver la nota de arriba.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // Fastify ya ha leido y parseado el cuerpo, asi que se le pasa hecho: si no,
    // el transporte se quedaria esperando un flujo que nadie va a emitir.
    reply.hijack();
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);

    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
  });
}
