import { describe, expect, it } from 'vitest';
import {
  DOCKER_HUB_HOST,
  digestsForRepository,
  displayReference,
  parseImageReference,
} from './reference.js';

describe('parseImageReference', () => {
  it('anade el namespace library implicito solo en Docker Hub', () => {
    expect(parseImageReference('nginx')).toMatchObject({
      host: DOCKER_HUB_HOST,
      repository: 'library/nginx',
      tag: 'latest',
    });

    // En cualquier otro registry, `nginx` es literalmente el repositorio
    // `nginx`, sin `library/` delante.
    expect(parseImageReference('ghcr.io/nginx')).toMatchObject({
      host: 'ghcr.io',
      repository: 'nginx',
    });
  });

  it('no anade library cuando ya hay namespace', () => {
    expect(parseImageReference('grafana/grafana:11.1.0')).toMatchObject({
      host: DOCKER_HUB_HOST,
      repository: 'grafana/grafana',
      tag: '11.1.0',
    });
  });

  it('unifica los alias de Docker Hub en un unico host', () => {
    const forms = ['docker.io/library/nginx', 'index.docker.io/library/nginx', 'nginx'];
    const normalized = forms.map((form) => parseImageReference(form).normalized);
    expect(new Set(normalized).size).toBe(1);
  });

  it('distingue host de namespace por el punto, los dos puntos o localhost', () => {
    expect(parseImageReference('ghcr.io/mateof/app').host).toBe('ghcr.io');
    expect(parseImageReference('localhost:5000/app').host).toBe('localhost:5000');
    // `mateof` no tiene punto ni dos puntos: es un namespace de Hub.
    expect(parseImageReference('mateof/app').host).toBe(DOCKER_HUB_HOST);
  });

  it('no confunde el puerto del host con el separador de tag', () => {
    const ref = parseImageReference('registry.local:5000/team/app:1.2.3');
    expect(ref.host).toBe('registry.local:5000');
    expect(ref.repository).toBe('team/app');
    expect(ref.tag).toBe('1.2.3');
  });

  it('extrae el digest cuando la referencia viene anclada', () => {
    const ref = parseImageReference(
      'nginx@sha256:6be2079f2181018558b14f5bedd074d5520112f74a60a0732a8c4f8042267c0a',
    );
    expect(ref.digest).toBe(
      'sha256:6be2079f2181018558b14f5bedd074d5520112f74a60a0732a8c4f8042267c0a',
    );
  });

  it('rechaza referencias invalidas', () => {
    expect(() => parseImageReference('')).toThrow();
    expect(() => parseImageReference('nginx@sha256:noesundigest')).toThrow();
  });

  it('muestra la forma corta que escribiria una persona', () => {
    expect(displayReference(parseImageReference('nginx:alpine'))).toBe('nginx:alpine');
    expect(displayReference(parseImageReference('ghcr.io/mateof/app:1.0'))).toBe(
      'ghcr.io/mateof/app:1.0',
    );
  });
});

describe('digestsForRepository', () => {
  const ref = parseImageReference('nginx:alpine');

  it('devuelve TODOS los digests del repositorio, no solo el primero', () => {
    // Caso real verificado: Podman guarda dos digests para nginx:alpine, el del
    // indice OCI y el del manifest de la arquitectura local. Quedarse con uno
    // solo produce falsos "hay actualizacion".
    const digests = digestsForRepository(
      [
        'docker.io/library/nginx@sha256:6be2079f2181018558b14f5bedd074d5520112f74a60a0732a8c4f8042267c0a',
        'docker.io/library/nginx@sha256:8b1e78743a03dbb2c95171cc58639fef29abc8816598e27fb910ed2e621e589a',
      ],
      ref,
    );
    expect(digests).toHaveLength(2);
  });

  it('descarta digests de otro repositorio', () => {
    // Una imagen retageada arrastra digests ajenos. Compararlos daria un "al
    // dia" falso frente al repositorio equivocado.
    const digests = digestsForRepository(
      [
        'docker.io/library/nginx@sha256:aaaa000000000000000000000000000000000000000000000000000000000000',
        'docker.io/library/postgres@sha256:bbbb000000000000000000000000000000000000000000000000000000000000',
      ],
      ref,
    );
    expect(digests).toEqual([
      'sha256:aaaa000000000000000000000000000000000000000000000000000000000000',
    ]);
  });

  it('acepta la forma corta y la larga del repositorio', () => {
    expect(
      digestsForRepository(
        ['nginx@sha256:cccc000000000000000000000000000000000000000000000000000000000000'],
        ref,
      ),
    ).toHaveLength(1);
  });

  it('devuelve una lista vacia cuando no hay digests', () => {
    expect(digestsForRepository(null, ref)).toEqual([]);
    expect(digestsForRepository(undefined, ref)).toEqual([]);
  });
});
