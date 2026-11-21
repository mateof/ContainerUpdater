import { describe, expect, it } from 'vitest';
import { parseMeminfo, parseMountinfo, parseVmstat } from './system.js';

describe('parseVmstat', () => {
  it('lee las paginas que entran y salen de la swap', () => {
    expect(parseVmstat('nr_free_pages 1000\npswpin 12\npswpout 345\n')).toEqual({ inPages: 12, outPages: 345 });
  });

  it('devuelve null si el kernel no los da', () => {
    expect(parseVmstat('nr_free_pages 1000\n')).toBeNull();
  });
});

describe('parseMeminfo', () => {
  it('pasa los kB de la swap a bytes', () => {
    expect(parseMeminfo('MemTotal: 100 kB\nSwapTotal:     4194300 kB\nSwapFree:      4000000 kB\n')).toEqual({
      totalBytes: 4194300 * 1024,
      freeBytes: 4000000 * 1024,
    });
  });
});

const DSM_MOUNTINFO = [
  '22 1 9:0 / / rw,noatime shared:1 - ext4 /dev/md0 rw,data=ordered',
  '40 22 0:20 / /proc rw,nosuid shared:2 - proc proc rw',
  '61 22 248:18 / /volume2 rw,relatime shared:30 - btrfs /dev/mapper/cachedev_5 rw,ssd,synoacl,space_cache=v2,auto_reclaim_space,metadata_ratio=50,syno_allocator,subvolid=256,subvol=/@syno',
  '62 61 248:18 /@docker/btrfs/subvolumes/abc /volume2/@docker/btrfs/subvolumes/abc rw,relatime - btrfs /dev/mapper/cachedev_5 rw,ssd',
  '63 22 248:13 / /volume1 rw,noatime shared:31 - btrfs /dev/mapper/cachedev_0 rw,autodefrag,commit=60,discard',
].join('\n');

describe('parseMountinfo', () => {
  it('lista los volumenes con su modo de atime, su commit y sus avisos', () => {
    const mounts = parseMountinfo(DSM_MOUNTINFO);
    expect(mounts.map((mount) => mount.mountPoint)).toEqual(['/', '/volume1', '/volume2']);
    const volume2 = mounts.find((mount) => mount.mountPoint === '/volume2')!;
    expect(volume2).toMatchObject({ fsType: 'btrfs', atime: 'relatime', commitSeconds: null, defaultCommitSeconds: 30 });
    expect(volume2.advice).toEqual(['atime', 'commit']);
    const volume1 = mounts.find((mount) => mount.mountPoint === '/volume1')!;
    expect(volume1).toMatchObject({ atime: 'noatime', commitSeconds: 60 });
    expect(volume1.advice).toEqual(['autodefrag', 'discard']);
  });

  it('no repite el mismo volumen por cada subvolumen de Docker', () => {
    expect(parseMountinfo(DSM_MOUNTINFO).filter((mount) => mount.source === '/dev/mapper/cachedev_5')).toHaveLength(1);
  });
});
