import { describe, expect, it } from 'vitest';
import { especificidad, pareceVersion } from './version.js';

/**
 * La parte que decide QUE etiqueta se enseña como version instalada.
 *
 * El resto (hablar con el registry) se probo en vivo contra Docker Hub y GHCR
 * con imagenes reales; aqui va lo que se puede fijar sin red y lo que de verdad
 * puede romperse en silencio si alguien lo toca.
 */
describe('que etiquetas nombran una version', () => {
  it('las rodantes no dicen nada', () => {
    // Contestar que tu `latest` es `latest` no informa de nada.
    for (const tag of ['latest', 'stable', 'main', 'master', 'edge', 'nightly', 'dev']) {
      expect(pareceVersion(tag), tag).toBe(false);
    }
  });

  it('mayusculas incluidas', () => {
    expect(pareceVersion('LATEST')).toBe(false);
  });

  it('las que llevan numeros si', () => {
    for (const tag of ['1.2.3', 'v3.7.2', '17-alpine', '8.2', '7.4.10-alpine3.21', '11.1.0']) {
      expect(pareceVersion(tag), tag).toBe(true);
    }
  });

  it('una etiqueta sin numeros tampoco vale', () => {
    // `alpine` o `bookworm` nombran la base, no la version del programa.
    expect(pareceVersion('alpine')).toBe(false);
    expect(pareceVersion('bookworm')).toBe(false);
  });
});

describe('cual de varias es la mas concreta', () => {
  it('gana la que tiene mas numeros', () => {
    // Entre v3, v3.7 y v3.7.2 interesa la ultima: es la que responde de verdad
    // a "que tengo instalado".
    expect(especificidad('v3.7.2')).toBeGreaterThan(especificidad('v3.7'));
    expect(especificidad('v3.7')).toBeGreaterThan(especificidad('v3'));
  });

  it('a igualdad de numeros, la mas larga', () => {
    expect(especificidad('7.4.10-alpine3.21')).toBeGreaterThan(especificidad('7.4.10'));
  });
});

describe('etiquetas de arquitectura', () => {
  it('no cuentan como version aunque lleven numeros', () => {
    // Comprobado en real: `redis/redis-stack:7.4.0-v0` resolvia a
    // `7.4.0-v0-x86_64`. Es cierto que apunta al mismo digest, pero nombra la
    // maquina, no la version, y encima gana por puntuacion (86 y 64 son
    // numeros). Enseñarlo confunde mas que el nombre original.
    for (const tag of ['7.4.0-v0-x86_64', '1.2.3-amd64', '2.0-arm64', 'v1-aarch64', '3.1-armv7l']) {
      expect(pareceVersion(tag), tag).toBe(false);
    }
  });

  it('pero no se lleva por delante versiones legitimas parecidas', () => {
    for (const tag of ['1.386.0', '8.64.2', 'v2.64', '3.86.1-alpine']) {
      expect(pareceVersion(tag), tag).toBe(true);
    }
  });
});
