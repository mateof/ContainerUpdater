import { describe, expect, it } from 'vitest';
import { describeRelyingParty } from './passkeys.js';

/**
 * Que origenes admiten passkeys.
 *
 * Merece pruebas propias porque la respuesta NO es intuitiva y la impone el
 * navegador: hace falta contexto seguro Y que el identificador de sitio sea un
 * dominio. El acceso tipico a un NAS, por IP y HTTP plano, falla las dos
 * condiciones, y la interfaz tiene que poder decir cual falla para que el
 * usuario sepa que arreglar.
 */
describe('describeRelyingParty', () => {
  it('rechaza HTTP plano por dominio: falta contexto seguro', () => {
    const rp = describeRelyingParty({ host: 'nas.ejemplo.com', proto: 'http' });
    expect(rp.usable).toBe(false);
    expect(rp.reason).toBe('insecure-origin');
  });

  it('rechaza una IP aunque vaya por HTTPS', () => {
    // Este es el caso que sorprende: cifrar no basta, el identificador de sitio
    // tiene que ser un nombre.
    const rp = describeRelyingParty({ host: '192.168.1.50:8099', proto: 'https' });
    expect(rp.usable).toBe(false);
    expect(rp.reason).toBe('ip-address');
  });

  it('rechaza el acceso tipico a un NAS, que falla por las dos', () => {
    const rp = describeRelyingParty({ host: '192.168.1.50:8099', proto: 'http' });
    expect(rp.usable).toBe(false);
  });

  it('acepta un dominio por HTTPS y le quita el puerto al identificador', () => {
    // El puerto forma parte del origen pero NO del identificador de sitio.
    const rp = describeRelyingParty({ host: 'nas.ejemplo.com:8443', proto: 'https' });
    expect(rp.usable).toBe(true);
    expect(rp.id).toBe('nas.ejemplo.com');
    expect(rp.origin).toBe('https://nas.ejemplo.com:8443');
  });

  it('acepta localhost por HTTP, que es la excepcion del navegador', () => {
    const rp = describeRelyingParty({ host: 'localhost:8099', proto: 'http' });
    expect(rp.usable).toBe(true);
    expect(rp.id).toBe('localhost');
  });

  it('acepta 127.0.0.1, que es IP pero tambien es la excepcion', () => {
    expect(describeRelyingParty({ host: '127.0.0.1:8099', proto: 'http' }).usable).toBe(true);
  });

  it('rechaza IPv6', () => {
    const rp = describeRelyingParty({ host: '[fd00::1]:8099', proto: 'https' });
    expect(rp.reason).toBe('ip-address');
  });

  it('lo configurado a mano manda sobre la deteccion', () => {
    // Hace falta cuando el proxy no reenvia las cabeceras y el servidor no puede
    // saber con que nombre lo ve el navegador.
    const rp = describeRelyingParty({
      host: '10.0.0.5',
      proto: 'http',
      configuredId: 'nas.ejemplo.com',
      configuredOrigin: 'https://nas.ejemplo.com',
    });
    expect(rp.usable).toBe(true);
    expect(rp.id).toBe('nas.ejemplo.com');
  });
});
