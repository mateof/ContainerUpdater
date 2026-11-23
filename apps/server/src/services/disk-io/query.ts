import {
  DISK_IO_RANGE_MS,
  BYTES_PER_TB,
  type AppSettings,
  type ContainerSeries,
  type DiskIoOp,
  type DiskIoRange,
  type DiskIoSeriesResponse,
  type DiskIoSource,
  type DiskIoStatus,
  type DiskLifetime,
  type DiskSummary,
  type LifetimeWindow,
} from '@cu/shared';
import type { DiskDeviceRow, DiskIoRepository } from '../../db/repositories/disk-io.js';
import { BUCKET_MS, bucketOf, type Tick } from './model.js';
import { attributedShare } from './attribution.js';
import { remainingBytes, usedBytes, windowRate, yearsLeft } from './lifetime.js';

export const STEP_SECONDS: Record<DiskIoRange, number> = {
  '1h': 60,
  '24h': 300,
  '7d': 1800,
  '30d': 7200,
};

const LIFETIME_WINDOWS: Array<{ window: LifetimeWindow; ms: number }> = [
  { window: '1h', ms: 3600_000 },
  { window: '24h', ms: 24 * 3600_000 },
  { window: '7d', ms: 7 * 24 * 3600_000 },
];

export interface DiskChunkValues {
  readBytes: number;
  writeBytes: number;
  readIos: number;
  writeIos: number;
  attributedRead: number;
  attributedWrite: number;
  readMaxBps: number;
  writeMaxBps: number;
}

export interface Chunk {
  ts: number;
  seconds: number;
  source: 'memory' | 'history';
  disks: Map<string, DiskChunkValues & { seconds: number }>;
  containers: Array<{ disk: string; container: string; project: string | null; readBytes: number; writeBytes: number }>;
}

export function chunksFromTicks(ticks: Tick[], from: number): Chunk[] {
  return ticks
    .filter((tick) => tick.at > from && tick.disks.length > 0)
    .map((tick) => ({
      ts: tick.at,
      seconds: tick.seconds,
      source: 'memory' as const,
      disks: new Map(
        tick.disks.map((d) => [
          d.disk,
          {
            seconds: tick.seconds,
            readBytes: d.readBytes,
            writeBytes: d.writeBytes,
            readIos: d.readIos,
            writeIos: d.writeIos,
            attributedRead: d.attributedRead,
            attributedWrite: d.attributedWrite,
            readMaxBps: d.readBytes / tick.seconds,
            writeMaxBps: d.writeBytes / tick.seconds,
          },
        ]),
      ),
      containers: tick.containerDisks.map((c) => ({ ...c })),
    }));
}

export function chunksFromHistory(repo: DiskIoRepository, from: number, to: number): Chunk[] {
  if (to <= from) return [];
  const byBucket = new Map<number, Chunk>();
  for (const row of repo.diskBuckets(from, to)) {
    const chunk = byBucket.get(row.bucket) ?? {
      ts: row.bucket + BUCKET_MS,
      seconds: 0,
      source: 'history' as const,
      disks: new Map(),
      containers: [],
    };
    chunk.seconds = Math.max(chunk.seconds, row.seconds);
    chunk.disks.set(row.disk, {
      seconds: row.seconds,
      readBytes: row.readBytes,
      writeBytes: row.writeBytes,
      readIos: row.readIos,
      writeIos: row.writeIos,
      attributedRead: row.attributedRead,
      attributedWrite: row.attributedWrite,
      readMaxBps: row.readMaxBps,
      writeMaxBps: row.writeMaxBps,
    });
    byBucket.set(row.bucket, chunk);
  }
  for (const row of repo.containerDiskBuckets(from, to)) {
    byBucket.get(row.bucket)?.containers.push({
      disk: row.disk,
      container: row.container,
      project: row.project,
      readBytes: row.readBytes,
      writeBytes: row.writeBytes,
    });
  }
  return [...byBucket.values()].sort((a, b) => a.ts - b.ts);
}

export function collectChunks(input: {
  repo: DiskIoRepository;
  ring: Tick[];
  from: number;
  now: number;
}): Chunk[] {
  const ticks = input.ring.filter((tick) => tick.disks.length > 0);
  const firstTick = ticks[0];
  const lastTick = ticks.at(-1);
  const ringFullFrom = firstTick
    ? Math.ceil((firstTick.at - firstTick.seconds * 1000) / BUCKET_MS) * BUCKET_MS
    : Number.POSITIVE_INFINITY;
  const openBucket = lastTick ? bucketOf(lastTick.at) : bucketOf(input.now);

  const fromHistory = chunksFromHistory(input.repo, bucketOf(input.from), input.now).filter(
    (chunk) => chunk.ts - BUCKET_MS < ringFullFrom && chunk.ts > input.from,
  );
  const storedBuckets = new Set(fromHistory.map((chunk) => chunk.ts - BUCKET_MS));
  const fromMemory = chunksFromTicks(ticks, input.from).filter((chunk) => {
    const bucket = bucketOf(chunk.ts);
    return bucket >= ringFullFrom || bucket === openBucket || !storedBuckets.has(bucket);
  });
  return [...fromHistory, ...fromMemory].sort((a, b) => a.ts - b.ts);
}

function sourceOf(chunks: Chunk[]): DiskIoSource {
  const memory = chunks.some((c) => c.source === 'memory');
  const history = chunks.some((c) => c.source === 'history');
  if (memory && history) return 'mixed';
  if (memory) return 'memory';
  if (history) return 'history';
  return 'none';
}

interface StepAccumulator {
  seconds: number;
  bytes: number;
  attributed: number;
  peak: number;
}

export function buildSeries(input: {
  chunks: Chunk[];
  range: DiskIoRange;
  op: DiskIoOp;
  view: 'disks' | 'stacked';
  disks: string[];
  disk?: string;
  containers: string[];
  project?: string;
  top: number;
  now: number;
  intervalSeconds: number;
  knownContainers: Array<{ name: string; project: string | null }>;
}): Omit<DiskIoSeriesResponse, 'events' | 'eventsTruncated'> {
  const stepSeconds = Math.max(STEP_SECONDS[input.range], input.intervalSeconds);
  const stepMs = stepSeconds * 1000;
  const from = input.now - DISK_IO_RANGE_MS[input.range];
  const start = bucketOf(from, stepMs);
  const count = Math.max(1, Math.ceil((input.now - start) / stepMs));
  const timestamps = Array.from({ length: count }, (_, i) => start + i * stepMs);
  const read = input.op === 'read';
  const indexOf = (ts: number): number => Math.min(count - 1, Math.max(0, Math.floor((ts - 1 - start) / stepMs)));

  const diskSteps = new Map<string, StepAccumulator[]>();
  const containerProject = new Map<string, string | null>();
  for (const known of input.knownContainers) containerProject.set(known.name, known.project);

  for (const chunk of input.chunks) {
    const index = indexOf(chunk.ts);
    for (const [disk, values] of chunk.disks) {
      const steps =
        diskSteps.get(disk) ??
        Array.from({ length: count }, () => ({ seconds: 0, bytes: 0, attributed: 0, peak: 0 }));
      const step = steps[index]!;
      step.seconds += values.seconds;
      step.bytes += read ? values.readBytes : values.writeBytes;
      step.attributed += read ? values.attributedRead : values.attributedWrite;
      step.peak = Math.max(step.peak, read ? values.readMaxBps : values.writeMaxBps);
      diskSteps.set(disk, steps);
    }
    for (const entry of chunk.containers) {
      if (!containerProject.has(entry.container) || entry.project) {
        containerProject.set(entry.container, entry.project ?? containerProject.get(entry.container) ?? null);
      }
    }
  }

  const selectedDisks = input.disks.length > 0 ? input.disks : [...diskSteps.keys()].sort();
  const rate = (step: StepAccumulator): number | null => (step.seconds > 0 ? step.bytes / step.seconds : null);

  const disks = selectedDisks.map((name) => {
    const steps = diskSteps.get(name);
    return {
      name,
      values: steps ? steps.map(rate) : timestamps.map(() => null),
      peaks: steps ? steps.map((s) => (s.seconds > 0 ? s.peak : null)) : timestamps.map(() => null),
    };
  });

  let stack: DiskIoSeriesResponse['stack'] = null;
  if (input.view === 'stacked') {
    const busiest = [...diskSteps]
      .filter(([name]) => selectedDisks.includes(name))
      .map(([name, steps]) => ({ name, bytes: steps.reduce((sum, s) => sum + s.bytes, 0) }))
      .sort((a, b) => b.bytes - a.bytes)[0]?.name;
    const disk = input.disk ?? busiest ?? selectedDisks[0] ?? null;
    if (disk) stack = buildStack({ ...input, disk, count, read, indexOf, steps: diskSteps.get(disk) });
  }

  const projects = [...new Set([...containerProject.values()].filter((p): p is string => Boolean(p)))].sort();
  return {
    source: sourceOf(input.chunks),
    coverageFrom: input.chunks.length > 0 ? input.chunks[0]!.ts - input.chunks[0]!.seconds * 1000 : null,
    stepSeconds,
    timestamps,
    disks,
    stack,
    projects,
    containers: [...containerProject].map(([name, project]) => ({ name, project })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function buildStack(input: {
  chunks: Chunk[];
  disk: string;
  containers: string[];
  project?: string;
  top: number;
  count: number;
  read: boolean;
  indexOf: (ts: number) => number;
  steps: StepAccumulator[] | undefined;
}): NonNullable<DiskIoSeriesResponse['stack']> {
  const perContainer = new Map<string, { project: string | null; total: number; steps: number[] }>();
  for (const chunk of input.chunks) {
    const index = input.indexOf(chunk.ts);
    for (const entry of chunk.containers) {
      if (entry.disk !== input.disk) continue;
      const bytes = input.read ? entry.readBytes : entry.writeBytes;
      const current = perContainer.get(entry.container) ?? {
        project: entry.project,
        total: 0,
        steps: new Array<number>(input.count).fill(0),
      };
      current.project = entry.project ?? current.project;
      current.total += bytes;
      current.steps[index]! += bytes;
      perContainer.set(entry.container, current);
    }
  }

  const candidates = [...perContainer].filter(([name, value]) => {
    if (input.containers.length > 0 && !input.containers.includes(name)) return false;
    if (input.project && value.project !== input.project) return false;
    return true;
  });
  const chosen =
    input.containers.length > 0
      ? candidates
      : candidates.sort((a, b) => b[1].total - a[1].total).slice(0, input.top);

  const steps = input.steps;
  const seconds = (i: number): number => steps?.[i]?.seconds ?? 0;
  const perSecond = (bytes: number, i: number): number | null => (seconds(i) > 0 ? bytes / seconds(i) : null);

  const containers: ContainerSeries[] = chosen.map(([name, value]) => ({
    name,
    project: value.project,
    values: value.steps.map((bytes, i) => perSecond(bytes, i)),
  }));

  const others: Array<number | null> = [];
  const unattributedValues: Array<number | null> = [];
  let diskTotal = 0;
  let attributedTotal = 0;
  for (let i = 0; i < input.count; i += 1) {
    const step = steps?.[i];
    if (!step || step.seconds <= 0) {
      others.push(null);
      unattributedValues.push(null);
      continue;
    }
    const chosenBytes = chosen.reduce((sum, [, value]) => sum + (value.steps[i] ?? 0), 0);
    others.push(Math.max(0, step.attributed - chosenBytes) / step.seconds);
    unattributedValues.push(Math.max(0, step.bytes - step.attributed) / step.seconds);
    diskTotal += step.bytes;
    attributedTotal += step.attributed;
  }

  return {
    disk: input.disk,
    containers,
    others,
    unattributed: unattributedValues,
    attributedShare: attributedShare(diskTotal, attributedTotal),
  };
}

export interface DiskTotals {
  seconds: number;
  readBytes: number;
  writeBytes: number;
  attributedWrite: number;
  containers: Map<string, { project: string | null; writeBytes: number }>;
}

export function totalsByDisk(chunks: Chunk[]): Map<string, DiskTotals> {
  const totals = new Map<string, DiskTotals>();
  for (const chunk of chunks) {
    for (const [disk, values] of chunk.disks) {
      const entry = totals.get(disk) ?? { seconds: 0, readBytes: 0, writeBytes: 0, attributedWrite: 0, containers: new Map() };
      entry.seconds += values.seconds;
      entry.readBytes += values.readBytes;
      entry.writeBytes += values.writeBytes;
      entry.attributedWrite += values.attributedWrite;
      totals.set(disk, entry);
    }
    for (const container of chunk.containers) {
      const entry = totals.get(container.disk);
      if (!entry) continue;
      const writer = entry.containers.get(container.container) ?? { project: container.project, writeBytes: 0 };
      writer.writeBytes += container.writeBytes;
      writer.project = container.project ?? writer.project;
      entry.containers.set(container.container, writer);
    }
  }
  return totals;
}

export function topWriters(totals: DiskTotals | undefined, limit: number): DiskSummary['topContainers'] {
  if (!totals || totals.seconds <= 0) return [];
  return [...totals.containers]
    .map(([name, value]) => ({ name, project: value.project, writeBps: value.writeBytes / totals.seconds }))
    .sort((a, b) => b.writeBps - a.writeBps)
    .slice(0, limit);
}

export function buildDiskSummaries(input: {
  watched: string[];
  labels: Map<string, string | null>;
  rows: Map<string, DiskDeviceRow>;
  ring: Tick[];
  chunksSince: (from: number) => Chunk[];
  writtenSince: (disk: string, since: number) => number;
  activeAlerts: Map<string, { alertedAt: number }>;
  settings: AppSettings;
  now: number;
}): DiskSummary[] {
  const lastTick = [...input.ring].reverse().find((tick) => tick.disks.length > 0);
  const windows = LIFETIME_WINDOWS.map(({ window, ms }) => ({
    window,
    ms,
    totals: totalsByDisk(input.chunksSince(input.now - ms)),
  }));
  const hour = windows[0]!.totals;

  return input.watched.map((disk) => {
    const row = input.rows.get(disk);
    const sample = lastTick?.disks.find((d) => d.disk === disk);
    const tbwTb = row?.tbw_tb ?? null;
    const writtenTb = row?.written_tb ?? null;
    const writtenSinceBytes = row?.written_at ? input.writtenSince(disk, row.written_at) : 0;
    const remaining = remainingBytes({ tbwTb, writtenTb, writtenSinceBytes });

    const lifetime: DiskLifetime[] = windows.map(({ window, ms, totals }) => {
      const entry = totals.get(disk);
      const bps = entry ? windowRate(entry.writeBytes, entry.seconds) : null;
      return {
        window,
        bytesPerSecond: bps,
        coveredSeconds: entry?.seconds ?? 0,
        windowSeconds: ms / 1000,
        years: yearsLeft(remaining, bps),
      };
    });

    const hourTotals = hour.get(disk);
    const alert = input.activeAlerts.get(`disk:${disk}`);
    return {
      name: disk,
      label: input.labels.get(disk) ?? null,
      current:
        sample && lastTick
          ? {
              ts: lastTick.at,
              readBps: sample.readBytes / lastTick.seconds,
              writeBps: sample.writeBytes / lastTick.seconds,
              readIops: sample.readIos / lastTick.seconds,
              writeIops: sample.writeIos / lastTick.seconds,
              avgReadIoBytes: sample.readIos > 0 ? sample.readBytes / sample.readIos : null,
              avgWriteIoBytes: sample.writeIos > 0 ? sample.writeBytes / sample.writeIos : null,
              flushesPerSecond: sample.flushes === null ? null : sample.flushes / lastTick.seconds,
            }
          : null,
      hourWriteBps: hourTotals && hourTotals.seconds > 0 ? hourTotals.writeBytes / hourTotals.seconds : null,
      lifetime,
      remainingTb: remaining === null ? null : remaining / BYTES_PER_TB,
      usedTb: tbwTb === null ? null : usedBytes({ writtenTb, writtenSinceBytes }) / BYTES_PER_TB,
      tbwTb,
      writtenTb,
      thresholdMbPerMin: row?.threshold_mb_min ?? input.settings.diskAlertThresholdMbPerMin,
      alert: { active: Boolean(alert), since: alert?.alertedAt ?? null },
      attributedShare: hourTotals ? attributedShare(hourTotals.writeBytes, hourTotals.attributedWrite) : null,
      unattributedBps:
        hourTotals && hourTotals.seconds > 0
          ? Math.max(0, hourTotals.writeBytes - hourTotals.attributedWrite) / hourTotals.seconds
          : null,
      topContainers: topWriters(hourTotals, 5),
    };
  });
}

export function containerAlertList(active: Map<string, { kind: string; name: string; alertedAt: number }>): DiskIoStatus['containerAlerts'] {
  return [...active.values()]
    .filter((alert) => alert.kind === 'container')
    .map((alert) => ({ name: alert.name, since: alert.alertedAt }));
}
