import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  mbPerMinuteToBytesPerSecond,
  type AppSettings,
  type ContainerEvent,
  type ContainerSummary,
  type SwapStatus,
} from '@cu/shared';
import { StatsCalculator } from '../../docker/stats.js';
import { mapWithConcurrency } from '../checker.js';
import type { DockerApi } from '../../docker/api.js';
import type { ContainerStats, DockerEvent } from '../../docker/types.js';
import type { InventoryService } from '../inventory.js';
import type { Repositories } from '../../db/repositories/index.js';
import type { DiskDeviceRow } from '../../db/repositories/disk-io.js';
import type { Logger } from '../../logger.js';
import { parseDiskstats, type DiskCounters } from './diskstats.js';
import {
  buildTopology,
  parseMdstat,
  readSysfsBlock,
  selectableDevices,
  type Topology,
} from './topology.js';
import { CounterTracker } from './counters.js';
import { attributeToDisk, blkioByDevice, type IoBytes } from './attribution.js';
import {
  RollupAccumulator,
  windowTotals,
  type ContainerDiskTickSample,
  type DiskTickSample,
  type Tick,
  type UsageTickSample,
} from './model.js';
import { lifecycleEventFrom } from './lifecycle.js';
import { PackageTracker, scanPackages } from './packages.js';
import { PAGE_BYTES, parseMeminfo, parseVmstat, type SwapCounters, type SwapSize } from './system.js';
import { counterDelta } from './counters.js';
import { alertSubject, evaluateAlerts, type AlertInput, type AlertTransition } from './alerts.js';

export const RING_SPAN_MS = 24 * 3600_000;
const TOPOLOGY_TTL_MS = 10 * 60_000;
const ALERT_COVERAGE_RATIO = 0.9;
const TOP_WRITERS_IN_ALERT = 3;

type DiskValues = { readIos: number; readBytes: number; writeIos: number; writeBytes: number; flushes: number | null };

export interface DiskAlertContext {
  transition: AlertTransition;
  disk: string | null;
  sustainMinutes: number;
  topContainers: Array<{ name: string; writeBps: number }>;
  unattributedBps: number | null;
}

export interface DiskAlertSink {
  notifyDiskAlert(context: DiskAlertContext): Promise<void>;
}

export interface CollectedContainer {
  id: string;
  name: string;
  project: string | null;
  createdAt: number;
  stats: ContainerStats;
}

export function isWatched(
  device: { name: string; kind: string; partitionOf: string | null },
  row: DiskDeviceRow | undefined,
): boolean {
  if (device.partitionOf !== null || device.kind === 'excluded') return false;
  if (row?.watched !== null && row?.watched !== undefined) return row.watched === 1;
  return device.kind === 'physical';
}

export function watchedDisks(topology: Topology, rows: DiskDeviceRow[]): string[] {
  const byName = new Map(rows.map((row) => [row.name, row]));
  return selectableDevices(topology)
    .filter((device) => isWatched(device, byName.get(device.name)))
    .map((device) => device.name);
}

export function shouldCollect(settings: AppSettings): boolean {
  return settings.diskWatchEnabled || settings.metricsHistoryEnabled;
}

export class DiskWatchService {
  readonly #ring: Tick[] = [];
  readonly #events: ContainerEvent[] = [];
  readonly #accumulator = new RollupAccumulator();
  readonly #diskTracker = new CounterTracker<DiskValues>();
  readonly #containerTracker = new CounterTracker<Record<string, number>>();
  #calculator: StatsCalculator | null = null;
  #timer: NodeJS.Timeout | null = null;
  #intervalSeconds: number | null = null;
  #sampling = false;
  #lastMono: number | null = null;
  #lastAt: number | null = null;
  #topology: Topology | null = null;
  #topologyAt = 0;
  #topologyKey = '';
  #procAvailable = false;
  #attributionAvailable = false;
  #sink: DiskAlertSink | null = null;
  readonly #packages = new PackageTracker();
  #swapPrevious: SwapCounters | null = null;
  #swapSize: SwapSize | null = null;

  constructor(
    private readonly docker: DockerApi,
    private readonly inventory: InventoryService,
    private readonly repos: Repositories,
    private readonly procPath: string | null,
    private readonly log: Logger,
    private readonly sysRoot = '/sys',
  ) {}

  setSink(sink: DiskAlertSink): void {
    this.#sink = sink;
  }

  get ring(): Tick[] {
    return this.#ring;
  }

  get events(): ContainerEvent[] {
    return this.#events;
  }

  recordDockerEvent(event: DockerEvent): ContainerEvent | null {
    const lifecycle = lifecycleEventFrom(event, (id) => {
      const found = this.inventory.snapshot.containers.find((container) => container.id === id);
      return found ? { name: found.name, project: found.projectName } : undefined;
    });
    if (!lifecycle || !this.repos.settings.getAll().diskWatchEnabled) return null;
    this.#addEvent(lifecycle);
    return lifecycle;
  }

  #addEvent(event: ContainerEvent): void {
    this.#events.push(event);
    this.#events.sort((a, b) => a.at - b.at);
    const cutoff = Date.now() - RING_SPAN_MS;
    while (this.#events.length > 0 && this.#events[0]!.at < cutoff) this.#events.shift();
    this.#accumulator.addEvent(event);
  }

  swapStatus(now = Date.now()): SwapStatus | null {
    const size = this.#swapSize;
    if (!size || size.totalBytes <= 0) return null;
    const hour = this.#ring.filter((tick) => tick.swap && tick.at >= now - 3600_000);
    const seconds = hour.reduce((sum, tick) => sum + tick.seconds, 0);
    const last = [...this.#ring].reverse().find((tick) => tick.swap);
    return {
      totalBytes: size.totalBytes,
      usedBytes: Math.max(0, size.totalBytes - size.freeBytes),
      outBpsNow: last?.swap && last.seconds > 0 ? last.swap.outBytes / last.seconds : null,
      outBpsHour: seconds > 0 ? hour.reduce((sum, tick) => sum + tick.swap!.outBytes, 0) / seconds : null,
      inBpsHour: seconds > 0 ? hour.reduce((sum, tick) => sum + tick.swap!.inBytes, 0) / seconds : null,
      coveredSeconds: seconds,
    };
  }

  async #observePackages(at: number): Promise<void> {
    if (!this.procPath) return;
    const names = await scanPackages(this.procPath).catch(() => null);
    if (!names) return;
    for (const transition of this.#packages.observe(names, at)) {
      this.#addEvent({
        at: transition.at,
        container: transition.name,
        project: null,
        kind: transition.kind,
        exitCode: null,
        source: 'package',
      });
    }
  }

  async #readSwap(seconds: number | null): Promise<{ inBytes: number; outBytes: number } | null> {
    if (!this.procPath) return null;
    const [vmstat, meminfo] = await Promise.all([
      readFile(join(this.procPath, 'vmstat'), 'utf8').then(parseVmstat, () => null),
      readFile(join(this.procPath, 'meminfo'), 'utf8').then(parseMeminfo, () => null),
    ]);
    this.#swapSize = meminfo;
    const previous = this.#swapPrevious;
    this.#swapPrevious = vmstat;
    if (!vmstat || !previous || seconds === null || seconds <= 0) return null;
    return {
      inBytes: counterDelta(previous.inPages, vmstat.inPages) * PAGE_BYTES,
      outBytes: counterDelta(previous.outPages, vmstat.outPages) * PAGE_BYTES,
    };
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  get intervalSeconds(): number | null {
    return this.#intervalSeconds;
  }

  get procAvailable(): boolean {
    return this.#procAvailable;
  }

  get attributionAvailable(): boolean {
    return this.#attributionAvailable;
  }

  get topology(): Topology | null {
    return this.#topology;
  }

  get memorySince(): number | null {
    const first = this.#ring.find((tick) => tick.disks.length > 0);
    return first ? first.at - first.seconds * 1000 : null;
  }

  watched(): string[] {
    return this.#topology ? watchedDisks(this.#topology, this.repos.diskIo.devices()) : [];
  }

  start(): void {
    this.reconfigure();
  }

  reconfigure(): void {
    const settings = this.repos.settings.getAll();
    if (!shouldCollect(settings)) {
      this.stop();
      return;
    }
    if (this.#timer && this.#intervalSeconds === settings.diskWatchIntervalSeconds) return;
    this.#clearTimer();
    this.#resetBaselines();
    this.#intervalSeconds = settings.diskWatchIntervalSeconds;
    this.log.debug(`Vigilancia de disco cada ${settings.diskWatchIntervalSeconds}s`);
    void this.sample();
    this.#timer = setInterval(() => void this.sample(), settings.diskWatchIntervalSeconds * 1000);
  }

  stop(): void {
    this.#clearTimer();
    this.#resetBaselines();
    this.flush();
  }

  flush(): void {
    const batch = this.#accumulator.drain();
    this.#persist(batch);
  }

  async refreshTopology(force = false): Promise<Topology | null> {
    if (!this.procPath) return null;
    const counters = await this.#readDiskstats();
    if (counters.length === 0) return this.#topology;
    await this.#ensureTopology(counters, force);
    return this.#topology;
  }

  async sample(): Promise<Tick | null> {
    if (this.#sampling) return null;
    this.#sampling = true;
    try {
      return await this.#sample();
    } catch (error) {
      this.log.debug('Fallo en el ciclo de vigilancia de disco', error);
      return null;
    } finally {
      this.#sampling = false;
    }
  }

  async #sample(): Promise<Tick | null> {
    const settings = this.repos.settings.getAll();
    const mono = performance.now();
    const at = Date.now();
    const seconds = this.#lastMono === null ? null : (mono - this.#lastMono) / 1000;
    const previousAt = this.#lastAt;
    this.#lastMono = mono;
    this.#lastAt = at;

    const counters = settings.diskWatchEnabled ? await this.#readDiskstats() : [];
    if (counters.length > 0) await this.#ensureTopology(counters, false);
    const swap = settings.diskWatchEnabled ? await this.#readSwap(seconds) : null;
    if (settings.diskWatchEnabled) await this.#observePackages(at);

    const running = this.inventory.snapshot.containers.filter((c) => c.state === 'running');
    const collected = await this.#collectContainers(running);

    const tick = this.buildTick({
      at,
      seconds,
      previousAt,
      counters,
      containers: collected,
      settings,
    });
    if (!tick) return null;
    tick.swap = swap;

    this.#ring.push({ ...tick, usage: [] });
    while (this.#ring.length > 0 && this.#ring[0]!.at < at - RING_SPAN_MS) this.#ring.shift();

    const completed = this.#accumulator.add(tick);
    this.#persist(completed);

    await this.#evaluateAlerts(settings, at);
    return tick;
  }

  buildTick(input: {
    at: number;
    seconds: number | null;
    previousAt: number | null;
    counters: DiskCounters[];
    containers: CollectedContainer[];
    settings: AppSettings;
  }): Tick | null {
    const topology = this.#topology;
    const watched = topology && input.counters.length > 0 ? new Set(this.watched()) : new Set<string>();

    this.#diskTracker.retain(new Set(input.counters.map((c) => c.name).filter((name) => watched.has(name))));
    const diskDeltas = new Map<string, DiskValues>();
    for (const counter of input.counters) {
      if (!watched.has(counter.name)) continue;
      const delta = this.#diskTracker.observe(counter.name, {
        readIos: counter.readIos,
        readBytes: counter.readBytes,
        writeIos: counter.writeIos,
        writeBytes: counter.writeBytes,
        flushes: counter.flushes,
      });
      if (delta) diskDeltas.set(counter.name, delta);
    }

    this.#containerTracker.retain(new Set(input.containers.map((c) => c.id)));
    this.#calculator ??= new StatsCalculator(this.docker.client.ncpu, this.docker.client.hostMemTotal);
    this.#calculator.retain(new Set(input.containers.map((c) => c.id)));

    const containerDisks: ContainerDiskTickSample[] = [];
    const usage: UsageTickSample[] = [];
    const attributed = new Map<string, IoBytes>();

    for (const container of input.containers) {
      const computed = this.#calculator.compute(container.id, container.stats);
      usage.push({
        container: container.name,
        project: container.project,
        cpuPercent: computed.cpuPercent,
        memoryPercent: computed.memoryPercent,
      });

      if (!topology) continue;
      const perDevice = blkioByDevice(container.stats.blkio_stats?.io_service_bytes_recursive, topology);
      if (perDevice.size > 0) this.#attributionAvailable = true;
      const flat: Record<string, number> = {};
      for (const [device, bytes] of perDevice) {
        flat[`${device}|r`] = bytes.read;
        flat[`${device}|w`] = bytes.write;
      }
      const countFromZero = input.previousAt !== null && container.createdAt >= input.previousAt;
      const delta = this.#containerTracker.observe(container.id, flat, countFromZero);
      if (!delta) continue;

      const deltaPerDevice = new Map<string, IoBytes>();
      for (const [key, value] of Object.entries(delta)) {
        const [device, op] = key.split('|') as [string, 'r' | 'w'];
        const bytes = deltaPerDevice.get(device) ?? { read: 0, write: 0 };
        if (op === 'r') bytes.read = value ?? 0;
        else bytes.write = value ?? 0;
        deltaPerDevice.set(device, bytes);
      }

      for (const disk of diskDeltas.keys()) {
        const share = attributeToDisk(deltaPerDevice, disk, topology);
        if (share.read + share.write <= 0) continue;
        containerDisks.push({
          disk,
          container: container.name,
          project: container.project,
          readBytes: share.read,
          writeBytes: share.write,
        });
        const total = attributed.get(disk) ?? { read: 0, write: 0 };
        total.read += share.read;
        total.write += share.write;
        attributed.set(disk, total);
      }
    }

    if (input.seconds === null || input.seconds <= 0) return null;

    const disks: DiskTickSample[] = [...diskDeltas].map(([disk, delta]) => ({
      disk,
      readBytes: delta.readBytes,
      writeBytes: delta.writeBytes,
      readIos: delta.readIos,
      writeIos: delta.writeIos,
      flushes: delta.flushes,
      attributedRead: attributed.get(disk)?.read ?? 0,
      attributedWrite: attributed.get(disk)?.write ?? 0,
    }));

    return {
      at: input.at,
      seconds: input.seconds,
      disks,
      containerDisks,
      usage: input.settings.metricsHistoryEnabled ? usage : [],
    };
  }

  #persist(batch: ReturnType<RollupAccumulator['drain']>): void {
    if (batch.disks.length + batch.containerDisks.length + batch.usage.length + batch.events.length === 0) return;
    if (!this.repos.settings.getAll().metricsHistoryEnabled) return;
    try {
      this.repos.diskIo.writeBatch(batch);
    } catch (error) {
      this.log.warn('No se ha podido guardar el historico de metricas', error);
    }
  }

  async #evaluateAlerts(settings: AppSettings, now: number): Promise<void> {
    const repo = this.repos.diskIo;
    if (!settings.diskWatchEnabled || !settings.diskAlertEnabled) {
      repo.replaceAlerts(new Map());
      return;
    }

    const sustainMs = settings.diskAlertSustainMinutes * 60_000;
    const required = (sustainMs / 1000) * ALERT_COVERAGE_RATIO;
    const totals = windowTotals(this.#ring, now - sustainMs);
    const rows = new Map(repo.devices().map((row) => [row.name, row]));
    const active = repo.activeAlerts();
    const inputs: AlertInput[] = [];

    for (const disk of this.watched()) {
      const entry = totals.disks.get(disk);
      const threshold = rows.get(disk)?.threshold_mb_min ?? settings.diskAlertThresholdMbPerMin;
      inputs.push({
        kind: 'disk',
        name: disk,
        rateBps: entry && entry.seconds >= required ? entry.writeBytes / entry.seconds : null,
        thresholdBps: mbPerMinuteToBytesPerSecond(threshold),
      });
    }

    if (settings.containerWriteThresholdMbPerMin > 0) {
      const alive = new Set(this.inventory.snapshot.containers.map((c) => c.name));
      const rates = containerRates(totals, required);
      for (const alert of active.values()) {
        if (alert.kind === 'container' && alive.has(alert.name) && !rates.has(alert.name)) {
          rates.set(alert.name, { rate: totals.seconds >= required ? 0 : null, disk: null });
        }
      }
      for (const [name, value] of rates) {
        if (!alive.has(name)) continue;
        inputs.push({
          kind: 'container',
          name,
          rateBps: value.rate,
          thresholdBps: mbPerMinuteToBytesPerSecond(settings.containerWriteThresholdMbPerMin),
        });
      }
    }

    const { transitions, next } = evaluateAlerts(inputs, active, now);
    repo.replaceAlerts(next);
    if (!this.#sink) return;

    const rates = containerRates(totals, required);
    for (const transition of transitions) {
      const disk = transition.kind === 'disk' ? transition.name : (rates.get(transition.name)?.disk ?? null);
      const diskTotals = disk ? totals.disks.get(disk) : undefined;
      const writers = disk ? totals.containers.get(disk) : undefined;
      const topContainers =
        writers && diskTotals && diskTotals.seconds > 0
          ? [...writers]
              .map(([name, value]) => ({ name, writeBps: value.writeBytes / diskTotals.seconds }))
              .sort((a, b) => b.writeBps - a.writeBps)
              .slice(0, TOP_WRITERS_IN_ALERT)
          : [];
      const unattributedBps =
        diskTotals && diskTotals.seconds > 0
          ? Math.max(0, diskTotals.writeBytes - diskTotals.attributedWrite) / diskTotals.seconds
          : null;
      try {
        await this.#sink.notifyDiskAlert({
          transition,
          disk,
          sustainMinutes: settings.diskAlertSustainMinutes,
          topContainers,
          unattributedBps,
        });
      } catch (error) {
        this.log.warn(`No se ha podido avisar de ${alertSubject(transition.kind, transition.name)}`, error);
      }
    }
  }

  async #collectContainers(running: ContainerSummary[]): Promise<CollectedContainer[]> {
    const collected: CollectedContainer[] = [];
    await mapWithConcurrency(running, 4, async (container) => {
      try {
        const stats = await this.docker.statsOnce(container.id);
        collected.push({
          id: container.id,
          name: container.name,
          project: container.projectName,
          createdAt: container.createdAt,
          stats,
        });
      } catch (error) {
        this.log.debug(`No se han podido leer las stats de ${container.name}`, error);
      }
    });
    return collected;
  }

  async #readDiskstats(): Promise<DiskCounters[]> {
    if (!this.procPath) {
      this.#procAvailable = false;
      return [];
    }
    try {
      const counters = parseDiskstats(await readFile(join(this.procPath, 'diskstats'), 'utf8'));
      this.#procAvailable = counters.length > 0;
      return counters;
    } catch (error) {
      if (this.#procAvailable) this.log.warn('No se puede leer diskstats del host', error);
      this.#procAvailable = false;
      return [];
    }
  }

  async #ensureTopology(counters: DiskCounters[], force: boolean): Promise<void> {
    const key = counters.map((c) => `${c.name}:${c.major}:${c.minor}`).join(',');
    if (!force && this.#topology && key === this.#topologyKey && Date.now() - this.#topologyAt < TOPOLOGY_TTL_MS) {
      return;
    }
    const [sysfs, mdstat] = await Promise.all([
      readSysfsBlock(this.sysRoot).catch(() => null),
      this.procPath
        ? readFile(join(this.procPath, 'mdstat'), 'utf8').then(parseMdstat, () => new Map<string, string[]>())
        : Promise.resolve(new Map<string, string[]>()),
    ]);
    this.setTopology(buildTopology(counters, sysfs, mdstat), key);
  }

  setTopology(topology: Topology, key = ''): void {
    this.#topology = topology;
    this.#topologyKey = key;
    this.#topologyAt = Date.now();
  }

  #resetBaselines(): void {
    this.#lastMono = null;
    this.#lastAt = null;
    this.#diskTracker.clear();
    this.#containerTracker.clear();
    this.#calculator = null;
    this.#packages.reset();
    this.#swapPrevious = null;
  }

  #clearTimer(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#intervalSeconds = null;
  }
}

export function containerRates(
  totals: ReturnType<typeof windowTotals>,
  requiredSeconds: number,
): Map<string, { rate: number | null; disk: string | null }> {
  const rates = new Map<string, { rate: number | null; disk: string | null }>();
  for (const [disk, writers] of totals.containers) {
    const seconds = totals.disks.get(disk)?.seconds ?? 0;
    for (const [name, value] of writers) {
      const rate = seconds >= requiredSeconds ? value.writeBytes / seconds : null;
      const current = rates.get(name);
      if (!current || (rate ?? -1) > (current.rate ?? -1)) rates.set(name, { rate, disk });
    }
  }
  return rates;
}
