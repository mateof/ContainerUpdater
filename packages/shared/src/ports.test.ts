import { describe, expect, it } from 'vitest';
import { buildPortLink } from './ports.js';

const desdeElNas = { viewerHost: '192.168.0.22' };

describe('enlace al servicio de un contenedor', () => {
  it('usa la direccion por la que estas viendo el panel', () => {
    // Es la respuesta que no necesita configuracion: si has llegado al panel por
    // esa direccion, esa direccion alcanza esta maquina, y los contenedores
    // corren en ella porque la aplicacion gestiona su daemon local.
    const link = buildPortLink({ ip: '0.0.0.0', privatePort: 80, publicPort: 8096, type: 'tcp' }, desdeElNas);
    expect(link.url).toBe('http://192.168.0.22:8096');
  });

  it('respeta el host configurado a mano', () => {
    // Para cuando el panel se ve por un dominio que pasa por un proxy inverso y
    // ese dominio no publica los puertos de los contenedores.
    const link = buildPortLink(
      { ip: '0.0.0.0', privatePort: 80, publicPort: 8096, type: 'tcp' },
      { viewerHost: 'panel.ejemplo.com', configuredHost: '192.168.0.22' },
    );
    expect(link.url).toBe('http://192.168.0.22:8096');
  });

  it('una publicacion atada a una IP concreta manda sobre todo lo demas', () => {
    // Es la unica direccion por la que ese servicio responde: ni el host
    // configurado ni el del navegador sirven.
    const link = buildPortLink(
      { ip: '10.0.0.5', privatePort: 80, publicPort: 8096, type: 'tcp' },
      { viewerHost: '192.168.0.22', configuredHost: '192.168.0.99' },
    );
    expect(link.url).toBe('http://10.0.0.5:8096');
  });

  it('sin publicar no hay enlace, y se dice por que', () => {
    const link = buildPortLink({ privatePort: 5432, type: 'tcp' }, desdeElNas);
    expect(link.url).toBeNull();
    expect(link.reason).toBe('not-published');
    // El texto sigue siendo util aunque no sea enlace.
    expect(link.label).toBe('5432/tcp');
  });

  it('udp no se abre en un navegador', () => {
    const link = buildPortLink({ ip: '0.0.0.0', privatePort: 53, publicPort: 53, type: 'udp' }, desdeElNas);
    expect(link.url).toBeNull();
    expect(link.reason).toBe('not-browsable');
  });

  describe('publicado solo en el bucle local', () => {
    const soloLocal = { ip: '127.0.0.1', privatePort: 80, publicPort: 9000, type: 'tcp' };

    it('no se enlaza desde otra maquina, porque no responderia', () => {
      const link = buildPortLink(soloLocal, desdeElNas);
      expect(link.url).toBeNull();
      expect(link.reason).toBe('loopback');
    });

    it('pero si estas en el propio anfitrion, si', () => {
      expect(buildPortLink(soloLocal, { viewerHost: 'localhost' }).url).toBe('http://localhost:9000');
      expect(buildPortLink(soloLocal, { viewerHost: '127.0.0.1' }).url).toBe('http://127.0.0.1:9000');
    });
  });

  it('los puertos que suelen hablar TLS van por https', () => {
    for (const puerto of [443, 8443, 9443]) {
      const link = buildPortLink({ ip: '0.0.0.0', privatePort: 443, publicPort: puerto, type: 'tcp' }, desdeElNas);
      expect(link.url, String(puerto)).toBe(`https://192.168.0.22:${puerto}`);
    }
    // Y el resto por http: ofrecer https a un servicio en claro da un error de
    // navegador que no explica nada.
    expect(buildPortLink({ ip: '0.0.0.0', privatePort: 80, publicPort: 8080, type: 'tcp' }, desdeElNas).url).toBe(
      'http://192.168.0.22:8080',
    );
  });

  it('una IPv6 va entre corchetes o la URL no es valida', () => {
    const link = buildPortLink(
      { ip: 'fd00::1', privatePort: 80, publicPort: 8096, type: 'tcp' },
      desdeElNas,
    );
    expect(link.url).toBe('http://[fd00::1]:8096');
  });
});
