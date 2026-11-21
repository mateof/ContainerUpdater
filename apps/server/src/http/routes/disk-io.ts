import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DISK_IO_RANGE_MS,
  diskDeviceConfigSchema,
  diskDeviceNameSchema,
  diskIoSeriesQuerySchema,
} from '@cu/shared';
import type { AppContext } from '../../app.js';

const usageQuerySchema = z.object({
  container: z.string().min(1).max(255),
  range: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
});

export async function registerDiskIoRoutes(fastify: FastifyInstance, app: AppContext): Promise<void> {
  fastify.get('/api/disk-io/devices', { onRequest: [fastify.requireAuth] }, async () => ({
    devices: await app.diskIo.devices(),
  }));

  fastify.put('/api/disk-io/devices/:name', { onRequest: [fastify.requireOperator] }, async (request, reply) => {
    const name = diskDeviceNameSchema.parse(decodeURIComponent((request.params as { name: string }).name));
    const input = diskDeviceConfigSchema.parse(request.body);
    const device = await app.diskIo.saveDevice(name, input);
    if (!device) return reply.code(404).send({ error: 'not-found' });

    app.repos.history.audit({
      actorType: 'user',
      actorId: String(request.currentUser!.id),
      action: 'disk-device.updated',
      target: name,
      detail: JSON.stringify(input),
      ip: request.ip,
    });
    return { device };
  });

  fastify.get('/api/disk-io/status', { onRequest: [fastify.requireAuth] }, async () => ({
    status: app.diskIo.status(),
  }));

  fastify.get('/api/disk-io/series', { onRequest: [fastify.requireAuth] }, async (request) => {
    const query = diskIoSeriesQuerySchema.parse(request.query);
    return { series: app.diskIo.series(query) };
  });

  fastify.get('/api/metrics/history', { onRequest: [fastify.requireAuth] }, async (request) => {
    const query = usageQuerySchema.parse(request.query);
    const now = Date.now();
    return {
      buckets: app.repos.diskIo.usageBuckets(now - DISK_IO_RANGE_MS[query.range], now, query.container),
      historyEnabled: app.repos.settings.getAll().metricsHistoryEnabled,
    };
  });
}
