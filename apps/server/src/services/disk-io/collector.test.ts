import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TEST_SETTINGS, type AppSettings, type ContainerSummary } from '@cu/shared';
import { DiskWatchService, type CollectedContainer, type DiskAlertContext } from './collector.js';
import { buildTopology } from './topology.js';
import type { DiskCounters } from './diskstats.js';
import type { ContainerStats } from '../../docker/types.js';
import type { Repositories } from '../../db/repositories/index.js';
import type { ActiveAlert } from './alerts.js';
import type { BucketBatch } from './model.js';

const MB = 1_000_000;

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_TEST_SETTINGS, diskWatchEnabled: true, metricsHistoryEnabled: true, ...overrides };
}

function fakeRepos(current: () => AppSettings) {
  const batches: BucketBatch[] = [];
  let alerts = new Map<string, ActiveAlert>();
  const repos = {
    settings: { getAll: current },
    diskIo: {
      devices: () => [],
      writeBatch: (batch: BucketBatch) => {
        batches.push(batch);
        return true;
      },
      activeAlerts: () => new Map(alerts),
      replaceAlerts: (next: Map<string, ActiveAlert>) => {
        alerts = new Map(next);
      },
    },
  } as unknown as Repositories;
  return { repos, batches, alerts: () => alerts };
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLog; } } as never;

function makeService(current: () => AppSettings, procPath: string | null = null, containers: ContainerSummary[] = []) {
  const fake = fakeRepos(current);
  const stats = new Map<string, ContainerStats>();
  const docker = {
    client: { ncpu: 4, hostMemTotal: 8_000_000_000 },
    statsOnce: async (id: string) => stats.get(id)!,
  } as never;
  const inventory = { snapshot: { containers } } as never;
  const service = new DiskWatchService(docker, inventory, fake.repos, procPath, silentLog, '/nonexistent');
  service.setTopology(
    buildTopology(
      [
        { name: 'sata3', major: 8, minor: 32 },
        { name: 'sata4', major: 8, minor: 48 },
        { name: 'md3', major: 9, minor: 3 },
        { name: 'loop0', major: 7, minor: 0 },
      ],
      { partitionParent: new Map(), slaves: new Map([['md3', ['sata3', 'sata4']]]), dmNames: new Map() },
      new Map(),
    ),
  );
  return { service, stats, ...fake };
}

function disk(name: string, writeMb: number, writeIos = 100): DiskCounters {
  const [major, minor] = name === 'sata3' ? [8, 32] : name === 'sata4' ? [8, 48] : name === 'md3' ? [9, 3] : [7, 0];
  return { major: major!, minor: minor!, name, readIos: 0, readBytes: 0, writeIos, writeBytes: writeMb * MB, flushes: null };
}

function container(id: string, name: string, md3WriteMb: number, createdAt = 0): CollectedContainer {
  return {
    id,
    name,
    project: 'media',
    createdAt,
    stats: {
      cpu_stats: { cpu_usage: { total_usage: 1 }, system_cpu_usage: null, online_cpus: null },
      memory_stats: { usage: 100, limit: 1000 },
      blkio_stats: { io_service_bytes_recursive: [{ major: 9, minor: 3, op: 'Write', value: md3WriteMb * MB }] },
    },
  };
}

describe('DiskWatchService.buildTick', () => {
  it('da los deltas por disco y la parte que no explica ningun contenedor', () => {
    const { service } = makeService(() => settings());
    const base = { settings: settings(), previousAt: null };
    service.buildTick({ ...base, at: 0, seconds: null, counters: [disk('sata3', 1000)], containers: [container('a', 'emby', 50)] });
    const tick = service.buildTick({
      ...base,
      at: 60_000,
      seconds: 60,
      previousAt: 0,
      counters: [disk('sata3', 1170, 10_900)],
      containers: [container('a', 'emby', 62)],
    })!;

    expect(tick.disks).toEqual([
      expect.objectContaining({ disk: 'sata3', writeBytes: 170 * MB, writeIos: 10_800, attributedWrite: 12 * MB }),
    ]);
    expect(tick.containerDisks).toEqual([
      { disk: 'sata3', container: 'emby', project: 'media', readBytes: 0, writeBytes: 12 * MB },
    ]);
  });

  it('mide cada miembro del raid1 por separado en vez de sumarlos', () => {
    const { service } = makeService(() => settings());
    const base = { settings: settings(), containers: [] };
    service.buildTick({ ...base, at: 0, seconds: null, previousAt: null, counters: [disk('sata3', 0), disk('sata4', 0)] });
    const tick = service.buildTick({ ...base, at: 60_000, seconds: 60, previousAt: 0, counters: [disk('sata3', 121), disk('sata4', 121)] })!;
    expect(tick.disks.map((d) => [d.disk, d.writeBytes])).toEqual([
      ['sata3', 121 * MB],
      ['sata4', 121 * MB],
    ]);
  });

  it('no vigila por defecto los raid ni los dispositivos loop', () => {
    const { service } = makeService(() => settings());
    const base = { settings: settings(), containers: [] };
    service.buildTick({ ...base, at: 0, seconds: null, previousAt: null, counters: [disk('md3', 0), disk('loop0', 0), disk('sata3', 0)] });
    const tick = service.buildTick({
      ...base,
      at: 60_000,
      seconds: 60,
      previousAt: 0,
      counters: [disk('md3', 5), disk('loop0', 5), disk('sata3', 5)],
    })!;
    expect(tick.disks.map((d) => d.disk)).toEqual(['sata3']);
  });

  it('cuenta desde cero un contenedor creado dentro del intervalo en vez de perder su primer minuto', () => {
    const { service } = makeService(() => settings());
    const base = { settings: settings() };
    service.buildTick({ ...base, at: 0, seconds: null, previousAt: null, counters: [disk('sata3', 0)], containers: [] });
    const tick = service.buildTick({
      ...base,
      at: 60_000,
      seconds: 60,
      previousAt: 0,
      counters: [disk('sata3', 30)],
      containers: [container('new', 'immich', 8, 30_000)],
    })!;
    expect(tick.containerDisks.map((c) => [c.container, c.writeBytes])).toEqual([['immich', 8 * MB]]);
  });

  it('aguanta el reinicio de un contenedor cuyos contadores de blkio vuelven a cero', () => {
    const { service } = makeService(() => settings());
    const base = { settings: settings() };
    service.buildTick({ ...base, at: 0, seconds: null, previousAt: null, counters: [disk('sata3', 0)], containers: [container('a', 'emby', 900)] });
    const tick = service.buildTick({
      ...base,
      at: 60_000,
      seconds: 60,
      previousAt: 0,
      counters: [disk('sata3', 10)],
      containers: [container('a', 'emby', 3)],
    })!;
    expect(tick.containerDisks[0]?.writeBytes).toBe(3 * MB);
  });

  it('olvida un disco que desaparece y no se inventa un delta cuando vuelve', () => {
    const { service } = makeService(() => settings());
    const base = { settings: settings(), containers: [] };
    service.buildTick({ ...base, at: 0, seconds: null, previousAt: null, counters: [disk('sata3', 0), disk('sata4', 0)] });
    const without = service.buildTick({ ...base, at: 60_000, seconds: 60, previousAt: 0, counters: [disk('sata3', 1)] })!;
    expect(without.disks.map((d) => d.disk)).toEqual(['sata3']);
    const back = service.buildTick({ ...base, at: 120_000, seconds: 60, previousAt: 60_000, counters: [disk('sata3', 2), disk('sata4', 9000)] })!;
    expect(back.disks.map((d) => d.disk)).toEqual(['sata3']);
  });

  it('sigue funcionando con blkio vacio y lo deja todo como no atribuido', () => {
    const { service } = makeService(() => settings());
    const empty: CollectedContainer = { ...container('a', 'emby', 0), stats: { memory_stats: { usage: 1, limit: 2 } } };
    const base = { settings: settings() };
    service.buildTick({ ...base, at: 0, seconds: null, previousAt: null, counters: [disk('sata3', 0)], containers: [empty] });
    const tick = service.buildTick({ ...base, at: 60_000, seconds: 60, previousAt: 0, counters: [disk('sata3', 91)], containers: [empty] })!;
    expect(tick.disks[0]).toMatchObject({ writeBytes: 91 * MB, attributedWrite: 0 });
    expect(service.attributionAvailable).toBe(false);
  });
});

describe('DiskWatchService.sample', () => {
  afterEach(() => vi.useRealTimers());

  function procWith(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cu-proc-'));
    writeFileSync(join(dir, 'diskstats'), content);
    return dir;
  }

  function line(sectors: number): string {
    return `   8      32 sata3 0 0 0 0 100 0 ${sectors} 0 0 0 0\n`;
  }

  it('escribe como mucho un lote por tramo de cinco minutos', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-11-21T10:00:30Z'));
    const proc = procWith(line(0));
    const { service, batches } = makeService(() => settings(), proc);

    for (let minute = 0; minute <= 10; minute += 1) {
      writeFileSync(join(proc, 'diskstats'), line(minute * 120_000));
      await service.sample();
      vi.advanceTimersByTime(60_000);
    }

    expect(batches).toHaveLength(2);
    expect(batches.every((batch) => new Set(batch.disks.map((d) => d.bucket)).size === 1)).toBe(true);
  });

  it('guarda los arranques y paradas en el lote de su tramo en vez de abrir una transaccion por evento', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-11-21T10:00:30Z'));
    const proc = procWith(line(0));
    const { service, batches } = makeService(() => settings(), proc);
    const at = Date.parse('2026-11-21T10:02:00Z') / 1000;

    for (let minute = 0; minute <= 10; minute += 1) {
      if (minute === 2) {
        service.recordDockerEvent({ Type: 'container', Action: 'die', time: at, Actor: { ID: 'a', Attributes: { name: 'emby', exitCode: '0' } } });
        service.recordDockerEvent({ Type: 'container', Action: 'start', time: at + 5, Actor: { ID: 'a', Attributes: { name: 'emby' } } });
      }
      writeFileSync(join(proc, 'diskstats'), line(minute * 120_000));
      await service.sample();
      vi.advanceTimersByTime(60_000);
    }

    expect(batches).toHaveLength(2);
    expect(batches[0]?.events.map((e) => e.kind)).toEqual(['stop', 'start']);
    expect(batches[1]?.events).toEqual([]);
    expect(service.events).toHaveLength(2);
  });

  it('no apunta eventos mientras la vigilancia de disco esta apagada', () => {
    const { service } = makeService(() => settings({ diskWatchEnabled: false }));
    expect(service.recordDockerEvent({ Type: 'container', Action: 'start', Actor: { Attributes: { name: 'emby' } } })).toBeNull();
    expect(service.events).toEqual([]);
  });

  it('lo guarda todo en memoria y no escribe nada mientras el historico esta desactivado', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-11-21T10:00:30Z'));
    const proc = procWith(line(0));
    const { service, batches } = makeService(() => settings({ metricsHistoryEnabled: false }), proc);

    for (let minute = 0; minute <= 10; minute += 1) {
      writeFileSync(join(proc, 'diskstats'), line(minute * 120_000));
      await service.sample();
      vi.advanceTimersByTime(60_000);
    }
    service.flush();

    expect(batches).toHaveLength(0);
    expect(service.ring.length).toBe(10);
  });

  it('avisa una vez al cumplirse la ventana sostenida y otra al recuperarse', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-11-21T10:00:00Z'));
    const proc = procWith(line(0));
    const current = settings({ diskAlertEnabled: true, diskAlertSustainMinutes: 5, diskAlertThresholdMbPerMin: 120 });
    const { service } = makeService(() => current, proc);
    const sent: DiskAlertContext[] = [];
    service.setSink({ notifyDiskAlert: async (context) => void sent.push(context) });

    let sectors = 0;
    const minute = async (mbPerMin: number) => {
      sectors += (mbPerMin * MB) / 512;
      vi.advanceTimersByTime(60_000);
      writeFileSync(join(proc, 'diskstats'), line(sectors));
      await service.sample();
    };

    await service.sample();
    for (let i = 0; i < 10; i += 1) await minute(170);
    expect(sent.map((c) => c.transition.type)).toEqual(['over']);
    expect(sent[0]?.disk).toBe('sata3');

    for (let i = 0; i < 10; i += 1) await minute(91);
    expect(sent.map((c) => c.transition.type)).toEqual(['over', 'recovered']);
  });
});
