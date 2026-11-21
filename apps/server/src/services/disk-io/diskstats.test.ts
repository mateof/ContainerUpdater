import { describe, expect, it } from 'vitest';
import { parseDiskstats } from './diskstats.js';

const DSM_KERNEL_4_4 = [
  '   8      32 sata3 268443 7326 21992114 302975 8333827 8019265 1463090929 71024074 0 9050917 71319984',
  '   8      37 sata3p5 1000 0 2000 10 3000 0 4000 20 0 30 40',
  '   9       3 md3 421276 0 33253702 586511 6370205 0 211841344 167030133 0 3584779 167626019',
  ' 248      18 dm-18 1 2 3 4 5 6 7 8 9 10 11',
].join('\n');

const KERNEL_6_12_WITH_FLUSHES =
  ' 252       0 vda 22798 44 2113183 5216 507331 8073 72602142 390132 0 111628 435760 0 0 0 0 33845 40410';

const KERNEL_5_4_WITH_DISCARDS = '   8       0 sda 100 0 800 5 200 0 1600 10 0 20 30 7 0 56 2';

describe('parseDiskstats', () => {
  it('lee el formato de 14 campos del kernel 4.4 de DSM pasando sectores de 512 bytes a bytes', () => {
    const [sata3] = parseDiskstats(DSM_KERNEL_4_4);
    expect(sata3).toEqual({
      major: 8,
      minor: 32,
      name: 'sata3',
      readIos: 268443,
      readBytes: 21992114 * 512,
      writeIos: 8333827,
      writeBytes: 1463090929 * 512,
      flushes: null,
    });
  });

  it('conserva particiones, md y dm para que la topologia decida que vigilar', () => {
    expect(parseDiskstats(DSM_KERNEL_4_4).map((d) => d.name)).toEqual(['sata3', 'sata3p5', 'md3', 'dm-18']);
  });

  it('lee los flush solo cuando el kernel da 20 campos', () => {
    const [vda] = parseDiskstats(KERNEL_6_12_WITH_FLUSHES);
    expect(vda?.flushes).toBe(33845);
    expect(vda?.writeBytes).toBe(72602142 * 512);
  });

  it('trata el formato de 18 campos con discards como sin contador de flush', () => {
    const [sda] = parseDiskstats(KERNEL_5_4_WITH_DISCARDS);
    expect(sda?.flushes).toBeNull();
    expect(sda?.writeIos).toBe(200);
  });

  it('ignora lineas vacias o cortadas en vez de inventarse dispositivos', () => {
    expect(parseDiskstats('\n   8 0 sda 1 2 3\n\n')).toEqual([]);
  });
});
