import { describe, expect, it } from 'vitest';
import { compareDigests, isIndexMediaType, pickPlatformChild } from './manifest.js';
import { parseChallenge, parseRetryAfter } from './auth.js';

describe('parseChallenge', () => {
  it('lee el realm de la cabecera y no lo da por supuesto', () => {
    // Caso verificado con lscr.io: el registry al que pides la imagen y el que
    // emite el token son hosts distintos. Hardcodear el endpoint de token
    // rompe linuxserver.io, que es de lo mas comun en un NAS.
    const challenge = parseChallenge(
      'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:linuxserver/sonarr:pull"',
    );
    expect(challenge).toMatchObject({
      scheme: 'bearer',
      realm: 'https://ghcr.io/token',
      service: 'ghcr.io',
      scope: 'repository:linuxserver/sonarr:pull',
    });
  });

  it('acepta valores sin comillas y en cualquier orden', () => {
    expect(parseChallenge('Bearer service=registry.docker.io,realm=https://auth.docker.io/token'))
      .toMatchObject({ realm: 'https://auth.docker.io/token', service: 'registry.docker.io' });
  });

  it('reconoce el esquema Basic de los registries con htpasswd', () => {
    expect(parseChallenge('Basic realm="Registry"')?.scheme).toBe('basic');
  });

  it('devuelve null sin cabecera, que es el caso de quay.io publico', () => {
    expect(parseChallenge(null)).toBeNull();
    expect(parseChallenge('Negotiate')).toBeNull();
  });
});

describe('parseRetryAfter', () => {
  it('acepta segundos', () => {
    expect(parseRetryAfter('120')).toBe(120);
  });

  it('acota valores absurdos para no quedarse parado una eternidad', () => {
    expect(parseRetryAfter('999999')).toBe(3600);
    expect(parseRetryAfter('-5')).toBe(1);
  });

  it('usa un valor razonable si falta la cabecera', () => {
    expect(parseRetryAfter(null)).toBe(60);
  });
});

describe('compareDigests', () => {
  const remote = (digest: string, mediaType = 'application/vnd.oci.image.index.v1+json') => ({
    digest,
    mediaType,
    status: 200,
    rateLimit: { remaining: null, total: null },
  });

  it('da por actualizado si el digest del indice esta entre los locales', () => {
    const result = compareDigests(['sha256:aaa', 'sha256:bbb'], remote('sha256:bbb'));
    expect(result.upToDate).toBe(true);
    expect(result.needsIndexLookup).toBe(false);
  });

  it('pide mirar dentro del indice cuando no coincide de entrada', () => {
    // El digest local puede ser el del manifest de la arquitectura en vez del
    // indice: antes de declarar novedad hay que comprobarlo.
    const result = compareDigests(['sha256:aaa'], remote('sha256:zzz'));
    expect(result.upToDate).toBe(false);
    expect(result.needsIndexLookup).toBe(true);
  });

  it('no pide mirar el indice si el manifest no es un indice', () => {
    const result = compareDigests(
      ['sha256:aaa'],
      remote('sha256:zzz', 'application/vnd.docker.distribution.manifest.v2+json'),
    );
    expect(result.needsIndexLookup).toBe(false);
  });

  it('no da nada por actualizado sin digest remoto', () => {
    const result = compareDigests(['sha256:aaa'], {
      digest: null,
      mediaType: null,
      status: 404,
      rateLimit: { remaining: null, total: null },
    });
    expect(result.upToDate).toBe(false);
  });
});

describe('isIndexMediaType', () => {
  it('reconoce indices OCI y listas de manifests de Docker', () => {
    expect(isIndexMediaType('application/vnd.oci.image.index.v1+json')).toBe(true);
    expect(isIndexMediaType('application/vnd.docker.distribution.manifest.list.v2+json')).toBe(true);
  });

  it('no confunde un manifest suelto con un indice', () => {
    expect(isIndexMediaType('application/vnd.docker.distribution.manifest.v2+json')).toBe(false);
    expect(isIndexMediaType(null)).toBe(false);
  });
});

describe('pickPlatformChild', () => {
  const children = [
    { digest: 'sha256:amd', mediaType: 'm', platform: { architecture: 'amd64', os: 'linux' } },
    {
      digest: 'sha256:arm',
      mediaType: 'm',
      platform: { architecture: 'arm64', os: 'linux', variant: 'v8' },
    },
    // Las atestaciones vienen con plataforma "unknown" y no son imagenes.
    { digest: 'sha256:att', mediaType: 'm', platform: { architecture: 'unknown', os: 'unknown' } },
  ];

  it('elige el manifest de la arquitectura local', () => {
    expect(
      pickPlatformChild(children, { architecture: 'arm64', os: 'linux', variant: 'v8' })?.digest,
    ).toBe('sha256:arm');
    expect(
      pickPlatformChild(children, { architecture: 'amd64', os: 'linux', variant: null })?.digest,
    ).toBe('sha256:amd');
  });

  it('nunca elige una entrada de atestacion', () => {
    const result = pickPlatformChild(children, {
      architecture: 'unknown',
      os: 'unknown',
      variant: null,
    });
    expect(result).toBeNull();
  });

  it('cae a amd64/linux cuando la plataforma local es desconocida', () => {
    expect(
      pickPlatformChild(children, { architecture: null, os: null, variant: null })?.digest,
    ).toBe('sha256:amd');
  });

  it('devuelve null si no hay ninguna coincidencia', () => {
    expect(
      pickPlatformChild(children, { architecture: 'riscv64', os: 'linux', variant: null }),
    ).toBeNull();
  });
});
