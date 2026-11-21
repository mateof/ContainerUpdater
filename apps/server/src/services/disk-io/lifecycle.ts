import type { ContainerEvent, ContainerEventKind } from '@cu/shared';
import type { DockerEvent } from '../../docker/types.js';

export const MAX_SERIES_EVENTS = 500;

const KINDS: Record<string, ContainerEventKind> = {
  start: 'start',
  die: 'stop',
  died: 'stop',
  pause: 'pause',
  unpause: 'unpause',
};

const IMAGE_ID = /^(sha256:)?[a-f0-9]{12,64}$/;

export type KnownContainer = { name: string; project: string | null };

export function lifecycleEventFrom(
  event: DockerEvent,
  lookup: (id: string) => KnownContainer | undefined,
  now = Date.now(),
): ContainerEvent | null {
  const action = (event.Action ?? event.status ?? '').split(':')[0] ?? '';
  if (event.Type === 'image') return imagePullFrom(event, action, now);
  if (event.Type !== undefined && event.Type !== 'container') return null;
  const kind = KINDS[action];
  if (!kind) return null;

  const id = event.Actor?.ID ?? event.id;
  const attributes = event.Actor?.Attributes ?? {};
  const known = id ? lookup(id) : undefined;
  const container = known?.name ?? attributes.name;
  if (!container) return null;

  const exitCode = kind === 'stop' ? Number.parseInt(attributes.exitCode ?? '', 10) : Number.NaN;
  return {
    at: eventTime(event, now),
    container,
    project: known?.project ?? attributes['com.docker.compose.project'] ?? null,
    kind,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    source: 'container',
  };
}

function imagePullFrom(event: DockerEvent, action: string, now: number): ContainerEvent | null {
  if (action !== 'pull') return null;
  const id = event.Actor?.ID ?? event.id;
  const named = event.Actor?.Attributes?.name;
  const reference = id && !IMAGE_ID.test(id) ? id : (named ?? id);
  if (!reference) return null;
  return { at: eventTime(event, now), container: reference, project: null, kind: 'pull', exitCode: null, source: 'image' };
}

function eventTime(event: DockerEvent, now: number): number {
  if (typeof event.timeNano === 'number' && event.timeNano > 0) return Math.floor(event.timeNano / 1_000_000);
  if (typeof event.time === 'number' && event.time > 0) return event.time * 1000;
  return now;
}

export function eventKey(event: ContainerEvent): string {
  return `${event.at}|${event.container}|${event.kind}`;
}

export function selectEvents(input: {
  stored: ContainerEvent[];
  memory: ContainerEvent[];
  from: number;
  containers: string[];
  project?: string;
  limit?: number;
}): { events: ContainerEvent[]; truncated: boolean } {
  const wanted = input.containers.length > 0 ? new Set(input.containers) : null;
  const merged = new Map<string, ContainerEvent>();
  for (const event of [...input.stored, ...input.memory]) {
    if (event.at < input.from) continue;
    const filtered = wanted !== null || Boolean(input.project);
    if (filtered && event.source !== 'container') continue;
    if (wanted && !wanted.has(event.container)) continue;
    if (!wanted && input.project && event.project !== input.project) continue;
    merged.set(eventKey(event), event);
  }
  const sorted = [...merged.values()].sort((a, b) => a.at - b.at || a.container.localeCompare(b.container));
  const limit = input.limit ?? MAX_SERIES_EVENTS;
  return { events: sorted.slice(-limit), truncated: sorted.length > limit };
}
