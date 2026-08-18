import type { FastifyInstance } from 'fastify';
import { restoreSchema, volumeSchema } from '@cu/shared';
import type { BackupFile } from '@cu/shared';
import type { AppContext } from '../../app.js';
import { UnsupportedBackupError } from '../../services/backup.js';
import { VolumeInUseError, VolumeNotFoundError } from '../../services/storage.js';

export async function registerStorageRoutes(
  fastify: FastifyInstance,
  app: AppContext,
): Promise<void> {
  /**
   * Uso de disco. Puede tardar varios segundos porque el daemon recorre el
   * disco para calcularlo, asi que se pide solo al abrir la pantalla y nunca
   * desde un bucle ni desde el panel principal.
   */
  fastify.get('/api/storage', { onRequest: [fastify.requireAuth] }, async () => {
    return { usage: await app.storage.usage() };
  });

  /**
   * Borra un volumen que no usa nadie.
   *
   * Sin `force` en ningun caso, a diferencia del borrado de imagenes. Una
   * imagen forzada se vuelve a descargar; un volumen forzado se lleva los datos
   * por delante. Si el daemon dice que esta en uso, se le hace caso y se
   * responde 409 con cuantos contenedores lo usan.
   */
  fastify.delete('/api/storage/volumes/:name', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const { name } = volumeSchema.parse({ name: decodeURIComponent((request.params as { name: string }).name) });

    try {
      await app.storage.removeVolume(name);
    } catch (error) {
      if (error instanceof VolumeNotFoundError) return reply.code(404).send({ error: 'not-found' });
      if (error instanceof VolumeInUseError) {
        return reply.code(409).send({ error: 'in-use', refCount: error.refCount });
      }
      throw error;
    }

    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'volume.removed',
      target: name,
      ip: request.ip,
    });

    return { ok: true };
  });

  fastify.post('/api/storage/build-cache/prune', { onRequest: [fastify.requireOperator] }, async (request) => {
    const freed = await app.storage.pruneBuildCache();

    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'build-cache.pruned',
      detail: String(freed),
      ip: request.ip,
    });

    return { freed };
  });

  // -- Copia de seguridad -----------------------------------------------------

  /**
   * Descarga la configuracion.
   *
   * Va con `Content-Disposition` para que el navegador lo guarde como fichero
   * en vez de pintarlo. No lleva secretos: ver `services/backup.ts`.
   */
  fastify.get('/api/backup', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const file = app.backup.export();

    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'backup.exported',
      ip: request.ip,
    });

    const stamp = new Date(file.createdAt).toISOString().slice(0, 10);
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="containerupdater-${stamp}.json"`)
      .send(file);
  });

  fastify.post('/api/backup/restore', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const body = restoreSchema.parse(request.body);

    try {
      const report = app.backup.restore(body.file as BackupFile, {
        settings: body.settings,
        policies: body.policies,
      });

      app.repos.history.audit({
        actorType: 'user',
        actorId: String(request.currentUser!.id),
        action: 'backup.restored',
        detail: JSON.stringify(report),
        ip: request.ip,
      });

      return { report };
    } catch (error) {
      if (error instanceof UnsupportedBackupError) {
        return reply.code(400).send({ error: 'unsupported-version' });
      }
      throw error;
    }
  });
}
