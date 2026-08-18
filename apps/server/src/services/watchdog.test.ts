import { describe, expect, it } from 'vitest';
import { DEFAULT_TEST_SETTINGS } from '@cu/shared';
import type { ContainerSummary } from '@cu/shared';
import { classify } from './watchdog.js';

function container(patch: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: 'abc',
    name: 'audiobookshelf',
    image: 'x',
    imageRef: 'x',
    imageId: 'sha256:1',
    state: 'running',
    status: 'Up 2 hours',
    health: 'none',
    createdAt: 0,
    startedAt: null,
    restartCount: 0,
    exitCode: null,
    updateAvailable: false,
    ports: [],
    projectKey: null,
    projectName: null,
    serviceName: null,
    isSelf: false,
    ...patch,
  };
}

const S = DEFAULT_TEST_SETTINGS;

describe('que merece un aviso', () => {
  it('un contenedor corriendo y sano no avisa', () => {
    expect(classify(container(), 0, S)).toBeNull();
  });

  it('salir con codigo distinto de cero es una caida', () => {
    expect(classify(container({ state: 'exited', exitCode: 1 }), 0, S)).toBe('down');
    expect(classify(container({ state: 'exited', exitCode: 137 }), 0, S)).toBe('down');
  });

  it('salir con cero NO avisa: es una parada voluntaria', () => {
    // Es la regla que evita avisar al usuario de lo que el mismo acaba de
    // hacer, que es la forma mas rapida de que apague los avisos.
    expect(classify(container({ state: 'exited', exitCode: 0 }), 0, S)).toBeNull();
  });

  it('sin codigo de salida no se afirma nada', () => {
    expect(classify(container({ state: 'exited', exitCode: null }), 0, S)).toBeNull();
  });

  it('el estado reiniciando es bucle', () => {
    expect(classify(container({ state: 'restarting' }), 0, S)).toBe('restart-loop');
  });

  it('detecta el bucle aunque en el momento del muestreo este corriendo', () => {
    // Con `restart: unless-stopped` un contenedor roto aparece "corriendo" a
    // ratos. Lo que lo delata es el contador de reinicios subiendo.
    expect(classify(container({ restartCount: 12 }), 9, S)).toBe('restart-loop');
    expect(classify(container({ restartCount: 11 }), 9, S)).toBeNull();
  });

  it('no confunde el contador acumulado con reinicios nuevos', () => {
    // Un contenedor con 40 reinicios de hace meses que ahora esta estable no
    // esta en bucle. Lo que cuenta es el delta, no el total.
    expect(classify(container({ restartCount: 40 }), 40, S)).toBeNull();
  });

  it('sin estado anterior no se inventa un bucle', () => {
    // Primera vez que se ve el contenedor: 40 reinicios historicos no son 40
    // reinicios ahora mismo.
    expect(classify(container({ restartCount: 40 }), null, S)).toBeNull();
  });

  it('corriendo pero enfermo avisa', () => {
    expect(classify(container({ health: 'unhealthy' }), 0, S)).toBe('unhealthy');
  });

  it('el bucle tiene prioridad sobre la caida', () => {
    // Un contenedor en bucle alterna entre parado y arrancando: sin esta
    // prioridad mandaria "se ha caido" y "se ha recuperado" en bucle.
    expect(classify(container({ state: 'restarting', exitCode: 1 }), 0, S)).toBe('restart-loop');
  });
});
