/**
 * Servidor HTTP. Sirve la API y la SPA compilada desde el mismo origen, lo que
 * permite usar cookies de sesion sin CORS ni tokens en cabeceras.
 */
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import type { AppContext } from '../app.js';
import type { UserRow } from '../db/repositories/index.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDockerRoutes } from './routes/docker.js';
import { registerUpdateRoutes } from './routes/updates.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerEventRoutes } from './routes/events.js';

export const SESSION_COOKIE = 'cu_session';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: UserRow;
    sessionToken?: string;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
    requireOperator: (
      request: FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>;
  }
}

export async function buildServer(app: AppContext): Promise<FastifyInstance> {
  const fastify = Fastify({
    // El logger propio ya escribe lo que interesa; el de Fastify duplicaria
    // cada peticion y en un NAS eso es ruido.
    logger: false,
    trustProxy: app.config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  await fastify.register(cookie);

  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Vite emite CSS y JS a ficheros, asi que no hace falta unsafe-inline.
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // `upgrade-insecure-requests` se desactiva salvo que haya TLS de
        // verdad: en una LAN por HTTP plano obliga al navegador a reintentar
        // por HTTPS y la pagina no carga, con un error que no explica nada.
        ...(app.config.secureCookies === true ? {} : { upgradeInsecureRequests: null }),
      },
    },
    // HSTS solo tiene sentido tras TLS. En una LAN por HTTP plano, activarlo
    // dejaria el navegador incapaz de volver al panel.
    hsts: app.config.secureCookies === true,
    crossOriginEmbedderPolicy: false,
  });

  await fastify.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // El SSE mantiene la conexion abierta y no debe contar como rafaga.
    allowList: (request) => request.url.startsWith('/api/events'),
  });

  // -- Autenticacion --------------------------------------------------------

  fastify.decorateRequest('currentUser', undefined);
  fastify.decorateRequest('sessionToken', undefined);

  fastify.decorate('requireAuth', async (request: FastifyRequest, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const session = app.auth.resolveSession(token);
    if (!session) {
      await reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(401).send({ error: 'unauthorized' });
      return;
    }
    request.currentUser = session.user;
    request.sessionToken = token;

    // Mientras haya que cambiar la contrasena solo se permite justamente eso.
    if (
      session.user.must_change_password === 1 &&
      !request.url.startsWith('/api/auth/password') &&
      !request.url.startsWith('/api/auth/me') &&
      !request.url.startsWith('/api/auth/logout')
    ) {
      await reply.code(403).send({ error: 'password-change-required' });
    }
  });

  fastify.decorate('requireOperator', async (request: FastifyRequest, reply) => {
    await fastify.requireAuth(request, reply);
    if (reply.sent) return;
    if (request.currentUser?.role === 'viewer') {
      await reply.code(403).send({ error: 'forbidden' });
    }
  });

  /**
   * Comprobacion de origen en las mutaciones.
   *
   * SameSite=Lax ya bloquea el envio de la cookie en peticiones POST
   * cross-site, asi que esto es una segunda capa barata. Se acepta que falte la
   * cabecera porque algunos clientes legitimos no la mandan.
   */
  fastify.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    if (!request.url.startsWith('/api/')) return;

    const site = request.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') {
      await reply.code(403).send({ error: 'cross-origin-blocked' });
      return;
    }

    const origin = request.headers.origin;
    if (origin) {
      const host = request.headers.host;
      try {
        if (new URL(origin).host !== host) {
          await reply.code(403).send({ error: 'cross-origin-blocked' });
        }
      } catch {
        await reply.code(403).send({ error: 'cross-origin-blocked' });
      }
    }
  });

  fastify.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      await reply.code(400).send({
        error: 'validation',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }
    if (error.statusCode && error.statusCode < 500) {
      await reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    app.log.error(`Error no controlado en ${request.method} ${request.url}`, error);
    await reply.code(500).send({ error: 'internal' });
  });

  // -- Rutas ----------------------------------------------------------------

  await registerAuthRoutes(fastify, app);
  await registerDockerRoutes(fastify, app);
  await registerUpdateRoutes(fastify, app);
  await registerProjectRoutes(fastify, app);
  await registerSettingsRoutes(fastify, app);
  await registerEventRoutes(fastify, app);

  fastify.get('/api/health', async () => ({
    ok: true,
    docker: app.docker.client.connected,
    version: app.config.version,
  }));

  // -- SPA ------------------------------------------------------------------

  if (existsSync(app.config.publicDir)) {
    await fastify.register(fastifyStatic, {
      root: app.config.publicDir,
      // Los nombres llevan hash, asi que el contenido de un nombre dado no
      // cambia nunca y se puede cachear de forma agresiva.
      maxAge: '1y',
      immutable: true,
      index: false,
      // Sirve los .br y .gz pregenerados si el navegador los acepta.
      preCompressed: true,
    });

    /**
     * La raiz y las rutas de la SPA se sirven leyendo el index a mano.
     *
     * Dos motivos para no usar `sendFile`:
     *
     * 1. Con `index: false`, @fastify/static trata `/` como un directorio sin
     *    indice y responde 403 antes de que el manejador de "no encontrado"
     *    llegue a intervenir.
     * 2. `sendFile` impone la politica de cache del plugin, que aqui es
     *    `immutable` durante un ano. Eso vale para los assets, que llevan hash
     *    en el nombre, pero NO para el index.html: si el navegador lo cachea un
     *    ano, tras un despliegue seguira pidiendo los assets antiguos, que ya no
     *    existen, y la aplicacion queda rota hasta un recarga forzada.
     *
     * El fichero se lee una vez al arrancar: son un par de KB y evita tocar el
     * disco del NAS en cada navegacion.
     */
    const indexHtml = readFileSync(join(app.config.publicDir, 'index.html'), 'utf8');

    const sendApp = async (reply: import('fastify').FastifyReply): Promise<void> => {
      await reply
        .type('text/html; charset=utf-8')
        .header('Cache-Control', 'no-store, must-revalidate')
        .send(indexHtml);
    };

    fastify.get('/', async (_request, reply) => sendApp(reply));

    // El resto de rutas caen en el index para que funcionen las rutas de React
    // al recargar la pagina o entrar por un enlace directo.
    fastify.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        await reply.code(404).send({ error: 'not-found' });
        return;
      }
      await sendApp(reply);
    });
  } else {
    app.log.warn(
      `No se encuentra la carpeta del frontend (${app.config.publicDir}). Solo estara disponible la API.`,
    );
  }

  return fastify;
}
