import { describe, expect, it } from 'vitest';
import { applyContainerFocus, hasFocus } from './focus.js';
import type { ContainerSummary } from './types.js';

function container(input: Partial<ContainerSummary> & { name: string }): ContainerSummary {
  return {
    id: input.name,
    image: 'docker.io/library/nginx:alpine',
    imageRef: 'registry-1.docker.io/library/nginx:alpine',
    imageId: 'sha256:x',
    state: 'running',
    status: 'Up',
    exitCode: null,
    health: 'none',
    createdAt: 0,
    startedAt: null,
    restartCount: 0,
    ports: [],
    projectKey: null,
    projectName: null,
    serviceName: null,
    isSelf: false,
    ...input,
  };
}

const LIST = [
  container({ name: 'audiobookshelf', projectKey: 'medios /srv/medios' }),
  container({ name: 'metube', projectKey: 'medios /srv/medios' }),
  container({
    name: 'panel',
    projectKey: 'panel /srv/panel',
    imageRef: 'ghcr.io/ejemplo/panel:latest',
  }),
];

describe('applyContainerFocus', () => {
  it('recorta a UN contenedor por su nombre', () => {
    // Es el caso que se perdio sin que nada fallara: salia la lista entera con
    // el aviso de filtrado puesto.
    const result = applyContainerFocus(LIST, { container: 'audiobookshelf' });
    expect(result.map((c) => c.name)).toEqual(['audiobookshelf']);
  });

  it('recorta por imagen usando la referencia normalizada', () => {
    const result = applyContainerFocus(LIST, {
      image: 'registry-1.docker.io/library/nginx:alpine',
    });
    expect(result.map((c) => c.name)).toEqual(['audiobookshelf', 'metube']);
  });

  it('no recorta por la cadena cruda del daemon', () => {
    // Comparar `image` en vez de `imageRef` es el fallo que ya mordio una vez.
    expect(applyContainerFocus(LIST, { image: 'docker.io/library/nginx:alpine' })).toEqual([]);
  });

  it('recorta por proyecto', () => {
    const result = applyContainerFocus(LIST, { project: 'medios /srv/medios' });
    expect(result.map((c) => c.name)).toEqual(['audiobookshelf', 'metube']);
  });

  it('sin foco devuelve la lista entera', () => {
    expect(applyContainerFocus(LIST, {})).toHaveLength(3);
    expect(applyContainerFocus(LIST, { container: null, image: null, project: null })).toHaveLength(3);
  });

  it('el contenedor concreto gana sobre los demas', () => {
    // Puede quedar un filtro viejo en la URL; lo mas concreto es lo que se acaba
    // de pedir.
    const result = applyContainerFocus(LIST, {
      container: 'panel',
      project: 'medios /srv/medios',
    });
    expect(result.map((c) => c.name)).toEqual(['panel']);
  });

  it('un nombre que no existe devuelve vacio, no la lista entera', () => {
    // La diferencia importa: vacio dice "no esta", entero dice "no filtre".
    expect(applyContainerFocus(LIST, { container: 'no-existe' })).toEqual([]);
  });
});

describe('hasFocus', () => {
  it('distingue tener foco de no tenerlo', () => {
    expect(hasFocus({})).toBe(false);
    expect(hasFocus({ container: null })).toBe(false);
    expect(hasFocus({ container: 'algo' })).toBe(true);
    expect(hasFocus({ project: 'algo' })).toBe(true);
  });
});
