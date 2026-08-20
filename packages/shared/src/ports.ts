/**
 * Enlaces a los servicios publicados por un contenedor.
 *
 * Suena a "pon un `<a>` con el puerto" y tiene mas casos de los que parece.
 * Cuatro cosas hay que acertar o el enlace lleva a ninguna parte, que es peor
 * que no ofrecerlo:
 *
 * 1. **Que puerto.** Solo los publicados salen de la maquina. Un puerto interno
 *    no es accesible ni desde el propio anfitrion.
 * 2. **A que maquina.** La respuesta por defecto es la que estas mirando: si
 *    tienes el panel abierto en `192.168.0.22:8210`, los contenedores corren en
 *    esa misma maquina, porque la aplicacion gestiona su daemon local. Asi que
 *    el navegador ya sabe la direccion buena y no hay nada que configurar.
 * 3. **Salvo que la publicacion diga otra cosa.** Docker permite atar un puerto
 *    a una IP concreta, y entonces manda esa y no la del panel.
 * 4. **Con que esquema.** Un enlace `http` a un servicio que solo habla TLS da
 *    un error ilegible.
 */

export interface PortSpec {
  ip?: string;
  privatePort: number;
  publicPort?: number;
  type: string;
}

export type PortLinkReason =
  /** Sin publicar: no sale de la maquina. */
  | 'not-published'
  /** UDP u otro protocolo que un navegador no sabe abrir. */
  | 'not-browsable'
  /** Atado al bucle local: solo accesible desde el propio anfitrion. */
  | 'loopback';

export interface PortLink {
  url: string | null;
  reason: PortLinkReason | null;
  /** Lo que se enseña como texto del enlace. */
  label: string;
}

/** Direcciones que significan "todas las interfaces". */
const TODAS = new Set(['', '0.0.0.0', '::', '[::]', '*']);

/** Direcciones del bucle local. */
const BUCLE = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Puertos que casi siempre hablan TLS.
 *
 * Es una lista corta y conservadora a proposito. Acertar de mas aqui no aporta
 * (el usuario corrige la barra de direcciones en un segundo) y equivocarse hacia
 * abajo tampoco duele, mientras que ofrecer `https` a un servicio que solo habla
 * claro da un error de navegador que no explica nada.
 */
const TLS = new Set([443, 8443, 9443, 4443]);

export interface PortLinkOptions {
  /** Host forzado en ajustes. Vacio o null = usar el del navegador. */
  configuredHost?: string | null;
  /** `window.location.hostname`: la maquina desde la que se ve el panel. */
  viewerHost: string;
}

export function buildPortLink(port: PortSpec, options: PortLinkOptions): PortLink {
  const label = port.publicPort
    ? `${port.publicPort}:${port.privatePort}`
    : `${port.privatePort}/${port.type}`;

  if (!port.publicPort) return { url: null, reason: 'not-published', label };
  if (port.type.toLowerCase() !== 'tcp') return { url: null, reason: 'not-browsable', label };

  const binding = (port.ip ?? '').trim();
  const viewer = options.viewerHost.trim();
  const configured = (options.configuredHost ?? '').trim();

  let host: string;
  if (BUCLE.has(binding)) {
    // Publicado solo en el bucle local. Desde otra maquina no hay forma de
    // llegar, asi que no se ofrece un enlace que fallaria; solo vale si estas
    // mirando el panel desde el propio anfitrion.
    if (!BUCLE.has(viewer)) return { url: null, reason: 'loopback', label };
    host = viewer;
  } else if (TODAS.has(binding)) {
    // Escucha en todas: sirve la direccion por la que has llegado al panel, que
    // por definicion es una que alcanza esta maquina.
    host = configured || viewer;
  } else {
    // Atado a una direccion concreta: manda ella, diga lo que diga el ajuste.
    // Es la unica por la que el servicio responde.
    host = binding;
  }

  if (!host) return { url: null, reason: 'not-published', label };

  const scheme = TLS.has(port.publicPort) ? 'https' : 'http';
  // Las IPv6 van entre corchetes en una URL.
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return { url: `${scheme}://${authority}:${port.publicPort}`, reason: null, label };
}
