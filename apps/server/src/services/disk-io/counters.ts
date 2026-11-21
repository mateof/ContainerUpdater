export function counterDelta(previous: number, current: number): number {
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return 0;
  return current >= previous ? current - previous : current;
}

export type CounterValues = Record<string, number | null>;

export class CounterTracker<T extends CounterValues> {
  readonly #previous = new Map<string, T>();

  observe(key: string, current: T, countFromZero = false): T | null {
    const previous = this.#previous.get(key);
    this.#previous.set(key, current);
    if (!previous && !countFromZero) return null;

    const delta = {} as Record<string, number | null>;
    for (const field of Object.keys(current)) {
      const now = current[field];
      const before = previous && field in previous ? previous[field] : 0;
      delta[field] =
        now === null || now === undefined || before === null || before === undefined
          ? null
          : counterDelta(before, now);
    }
    return delta as T;
  }

  retain(keys: Set<string>): void {
    for (const key of this.#previous.keys()) {
      if (!keys.has(key)) this.#previous.delete(key);
    }
  }

  clear(): void {
    this.#previous.clear();
  }

  get size(): number {
    return this.#previous.size;
  }
}
