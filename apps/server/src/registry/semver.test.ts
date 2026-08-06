import { describe, expect, it } from 'vitest';
import { defaultTrackMode, findUpgradeCandidate, parseTag, sameFlavour } from './semver.js';

describe('parseTag', () => {
  it('separa prefijo, version y sufijo', () => {
    expect(parseTag('v2.53.0')).toMatchObject({ prefix: 'v', version: '2.53.0', suffix: '' });
    expect(parseTag('17-alpine')).toMatchObject({ prefix: '', version: '17', suffix: '-alpine' });
    expect(parseTag('7.4.0-v0')).toMatchObject({ version: '7.4.0', suffix: '-v0' });
  });

  it('registra la precision de la version', () => {
    expect(parseTag('17')?.precision).toBe(1);
    expect(parseTag('8.2')?.precision).toBe(2);
    expect(parseTag('11.1.0')?.precision).toBe(3);
  });

  it('ignora las etiquetas rodantes', () => {
    for (const tag of ['latest', 'stable', 'edge', 'main', 'nightly']) {
      expect(parseTag(tag)).toBeNull();
    }
  });

  it('ignora lo que no empieza por un numero de version', () => {
    expect(parseTag('buildx-stable-1')).toBeNull();
    expect(parseTag('bookworm-slim')).toBeNull();
  });
});

describe('sameFlavour', () => {
  it('separa sabores distintos con el mismo numero', () => {
    const alpine = parseTag('17-alpine')!;
    const bookworm = parseTag('17-bookworm')!;
    const plain = parseTag('17')!;

    expect(sameFlavour(alpine, bookworm)).toBe(false);
    expect(sameFlavour(alpine, plain)).toBe(false);
    expect(sameFlavour(alpine, parseTag('18-alpine')!)).toBe(true);
  });

  it('separa por precision', () => {
    // `8.2` y `8.2.1` conviven en Hub y significan cosas distintas: una es
    // movil dentro de la minor, la otra esta fijada al parche.
    expect(sameFlavour(parseTag('8.2')!, parseTag('8.2.1')!)).toBe(false);
  });
});

describe('findUpgradeCandidate', () => {
  const postgres = ['15', '16', '17', '18', '17-alpine', '18-alpine', '17-bookworm', 'latest'];

  it('solo propone etiquetas del mismo sabor', () => {
    // Desde 17-alpine el unico salto valido es 18-alpine. Proponer `18` seria
    // cambiar de imagen base sin avisar.
    expect(findUpgradeCandidate('17-alpine', postgres, 'major')).toMatchObject({
      tag: '18-alpine',
    });
  });

  it('conserva el prefijo v del tag original', () => {
    const tags = ['v2.53.0', 'v2.54.0', 'v2.55.1', 'latest'];
    expect(findUpgradeCandidate('v2.53.0', tags, 'minor')?.tag).toBe('v2.55.1');
  });

  it('respeta el canal configurado', () => {
    const tags = ['1.2.3', '1.2.4', '1.3.0', '2.0.0'];
    expect(findUpgradeCandidate('1.2.3', tags, 'patch')?.tag).toBe('1.2.4');
    expect(findUpgradeCandidate('1.2.3', tags, 'minor')?.tag).toBe('1.3.0');
    expect(findUpgradeCandidate('1.2.3', tags, 'major')?.tag).toBe('2.0.0');
  });

  it('nunca propone versiones preliminares', () => {
    const tags = ['1.2.3', '1.3.0-rc.1', '1.3.0-beta'];
    expect(findUpgradeCandidate('1.2.3', tags, 'major')).toBeNull();
  });

  it('devuelve null cuando ya es la mas alta', () => {
    expect(findUpgradeCandidate('18-alpine', postgres, 'major')).toBeNull();
  });

  it('no propone nada para una etiqueta rodante', () => {
    expect(findUpgradeCandidate('latest', postgres, 'major')).toBeNull();
  });

  it('elige la mas alta aunque los tags lleguen desordenados', () => {
    // GHCR devuelve los tags en orden de publicacion, no ordenados.
    const unordered = ['0.0.1', '0.13.0', '0.2.0', '0.9.0'];
    expect(findUpgradeCandidate('0.0.1', unordered, 'minor')?.tag).toBe('0.13.0');
  });
});

describe('defaultTrackMode', () => {
  it('usa digest para etiquetas rodantes', () => {
    expect(defaultTrackMode('latest')).toBe('digest');
    expect(defaultTrackMode('bookworm-slim')).toBe('digest');
  });

  it('usa semver para versiones completas', () => {
    expect(defaultTrackMode('11.1.0')).toBe('semver');
  });

  it('usa ambos para versiones parciales, que son ancla y movil a la vez', () => {
    expect(defaultTrackMode('8.2')).toBe('both');
    expect(defaultTrackMode('17-alpine')).toBe('both');
  });
});
