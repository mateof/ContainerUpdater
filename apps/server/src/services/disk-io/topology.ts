import { readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlockDeviceKind } from '@cu/shared';

export interface DeviceInfo {
  name: string;
  major: number;
  minor: number;
  kind: BlockDeviceKind;
  label: string | null;
  partitionOf: string | null;
  slaves: string[];
  disks: string[];
}

export interface SysfsBlockInfo {
  partitionParent: Map<string, string>;
  slaves: Map<string, string[]>;
  dmNames: Map<string, string>;
}

export interface Topology {
  devices: Map<string, DeviceInfo>;
  byNumber: Map<string, string>;
  physical: string[];
  stackOf(disk: string): string[];
}

const EXCLUDED = /^(loop|ram|zram|sr|fd|nbd|synoboot|mtdblock|zd|scd)\d*$/;
const RAID = /^md\d+$|^md_d\d+$/;
const MAPPER = /^dm-\d+$|^cachedev_\d+$|^bcache\d+$/;

export function deviceNumber(major: number, minor: number): string {
  return `${major}:${minor}`;
}

export function classifyDevice(name: string): BlockDeviceKind {
  if (EXCLUDED.test(name)) return 'excluded';
  if (RAID.test(name)) return 'raid';
  if (MAPPER.test(name)) return 'mapper';
  return 'physical';
}

export function partitionParentByName(name: string, names: Set<string>): string | null {
  const head = /^(.*\D)\d+$/.exec(name)?.[1];
  if (!head) return null;
  const withoutP = head.endsWith('p') ? head.slice(0, -1) : null;
  if (withoutP && /\d$/.test(withoutP) && names.has(withoutP)) return withoutP;
  if (names.has(head)) return head;
  return null;
}

export function parseMdstat(content: string): Map<string, string[]> {
  const slaves = new Map<string, string[]>();
  for (const line of content.split('\n')) {
    const match = /^(md\w*)\s*:\s*\w+\s+(.*)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    const members = [...match[2].matchAll(/([A-Za-z0-9_-]+)\[\d+\]/g)].map((m) => m[1]!);
    if (members.length > 0) slaves.set(match[1], members);
  }
  return slaves;
}

export function buildTopology(
  counters: Array<{ name: string; major: number; minor: number }>,
  sysfs: SysfsBlockInfo | null,
  mdstat: Map<string, string[]>,
): Topology {
  const names = new Set(counters.map((c) => c.name));
  const devices = new Map<string, DeviceInfo>();
  const byNumber = new Map<string, string>();

  for (const counter of counters) {
    const partitionOf =
      sysfs?.partitionParent.get(counter.name) ?? partitionParentByName(counter.name, names);
    const slaves = sysfs?.slaves.get(counter.name) ?? mdstat.get(counter.name) ?? [];
    devices.set(counter.name, {
      name: counter.name,
      major: counter.major,
      minor: counter.minor,
      kind: classifyDevice(counter.name),
      label: sysfs?.dmNames.get(counter.name) ?? null,
      partitionOf: partitionOf && names.has(partitionOf) ? partitionOf : null,
      slaves: slaves.filter((slave) => names.has(slave)),
      disks: [],
    });
    byNumber.set(deviceNumber(counter.major, counter.minor), counter.name);
  }

  const resolving = new Set<string>();
  const resolve = (name: string): string[] => {
    const device = devices.get(name);
    if (!device) return [];
    if (device.disks.length > 0) return device.disks;
    if (resolving.has(name)) return [];
    resolving.add(name);
    let disks: string[];
    if (device.partitionOf) disks = resolve(device.partitionOf);
    else if (device.slaves.length > 0) disks = [...new Set(device.slaves.flatMap(resolve))].sort();
    else disks = device.kind === 'physical' ? [name] : [];
    resolving.delete(name);
    device.disks = disks;
    return disks;
  };
  for (const name of devices.keys()) resolve(name);

  const physical = [...devices.values()]
    .filter((d) => d.kind === 'physical' && d.partitionOf === null)
    .map((d) => d.name);

  return {
    devices,
    byNumber,
    physical,
    stackOf(disk: string): string[] {
      return [...devices.values()].filter((d) => d.disks.includes(disk)).map((d) => d.name);
    },
  };
}

export function selectableDevices(topology: Topology): DeviceInfo[] {
  return [...topology.devices.values()].filter((d) => d.partitionOf === null && d.kind !== 'excluded');
}

export async function readSysfsBlock(sysRoot: string): Promise<SysfsBlockInfo | null> {
  const base = join(sysRoot, 'class', 'block');
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return null;
  }

  const info: SysfsBlockInfo = { partitionParent: new Map(), slaves: new Map(), dmNames: new Map() };
  await Promise.all(
    entries.map(async (name) => {
      const dir = join(base, name);
      const isPartition = await readFile(join(dir, 'partition'), 'utf8').then(
        () => true,
        () => false,
      );
      if (isPartition) {
        const target = await readlink(dir).catch(() => null);
        const segments = target?.split('/').filter(Boolean) ?? [];
        const parent = segments.at(-2);
        if (parent) info.partitionParent.set(name, parent);
        return;
      }
      const slaves = await readdir(join(dir, 'slaves')).catch(() => []);
      if (slaves.length > 0) info.slaves.set(name, slaves);
      const dmName = await readFile(join(dir, 'dm', 'name'), 'utf8').catch(() => null);
      if (dmName?.trim()) info.dmNames.set(name, dmName.trim());
    }),
  );
  return info;
}
