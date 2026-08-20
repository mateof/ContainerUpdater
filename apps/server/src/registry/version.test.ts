import { describe, expect, it } from 'vitest';
import { especificidad, ordenarPorProbabilidad, pareceVersion } from './version.js';

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

describe('orden en que se prueban las candidatas', () => {
  it('de mas nueva a mas vieja', () => {
    // Es la diferencia entre encontrarla y no encontrarla. Fuera de Docker Hub
    // cada etiqueta cuesta una peticion y hay tope, asi que el orden decide
    // cuales se llegan a mirar.
    expect(ordenarPorProbabilidad(['0.1.0', '0.36.0', '0.24.2', '0.2.0'])).toEqual([
      '0.36.0',
      '0.24.2',
      '0.2.0',
      '0.1.0',
    ]);
  });

  it('caso real: 28 versiones y la buena era la ultima del listado', () => {
    // Repositorio real (`ghcr.io/mateof/mock-server`). El registry las devuelve
    // de mas vieja a mas nueva, y la primera version ordenaba por cuantos
    // numeros lleva la etiqueta: casi todas empataban, el desempate lo daba ese
    // orden de llegada, y con tope de peticiones se consultaban justo las mas
    // antiguas. No encontraba nada.
    const delRegistry = [
      '0.0.1', '0.1.0', '0.1.1', '0.2.0', '0.3.0', '0.4.0', '0.4.1', '0.5.0',
      '0.6.0', '0.7.0', '0.8.0', '0.9.0', '0.10.0', '0.11.0', '0.12.0', '0.13.0',
      '0.15.0', '0.16.0', '0.19.0', '0.20.0', '0.21.0', '0.23.0', '0.24.0',
      '0.24.2', '0.24.3', '0.34.0', '0.36.0',
    ];
    expect(ordenarPorProbabilidad(delRegistry)[0]).toBe('0.36.0');
    // Y la instalada entra de sobra dentro del tope de peticiones.
    expect(ordenarPorProbabilidad(delRegistry).slice(0, 20)).toContain('0.36.0');
  });

  it('0.10.0 es mas nueva que 0.9.0, no al reves', () => {
    // Comparacion de versiones y no alfabetica, que es donde se cae solo.
    expect(ordenarPorProbabilidad(['0.9.0', '0.10.0'])[0]).toBe('0.10.0');
  });

  it('lo que no se puede interpretar va al final, pero no se tira', () => {
    // Puede ser una fecha o un hash de commit, y aun asi apuntar al digest.
    const orden = ordenarPorProbabilidad(['sha-abc123', '2.0.0', '1.0.0']);
    expect(orden).toEqual(['2.0.0', '1.0.0', 'sha-abc123']);
  });
});
