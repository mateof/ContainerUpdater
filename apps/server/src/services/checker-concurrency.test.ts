import { describe, expect, it, vi } from 'vitest';
import { CheckerService } from './checker.js';
import type { Repositories } from '../db/repositories/index.js';
import type { DockerApi } from '../docker/api.js';

/**
 * Que comprobar una imagen suelta no choque con nada.
 *
 * Existe por un fallo que se veia usando la aplicacion: pulsar "comprobar" en
 * una imagen y, antes de que terminara, pulsarlo en otra, daba error. La
 * exclusion mutua valia para CUALQUIER comprobacion cuando lo unico que tiene
 * que proteger es que dos barridos completos no se pisen.
 *
 * La regla que se fija aqui: con `refs` puede haber las que sea a la vez; sin
 * `refs` (barrido entero) solo una.
 */
function repos(): Repositories {
  let runId = 0;
  return {
    history: {
      startRun: () => ++runId,
      finishRun: vi.fn(),
      getRun: (id: number) => ({
        id,
        trigger: 'manual',
        status: 'ok',
        startedAt: 0,
        finishedAt: 0,
        imagesChecked: 0,
        updatesFound: 0,
        errors: 0,
      }),
      recordResult: vi.fn(),
    },
    // Sin imagenes que comprobar: lo que se prueba es la exclusion, no el
    // resultado, y asi la prueba no toca la red.
    inventory: {
      listCheckable: () => [],
      findImage: () => undefined,
      recordCheck: vi.fn(),
      clearRelease: vi.fn(),
    },
    settings: { getAll: () => ({ registryConcurrency: 3 }), setRaw: vi.fn() },
    registries: { getCredentials: () => null, setStatus: vi.fn(), setRateLimit: vi.fn() },
  } as unknown as Repositories;
}

const log = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: () => log,
} as never;

describe('comprobaciones simultaneas', () => {
  it('varias de una imagen concreta pueden convivir', async () => {
    const checker = new CheckerService(repos(), {} as DockerApi, log);
    const resultados = await Promise.allSettled([
      checker.runCheck('manual', { refs: ['a'] }),
      checker.runCheck('manual', { refs: ['b'] }),
      checker.runCheck('manual', { refs: ['c'] }),
    ]);
    expect(resultados.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
  });

  it('un barrido completo sigue excluyendo a otro barrido completo', async () => {
    // Aqui la exclusion SI hace falta: dos barridos consultan cada registry dos
    // veces y dejan dos filas de ejecucion solapadas en el historial.
    const checker = new CheckerService(repos(), {} as DockerApi, log);
    const resultados = await Promise.allSettled([checker.runCheck('schedule'), checker.runCheck('schedule')]);
    const rechazados = resultados.filter((r) => r.status === 'rejected');
    expect(rechazados).toHaveLength(1);
  });

  it('el barrido completo no bloquea la comprobacion de una imagen', async () => {
    const checker = new CheckerService(repos(), {} as DockerApi, log);
    const [barrido, suelta] = await Promise.allSettled([
      checker.runCheck('schedule'),
      checker.runCheck('manual', { refs: ['a'] }),
    ]);
    expect(barrido.status).toBe('fulfilled');
    expect(suelta.status).toBe('fulfilled');
  });
});
