export type BlockDeviceKind = 'physical' | 'raid' | 'mapper' | 'excluded';

export type DiskIoRange = '1h' | '24h' | '7d' | '30d';

export type DiskIoOp = 'read' | 'write';

export type DiskIoView = 'disks' | 'stacked';

export type DiskIoSource = 'memory' | 'history' | 'mixed' | 'none';

export type ContainerEventKind = 'start' | 'stop' | 'pause' | 'unpause';

export interface ContainerEvent {
  at: number;
  container: string;
  project: string | null;
  kind: ContainerEventKind;
  exitCode: number | null;
}

export const DISK_IO_RANGES: DiskIoRange[] = ['1h', '24h', '7d', '30d'];

export const DISK_IO_RANGE_MS: Record<DiskIoRange, number> = {
  '1h': 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
};

export const BYTES_PER_MB = 1_000_000;

export const BYTES_PER_TB = 1_000_000_000_000;

export function bytesPerSecondToMbPerMinute(value: number): number {
  return (value * 60) / BYTES_PER_MB;
}

export function mbPerMinuteToBytesPerSecond(value: number): number {
  return (value * BYTES_PER_MB) / 60;
}

export interface BlockDevice {
  name: string;
  major: number;
  minor: number;
  kind: BlockDeviceKind;
  label: string | null;
  disks: string[];
  watched: boolean;
  watchedByDefault: boolean;
  tbwTb: number | null;
  writtenTb: number | null;
  writtenAt: number | null;
  thresholdMbPerMin: number | null;
}

export interface DiskDeviceConfigInput {
  watched?: boolean | null;
  tbwTb?: number | null;
  writtenTb?: number | null;
  thresholdMbPerMin?: number | null;
}

export type LifetimeWindow = '1h' | '24h' | '7d';

export interface DiskLifetime {
  window: LifetimeWindow;
  bytesPerSecond: number | null;
  coveredSeconds: number;
  windowSeconds: number;
  years: number | null;
}

export interface DiskCurrentRates {
  ts: number;
  readBps: number;
  writeBps: number;
  readIops: number;
  writeIops: number;
  avgReadIoBytes: number | null;
  avgWriteIoBytes: number | null;
  flushesPerSecond: number | null;
}

export interface ContainerWriter {
  name: string;
  project: string | null;
  writeBps: number;
}

export interface DiskSummary {
  name: string;
  label: string | null;
  current: DiskCurrentRates | null;
  hourWriteBps: number | null;
  lifetime: DiskLifetime[];
  remainingTb: number | null;
  tbwTb: number | null;
  writtenTb: number | null;
  thresholdMbPerMin: number;
  alert: { active: boolean; since: number | null };
  attributedShare: number | null;
  unattributedBps: number | null;
  topContainers: ContainerWriter[];
}

export interface DiskIoStatus {
  enabled: boolean;
  running: boolean;
  intervalSeconds: number;
  procAvailable: boolean;
  historyEnabled: boolean;
  historySince: number | null;
  memorySince: number | null;
  attributionAvailable: boolean;
  alertsEnabled: boolean;
  sustainMinutes: number;
  containerThresholdMbPerMin: number;
  containerAlerts: Array<{ name: string; since: number }>;
  disks: DiskSummary[];
}

export interface DiskSeries {
  name: string;
  values: Array<number | null>;
  peaks: Array<number | null>;
}

export interface ContainerSeries {
  name: string;
  project: string | null;
  values: Array<number | null>;
}

export interface DiskStack {
  disk: string;
  containers: ContainerSeries[];
  others: Array<number | null>;
  unattributed: Array<number | null>;
  attributedShare: number | null;
}

export interface DiskIoSeriesResponse {
  source: DiskIoSource;
  coverageFrom: number | null;
  stepSeconds: number;
  timestamps: number[];
  disks: DiskSeries[];
  stack: DiskStack | null;
  projects: string[];
  containers: Array<{ name: string; project: string | null }>;
  events: ContainerEvent[];
  eventsTruncated: boolean;
}
