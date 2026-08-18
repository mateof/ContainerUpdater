import type { ReleaseInfo } from './types.js';

/**
 * Construccion del enlace a "que cambia en esta version".
 *
 * Vive en `shared` y no en el servidor porque es logica pura sobre datos que ya
 * viajan al cliente, y porque asi el bot de Telegram y la web construyen
 * exactamente el mismo enlace en vez de dos parecidos.
 */

export interface ReleaseInput {
  sourceUrl: string | null;
  localRevision: string | null;
  remoteRevision: string | null;
  remoteVersion: string | null;
  publishedAt: number | null;
}

/**
 * Normaliza `org.opencontainers.image.source` a una URL de navegador.
 *
 * La etiqueta no siempre trae una URL limpia: se publican formas como
 * `git@github.com:usuario/repo.git`, `https://github.com/usuario/repo.git` y
 * `github.com/usuario/repo`. Sin normalizar, el enlace lleva a una pagina de
 * error o directamente no abre.
 *
 * Devuelve null ante cualquier cosa que no sea http(s) tras normalizar, para no
 * generar un enlace a un esquema raro desde una etiqueta que controla el autor
 * de la imagen y no el usuario.
 */
export function normalizeSourceUrl(raw: string | null): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value) return null;

  // Forma SSH de git: git@host:usuario/repo.git
  const ssh = /^git@([^:]+):(.+)$/.exec(value);
  if (ssh) value = `https://${ssh[1]}/${ssh[2]}`;

  value = value.replace(/^git\+/, '');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  value = value.replace(/\.git$/, '').replace(/\/+$/, '');

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Alojamientos cuya sintaxis de comparacion conocemos y hemos comprobado. */
const COMPARE_HOSTS = new Set(['github.com', 'gitlab.com', 'codeberg.org']);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Une todo en el enlace que se le ofrece al usuario.
 *
 * El orden de preferencia es deliberado y va de mas concreto a mas generico:
 * comparar los dos commits exactos es lo unico que responde de verdad a "que
 * cambia"; la pagina de la release concreta es la segunda mejor cosa; y el
 * listado de releases es el ultimo recurso, que al menos deja al usuario a un
 * clic de la respuesta en vez de a una busqueda.
 */
export function buildReleaseInfo(input: ReleaseInput): ReleaseInfo | null {
  const sourceUrl = normalizeSourceUrl(input.sourceUrl);
  const { localRevision, remoteRevision, remoteVersion, publishedAt } = input;

  // Sin origen no hay enlaces posibles, pero la fecha por si sola ya vale: es
  // lo que explica por que una imagen esta en cuarentena.
  if (!sourceUrl) {
    if (publishedAt === null) return null;
    return {
      sourceUrl: null,
      localRevision,
      remoteRevision,
      remoteVersion,
      publishedAt,
      compareUrl: null,
      releasesUrl: null,
    };
  }

  const host = hostOf(sourceUrl);
  const comparable = host !== null && COMPARE_HOSTS.has(host);

  // Comparar un commit consigo mismo no dice nada, asi que se descarta.
  const differentRevisions =
    Boolean(localRevision) && Boolean(remoteRevision) && localRevision !== remoteRevision;

  const compareUrl =
    comparable && differentRevisions
      ? `${sourceUrl}/compare/${localRevision}...${remoteRevision}`
      : null;

  const releasesUrl = comparable
    ? remoteVersion
      ? `${sourceUrl}/releases/tag/${encodeURIComponent(remoteVersion)}`
      : `${sourceUrl}/releases`
    : sourceUrl;

  return {
    sourceUrl,
    localRevision,
    remoteRevision,
    remoteVersion,
    publishedAt,
    compareUrl,
    releasesUrl,
  };
}
