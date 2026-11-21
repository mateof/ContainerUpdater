import type { ContainerEvent } from '@cu/shared';
import { eventKey } from './lifecycle.js';

export const BUCKET_MS = 5 * 60_000;

export interface DiskTickSample {
  disk: string;
  readBytes: number;
  writeBytes: number;
  readIos: number;
  writeIos: number;
  flushes: number | null;
  attributedRead: number;
  attributedWrite: number;
}

export interface ContainerDiskTickSample {
  disk: string;
  container: string;
  project: string | null;
  readBytes: number;
  writeBytes: number;
}

export interface UsageTickSample {
  container: string;
  project: string | null;
  cpuPercent: number | null;
  memoryPercent: number;
}

export interface Tick {
  at: number;
  seconds: number;
  disks: DiskTickSample[];
  containerDisks: ContainerDiskTickSample[];
  usage: UsageTickSample[];
}

export interface DiskBucket {
  bucket: number;
  disk: string;
  seconds: number;
  readBytes: number;
  writeBytes: number;
  readIos: number;
  writeIos: number;
  flushes: number | null;
  attributedRead: number;
  attributedWrite: number;
  readMaxBps: number;
  writeMaxBps: number;
}

export interface ContainerDiskBucket {
  bucket: number;
  disk: string;
  container: string;
  project: string | null;
  readBytes: number;
  writeBytes: number;
}

export interface UsageBucket {
  bucket: number;
  container: string;
  project: string | null;
  samples: number;
  cpuSamples: number;
  cpuAvg: number | null;
  cpuMax: number | null;
  memAvg: number;
  memMax: number;
}

export interface BucketBatch {
  disks: DiskBucket[];
  containerDisks: ContainerDiskBucket[];
  usage: UsageBucket[];
  events: ContainerEvent[];
}

export function bucketOf(ts: number, size = BUCKET_MS): number {
  return Math.floor(ts / size) * size;
}

export function emptyBatch(): BucketBatch {
  return { disks: [], containerDisks: [], usage: [], events: [] };
}

export function mergeDiskBucket(target: DiskBucket, other: DiskBucket): DiskBucket {
  return {
    ...target,
    seconds: target.seconds + other.seconds,
    readBytes: target.readBytes + other.readBytes,
    writeBytes: target.writeBytes + other.writeBytes,
    readIos: target.readIos + other.readIos,
    writeIos: target.writeIos + other.writeIos,
    flushes:
      target.flushes === null && other.flushes === null
        ? null
        : (target.flushes ?? 0) + (other.flushes ?? 0),
    attributedRead: target.attributedRead + other.attributedRead,
    attributedWrite: target.attributedWrite + other.attributedWrite,
    readMaxBps: Math.max(target.readMaxBps, other.readMaxBps),
    writeMaxBps: Math.max(target.writeMaxBps, other.writeMaxBps),
  };
}

export function mergeUsageBucket(target: UsageBucket, other: UsageBucket): UsageBucket {
  const cpuSamples = target.cpuSamples + other.cpuSamples;
  const samples = target.samples + other.samples;
  return {
    ...target,
    project: other.project ?? target.project,
    samples,
    cpuSamples,
    cpuAvg:
      cpuSamples === 0
        ? null
        : ((target.cpuAvg ?? 0) * target.cpuSamples + (other.cpuAvg ?? 0) * other.cpuSamples) / cpuSamples,
    cpuMax:
      target.cpuMax === null ? other.cpuMax : other.cpuMax === null ? target.cpuMax : Math.max(target.cpuMax, other.cpuMax),
    memAvg: samples === 0 ? 0 : (target.memAvg * target.samples + other.memAvg * other.samples) / samples,
    memMax: Math.max(target.memMax, other.memMax),
  };
}

export function tickToBatch(tick: Tick): BucketBatch {
  const bucket = bucketOf(tick.at);
  const seconds = tick.seconds;
  return {
    disks: tick.disks.map((d) => ({
      bucket,
      disk: d.disk,
      seconds,
      readBytes: d.readBytes,
      writeBytes: d.writeBytes,
      readIos: d.readIos,
      writeIos: d.writeIos,
      flushes: d.flushes,
      attributedRead: d.attributedRead,
      attributedWrite: d.attributedWrite,
      readMaxBps: seconds > 0 ? d.readBytes / seconds : 0,
      writeMaxBps: seconds > 0 ? d.writeBytes / seconds : 0,
    })),
    containerDisks: tick.containerDisks.map((c) => ({ bucket, ...c })),
    usage: tick.usage.map((u) => ({
      bucket,
      container: u.container,
      project: u.project,
      samples: 1,
      cpuSamples: u.cpuPercent === null ? 0 : 1,
      cpuAvg: u.cpuPercent,
      cpuMax: u.cpuPercent,
      memAvg: u.memoryPercent,
      memMax: u.memoryPercent,
    })),
    events: [],
  };
}

export class RollupAccumulator {
  readonly #disks = new Map<string, DiskBucket>();
  readonly #containerDisks = new Map<string, ContainerDiskBucket>();
  readonly #usage = new Map<string, UsageBucket>();
  readonly #events = new Map<string, ContainerEvent>();

  addEvent(event: ContainerEvent): void {
    this.#events.set(eventKey(event), event);
  }

  add(tick: Tick): BucketBatch {
    const current = bucketOf(tick.at);
    const completed = this.#take((bucket) => bucket < current);
    const batch = tickToBatch(tick);

    for (const disk of batch.disks) {
      const key = `${disk.bucket}|${disk.disk}`;
      const existing = this.#disks.get(key);
      this.#disks.set(key, existing ? mergeDiskBucket(existing, disk) : disk);
    }
    for (const entry of batch.containerDisks) {
      const key = `${entry.bucket}|${entry.disk}|${entry.container}`;
      const existing = this.#containerDisks.get(key);
      this.#containerDisks.set(
        key,
        existing
          ? {
              ...existing,
              project: entry.project ?? existing.project,
              readBytes: existing.readBytes + entry.readBytes,
              writeBytes: existing.writeBytes + entry.writeBytes,
            }
          : entry,
      );
    }
    for (const usage of batch.usage) {
      const key = `${usage.bucket}|${usage.container}`;
      const existing = this.#usage.get(key);
      this.#usage.set(key, existing ? mergeUsageBucket(existing, usage) : usage);
    }

    return completed;
  }

  drain(): BucketBatch {
    return this.#take(() => true);
  }

  get pending(): boolean {
    return this.#disks.size + this.#containerDisks.size + this.#usage.size + this.#events.size > 0;
  }

  #take(predicate: (bucket: number) => boolean): BucketBatch {
    const batch = emptyBatch();
    for (const [key, value] of this.#disks) {
      if (!predicate(value.bucket)) continue;
      batch.disks.push(value);
      this.#disks.delete(key);
    }
    for (const [key, value] of this.#containerDisks) {
      if (!predicate(value.bucket)) continue;
      batch.containerDisks.push(value);
      this.#containerDisks.delete(key);
    }
    for (const [key, value] of this.#usage) {
      if (!predicate(value.bucket)) continue;
      batch.usage.push(value);
      this.#usage.delete(key);
    }
    for (const [key, value] of this.#events) {
      if (!predicate(bucketOf(value.at))) continue;
      batch.events.push(value);
      this.#events.delete(key);
    }
    return batch;
  }
}

export interface WindowTotals {
  seconds: number;
  disks: Map<string, { seconds: number; readBytes: number; writeBytes: number; attributedWrite: number }>;
  containers: Map<string, Map<string, { project: string | null; readBytes: number; writeBytes: number }>>;
}

export function windowTotals(ticks: Tick[], from: number): WindowTotals {
  const totals: WindowTotals = { seconds: 0, disks: new Map(), containers: new Map() };
  for (const tick of ticks) {
    if (tick.at <= from) continue;
    const covered = Math.min(tick.seconds, (tick.at - from) / 1000);
    const share = tick.seconds > 0 ? covered / tick.seconds : 0;
    totals.seconds += covered;
    for (const disk of tick.disks) {
      const entry = totals.disks.get(disk.disk) ?? { seconds: 0, readBytes: 0, writeBytes: 0, attributedWrite: 0 };
      entry.seconds += covered;
      entry.readBytes += disk.readBytes * share;
      entry.writeBytes += disk.writeBytes * share;
      entry.attributedWrite += disk.attributedWrite * share;
      totals.disks.set(disk.disk, entry);
    }
    for (const sample of tick.containerDisks) {
      const perDisk = totals.containers.get(sample.disk) ?? new Map();
      const entry = perDisk.get(sample.container) ?? { project: sample.project, readBytes: 0, writeBytes: 0 };
      entry.project = sample.project ?? entry.project;
      entry.readBytes += sample.readBytes * share;
      entry.writeBytes += sample.writeBytes * share;
      perDisk.set(sample.container, entry);
      totals.containers.set(sample.disk, perDisk);
    }
  }
  return totals;
}
