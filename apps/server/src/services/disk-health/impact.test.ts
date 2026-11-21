import { describe, expect, it } from 'vitest';
import { computeImpact } from './impact.js';
import type { Tick } from '../disk-io/model.js';

const MB = 1_000_000;
const T0 = Date.parse('2026-11-21T10:00:00Z');

function tick(minute: number, mbPerMin: number): Tick {
  return {
    at: T0 + minute * 60_000,
    seconds: 60,
    disks: [{ disk: 'sata3', readBytes: 0, writeBytes: mbPerMin * MB, readIos: 0, writeIos: 0, flushes: null, attributedRead: 0, attributedWrite: 0 }],
    containerDisks: [],
    usage: [],
  };
}

describe('computeImpact', () => {
  it('compara el ritmo antes de pausar con el de la pausa, sin el primer medio minuto', () => {
    const ring = [
      ...[1, 2, 3, 4, 5].map((minute, i) => tick(minute, [168, 172, 170, 165, 175][i]!)),
      tick(6, 160),
      ...[7, 8, 9, 10].map((minute) => tick(minute, 95)),
    ];
    const [result] = computeImpact({
      ring,
      disks: ['sata3'],
      baselineFrom: T0,
      pausedAt: T0 + 5 * 60_000,
      resumedAt: T0 + 10 * 60_000,
    });
    expect(result!.baselineBps).toBeCloseTo((170 * MB) / 60, 0);
    expect(result!.pausedBps).toBeCloseTo((95 * MB) / 60, 0);
    expect(result!.significant).toBe(true);
  });

  it('no da por buena una diferencia que esta dentro del ruido del disco', () => {
    const ring = [
      ...[1, 2, 3, 4, 5].map((minute, i) => tick(minute, [150, 190, 160, 185, 165][i]!)),
      ...[6, 7, 8, 9, 10].map((minute, i) => tick(minute, [168, 172, 160, 175, 165][i]!)),
    ];
    const [result] = computeImpact({
      ring,
      disks: ['sata3'],
      baselineFrom: T0,
      pausedAt: T0 + 5 * 60_000,
      resumedAt: T0 + 10 * 60_000,
    });
    expect(result!.significant).toBe(false);
  });

  it('se niega a sacar conclusiones sin datos de la pausa', () => {
    expect(() =>
      computeImpact({ ring: [tick(1, 100)], disks: ['sata3'], baselineFrom: T0, pausedAt: T0 + 60_000, resumedAt: T0 + 90_000 }),
    ).toThrow('not-enough-data');
  });
});
