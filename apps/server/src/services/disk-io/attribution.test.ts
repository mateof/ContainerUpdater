import { describe, expect, it } from 'vitest';
import { attributeToDisk, attributedShare, blkioByDevice, unattributed } from './attribution.js';
import { buildTopology } from './topology.js';

const topology = buildTopology(
  [
    { name: 'sata3', major: 8, minor: 32 },
    { name: 'sata3p5', major: 8, minor: 37 },
    { name: 'sata4', major: 8, minor: 48 },
    { name: 'sata4p5', major: 8, minor: 53 },
    { name: 'md3', major: 9, minor: 3 },
    { name: 'dm-18', major: 248, minor: 18 },
    { name: 'vda', major: 252, minor: 0 },
  ],
  {
    partitionParent: new Map([
      ['sata3p5', 'sata3'],
      ['sata4p5', 'sata4'],
    ]),
    slaves: new Map([
      ['md3', ['sata3p5', 'sata4p5']],
      ['dm-18', ['md3']],
    ]),
    dmNames: new Map(),
  },
  new Map(),
);

describe('blkioByDevice', () => {
  it('suma lectura y escritura por dispositivo e ignora las filas Sync, Async y Total de cgroup v1', () => {
    const perDevice = blkioByDevice(
      [
        { major: 248, minor: 18, op: 'Read', value: 10 },
        { major: 248, minor: 18, op: 'Write', value: 300 },
        { major: 248, minor: 18, op: 'Sync', value: 300 },
        { major: 248, minor: 18, op: 'Total', value: 310 },
      ],
      topology,
    );
    expect(perDevice.get('dm-18')).toEqual({ read: 10, write: 300 });
  });

  it('reconoce el major y minor invertidos que devuelve la API compatible de Podman', () => {
    const perDevice = blkioByDevice([{ major: 0, minor: 252, op: 'write', value: 1224192 }], topology);
    expect(perDevice.get('vda')).toEqual({ read: 0, write: 1224192 });
  });

  it('descarta las entradas de dispositivos que no sabe ubicar en vez de adivinar', () => {
    expect(blkioByDevice([{ major: 99, minor: 99, op: 'write', value: 5 }], topology).size).toBe(0);
  });
});

describe('attributeToDisk', () => {
  it('prefiere la entrada del propio disco cuando blkio cuenta a ese nivel', () => {
    const perDevice = new Map([
      ['sata3', { read: 0, write: 100 }],
      ['dm-18', { read: 0, write: 400 }],
    ]);
    expect(attributeToDisk(perDevice, 'sata3', topology).write).toBe(100);
  });

  it('no cuenta dos veces los mismos bytes cuando aparecen en cachedev, md y particion', () => {
    const perDevice = new Map([
      ['dm-18', { read: 5, write: 400 }],
      ['md3', { read: 5, write: 400 }],
      ['sata3p5', { read: 0, write: 390 }],
    ]);
    expect(attributeToDisk(perDevice, 'sata3', topology)).toEqual({ read: 5, write: 400 });
  });

  it('da a cada miembro del raid1 la escritura entera, no la mitad', () => {
    const perDevice = new Map([['md3', { read: 0, write: 400 }]]);
    expect(attributeToDisk(perDevice, 'sata3', topology).write).toBe(400);
    expect(attributeToDisk(perDevice, 'sata4', topology).write).toBe(400);
  });

  it('no atribuye nada a un disco fuera de la pila del contenedor', () => {
    const perDevice = new Map([['md3', { read: 0, write: 400 }]]);
    expect(attributeToDisk(perDevice, 'vda', topology)).toEqual({ read: 0, write: 0 });
  });
});

describe('unattributed', () => {
  it('es el total del disco menos lo que explican los contenedores', () => {
    expect(unattributed(170, 12)).toBe(158);
  });

  it('nunca sale negativo cuando blkio y diskstats no cuadran', () => {
    expect(unattributed(100, 130)).toBe(0);
    expect(attributedShare(100, 130)).toBe(1);
  });

  it('no tiene porcentaje cuando el disco no escribio nada', () => {
    expect(attributedShare(0, 0)).toBeNull();
  });
});
