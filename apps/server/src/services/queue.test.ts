import { describe, expect, it } from 'vitest';

/**
 * Comportamiento de la cola de actualizaciones.
 *
 * Se prueba el mecanismo aislado en vez de instanciar UpdaterService entero,
 * que arrastraria Docker, SQLite y compose. Lo que puede romperse aqui es la
 * secuenciacion, no la lógica de actualizar, y eso se ve mejor sin ruido.
 */

/** Misma estructura que #drainQueue: uno a uno, sin solaparse. */
class SerialQueue {
  #busy = false;
  readonly #queue: Array<() => Promise<void>> = [];
  readonly order: string[] = [];
  maxConcurrent = 0;
  #running = 0;

  enqueue(name: string, task: () => Promise<void>): void {
    this.#queue.push(async () => {
      this.#running += 1;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.#running);
      try {
        await task();
        this.order.push(name);
      } finally {
        this.#running -= 1;
      }
    });
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (;;) {
        const entry = this.#queue.shift();
        if (!entry) break;
        // Un fallo no debe abortar la cola: los siguientes tienen que correr.
        await entry().catch(() => undefined);
      }
    } finally {
      this.#busy = false;
    }
  }

  async idle(): Promise<void> {
    while (this.#busy || this.#queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('cola de actualizaciones', () => {
  it('nunca ejecuta dos trabajos a la vez', async () => {
    // Es la garantia central: dos invocaciones de compose sobre el mismo
    // proyecto corrompen su estado.
    const queue = new SerialQueue();
    for (const name of ['a', 'b', 'c']) {
      queue.enqueue(name, () => sleep(10));
    }
    await queue.idle();

    expect(queue.maxConcurrent).toBe(1);
  });

  it('respeta el orden de llegada', async () => {
    const queue = new SerialQueue();
    queue.enqueue('primero', () => sleep(20));
    queue.enqueue('segundo', () => sleep(1));
    queue.enqueue('tercero', () => sleep(1));
    await queue.idle();

    expect(queue.order).toEqual(['primero', 'segundo', 'tercero']);
  });

  it('sigue procesando aunque un trabajo falle', async () => {
    // Si una actualizacion falla, las que esperan detras tienen que ejecutarse
    // igualmente: si no, un fallo dejaria la cola atascada para siempre.
    const queue = new SerialQueue();
    queue.enqueue('falla', () => Promise.reject(new Error('boom')));
    queue.enqueue('sigue', () => sleep(1));
    await queue.idle();

    expect(queue.order).toEqual(['sigue']);
  });

  it('acepta encolar mientras hay uno corriendo', async () => {
    const queue = new SerialQueue();
    queue.enqueue('largo', () => sleep(30));
    await sleep(5);
    queue.enqueue('tardio', () => sleep(1));
    await queue.idle();

    expect(queue.order).toEqual(['largo', 'tardio']);
    expect(queue.maxConcurrent).toBe(1);
  });
});
