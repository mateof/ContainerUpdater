/**
 * Creacion y edicion de proyectos.
 *
 * Es la unica familia de rutas que escribe en el disco del anfitrion, asi que
 * todas exigen rol de operador y todas dejan rastro en la auditoria. El
 * revelado de una variable del `.env` tambien: leer un secreto es un evento que
 * interesa poder mirar despues.
 */
import type { FastifyInstance } from 'fastify';
import {
  envRevealSchema,
  projectActionSchema,
  projectCreateSchema,
  projectFilesUpdateSchema,
  projectNameSchema,
} from '@cu/shared';
import type { AppContext } from '../../app.js';
import { ProjectFilesError } from '../../services/project-files.js';
import { SelfUpdateRejectedError, UpdateInProgressError } from '../../services/updater.js';
import { ComposeError } from '../../docker/compose.js';

export async function registerProjectRoutes(
  fastify: FastifyInstance,
  app: AppContext,
): Promise<void> {
  /** Si se puede crear, y si no, por que no. La interfaz lo necesita antes de ofrecerlo. */
  fastify.get('/api/projects/dir', { onRequest: [fastify.requireAuth] }, async () =>
    app.projectFiles.dirInfo(),
  );

  fastify.post('/api/projects/create', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const input = projectCreateSchema.parse(request.body);

    let created: { dir: string; composeFile: string } | null = null;
    try {
      created = await app.projectFiles.create({
        name: input.name,
        compose: input.compose,
        env: input.env,
        actorUserId: request.currentUser!.id,
      });

      /**
       * Validacion con el propio Compose, ya con los ficheros en su sitio.
       *
       * Tiene que ser aqui y no antes: `compose config` resuelve `${VARIABLE}`
       * contra el `.env` de al lado, asi que validar el YAML suelto daria un
       * falso error en cualquier proyecto que use variables. Si no pasa, se
       * deshace lo escrito y se devuelve el motivo tal cual lo da Compose, que
       * suele senalar la linea.
       */
      await app.compose.validate({
        projectName: input.name,
        workingDir: created.dir,
        configFiles: [created.composeFile],
      });
    } catch (error) {
      if (created) {
        // Se limpia lo que se acababa de crear: dejar una carpeta a medias que
        // ni levanta ni se ve en ningun sitio es peor que no haber creado nada.
        app.projectFiles.forget(input.name);
        await app.projectFiles.discard(created.dir).catch(() => undefined);
      }

      if (error instanceof ProjectFilesError) {
        return reply.code(error.code === 'already-exists' ? 409 : 422).send({
          error: error.code,
          message: error.message,
        });
      }
      if (error instanceof ComposeError) {
        return reply.code(422).send({ error: 'invalid-compose', message: error.message });
      }
      return reply.code(500).send({ error: 'create-failed', message: (error as Error).message });
    }

    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'project.created',
      target: input.name,
      detail: created.dir,
      ip: request.ip,
    });

    // Hace falta para que el proyecto aparezca ya en la lista: sin contenedores
    // todavia, lo unico que lo hace visible es el refresco del inventario.
    await app.inventory.refresh().catch(() => undefined);

    if (!input.start) return reply.code(201).send({ name: input.name, dir: created.dir, job: null });

    try {
      const { job } = await app.updater.enqueueProjectAction({
        projectKey: `${input.name} ${created.dir}`,
        action: 'up',
        actorUserId: request.currentUser!.id,
      });
      return reply.code(201).send({ name: input.name, dir: created.dir, job });
    } catch (error) {
      // El proyecto SI se ha creado. Que no se haya podido arrancar ahora mismo
      // no lo invalida: se informa y queda ahi para levantarlo desde la lista.
      return reply.code(201).send({
        name: input.name,
        dir: created.dir,
        job: null,
        startError: (error as Error).message,
      });
    }
  });

  /** Ficheros de un proyecto, con los valores sensibles ya ocultos. */
  fastify.get('/api/projects/:name/files', { onRequest: [fastify.requireAuth] }, async (request, reply) => {
    const parsed = projectNameSchema.safeParse((request.params as { name: string }).name);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid-name' });

    try {
      return { files: await app.projectFiles.read(parsed.data) };
    } catch (error) {
      if (error instanceof ProjectFilesError) {
        return reply.code(404).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  /**
   * El `.env` completo en texto plano, para poder editarlo.
   *
   * Va aparte de `/files` a proposito: esa ruta la llama la pantalla al abrirse
   * y devuelve los secretos ocultos, mientras que esta solo se pide al entrar a
   * editar de verdad y por eso puede auditarse como lo que es.
   */
  fastify.get('/api/projects/:name/env', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const parsed = projectNameSchema.safeParse((request.params as { name: string }).name);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid-name' });

    try {
      const content = await app.projectFiles.readEnvRaw(parsed.data);
      app.repos.history.audit({
        actorType: 'user',
        actorId: String(request.currentUser!.id),
        action: 'project.env.read',
        target: parsed.data,
        ip: request.ip,
      });
      return { content };
    } catch (error) {
      if (error instanceof ProjectFilesError) {
        return reply.code(404).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  /** Una sola variable en claro. Cada revelado deja su propia linea de auditoria. */
  fastify.post('/api/projects/env/reveal', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const input = envRevealSchema.parse(request.body);

    try {
      const value = await app.projectFiles.revealEnvValue(input.name, input.key);
      if (value === null) return reply.code(404).send({ error: 'not-found' });

      app.repos.history.audit({
        actorType: 'user',
        actorId: String(request.currentUser!.id),
        action: 'project.env.revealed',
        target: `${input.name} / ${input.key}`,
        ip: request.ip,
      });

      return { value };
    } catch (error) {
      if (error instanceof ProjectFilesError) {
        return reply.code(404).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  fastify.put('/api/projects/files', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const input = projectFilesUpdateSchema.parse(request.body);

    let dir: string;
    try {
      ({ dir } = await app.projectFiles.update({
        name: input.name,
        compose: input.compose,
        env: input.env,
        actorUserId: request.currentUser!.id,
      }));

      await app.compose.validate({
        projectName: input.name,
        workingDir: dir,
        configFiles: [`${dir}/docker-compose.yml`],
      });
    } catch (error) {
      if (error instanceof ProjectFilesError) {
        return reply.code(422).send({ error: error.code, message: error.message });
      }
      if (error instanceof ComposeError) {
        /**
         * Se deja lo guardado, no se revierte.
         *
         * Es lo contrario que al crear, y a proposito: aqui el usuario esta
         * editando algo que ya existe y perder su trabajo por un error de
         * sintaxis seria mucho peor que dejarle el fichero invalido para que lo
         * corrija. El proyecto en marcha no se ha tocado: nada se aplica hasta
         * que se pide.
         */
        return reply.code(422).send({ error: 'invalid-compose', message: error.message, saved: true });
      }
      throw error;
    }

    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'project.files.updated',
      target: input.name,
      detail: input.env !== undefined ? 'compose+env' : 'compose',
      ip: request.ip,
    });

    if (!input.apply) return { ok: true, job: null };

    try {
      const { job } = await app.updater.enqueueProjectAction({
        projectKey: `${input.name} ${dir}`,
        action: 'up',
        actorUserId: request.currentUser!.id,
      });
      return { ok: true, job };
    } catch (error) {
      return { ok: true, job: null, applyError: (error as Error).message };
    }
  });

  /**
   * Levantar, reiniciar o parar el proyecto entero.
   *
   * Sustituye al antiguo `/api/projects/apply`, que ejecutaba compose dentro de
   * la propia peticion: un stack grande tardaba mas de lo que aguanta el proxy
   * y no habia forma de ver el progreso.
   */
  fastify.post('/api/projects/action', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const input = projectActionSchema.parse(request.body);

    try {
      const { job } = await app.updater.enqueueProjectAction({
        projectKey: input.projectKey,
        action: input.action,
        actorUserId: request.currentUser!.id,
      });

      app.repos.history.audit({
        actorType: 'user',
        actorId: String(request.currentUser!.id),
        action: `project.${input.action}`,
        target: input.projectKey,
        ip: request.ip,
      });

      return reply.code(202).send({ job, queued: app.updater.queued });
    } catch (error) {
      if (error instanceof SelfUpdateRejectedError) {
        return reply.code(409).send({ error: 'self-update-rejected' });
      }
      if (error instanceof UpdateInProgressError) {
        return reply.code(409).send({ error: 'update-in-progress' });
      }
      return reply
        .code(422)
        .send({ error: 'project-action-failed', message: (error as Error).message });
    }
  });

  /**
   * Deja de gestionar un proyecto SIN borrar nada del disco.
   *
   * Se llama "olvidar" y no "borrar" porque es exactamente lo que hace: los
   * ficheros y los contenedores siguen donde estaban. Un boton que destruyese
   * el YAML y los volumenes de un stack no deberia existir en una interfaz web.
   */
  fastify.delete('/api/projects/:name', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const parsed = projectNameSchema.safeParse((request.params as { name: string }).name);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid-name' });

    app.projectFiles.forget(parsed.data);
    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'project.forgotten',
      target: parsed.data,
      ip: request.ip,
    });

    await app.inventory.refresh().catch(() => undefined);
    return { ok: true };
  });
}
