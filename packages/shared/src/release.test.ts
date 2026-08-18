import { describe, expect, it } from 'vitest';
import { buildReleaseInfo, normalizeSourceUrl } from './release.js';

describe('normalizacion del origen', () => {
  it('acepta las formas en que se publica de verdad la etiqueta', () => {
    // Todas estas aparecen en imagenes reales. Sin normalizar, el enlace lleva
    // a un 404 o directamente no abre.
    const expected = 'https://github.com/usuario/repo';
    for (const raw of [
      'https://github.com/usuario/repo',
      'https://github.com/usuario/repo.git',
      'https://github.com/usuario/repo/',
      'github.com/usuario/repo',
      'git@github.com:usuario/repo.git',
      'git+https://github.com/usuario/repo.git',
      '  https://github.com/usuario/repo  ',
    ]) {
      expect(normalizeSourceUrl(raw), raw).toBe(expected);
    }
  });

  it('rechaza lo que no sea http(s)', () => {
    // La etiqueta la controla quien publica la imagen, no el usuario: no se
    // convierte en un enlace cualquier esquema que venga.
    expect(normalizeSourceUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeSourceUrl('')).toBeNull();
    expect(normalizeSourceUrl(null)).toBeNull();
  });
});

describe('enlace de que cambia', () => {
  const base = {
    sourceUrl: 'https://github.com/usuario/repo',
    localRevision: 'aaaaaaa',
    remoteRevision: 'bbbbbbb',
    remoteVersion: 'v2.0.0',
    publishedAt: 1_700_000_000_000,
  };

  it('compara los dos commits cuando se conocen ambos', () => {
    expect(buildReleaseInfo(base)?.compareUrl).toBe(
      'https://github.com/usuario/repo/compare/aaaaaaa...bbbbbbb',
    );
  });

  it('no compara un commit consigo mismo', () => {
    // Pasa de verdad: una imagen reconstruida con dependencias nuevas cambia de
    // digest sin cambiar de commit. Un enlace a un diff vacio no informa.
    const info = buildReleaseInfo({ ...base, remoteRevision: 'aaaaaaa' });
    expect(info?.compareUrl).toBeNull();
    expect(info?.releasesUrl).toBe('https://github.com/usuario/repo/releases/tag/v2.0.0');
  });

  it('cae al listado de releases sin revisiones', () => {
    const info = buildReleaseInfo({ ...base, localRevision: null, remoteVersion: null });
    expect(info?.compareUrl).toBeNull();
    expect(info?.releasesUrl).toBe('https://github.com/usuario/repo/releases');
  });

  it('en un alojamiento desconocido enlaza al origen y no inventa sintaxis', () => {
    const info = buildReleaseInfo({ ...base, sourceUrl: 'https://ejemplo.org/codigo' });
    expect(info?.compareUrl).toBeNull();
    expect(info?.releasesUrl).toBe('https://ejemplo.org/codigo');
  });

  it('sin origen pero con fecha sigue valiendo, porque explica la cuarentena', () => {
    const info = buildReleaseInfo({ ...base, sourceUrl: null });
    expect(info).not.toBeNull();
    expect(info?.publishedAt).toBe(base.publishedAt);
    expect(info?.releasesUrl).toBeNull();
  });

  it('sin origen y sin fecha no hay nada que contar', () => {
    expect(buildReleaseInfo({ ...base, sourceUrl: null, publishedAt: null })).toBeNull();
  });
});
