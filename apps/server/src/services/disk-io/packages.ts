import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const INFRASTRUCTURE_SLICES = new Set([
  'system.slice',
  'user.slice',
  'machine.slice',
  'syno_dsm_internal.slice',
  'init.scope',
  '-.slice',
]);

const PACKAGE_UNIT = /^pkg-([A-Za-z0-9_.]+?)(?:-[A-Za-z0-9_.@]+(?:-[A-Za-z0-9_.@]+)*)?\.service$/;

function cgroupPath(text: string): string | null {
  const lines = text.split('\n').filter(Boolean);
  const pick =
    lines.find((line) => line.split(':')[1] === 'blkio') ??
    lines.find((line) => line.startsWith('0::')) ??
    lines.find((line) => line.split(':')[1] === 'name=systemd');
  if (!pick) return null;
  const parts = pick.split(':');
  return parts.slice(2).join(':');
}

export function packageFromCgroup(text: string): string | null {
  const path = cgroupPath(text);
  if (!path) return null;
  const segments = path.split('/').filter(Boolean);
  const first = segments[0];
  if (!first) return null;
  if (first.endsWith('.slice') && !INFRASTRUCTURE_SLICES.has(first)) {
    return first.slice(0, -'.slice'.length);
  }
  for (const segment of segments) {
    const match = PACKAGE_UNIT.exec(segment);
    if (match) return match[1]!;
  }
  return null;
}

export interface PackageTransition {
  at: number;
  name: string;
  kind: 'start' | 'stop';
}

export class PackageTracker {
  #present = new Set<string>();
  readonly #missingSince = new Map<string, number>();
  #primed = false;

  observe(names: Set<string>, at: number): PackageTransition[] {
    if (!this.#primed) {
      this.#present = new Set(names);
      this.#primed = true;
      return [];
    }
    const transitions: PackageTransition[] = [];
    for (const name of names) {
      this.#missingSince.delete(name);
      if (this.#present.has(name)) continue;
      this.#present.add(name);
      transitions.push({ at, name, kind: 'start' });
    }
    for (const name of [...this.#present]) {
      if (names.has(name)) continue;
      const since = this.#missingSince.get(name);
      if (since === undefined) {
        this.#missingSince.set(name, at);
        continue;
      }
      this.#present.delete(name);
      this.#missingSince.delete(name);
      transitions.push({ at: since, name, kind: 'stop' });
    }
    return transitions.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  }

  reset(): void {
    this.#present.clear();
    this.#missingSince.clear();
    this.#primed = false;
  }
}

export async function scanPackages(procPath: string, batch = 128): Promise<Set<string>> {
  const pids = (await readdir(procPath)).filter((entry) => /^\d+$/.test(entry));
  const names = new Set<string>();
  for (let index = 0; index < pids.length; index += batch) {
    const texts = await Promise.all(
      pids.slice(index, index + batch).map((pid) => readFile(join(procPath, pid, 'cgroup'), 'utf8').catch(() => '')),
    );
    for (const text of texts) {
      const name = text ? packageFromCgroup(text) : null;
      if (name) names.add(name);
    }
  }
  return names;
}
