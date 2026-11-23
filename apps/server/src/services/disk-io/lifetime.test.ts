import { describe, expect, it } from 'vitest';
import { BYTES_PER_TB, mbPerMinuteToBytesPerSecond } from '@cu/shared';
import { SECONDS_PER_YEAR, remainingBytes, usedBytes, windowRate, yearsLeft } from './lifetime.js';

describe('estimacion de vida util', () => {
  it('cuadra con el diagnostico: 512 TBW a 170 MB/min por disco son unos 5,7 años', () => {
    const remaining = remainingBytes({ tbwTb: 512, writtenTb: 0, writtenSinceBytes: 0 });
    const years = yearsLeft(remaining, mbPerMinuteToBytesPerSecond(170));
    expect(years).toBeCloseTo(5.73, 1);
  });

  it('resta lo que el usuario dice que ya se escribio y lo medido desde entonces', () => {
    const remaining = remainingBytes({ tbwTb: 512, writtenTb: 12, writtenSinceBytes: 0.5 * BYTES_PER_TB });
    expect(remaining).toBe(499.5 * BYTES_PER_TB);
  });

  it('nunca estima vida negativa para un disco que ya paso su TBW', () => {
    expect(remainingBytes({ tbwTb: 100, writtenTb: 150, writtenSinceBytes: 0 })).toBe(0);
  });

  it('sigue contando lo escrito por encima del TBW para poder decir cuanto se ha pasado', () => {
    expect(usedBytes({ writtenTb: 600, writtenSinceBytes: 0.5 * BYTES_PER_TB })).toBe(600.5 * BYTES_PER_TB);
  });

  it('no estima nada sin TBW ni con un disco que no escribe', () => {
    expect(remainingBytes({ tbwTb: null, writtenTb: 0, writtenSinceBytes: 0 })).toBeNull();
    expect(yearsLeft(BYTES_PER_TB, 0)).toBeNull();
  });

  it('cuenta cada miembro del raid1 con su propio ritmo, sin sumar el espejo', () => {
    const memberRate = mbPerMinuteToBytesPerSecond(121);
    const perMember = yearsLeft(512 * BYTES_PER_TB, memberRate);
    const summed = yearsLeft(512 * BYTES_PER_TB, memberRate * 2);
    expect(perMember).toBeCloseTo((512 * BYTES_PER_TB) / (memberRate * SECONDS_PER_YEAR));
    expect(perMember! / summed!).toBeCloseTo(2);
  });

  it('no extrapola una ventana con menos de diez minutos de datos', () => {
    expect(windowRate(1_000_000, 300)).toBeNull();
    expect(windowRate(6_000_000, 600)).toBe(10_000);
  });
});
