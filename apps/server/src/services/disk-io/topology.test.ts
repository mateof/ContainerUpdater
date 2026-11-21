import { describe, expect, it } from 'vitest';
import {
  buildTopology,
  classifyDevice,
  parseMdstat,
  partitionParentByName,
  selectableDevices,
  type SysfsBlockInfo,
} from './topology.js';

const NAS_MDSTAT = `Personalities : [raid1] [raid6] [raid5] [raid4] [raidF1]
md9 : active raid1 sata3p6[1] sata4p6[0]
      23429760 blocks super 1.2 [2/2] [UU]
md2 : active raid5 sata1p5[0] sata6p5[3] sata5p5[2] sata2p5[1]
      11706562368 blocks super 1.2 level 5, 64k chunk, algorithm 2 [4/4] [UUUU]
md3 : active raid1 sata3p5[3] sata4p5[2]
      966035584 blocks super 1.2 [2/2] [UU]
unused devices: <none>
`;

const NAS_DEVICES = [
  ['sata3', 8, 32],
  ['sata3p5', 8, 37],
  ['sata3p6', 8, 38],
  ['sata4', 8, 48],
  ['sata4p5', 8, 53],
  ['sata4p6', 8, 54],
  ['sata9', 8, 128],
  ['nvme0n1', 259, 4],
  ['nvme0n1p3', 259, 7],
  ['md3', 9, 3],
  ['md9', 9, 9],
  ['dm-8', 248, 8],
  ['dm-18', 248, 18],
  ['loop0', 7, 0],
  ['ram0', 1, 0],
  ['zram0', 249, 0],
  ['synoboot', 135, 240],
  ['synoboot1', 135, 241],
].map(([name, major, minor]) => ({ name: name as string, major: major as number, minor: minor as number }));

const NAS_SYSFS: SysfsBlockInfo = {
  partitionParent: new Map([
    ['sata3p5', 'sata3'],
    ['sata3p6', 'sata3'],
    ['sata4p5', 'sata4'],
    ['sata4p6', 'sata4'],
    ['nvme0n1p3', 'nvme0n1'],
    ['synoboot1', 'synoboot'],
  ]),
  slaves: new Map([
    ['md3', ['sata3p5', 'sata4p5']],
    ['md9', ['sata3p6', 'sata4p6']],
    ['dm-8', ['md3', 'md9']],
    ['dm-18', ['dm-8']],
  ]),
  dmNames: new Map([
    ['dm-8', 'vg1-volume_2'],
    ['dm-18', 'cachedev_5'],
  ]),
};

describe('partitionParentByName', () => {
  const names = new Set(['sata3', 'sata3p5', 'nvme0n1', 'nvme0n1p1', 'sda', 'sda1', 'vda', 'vda4', 'md12', 'md127', 'mmcblk0', 'mmcblk0p2']);

  it('sigue la regla del kernel: separador p solo si el nombre del disco acaba en cifra', () => {
    expect(partitionParentByName('sata3p5', names)).toBe('sata3');
    expect(partitionParentByName('nvme0n1p1', names)).toBe('nvme0n1');
    expect(partitionParentByName('mmcblk0p2', names)).toBe('mmcblk0');
    expect(partitionParentByName('sda1', names)).toBe('sda');
    expect(partitionParentByName('vda4', names)).toBe('vda');
  });

  it('no confunde md127 con una particion de md12', () => {
    expect(partitionParentByName('md127', names)).toBeNull();
  });

  it('no toma un disco entero por particion de un nombre mas corto', () => {
    expect(partitionParentByName('sata3', names)).toBeNull();
    expect(partitionParentByName('nvme0n1', names)).toBeNull();
  });
});

describe('classifyDevice', () => {
  it('separa las capas de Synology de los discos fisicos', () => {
    expect(classifyDevice('sata3')).toBe('physical');
    expect(classifyDevice('nvme0n1')).toBe('physical');
    expect(classifyDevice('md3')).toBe('raid');
    expect(classifyDevice('dm-18')).toBe('mapper');
    expect(classifyDevice('cachedev_5')).toBe('mapper');
  });

  it('excluye loop, ram, zram y el dispositivo de arranque de Synology', () => {
    for (const name of ['loop0', 'ram15', 'zram3', 'synoboot', 'sr0', 'nbd0']) {
      expect(classifyDevice(name)).toBe('excluded');
    }
  });
});

describe('parseMdstat', () => {
  it('lee los miembros de cada array del mdstat del NAS', () => {
    const slaves = parseMdstat(NAS_MDSTAT);
    expect(slaves.get('md3')).toEqual(['sata3p5', 'sata4p5']);
    expect(slaves.get('md2')).toEqual(['sata1p5', 'sata6p5', 'sata5p5', 'sata2p5']);
  });
});

describe('buildTopology', () => {
  it('resuelve cachedev sobre lvm sobre dos raid1 hasta los dos miembros fisicos', () => {
    const topology = buildTopology(NAS_DEVICES, NAS_SYSFS, new Map());
    expect(topology.devices.get('dm-18')?.disks).toEqual(['sata3', 'sata4']);
    expect(topology.devices.get('dm-18')?.label).toBe('cachedev_5');
    expect(topology.devices.get('md3')?.disks).toEqual(['sata3', 'sata4']);
  });

  it('lista como pila de un disco todas las capas que caen en el', () => {
    const topology = buildTopology(NAS_DEVICES, NAS_SYSFS, new Map());
    expect(topology.stackOf('sata3').sort()).toEqual(['dm-18', 'dm-8', 'md3', 'md9', 'sata3', 'sata3p5', 'sata3p6']);
  });

  it('recurre a las reglas de nombres y a mdstat si no puede leer sysfs', () => {
    const topology = buildTopology(NAS_DEVICES, null, parseMdstat(NAS_MDSTAT));
    expect(topology.devices.get('sata3p5')?.partitionOf).toBe('sata3');
    expect(topology.devices.get('md3')?.disks).toEqual(['sata3', 'sata4']);
  });

  it('ofrece discos enteros y capas, nunca particiones ni pseudodispositivos', () => {
    const topology = buildTopology(NAS_DEVICES, NAS_SYSFS, new Map());
    expect(selectableDevices(topology).map((d) => d.name)).toEqual([
      'sata3',
      'sata4',
      'sata9',
      'nvme0n1',
      'md3',
      'md9',
      'dm-8',
      'dm-18',
    ]);
    expect(topology.physical).toEqual(['sata3', 'sata4', 'sata9', 'nvme0n1']);
  });

  it('indexa los dispositivos por major y minor para cruzar blkio', () => {
    const topology = buildTopology(NAS_DEVICES, NAS_SYSFS, new Map());
    expect(topology.byNumber.get('8:32')).toBe('sata3');
    expect(topology.byNumber.get('248:18')).toBe('dm-18');
  });
});
