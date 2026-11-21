import { mbPerMinuteToBytesPerSecond, type ImpactDiskResult, type ImpactProbe } from '@cu/shared';
import type { DockerApi } from '../../docker/api.js';
import type { Repositories } from '../../db/repositories/index.js';
import type { InventoryService } from '../inventory.js';
import type { DiskWatchService } from '../disk-io/collector.js';
import type { Tick } from '../disk-io/model.js';
import type { Logger } from '../../logger.js';

export const SETTLE_MS = 30_000;
const MIN_BASELINE_COVERAGE = 0.8;
const MIN_SIGNIFICANT_BPS = mbPerMinuteToBytesPerSecond(1);
const MAX_INTERVAL_SECONDS = 60;

export class ImpactError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ImpactError';
  }
}

function rate(ticks: Tick[], disk: string): { bps: number; rates: number[]; seconds: number } {
  let bytes = 0;
  let seconds = 0;
  const rates: number[] = [];
  for (const tick of ticks) {
    const entry = tick.disks.find((d) => d.disk === disk);
    if (!entry || tick.seconds <= 0) continue;
    bytes += entry.writeBytes;
    seconds += tick.seconds;
    rates.push(entry.writeBytes / tick.seconds);
  }
  return { bps: seconds > 0 ? bytes / seconds : 0, rates, seconds };
}

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

export function computeImpact(input: {
  ring: Tick[];
  disks: string[];
  baselineFrom: number;
  pausedAt: number;
  resumedAt: number;
  settleMs?: number;
}): ImpactDiskResult[] {
  const settle = input.settleMs ?? SETTLE_MS;
  const start = (tick: Tick) => tick.at - tick.seconds * 1000;
  const baseline = input.ring.filter((tick) => start(tick) >= input.baselineFrom - 1000 && tick.at <= input.pausedAt + 1000);
  const paused = input.ring.filter((tick) => start(tick) >= input.pausedAt + settle - 1000 && tick.at <= input.resumedAt + 1000);
  if (baseline.length === 0 || paused.length === 0) throw new ImpactError('not-enough-data');

  return input.disks.map((disk) => {
    const before = rate(baseline, disk);
    const during = rate(paused, disk);
    const sd2 = variance(before.rates);
    const noise = 2 * Math.sqrt(sd2 / Math.max(1, before.rates.length) + sd2 / Math.max(1, during.rates.length));
    const difference = before.bps - during.bps;
    return {
      disk,
      baselineBps: before.bps,
      pausedBps: during.bps,
      noiseBps: noise,
      significant: Math.abs(difference) > Math.max(noise, MIN_SIGNIFICANT_BPS),
    };
  });
}

export class ImpactProbeService {
  #current: { probe: ImpactProbe; timer: NodeJS.Timeout } | null = null;

  constructor(
    private readonly docker: DockerApi,
    private readonly watch: DiskWatchService,
    private readonly repos: Repositories,
    private readonly inventory: InventoryService,
    private readonly log: Logger,
  ) {}

  status(): { current: ImpactProbe | null; recent: ImpactProbe[] } {
    return { current: this.#current?.probe ?? null, recent: this.repos.diskHealth.recentProbes() };
  }

  async recover(): Promise<void> {
    for (const probe of this.repos.diskHealth.runningProbes()) {
      await this.docker.unpauseContainer(probe.containerId).catch(() => undefined);
      this.repos.diskHealth.finishProbe(probe.id, 'aborted', [], 'restarted');
      this.log.warn(`Se ha reanudado ${probe.containerName}, que seguia pausado por una medicion interrumpida`);
    }
  }

  async start(input: { containerId: string; minutes: number }, now = Date.now()): Promise<ImpactProbe> {
    if (this.#current) throw new ImpactError('busy');
    const settings = this.repos.settings.getAll();
    if (!settings.diskWatchEnabled || !this.watch.running) throw new ImpactError('watch-off');
    if (settings.diskWatchIntervalSeconds > MAX_INTERVAL_SECONDS) throw new ImpactError('interval-too-long');
    const container = this.inventory.snapshot.containers.find((c) => c.id === input.containerId);
    if (!container) throw new ImpactError('not-found');
    if (container.isSelf) throw new ImpactError('self');
    if (container.state !== 'running') throw new ImpactError('not-running');

    const windowMs = input.minutes * 60_000;
    const covered = this.watch.ring
      .filter((tick) => tick.disks.length > 0 && tick.at >= now - windowMs)
      .reduce((sum, tick) => sum + tick.seconds * 1000, 0);
    if (covered < windowMs * MIN_BASELINE_COVERAGE) throw new ImpactError('needs-baseline');

    await this.docker.pauseContainer(container.id);
    const endsAt = now + windowMs + SETTLE_MS;
    const id = this.repos.diskHealth.createProbe({
      containerId: container.id,
      containerName: container.name,
      minutes: input.minutes,
      startedAt: now,
      endsAt,
    });
    const probe: ImpactProbe = {
      id,
      containerId: container.id,
      containerName: container.name,
      minutes: input.minutes,
      state: 'running',
      startedAt: now,
      endsAt,
      finishedAt: null,
      error: null,
      disks: [],
    };
    const timer = setTimeout(() => void this.#finish('done'), endsAt - now);
    this.#current = { probe, timer };
    return probe;
  }

  async cancel(): Promise<ImpactProbe | null> {
    if (!this.#current) return null;
    return this.#finish('cancelled');
  }

  async stop(): Promise<void> {
    if (this.#current) await this.#finish('aborted');
  }

  async #finish(state: 'done' | 'cancelled' | 'aborted'): Promise<ImpactProbe | null> {
    const current = this.#current;
    if (!current) return null;
    clearTimeout(current.timer);
    this.#current = null;
    const resumedAt = Date.now();
    const { probe } = current;

    let error: string | null = null;
    try {
      await this.docker.unpauseContainer(probe.containerId);
    } catch (unpauseError) {
      error = `unpause-failed: ${(unpauseError as Error).message}`;
      this.log.error(`No se ha podido reanudar ${probe.containerName}`, unpauseError);
    }

    let disks: ImpactDiskResult[] = [];
    let finalState: ImpactProbe['state'] = error ? 'failed' : state;
    if (!error && state === 'done') {
      try {
        disks = computeImpact({
          ring: this.watch.ring,
          disks: this.watch.watched(),
          baselineFrom: probe.startedAt - probe.minutes * 60_000,
          pausedAt: probe.startedAt,
          resumedAt,
        });
      } catch (computeError) {
        finalState = 'failed';
        error = (computeError as Error).message;
      }
    }

    this.repos.diskHealth.finishProbe(probe.id, finalState, disks, error, resumedAt);
    return { ...probe, state: finalState, finishedAt: resumedAt, error, disks };
  }
}
