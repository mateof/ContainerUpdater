export const SECTOR_BYTES = 512;

export interface DiskCounters {
  major: number;
  minor: number;
  name: string;
  readIos: number;
  readBytes: number;
  writeIos: number;
  writeBytes: number;
  flushes: number | null;
}

export function parseDiskstats(content: string): DiskCounters[] {
  const devices: DiskCounters[] = [];
  for (const line of content.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14) continue;
    const numbers = fields.map(Number);
    const name = fields[2];
    if (!name || !Number.isFinite(numbers[0]) || !Number.isFinite(numbers[1])) continue;
    devices.push({
      major: numbers[0]!,
      minor: numbers[1]!,
      name,
      readIos: numbers[3]!,
      readBytes: numbers[5]! * SECTOR_BYTES,
      writeIos: numbers[7]!,
      writeBytes: numbers[9]! * SECTOR_BYTES,
      flushes: fields.length >= 20 && Number.isFinite(numbers[18]) ? numbers[18]! : null,
    });
  }
  return devices;
}
