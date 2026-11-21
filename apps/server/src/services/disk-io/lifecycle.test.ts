import { describe, expect, it } from 'vitest';
import type { ContainerEvent } from '@cu/shared';
import { lifecycleEventFrom, selectEvents } from './lifecycle.js';

const NONE = () => undefined;

function dockerEvent(action: string, attributes: Record<string, string> = {}, extra: object = {}) {
  return {
    Type: 'container',
    Action: action,
    Actor: { ID: 'abc123', Attributes: { name: 'emby', ...attributes } },
    time: 1_763_700_000,
    ...extra,
  };
}

function event(at: number, container: string, project: string | null = null): ContainerEvent {
  return { at, container, project, kind: 'start', exitCode: null };
}

describe('lifecycleEventFrom', () => {
  it('convierte die en una parada con su codigo de salida', () => {
    expect(lifecycleEventFrom(dockerEvent('die', { exitCode: '137' }), NONE)).toEqual({
      at: 1_763_700_000_000,
      container: 'emby',
      project: null,
      kind: 'stop',
      exitCode: 137,
    });
  });

  it('entiende el died de Podman como una parada', () => {
    expect(lifecycleEventFrom(dockerEvent('died'), NONE)?.kind).toBe('stop');
  });

  it('ignora los exec y los health_status que disparan los healthchecks a cada rato', () => {
    for (const action of ['exec_create', 'exec_start', 'exec_die', 'health_status: healthy', 'kill', 'create']) {
      expect(lifecycleEventFrom(dockerEvent(action), NONE)).toBeNull();
    }
  });

  it('ignora los eventos de imagenes, redes y volumenes', () => {
    expect(lifecycleEventFrom({ ...dockerEvent('start'), Type: 'network' }, NONE)).toBeNull();
  });

  it('prefiere timeNano para no perder los milisegundos', () => {
    const parsed = lifecycleEventFrom(dockerEvent('start', {}, { timeNano: 1_763_700_000_123_456_789 }), NONE);
    expect(parsed?.at).toBe(1_763_700_000_123);
  });

  it('toma el nombre y el proyecto del inventario antes que de las etiquetas', () => {
    const parsed = lifecycleEventFrom(
      dockerEvent('start', { 'com.docker.compose.project': 'etiqueta' }),
      (id) => (id === 'abc123' ? { name: 'emby-server', project: 'media' } : undefined),
    );
    expect(parsed).toMatchObject({ container: 'emby-server', project: 'media' });
  });

  it('usa la etiqueta de Compose cuando el contenedor aun no esta en el inventario', () => {
    const parsed = lifecycleEventFrom(dockerEvent('start', { 'com.docker.compose.project': 'media' }), NONE);
    expect(parsed?.project).toBe('media');
  });

  it('descarta un evento sin nombre de contenedor', () => {
    expect(lifecycleEventFrom({ Type: 'container', Action: 'start', Actor: { ID: 'x' } }, NONE)).toBeNull();
  });
});

describe('selectEvents', () => {
  it('junta los guardados y los de memoria sin repetir los que estan en los dos sitios', () => {
    const shared = event(2000, 'emby');
    const { events } = selectEvents({
      stored: [event(1000, 'mongo'), shared],
      memory: [shared, event(3000, 'immich')],
      from: 0,
      containers: [],
    });
    expect(events.map((e) => e.container)).toEqual(['mongo', 'emby', 'immich']);
  });

  it('deja fuera lo anterior al rango', () => {
    expect(selectEvents({ stored: [event(500, 'a'), event(1500, 'b')], memory: [], from: 1000, containers: [] }).events).toEqual([
      event(1500, 'b'),
    ]);
  });

  it('filtra por los contenedores elegidos y, si no hay, por el proyecto', () => {
    const all = [event(1, 'emby', 'media'), event(2, 'jellyfin', 'media'), event(3, 'mongo', 'db')];
    expect(selectEvents({ stored: all, memory: [], from: 0, containers: ['mongo'] }).events.map((e) => e.container)).toEqual([
      'mongo',
    ]);
    expect(
      selectEvents({ stored: all, memory: [], from: 0, containers: [], project: 'media' }).events.map((e) => e.container),
    ).toEqual(['emby', 'jellyfin']);
  });

  it('se queda con los mas recientes y avisa cuando un contenedor en bucle llena el tope', () => {
    const loop = Array.from({ length: 10 }, (_, i) => event(i, 'crashy'));
    const result = selectEvents({ stored: loop, memory: [], from: 0, containers: [], limit: 3 });
    expect(result.events.map((e) => e.at)).toEqual([7, 8, 9]);
    expect(result.truncated).toBe(true);
  });
});
