import { describe, expect, it } from 'vitest';
import { BUCKET_MS, RollupAccumulator, windowTotals, type Tick } from './model.js';

const T0 = Date.UTC(2026, 10, 21, 10, 0, 0);

function tick(at: number, writeBytes: number, seconds = 60): Tick {
  return {
    at,
    seconds,
    disks: [
      { disk: 'sata3', readBytes: 0, writeBytes, readIos: 0, writeIos: 10, flushes: null, attributedRead: 0, attributedWrite: writeBytes / 10 },
    ],
    containerDisks: [{ disk: 'sata3', container: 'emby', project: null, readBytes: 0, writeBytes: writeBytes / 10 }],
    usage: [{ container: 'emby', project: null, cpuPercent: 10, memoryPercent: 20 }],
  };
}

describe('RollupAccumulator', () => {
  it('solo entrega un tramo cuando ya ha empezado el siguiente', () => {
    const accumulator = new RollupAccumulator();
    for (let minute = 1; minute <= 4; minute += 1) {
      const done = accumulator.add(tick(T0 + minute * 60_000, 100));
      expect(done.disks).toEqual([]);
    }
    const done = accumulator.add(tick(T0 + 5 * 60_000 + 1, 100));
    expect(done.disks).toHaveLength(1);
    expect(done.disks[0]).toMatchObject({ bucket: T0, seconds: 240, writeBytes: 400, writeMaxBps: 100 / 60 });
  });

  it('conserva la media real y el minuto mas alto de cada tramo', () => {
    const accumulator = new RollupAccumulator();
    accumulator.add(tick(T0 + 60_000, 60));
    accumulator.add(tick(T0 + 120_000, 600));
    const [bucket] = accumulator.drain().disks;
    expect(bucket!.writeBytes / bucket!.seconds).toBeCloseTo(660 / 120);
    expect(bucket!.writeMaxBps).toBeCloseTo(10);
  });

  it('promedia CPU y memoria por nombre de contenedor entre muestras', () => {
    const accumulator = new RollupAccumulator();
    accumulator.add({ ...tick(T0 + 60_000, 1), usage: [{ container: 'emby', project: 'm', cpuPercent: 10, memoryPercent: 20 }] });
    accumulator.add({ ...tick(T0 + 120_000, 1), usage: [{ container: 'emby', project: 'm', cpuPercent: 30, memoryPercent: 40 }] });
    const [usage] = accumulator.drain().usage;
    expect(usage).toMatchObject({ samples: 2, cpuAvg: 20, cpuMax: 30, memAvg: 30, memMax: 40 });
  });

  it('vacia el tramo a medias al cerrar para no perderlo', () => {
    const accumulator = new RollupAccumulator();
    accumulator.add(tick(T0 + 60_000, 100));
    expect(accumulator.drain().disks).toHaveLength(1);
    expect(accumulator.pending).toBe(false);
  });

  it('usa tramos de cinco minutos', () => {
    expect(BUCKET_MS).toBe(300_000);
  });
});

describe('windowTotals', () => {
  it('solo cuenta la parte de cada muestra que cae dentro de la ventana', () => {
    const totals = windowTotals([tick(T0 + 60_000, 600), tick(T0 + 120_000, 600)], T0 + 30_000);
    expect(totals.disks.get('sata3')).toMatchObject({ seconds: 90, writeBytes: 900 });
  });
});
