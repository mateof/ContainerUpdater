import { describe, expect, it } from 'vitest';
import { packageFromCgroup, PackageTracker } from './packages.js';

const v1 = (path: string) => `11:cpuset:/\n3:blkio:${path}\n1:name=systemd:${path}\n`;

describe('packageFromCgroup', () => {
  it('saca el paquete de DSM de su slice', () => {
    expect(packageFromCgroup(v1('/SynologyPhotos.slice'))).toBe('SynologyPhotos');
    expect(packageFromCgroup(v1('/Virtualization.slice/pkg-etcd-cached.service'))).toBe('Virtualization');
  });

  it('reconoce los servicios pkg- de dentro de system.slice', () => {
    expect(packageFromCgroup(v1('/system.slice/pkg-ContainerManager-dockerd.service'))).toBe('ContainerManager');
    expect(packageFromCgroup(v1('/system.slice/pkg-VPNCenter-openvpn-server.service'))).toBe('VPNCenter');
  });

  it('deja fuera los contenedores, la raiz y el propio sistema', () => {
    expect(packageFromCgroup(v1('/docker/9785bfb5d037'))).toBeNull();
    expect(packageFromCgroup(v1('/'))).toBeNull();
    expect(packageFromCgroup(v1('/syno_dsm_internal.slice'))).toBeNull();
    expect(packageFromCgroup(v1('/system.slice/synotaskmgr.service'))).toBeNull();
  });

  it('entiende el formato de cgroup v2', () => {
    expect(packageFromCgroup('0::/system.slice/pkg-Emby-server.service\n')).toBe('Emby');
  });
});

describe('PackageTracker', () => {
  it('no avisa de lo que ya estaba en marcha al empezar', () => {
    const tracker = new PackageTracker();
    expect(tracker.observe(new Set(['SynologyPhotos']), 0)).toEqual([]);
  });

  it('avisa del arranque en cuanto aparece', () => {
    const tracker = new PackageTracker();
    tracker.observe(new Set(), 0);
    expect(tracker.observe(new Set(['EmbyServer']), 60_000)).toEqual([{ at: 60_000, name: 'EmbyServer', kind: 'start' }]);
  });

  it('espera a no verlo dos veces seguidas para dar la parada, con la hora de la primera', () => {
    const tracker = new PackageTracker();
    tracker.observe(new Set(['EmbyServer']), 0);
    expect(tracker.observe(new Set(), 60_000)).toEqual([]);
    expect(tracker.observe(new Set(), 120_000)).toEqual([{ at: 60_000, name: 'EmbyServer', kind: 'stop' }]);
  });

  it('no da una parada si el paquete vuelve a la lectura siguiente', () => {
    const tracker = new PackageTracker();
    tracker.observe(new Set(['taskscheduler']), 0);
    tracker.observe(new Set(), 60_000);
    expect(tracker.observe(new Set(['taskscheduler']), 120_000)).toEqual([]);
    expect(tracker.observe(new Set(['taskscheduler']), 180_000)).toEqual([]);
  });
});
