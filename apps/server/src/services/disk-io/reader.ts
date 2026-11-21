import {
  DISK_IO_RANGE_MS,
  type BlockDevice,
  type DiskDeviceConfigInput,
  type DiskIoRange,
  type DiskIoSeriesResponse,
  type DiskIoStatus,
} from '@cu/shared';
import type { Repositories } from '../../db/repositories/index.js';
import type { InventoryService } from '../inventory.js';
import { isWatched, type DiskWatchService } from './collector.js';
import { selectableDevices } from './topology.js';
import { selectEvents } from './lifecycle.js';
import {
  buildDiskSummaries,
  buildSeries,
  collectChunks,
  containerAlertList,
  topWriters,
  totalsByDisk,
  type Chunk,
} from './query.js';

export interface SeriesQuery {
  range: DiskIoRange;
  op: 'read' | 'write';
  view: 'disks' | 'stacked';
  disks: string[];
  disk?: string;
  containers: string[];
  project?: string;
  top: number;
}

export class DiskIoReader {
  constructor(
    private readonly watch: DiskWatchService,
    private readonly repos: Repositories,
    private readonly inventory: InventoryService,
  ) {}

  chunksSince(from: number, now = Date.now()): Chunk[] {
    return collectChunks({ repo: this.repos.diskIo, ring: this.watch.ring, from, now });
  }

  async devices(): Promise<BlockDevice[]> {
    const topology = this.watch.topology ?? (await this.watch.refreshTopology());
    if (!topology) return [];
    const rows = new Map(this.repos.diskIo.devices().map((row) => [row.name, row]));
    return selectableDevices(topology)
      .map((device) => {
        const row = rows.get(device.name);
        return {
          name: device.name,
          major: device.major,
          minor: device.minor,
          kind: device.kind,
          label: device.label,
          disks: device.disks,
          watched: isWatched(device, row),
          watchedByDefault: device.kind === 'physical',
          tbwTb: row?.tbw_tb ?? null,
          writtenTb: row?.written_tb ?? null,
          writtenAt: row?.written_at ?? null,
          thresholdMbPerMin: row?.threshold_mb_min ?? null,
        };
      })
      .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.name.localeCompare(b.name, 'en', { numeric: true }));
  }

  async saveDevice(name: string, input: DiskDeviceConfigInput): Promise<BlockDevice | null> {
    const devices = await this.devices();
    if (!devices.some((device) => device.name === name)) return null;
    this.repos.diskIo.saveDevice(name, input);
    return (await this.devices()).find((device) => device.name === name) ?? null;
  }

  status(now = Date.now()): DiskIoStatus {
    const settings = this.repos.settings.getAll();
    const repo = this.repos.diskIo;
    const topology = this.watch.topology;
    const active = repo.activeAlerts();
    const rows = new Map(repo.devices().map((row) => [row.name, row]));
    const labels = new Map(
      topology ? [...topology.devices.values()].map((device) => [device.name, device.label] as const) : [],
    );

    return {
      enabled: settings.diskWatchEnabled,
      running: this.watch.running,
      intervalSeconds: settings.diskWatchIntervalSeconds,
      procAvailable: this.watch.procAvailable,
      historyEnabled: settings.metricsHistoryEnabled,
      historySince: repo.diskHistorySince(),
      memorySince: this.watch.memorySince,
      attributionAvailable: this.watch.attributionAvailable,
      alertsEnabled: settings.diskAlertEnabled,
      sustainMinutes: settings.diskAlertSustainMinutes,
      containerThresholdMbPerMin: settings.containerWriteThresholdMbPerMin,
      containerAlerts: containerAlertList(active),
      disks: settings.diskWatchEnabled
        ? buildDiskSummaries({
            watched: this.watch.watched(),
            labels,
            rows,
            ring: this.watch.ring,
            chunksSince: (from) => this.chunksSince(from, now),
            writtenSince: (disk, since) => repo.writtenSince(disk, since),
            activeAlerts: active,
            settings,
            now,
          })
        : [],
    };
  }

  series(query: SeriesQuery, now = Date.now()): DiskIoSeriesResponse {
    const from = now - DISK_IO_RANGE_MS[query.range];
    const settings = this.repos.settings.getAll();
    const watched = this.watch.watched();
    const stacked = query.view === 'stacked';
    const { events, truncated } = selectEvents({
      stored: this.repos.diskIo.eventsSince(from, now + 1),
      memory: this.watch.events,
      from,
      containers: stacked ? query.containers : [],
      project: stacked ? query.project : undefined,
    });
    const response = buildSeries({
      chunks: this.chunksSince(from, now),
      range: query.range,
      op: query.op,
      view: query.view,
      disks: query.disks.length > 0 ? query.disks : watched,
      disk: query.disk,
      containers: query.containers,
      project: query.project,
      top: query.top,
      now,
      intervalSeconds: settings.diskWatchIntervalSeconds,
      knownContainers: this.inventory.snapshot.containers.map((c) => ({ name: c.name, project: c.projectName })),
    });
    return { ...response, events, eventsTruncated: truncated };
  }

  eventsOverRange(range: DiskIoRange, limit: number, now = Date.now()) {
    const from = now - DISK_IO_RANGE_MS[range];
    return selectEvents({
      stored: this.repos.diskIo.eventsSince(from, now + 1),
      memory: this.watch.events,
      from,
      containers: [],
      limit,
    });
  }

  writersOverRange(range: DiskIoRange, limit: number, now = Date.now()) {
    const totals = totalsByDisk(this.chunksSince(now - DISK_IO_RANGE_MS[range], now));
    return this.watch.watched().map((disk) => {
      const entry = totals.get(disk);
      const seconds = entry?.seconds ?? 0;
      return {
        disk,
        coveredSeconds: seconds,
        writeBps: entry && seconds > 0 ? entry.writeBytes / seconds : null,
        readBps: entry && seconds > 0 ? entry.readBytes / seconds : null,
        unattributedBps:
          entry && seconds > 0 ? Math.max(0, entry.writeBytes - entry.attributedWrite) / seconds : null,
        topContainers: topWriters(entry, limit),
      };
    });
  }
}

function kindOrder(kind: string): number {
  return ['physical', 'raid', 'mapper', 'excluded'].indexOf(kind);
}
