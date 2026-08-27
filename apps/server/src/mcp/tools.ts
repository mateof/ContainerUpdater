/**
 * Las herramientas que se le ofrecen a una IA por MCP.
 *
 * Cada una declara el permiso que necesita, y las que no cubre el token NI
 * SIQUIERA SE LISTAN. Es deliberado: si se listaran y fallaran al llamarlas, el
 * modelo las intentaria igual, gastaria turnos y acabaria diciendo que "no tiene
 * permisos" en vez de trabajar con lo que si puede.
 *
 * Las descripciones estan escritas para que las lea un modelo y no una persona:
 * dicen que devuelven y CUANDO NO usarlas, que es lo que evita la mitad de las
 * llamadas inutiles.
 */
import { z } from 'zod';
import { buildPortsTable, type McpScope } from '@cu/shared';
import type { AppContext } from '../app.js';
import type { ProjectTarget } from '../services/project-files.js';

export interface McpTool {
  name: string;
  scope: McpScope;
  description: string;
  inputSchema: z.ZodRawShape;
  run: (app: AppContext, args: Record<string, unknown>) => Promise<unknown>;
}

/** Resuelve una clave de proyecto a lo que espera el servicio de ficheros. */
function targetFor(app: AppContext, projectKey: string): ProjectTarget {
  const project = app.inventory.snapshot.projects.find((p) => p.key === projectKey);
  if (!project) throw new Error(`No se encuentra el proyecto ${projectKey}`);
  if (project.configFiles.length !== 1 || !project.yamlAccessible) {
    throw new Error('Los ficheros de ese proyecto no son accesibles desde aqui');
  }
  return { name: project.name, dir: project.workingDir, composeFile: project.configFiles[0]! };
}

export const MCP_TOOLS: McpTool[] = [
  // -- Lectura ---------------------------------------------------------------
  {
    name: 'list_containers',
    scope: 'read',
    description:
      'Lista los contenedores con su estado, imagen, proyecto y puertos publicados. ' +
      'Para saber que hay corriendo. No incluye logs ni variables de entorno.',
    inputSchema: { onlyRunning: z.boolean().optional().describe('Solo los que estan en marcha') },
    run: async (app, args) => {
      const containers = app.inventory.listContainers();
      const filtrados = args.onlyRunning ? containers.filter((c) => c.state === 'running') : containers;
      return filtrados.map((c) => ({
        name: c.name,
        state: c.state,
        health: c.health,
        image: c.image,
        project: c.projectName,
        service: c.serviceName,
        updateAvailable: c.updateAvailable,
        exitCode: c.exitCode,
        ports: c.ports
          .filter((p) => p.publicPort)
          .map((p) => `${p.publicPort}:${p.privatePort}/${p.type}`),
      }));
    },
  },
  {
    name: 'list_images',
    scope: 'read',
    description:
      'Imagenes vigiladas con su estado de actualizacion, version instalada y quien las usa. ' +
      'Para saber que esta desactualizado o que ocupa disco sin usarse. No consulta los ' +
      'registries: devuelve lo ya sabido. Para consultar de verdad, check_updates.',
    inputSchema: {
      onlyWithUpdates: z.boolean().optional().describe('Solo las que tienen version nueva'),
    },
    run: async (app, args) => {
      const images = app.inventory.listImages();
      const filtradas = args.onlyWithUpdates
        ? images.filter((i) => i.status === 'update-available')
        : images;
      return filtradas.map((i) => ({
        ref: i.ref,
        tag: i.tag,
        status: i.status,
        installedVersion: i.installedVersion,
        usage: i.usage,
        usedBy: i.inUseBy,
        sizeBytes: i.sizeBytes,
        autoUpdate: i.policy.autoUpdate,
        whatChanged: i.release?.compareUrl ?? i.release?.releasesUrl ?? null,
      }));
    },
  },
  {
    name: 'list_projects',
    scope: 'read',
    description:
      'Proyectos de Docker Compose con sus servicios y actualizaciones pendientes. ' +
      'Un proyecto con 0 contenedores existe en disco pero no esta levantado. ' +
      'La clave que devuelve es la que piden las demas herramientas de proyecto.',
    inputSchema: {},
    run: async (app) =>
      app.inventory.listProjects().map((p) => ({
        key: p.key,
        name: p.name,
        directory: p.workingDir,
        strategy: p.strategy,
        editable: p.editable,
        updatesAvailable: p.updatesAvailable,
        containers: p.containers.map((c) => ({
          name: c.name,
          service: c.serviceName,
          state: c.state,
          updateAvailable: c.updateAvailable,
        })),
      })),
  },
  {
    name: 'list_ports',
    scope: 'read',
    description:
      'Puertos publicados de la maquina, quien los usa y si hay conflictos. ' +
      'Usala ANTES de proponer un puerto para algo nuevo, para no chocar con lo que ya hay. ' +
      'Un puerto "reservado" lo declara un contenedor parado: esta libre ahora y no lo estara al arrancarlo.',
    inputSchema: {},
    run: async (app) => {
      const resumen = buildPortsTable(app.inventory.listContainers());
      return {
        occupiedNow: resumen.occupiedNow,
        reserved: resumen.reserved,
        conflicts: resumen.conflicts,
        ports: resumen.rows.map((r) => ({
          port: r.publicPort,
          protocol: r.type,
          binding: r.binding,
          container: r.containerName,
          project: r.projectName,
          running: r.running,
          conflict: r.conflict,
        })),
      };
    },
  },
  {
    name: 'get_status',
    scope: 'read',
    description: 'Resumen general: version, cuantos contenedores, imagenes y actualizaciones pendientes.',
    inputSchema: {},
    run: async (app) => {
      const images = app.inventory.listImages();
      return {
        version: app.config.version,
        updatesAvailable: images.filter((i) => i.status === 'update-available').length,
        containers: app.inventory.listContainers().length,
        images: images.length,
        projects: app.inventory.listProjects().length,
      };
    },
  },

  // -- Lectura que puede filtrar secretos -------------------------------------
  {
    name: 'get_container_logs',
    scope: 'logs',
    description:
      'Ultimas lineas del log de un contenedor, para diagnosticar por que algo falla. ' +
      'AVISO: los logs suelen contener credenciales y datos personales.',
    inputSchema: {
      container: z.string().describe('Nombre del contenedor'),
      lines: z.number().int().min(1).max(500).optional().describe('Cuantas lineas, 100 por defecto'),
    },
    run: async (app, args) => {
      const nombre = String(args.container);
      const encontrado = app.inventory
        .listContainers()
        .find((c) => c.name === nombre || c.id.startsWith(nombre));
      if (!encontrado) throw new Error(`No existe el contenedor ${nombre}`);
      return {
        container: encontrado.name,
        logs: await app.docker.containerLogs(encontrado.id, Number(args.lines ?? 100)),
      };
    },
  },
  {
    name: 'read_project_files',
    scope: 'secrets',
    description:
      'Devuelve el docker-compose.yml de un proyecto y las CLAVES de su .env, sin los valores. ' +
      'AVISO: el compose puede llevar credenciales escritas directamente.',
    inputSchema: { projectKey: z.string().describe('Clave del proyecto, de list_projects') },
    run: async (app, args) => {
      const files = await app.projectFiles.read(targetFor(app, String(args.projectKey)));
      return {
        name: files.name,
        directory: files.dir,
        compose: files.compose,
        envKeys: files.env.map((e) => e.key),
        writable: files.writable,
      };
    },
  },

  // -- Contenedores -----------------------------------------------------------
  {
    name: 'control_container',
    scope: 'containers',
    description:
      'Arranca, para o reinicia un contenedor. No actualiza nada: para eso esta update_image.',
    inputSchema: { container: z.string(), action: z.enum(['start', 'stop', 'restart']) },
    run: async (app, args) => {
      const nombre = String(args.container);
      const encontrado = app.inventory.listContainers().find((c) => c.name === nombre);
      if (!encontrado) throw new Error(`No existe el contenedor ${nombre}`);
      if (encontrado.isSelf) throw new Error('Ese contenedor es la propia aplicacion');

      const accion = args.action as 'start' | 'stop' | 'restart';
      if (accion === 'start') await app.docker.startContainer(encontrado.id);
      else if (accion === 'stop') await app.docker.stopContainer(encontrado.id);
      else await app.docker.restartContainer(encontrado.id);
      return { container: encontrado.name, action: accion, done: true };
    },
  },

  // -- Actualizaciones --------------------------------------------------------
  {
    name: 'check_updates',
    scope: 'updates',
    description:
      'Consulta los registries para ver que imagenes tienen version nueva. Tarda unos segundos. ' +
      'Si solo quieres lo ya sabido, usa list_images, que no consulta nada.',
    inputSchema: {
      refs: z.array(z.string()).max(50).optional().describe('Referencias concretas; vacio = todas'),
    },
    run: async (app, args) => {
      const refs = args.refs as string[] | undefined;
      const resumen = await app.checker.runCheck('manual', refs?.length ? { refs } : {});
      return {
        checked: resumen.run.imagesChecked,
        withUpdates: resumen.run.updatesFound,
        errors: resumen.run.errors,
        results: resumen.outcomes
          .filter((o) => o.hasUpdate)
          .map((o) => ({ ref: o.ref, candidateTag: o.candidateTag })),
      };
    },
  },
  {
    name: 'update_image',
    scope: 'updates',
    description:
      'Actualiza una imagen y recrea el contenedor que la usa. Corre en segundo plano y ' +
      'devuelve un jobId: consulta el resultado con get_job.',
    inputSchema: { ref: z.string().describe('Referencia completa, de list_images') },
    run: async (app, args) => {
      const { job } = await app.updater.enqueue({
        imageRef: String(args.ref),
        mode: 'update',
        trigger: 'manual',
      });
      return { jobId: job.id, status: job.status };
    },
  },
  {
    name: 'get_job',
    scope: 'updates',
    description: 'Estado y log de un trabajo, por su identificador. Para saber como acabo lo que encolaste.',
    inputSchema: { jobId: z.number().int() },
    run: async (app, args) => {
      const job = app.repos.history.getJob(Number(args.jobId));
      if (!job) throw new Error(`No existe el trabajo ${String(args.jobId)}`);
      return { id: job.id, status: job.status, mode: job.mode, error: job.error, log: job.log };
    },
  },

  // -- Destructivas -----------------------------------------------------------
  {
    name: 'delete_image',
    scope: 'images.delete',
    description:
      'Borra una imagen local. Falla si la usa un contenedor EN MARCHA. Si la usan contenedores ' +
      'parados hace falta force, y esos contenedores dejaran de poder arrancar.',
    inputSchema: {
      ref: z.string(),
      force: z.boolean().optional().describe('Necesario si la usan contenedores parados'),
    },
    run: async (app, args) => {
      const ref = String(args.ref);
      const imagen = app.inventory.listImages().find((i) => i.ref === ref);
      if (!imagen) throw new Error(`No existe la imagen ${ref}`);
      if (imagen.usage === 'running') throw new Error('La usa un contenedor en marcha');
      if (imagen.usage === 'stopped' && !args.force) {
        throw new Error(
          `La usan contenedores parados (${imagen.inUseBy.join(', ')}). ` +
            'Repite con force si aceptas que no puedan arrancar.',
        );
      }
      await app.docker.removeImage(ref, imagen.usage === 'stopped');
      return { ref, deleted: true };
    },
  },

  // -- Proyectos --------------------------------------------------------------
  {
    name: 'project_action',
    scope: 'projects.lifecycle',
    description:
      'Levanta, arranca, para, reinicia, actualiza o baja un proyecto entero. ' +
      'OJO: `down` ELIMINA los contenedores; `stop` solo los para. Corre en segundo plano.',
    inputSchema: {
      projectKey: z.string(),
      action: z.enum(['up', 'start', 'stop', 'restart', 'down', 'update']),
    },
    run: async (app, args) => {
      const { job } = await app.updater.enqueueProjectAction({
        projectKey: String(args.projectKey),
        action: args.action as 'up' | 'start' | 'stop' | 'restart' | 'down' | 'update',
      });
      return { jobId: job.id, status: job.status };
    },
  },
  {
    name: 'create_project',
    scope: 'projects.write',
    description:
      'Crea un proyecto nuevo: carpeta, docker-compose.yml y .env opcional. ' +
      'Comprueba antes con list_ports que los puertos que vayas a usar estan libres.',
    inputSchema: {
      name: z.string().describe('Nombre del proyecto; sera el de la carpeta'),
      compose: z.string().describe('Contenido completo del docker-compose.yml'),
      env: z.string().optional().describe('Contenido del .env'),
      start: z.boolean().optional().describe('Levantarlo nada mas crearlo'),
    },
    run: async (app, args) => {
      const nombre = String(args.name);
      const resultado = await app.projectFiles.create({
        name: nombre,
        compose: String(args.compose),
        env: args.env === undefined ? undefined : String(args.env),
        actorUserId: null,
      });

      let jobId: number | null = null;
      if (args.start) {
        await app.inventory.refresh();
        const { job } = await app.updater.enqueueProjectAction({
          projectKey: `${nombre} ${resultado.dir}`,
          action: 'up',
        });
        jobId = job.id;
      }
      return { name: nombre, directory: resultado.dir, jobId };
    },
  },
  {
    name: 'update_project_files',
    scope: 'projects.write',
    description:
      'Reescribe el docker-compose.yml (y opcionalmente el .env) de un proyecto existente. ' +
      'Se valida antes de guardar. Lee primero con read_project_files para no perder nada.',
    inputSchema: {
      projectKey: z.string(),
      compose: z.string(),
      env: z.string().optional(),
      apply: z.boolean().optional().describe('Aplicar los cambios al guardar'),
    },
    run: async (app, args) => {
      const projectKey = String(args.projectKey);
      await app.projectFiles.update({
        target: targetFor(app, projectKey),
        compose: String(args.compose),
        env: args.env === undefined ? undefined : String(args.env),
        actorUserId: null,
      });

      let jobId: number | null = null;
      if (args.apply) {
        const { job } = await app.updater.enqueueProjectAction({ projectKey, action: 'up' });
        jobId = job.id;
      }
      return { saved: true, jobId };
    },
  },
];

/** Las que puede usar un token con estos permisos. */
export function toolsForScopes(scopes: McpScope[]): McpTool[] {
  const concedidos = new Set(scopes);
  return MCP_TOOLS.filter((tool) => concedidos.has(tool.scope));
}
