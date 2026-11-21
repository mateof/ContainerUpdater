import type { Db } from '../index.js';
import type { ContainerEvent, ContainerEventKind, DiskDeviceConfigInput, DiskEventSource } from '@cu/shared';
import type {
  BucketBatch,
  ContainerDiskBucket,
  DiskBucket,
  UsageBucket,
} from '../../services/disk-io/model.js';
import type { ActiveAlert, AlertSubjectKind } from '../../services/disk-io/alerts.js';

export interface DiskDeviceRow {
  name: string;
  watched: number | null;
  tbw_tb: number | null;
  written_tb: number | null;
  written_at: number | null;
  threshold_mb_min: number | null;
  updated_at: number;
}

interface DiskRollupRow {
  bucket_ts: number;
  disk: string;
  seconds: number;
  read_bytes: number;
  write_bytes: number;
  read_ios: number;
  write_ios: number;
  flushes: number | null;
  attributed_read_bytes: number;
  attributed_write_bytes: number;
  read_max_bps: number;
  write_max_bps: number;
}

interface ContainerDiskRow {
  bucket_ts: number;
  disk: string;
  container_name: string;
  project: string | null;
  read_bytes: number;
  write_bytes: number;
}

interface UsageRow {
  bucket_ts: number;
  container_name: string;
  project: string | null;
  samples: number;
  cpu_samples: number;
  cpu_avg: number | null;
  cpu_max: number | null;
  mem_avg: number;
  mem_max: number;
}

interface ContainerEventRow {
  at: number;
  container_name: string;
  project: string | null;
  kind: ContainerEventKind;
  exit_code: number | null;
  source: DiskEventSource;
}

function toDiskBucket(row: DiskRollupRow): DiskBucket {
  return {
    bucket: row.bucket_ts,
    disk: row.disk,
    seconds: row.seconds,
    readBytes: row.read_bytes,
    writeBytes: row.write_bytes,
    readIos: row.read_ios,
    writeIos: row.write_ios,
    flushes: row.flushes,
    attributedRead: row.attributed_read_bytes,
    attributedWrite: row.attributed_write_bytes,
    readMaxBps: row.read_max_bps,
    writeMaxBps: row.write_max_bps,
  };
}

function toContainerDiskBucket(row: ContainerDiskRow): ContainerDiskBucket {
  return {
    bucket: row.bucket_ts,
    disk: row.disk,
    container: row.container_name,
    project: row.project,
    readBytes: row.read_bytes,
    writeBytes: row.write_bytes,
  };
}

function toUsageBucket(row: UsageRow): UsageBucket {
  return {
    bucket: row.bucket_ts,
    container: row.container_name,
    project: row.project,
    samples: row.samples,
    cpuSamples: row.cpu_samples,
    cpuAvg: row.cpu_avg,
    cpuMax: row.cpu_max,
    memAvg: row.mem_avg,
    memMax: row.mem_max,
  };
}

export function createDiskIoRepository(db: Db) {
  const upsertDisk = db.prepare(
    `INSERT INTO disk_rollup (bucket_ts, disk, seconds, read_bytes, write_bytes, read_ios, write_ios,
       flushes, attributed_read_bytes, attributed_write_bytes, read_max_bps, write_max_bps)
     VALUES (@bucket, @disk, @seconds, @readBytes, @writeBytes, @readIos, @writeIos,
       @flushes, @attributedRead, @attributedWrite, @readMaxBps, @writeMaxBps)
     ON CONFLICT(bucket_ts, disk) DO UPDATE SET
       seconds = seconds + excluded.seconds,
       read_bytes = read_bytes + excluded.read_bytes,
       write_bytes = write_bytes + excluded.write_bytes,
       read_ios = read_ios + excluded.read_ios,
       write_ios = write_ios + excluded.write_ios,
       flushes = CASE WHEN flushes IS NULL AND excluded.flushes IS NULL THEN NULL
                      ELSE COALESCE(flushes, 0) + COALESCE(excluded.flushes, 0) END,
       attributed_read_bytes = attributed_read_bytes + excluded.attributed_read_bytes,
       attributed_write_bytes = attributed_write_bytes + excluded.attributed_write_bytes,
       read_max_bps = MAX(read_max_bps, excluded.read_max_bps),
       write_max_bps = MAX(write_max_bps, excluded.write_max_bps)`,
  );

  const upsertContainerDisk = db.prepare(
    `INSERT INTO disk_container_rollup (bucket_ts, disk, container_name, project, read_bytes, write_bytes)
     VALUES (@bucket, @disk, @container, @project, @readBytes, @writeBytes)
     ON CONFLICT(bucket_ts, disk, container_name) DO UPDATE SET
       project = COALESCE(excluded.project, project),
       read_bytes = read_bytes + excluded.read_bytes,
       write_bytes = write_bytes + excluded.write_bytes`,
  );

  const upsertUsage = db.prepare(
    `INSERT INTO metrics_rollup (bucket_ts, container_name, project, samples, cpu_samples,
       cpu_avg, cpu_max, mem_avg, mem_max)
     VALUES (@bucket, @container, @project, @samples, @cpuSamples, @cpuAvg, @cpuMax, @memAvg, @memMax)
     ON CONFLICT(bucket_ts, container_name) DO UPDATE SET
       project = COALESCE(excluded.project, project),
       cpu_avg = CASE WHEN cpu_samples + excluded.cpu_samples = 0 THEN NULL
                      ELSE (COALESCE(cpu_avg, 0) * cpu_samples + COALESCE(excluded.cpu_avg, 0) * excluded.cpu_samples)
                           / (cpu_samples + excluded.cpu_samples) END,
       cpu_max = MAX(COALESCE(cpu_max, excluded.cpu_max), COALESCE(excluded.cpu_max, cpu_max)),
       mem_avg = (mem_avg * samples + excluded.mem_avg * excluded.samples) / (samples + excluded.samples),
       mem_max = MAX(mem_max, excluded.mem_max),
       cpu_samples = cpu_samples + excluded.cpu_samples,
       samples = samples + excluded.samples`,
  );

  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO container_events (at, container_name, project, kind, exit_code, source)
     VALUES (@at, @container, @project, @kind, @exitCode, @source)`,
  );

  const writeBatch = db.transaction((batch: BucketBatch) => {
    for (const disk of batch.disks) upsertDisk.run(disk);
    for (const entry of batch.containerDisks) upsertContainerDisk.run(entry);
    for (const usage of batch.usage) upsertUsage.run(usage);
    for (const event of batch.events) insertEvent.run(event);
  });

  return {
    writeBatch(batch: BucketBatch): boolean {
      if (batch.disks.length + batch.containerDisks.length + batch.usage.length + batch.events.length === 0) {
        return false;
      }
      writeBatch(batch);
      return true;
    },

    eventsSince(from: number, to: number): ContainerEvent[] {
      const rows = db
        .prepare('SELECT * FROM container_events WHERE at >= ? AND at < ? ORDER BY at')
        .all(from, to) as ContainerEventRow[];
      return rows.map((row) => ({
        at: row.at,
        container: row.container_name,
        project: row.project,
        kind: row.kind,
        exitCode: row.exit_code,
        source: row.source,
      }));
    },

    diskBuckets(from: number, to: number, disks?: string[]): DiskBucket[] {
      const rows = db
        .prepare('SELECT * FROM disk_rollup WHERE bucket_ts >= ? AND bucket_ts < ? ORDER BY bucket_ts')
        .all(from, to) as DiskRollupRow[];
      const wanted = disks && disks.length > 0 ? new Set(disks) : null;
      return rows.filter((row) => !wanted || wanted.has(row.disk)).map(toDiskBucket);
    },

    containerDiskBuckets(from: number, to: number, disk?: string): ContainerDiskBucket[] {
      const rows = (
        disk
          ? db
              .prepare(
                'SELECT * FROM disk_container_rollup WHERE bucket_ts >= ? AND bucket_ts < ? AND disk = ? ORDER BY bucket_ts',
              )
              .all(from, to, disk)
          : db
              .prepare('SELECT * FROM disk_container_rollup WHERE bucket_ts >= ? AND bucket_ts < ? ORDER BY bucket_ts')
              .all(from, to)
      ) as ContainerDiskRow[];
      return rows.map(toContainerDiskBucket);
    },

    usageBuckets(from: number, to: number, container?: string): UsageBucket[] {
      const rows = (
        container
          ? db
              .prepare(
                'SELECT * FROM metrics_rollup WHERE bucket_ts >= ? AND bucket_ts < ? AND container_name = ? ORDER BY bucket_ts',
              )
              .all(from, to, container)
          : db
              .prepare('SELECT * FROM metrics_rollup WHERE bucket_ts >= ? AND bucket_ts < ? ORDER BY bucket_ts')
              .all(from, to)
      ) as UsageRow[];
      return rows.map(toUsageBucket);
    },

    writtenSince(disk: string, since: number): number {
      const row = db
        .prepare('SELECT COALESCE(SUM(write_bytes), 0) AS total FROM disk_rollup WHERE disk = ? AND bucket_ts >= ?')
        .get(disk, since) as { total: number };
      return row.total;
    },

    historySince(): number | null {
      const row = db
        .prepare(
          `SELECT MIN(ts) AS since FROM (
             SELECT MIN(bucket_ts) AS ts FROM disk_rollup
             UNION ALL SELECT MIN(bucket_ts) FROM metrics_rollup)`,
        )
        .get() as { since: number | null };
      return row.since;
    },

    diskHistorySince(): number | null {
      const row = db.prepare('SELECT MIN(bucket_ts) AS since FROM disk_rollup').get() as {
        since: number | null;
      };
      return row.since;
    },

    prune(retentionDays: number, now = Date.now()): void {
      const cutoff = now - retentionDays * 24 * 3600_000;
      db.prepare('DELETE FROM disk_rollup WHERE bucket_ts < ?').run(cutoff);
      db.prepare('DELETE FROM disk_container_rollup WHERE bucket_ts < ?').run(cutoff);
      db.prepare('DELETE FROM metrics_rollup WHERE bucket_ts < ?').run(cutoff);
      db.prepare('DELETE FROM container_events WHERE at < ?').run(cutoff);
    },

    devices(): DiskDeviceRow[] {
      return db.prepare('SELECT * FROM disk_devices').all() as DiskDeviceRow[];
    },

    saveDevice(name: string, input: DiskDeviceConfigInput, now = Date.now()): DiskDeviceRow {
      const existing = db.prepare('SELECT * FROM disk_devices WHERE name = ?').get(name) as
        | DiskDeviceRow
        | undefined;
      const writtenChanged = input.writtenTb !== undefined && input.writtenTb !== (existing?.written_tb ?? null);
      const row: DiskDeviceRow = {
        name,
        watched:
          input.watched === undefined ? (existing?.watched ?? null) : input.watched === null ? null : input.watched ? 1 : 0,
        tbw_tb: input.tbwTb === undefined ? (existing?.tbw_tb ?? null) : input.tbwTb,
        written_tb: input.writtenTb === undefined ? (existing?.written_tb ?? null) : input.writtenTb,
        written_at: writtenChanged ? (input.writtenTb === null ? null : now) : (existing?.written_at ?? null),
        threshold_mb_min:
          input.thresholdMbPerMin === undefined ? (existing?.threshold_mb_min ?? null) : input.thresholdMbPerMin,
        updated_at: now,
      };
      db.prepare(
        `INSERT INTO disk_devices (name, watched, tbw_tb, written_tb, written_at, threshold_mb_min, updated_at)
         VALUES (@name, @watched, @tbw_tb, @written_tb, @written_at, @threshold_mb_min, @updated_at)
         ON CONFLICT(name) DO UPDATE SET
           watched = excluded.watched,
           tbw_tb = excluded.tbw_tb,
           written_tb = excluded.written_tb,
           written_at = excluded.written_at,
           threshold_mb_min = excluded.threshold_mb_min,
           updated_at = excluded.updated_at`,
      ).run(row);
      return row;
    },

    activeAlerts(): Map<string, ActiveAlert> {
      const rows = db.prepare('SELECT * FROM disk_alert_state').all() as Array<{
        subject: string;
        kind: AlertSubjectKind;
        name: string;
        alerted_at: number;
        rate_bps: number;
      }>;
      return new Map(
        rows.map((row) => [row.subject, { kind: row.kind, name: row.name, alertedAt: row.alerted_at, rateBps: row.rate_bps }]),
      );
    },

    replaceAlerts(next: Map<string, ActiveAlert>): void {
      const current = this.activeAlerts();
      const same =
        current.size === next.size &&
        [...next].every(([subject, alert]) => current.get(subject)?.alertedAt === alert.alertedAt);
      if (same) return;
      db.transaction(() => {
        db.prepare('DELETE FROM disk_alert_state').run();
        const insert = db.prepare(
          'INSERT INTO disk_alert_state (subject, kind, name, alerted_at, rate_bps) VALUES (?, ?, ?, ?, ?)',
        );
        for (const [subject, alert] of next) {
          insert.run(subject, alert.kind, alert.name, alert.alertedAt, alert.rateBps);
        }
      })();
    },
  };
}

export type DiskIoRepository = ReturnType<typeof createDiskIoRepository>;
