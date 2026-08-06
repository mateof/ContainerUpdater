import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '@cu/shared';
import type { AppContext } from '../../app.js';

/** Latido para que ningun intermediario corte la conexion por inactividad. */
const KEEPALIVE_MS = 15_000;

export async function registerEventRoutes(
  fastify: FastifyInstance,
  app: AppContext,
): Promise<void> {
  fastify.get('/api/metrics/latest', { onRequest: [fastify.requireAuth] }, async () => ({
    snapshot: app.metrics.latest,
    history: app.metrics.history,
  }));

  /**
   * Canal de eventos en vivo.
   *
   * SSE y no WebSocket: el flujo es unidireccional, `EventSource` manda la
   * cookie de sesion sin trabajo extra y el navegador reconecta solo. Ademas
   * atraviesa el proxy inverso de DSM sin tener que configurar `Upgrade`, que
   * es una fuente habitual de "me funciona en local pero no en el NAS".
   */
  fastify.get('/api/events', { onRequest: [fastify.requireAuth] }, (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Imprescindible tras el proxy de DSM: su nginx bufferiza las respuestas
      // por defecto y el SSE llega a trompicones o directamente no llega.
      'X-Accel-Buffering': 'no',
    });

    const send = (event: ServerEvent): void => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
    };

    // El cliente recibe primero toda la historia disponible para pintar las
    // graficas de inmediato en vez de empezar con lienzos vacios.
    send({ type: 'metrics-snapshot', payload: { history: app.metrics.history } });

    const unsubscribe = app.metrics.subscribe(send);

    const keepalive = setInterval(() => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(': keepalive\n\n');
    }, KEEPALIVE_MS);

    const cleanup = (): void => {
      clearInterval(keepalive);
      unsubscribe();
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
