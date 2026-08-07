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
  projectFilesReadSchema,
  projectFilesUpdateSchema,
} from '@cu/shared';
import type { ComposeProject } from '@cu/shared';
import type { AppContext } from '../../app.js';
import { ProjectFilesError, type ProjectTarget } from '../../services/project-files.js';
import { SelfUpdateRejectedError, UpdateInProgressError } from '../../services/updater.js';
import { ComposeError } from '../../docker/compose.js';

export async function registerProjectRoutes(
  fastify: FastifyInstance,
  app: AppContext,
): Promise<void> {
  /**
   * Resuelve un proyecto por su clave y comprueba que se le puedan tocar los
   * ficheros.
   *
   * Se busca en el inventario y no en la base de datos a proposito: ahi es donde
   * esta el proyecto ya validado, con sus rutas resueltas contra las carpetas
   * permitidas. Vale igual para los creados aqui y para los de fuera.
   */
  function resolveTarget(
    projectKey: string,
    requireEditable: boolean,
  ): { target: ProjectTarget } | { error: string; message: string } {
    const project = app.inventory.snapshot.projects.find((p) => p.key === projectKey);
    if (!project) return { error: 'not-found', message: 'No se encuentra el proyecto' };

    if (requireEditable && !project.editable) {
      return {
        error: 'not-editable',
        message: EDIT_REASON[project.editableReason ?? 'read-only-mount'],
      };
    }
    // Aunque solo se lea, hace falta un unico fichero para saber cual mostrar.
    if (project.configFiles.length !== 1 || !project.yamlAccessible) {
      return {
        error: 'not-editable',
        message: EDIT_REASON[project.editableReason ?? 'yaml-not-accessible'],
      };
    }

    return {
      target: {
        name: project.name,
        dir: project.workingDir,
        composeFile: project.configFiles[0]!,
      },
    };
  }

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
        app.projectFiles.forget(created.dir);
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

  /**
   * Ficheros de un proyecto, con los valores sensibles ya ocultos.
   *
   * Va por POST y no por GET porque la clave del proyecto (nombre + directorio)
   * viaja en el cuerpo: en la ruta, las rutas largas de un NAS desbordan el
   * limite y el servidor responde 414 sin llegar al codigo. Mismo motivo que en
   * las acciones de servicio.
   */
  fastify.post('/api/projects/files/read', { onRequest: [fastify.requireAuth] }, async (request, reply) => {
    const { projectKey } = projectFilesReadSchema.parse(request.body);
    const resolved = resolveTarget(projectKey, false);
    if ('error' in resolved) return reply.code(404).send(resolved);

    try {
      return { files: await app.projectFiles.read(resolved.target) };
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
   * Va aparte de `/files/read` a proposito: esa la llama la pantalla al abrirse
   * y devuelve los secretos ocultos, mientras que esta solo se pide al entrar a
   * editar de verdad y por eso puede auditarse como lo que es.
   */
  fastify.post('/api/projects/files/env', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const { projectKey } = projectFilesReadSchema.parse(request.body);
    const resolved = resolveTarget(projectKey, false);
    if ('error' in resolved) return reply.code(404).send(resolved);

    const content = await app.projectFiles.readEnvRaw(resolved.target);
    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'project.env.read',
      target: resolved.target.dir,
      ip: request.ip,
    });
    return { content };
  });

  /** Una sola variable en claro. Cada revelado deja su propia linea de auditoria. */
  fastify.post('/api/projects/env/reveal', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const input = envRevealSchema.parse(request.body);
    const resolved = resolveTarget(input.projectKey, false);
    if ('error' in resolved) return reply.code(404).send(resolved);

    const value = await app.projectFiles.revealEnvValue(resolved.target, input.key);
    if (value === null) return reply.code(404).send({ error: 'not-found' });

    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'project.env.revealed',
      target: `${resolved.target.dir} / ${input.key}`,
      ip: request.ip,
    });

    return { value };
  });

  fastify.put('/api/projects/files', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const input = projectFilesUpdateSchema.parse(request.body);
    const resolved = resolveTarget(input.projectKey, true);
    if ('error' in resolved) return reply.code(422).send(resolved);
    const { target } = resolved;

    try {
      await app.projectFiles.update({
        target,
        compose: input.compose,
        env: input.env,
        actorUserId: request.currentUser!.id,
      });

      await app.compose.validate({
        projectName: target.name,
        workingDir: target.dir,
        configFiles: [target.composeFile],
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
      target: target.dir,
      detail: input.env !== undefined ? 'compose+env' : 'compose',
      ip: request.ip,
    });

    if (!input.apply) return { ok: true, job: null };

    try {
      const { job } = await app.updater.enqueueProjectAction({
        projectKey: input.projectKey,
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
  fastify.post('/api/projects/forget', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const { projectKey } = projectFilesReadSchema.parse(request.body);
    const resolved = resolveTarget(projectKey, false);
    if ('error' in resolved) return reply.code(404).send(resolved);

    app.projectFiles.forget(resolved.target.dir);
    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'project.forgotten',
      target: resolved.target.dir,
      ip: request.ip,
    });

    await app.inventory.refresh().catch(() => undefined);
    return { ok: true };
  });
}

/** Mensajes de por que no se puede editar, en el mismo sitio que la decision. */
const EDIT_REASON: Record<NonNullable<ComposeProject['editableReason']>, string> = {
  'yaml-not-accessible':
    'El fichero del proyecto no es accesible desde aqui. Montalo con la misma ruta que en el ' +
    'sistema anfitrion.',
  'multiple-files':
    'El proyecto usa varios ficheros de compose y no esta claro cual habria que editar.',
  'read-only-mount':
    'La carpeta del proyecto esta montada en solo lectura. Quitale el ":ro" para poder editarla.',
};
