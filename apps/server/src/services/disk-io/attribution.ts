import { deviceNumber, type Topology } from './topology.js';

export interface IoBytes {
  read: number;
  write: number;
}

export interface BlkioEntry {
  major: number;
  minor: number;
  op: string;
  value: number;
}

export function resolveDeviceName(major: number, minor: number, topology: Topology): string | null {
  return (
    topology.byNumber.get(deviceNumber(major, minor)) ??
    topology.byNumber.get(deviceNumber(minor, major)) ??
    null
  );
}

export function blkioByDevice(
  entries: BlkioEntry[] | null | undefined,
  topology: Topology,
): Map<string, IoBytes> {
  const devices = new Map<string, IoBytes>();
  for (const entry of entries ?? []) {
    const op = entry.op.toLowerCase();
    if (op !== 'read' && op !== 'write') continue;
    const name = resolveDeviceName(entry.major, entry.minor, topology);
    if (!name) continue;
    const bytes = devices.get(name) ?? { read: 0, write: 0 };
    bytes[op] += entry.value;
    devices.set(name, bytes);
  }
  return devices;
}

export function attributeToDisk(
  perDevice: Map<string, IoBytes>,
  disk: string,
  topology: Topology,
): IoBytes {
  const own = perDevice.get(disk);
  if (own) return { ...own };
  const result = { read: 0, write: 0 };
  for (const device of topology.stackOf(disk)) {
    const bytes = perDevice.get(device);
    if (!bytes) continue;
    result.read = Math.max(result.read, bytes.read);
    result.write = Math.max(result.write, bytes.write);
  }
  return result;
}

export function unattributed(diskBytes: number, attributedBytes: number): number {
  return Math.max(0, diskBytes - attributedBytes);
}

export function attributedShare(diskBytes: number, attributedBytes: number): number | null {
  if (diskBytes <= 0) return null;
  return Math.min(1, Math.max(0, attributedBytes / diskBytes));
}
