import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerEventsWatcher } from './events.js';
import type { DockerApi } from '../docker/api.js';
import type { InventoryService } from './inventory.js';

/**
 * Que escuchar al daemon no salga mas caro que sondearlo.
 *
 * El riesgo de esta funcionalidad no es que no se entere de los cambios, sino
 * lo contrario: un `compose up` de cinco servicios dispara decenas de eventos
 * en un segundo, y refrescar el inventario en cada uno seria decenas de pasadas
 * completas seguidas. Lo que se prueba aqui es que una rafaga produce UN
 * refresco.
 */
function montar() {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const avisado = vi.fn();
  const watcher = new DockerEventsWatcher(
    {} as DockerApi,
    { refresh } as unknown as InventoryService,
    avisado,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  );
  return { watcher, refresh, avisado };
}

describe('eventos del daemon', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('una rafaga entera se resuelve con un solo refresco', async () => {
    const { watcher, refresh } = montar();
    // Lo que emite de verdad levantar un proyecto de tres servicios.
    for (const nombre of ['a', 'b', 'c']) {
      for (const accion of ['create', 'init', 'start']) {
        watcher.handleEvent({ Type: 'container', Action: accion, Actor: { Attributes: { name: nombre } } });
      }
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('los eventos que van llegando no empujan el refresco indefinidamente', async () => {
    // Si el temporizador se reiniciara con cada evento, una rafaga continua lo
    // iria retrasando y el refresco no llegaria nunca. Se fija en el primero.
    const { watcher, refresh } = montar();
    watcher.handleEvent({ Type: 'container', Action: 'start' });
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(200);
      watcher.handleEvent({ Type: 'container', Action: 'start' });
    }
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('lo que no cambia nada no dispara refrescos', async () => {
    const { watcher, refresh } = montar();
    // `exec_start` salta cada vez que alguien entra a un contenedor, y `top` o
    // `attach` no cambian nada de lo que el panel enseña.
    for (const accion of ['exec_start', 'exec_create', 'top', 'attach', 'resize']) {
      watcher.handleEvent({ Type: 'container', Action: accion });
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('acepta el nombre antiguo del campo, que es el que usan algunos daemons', async () => {
    const { watcher, refresh } = montar();
    watcher.handleEvent({ status: 'start', id: 'abc' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('dos rafagas separadas si refrescan dos veces', async () => {
    const { watcher, refresh } = montar();
    watcher.handleEvent({ Type: 'container', Action: 'start' });
    await vi.advanceTimersByTimeAsync(3000);
    watcher.handleEvent({ Type: 'container', Action: 'die' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('avisa a la interfaz cuando termina de refrescar', async () => {
    const { watcher, avisado } = montar();
    watcher.handleEvent({ Type: 'image', Action: 'pull' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(avisado).toHaveBeenCalledTimes(1);
  });
});
