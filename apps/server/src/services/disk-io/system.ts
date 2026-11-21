import type { MountReport } from '@cu/shared';

export const PAGE_BYTES = 4096;

export interface SwapCounters {
  inPages: number;
  outPages: number;
}

export interface SwapSize {
  totalBytes: number;
  freeBytes: number;
}

export function parseVmstat(text: string): SwapCounters | null {
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && value !== undefined) values.set(key, Number(value));
  }
  const inPages = values.get('pswpin');
  const outPages = values.get('pswpout');
  if (inPages === undefined || outPages === undefined || !Number.isFinite(inPages) || !Number.isFinite(outPages)) {
    return null;
  }
  return { inPages, outPages };
}

export function parseMeminfo(text: string): SwapSize | null {
  const kb = (key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const totalBytes = kb('SwapTotal');
  const freeBytes = kb('SwapFree');
  if (totalBytes === null || freeBytes === null) return null;
  return { totalBytes, freeBytes };
}

const WATCHED_FS = new Set(['btrfs', 'ext4', 'ext3', 'xfs', 'f2fs']);
const DEFAULT_COMMIT: Record<string, number> = { btrfs: 30, ext4: 5, ext3: 5 };
const IGNORED_MOUNT = /(^\/(proc|sys|dev|run)(\/|$))|\/@docker\/|\/docker\/(btrfs|overlay2|containers|volumes)\/|^\/var\/lib\/(docker|containers)\//;

function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

export function parseMountinfo(text: string): MountReport[] {
  const bySource = new Map<string, MountReport>();
  for (const line of text.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator === -1) continue;
    const left = line.slice(0, separator).split(' ');
    const right = line.slice(separator + 3).split(' ');
    const mountPoint = unescapeMount(left[4] ?? '');
    const mountOptions = (left[5] ?? '').split(',');
    const [fsType = '', source = '', superOptions = ''] = right;
    if (!WATCHED_FS.has(fsType) || !mountPoint || IGNORED_MOUNT.test(mountPoint)) continue;

    const all = [...mountOptions, ...superOptions.split(',')];
    const atime = all.includes('noatime')
      ? 'noatime'
      : all.includes('strictatime')
        ? 'strictatime'
        : all.includes('lazytime')
          ? 'lazytime'
          : 'relatime';
    const commitOption = all.find((option) => option.startsWith('commit='));
    const commitSeconds = commitOption ? Number(commitOption.slice('commit='.length)) : null;
    const flags = all.filter((option) => ['autodefrag', 'discard', 'discard=async', 'discard=sync', 'ssd', 'nossd'].includes(option) || option.startsWith('compress'));
    const uniqueFlags = [...new Set(flags)];
    const advice: MountReport['advice'] = [];
    if (atime === 'relatime' || atime === 'strictatime') advice.push('atime');
    if (uniqueFlags.includes('autodefrag')) advice.push('autodefrag');
    if (uniqueFlags.includes('discard') || uniqueFlags.includes('discard=sync')) advice.push('discard');
    const defaultCommitSeconds = DEFAULT_COMMIT[fsType] ?? null;
    const effectiveCommit = commitSeconds ?? defaultCommitSeconds;
    if (fsType === 'btrfs' && effectiveCommit !== null && effectiveCommit <= 30) advice.push('commit');

    const report: MountReport = {
      mountPoint,
      source,
      fsType,
      atime,
      commitSeconds: commitSeconds !== null && Number.isFinite(commitSeconds) ? commitSeconds : null,
      defaultCommitSeconds,
      flags: uniqueFlags,
      advice,
    };
    const key = `${source}|${fsType}`;
    const existing = bySource.get(key);
    if (!existing || mountPoint.length < existing.mountPoint.length) bySource.set(key, report);
  }
  return [...bySource.values()].sort((a, b) => a.mountPoint.localeCompare(b.mountPoint, 'en', { numeric: true }));
}
