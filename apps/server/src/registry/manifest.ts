/**
 * Consulta de manifests y comparacion de digests.
 *
 * El camino caliente es un unico `HEAD` por imagen. Verificado contra Docker
 * Hub: los HEAD de manifest no decrementan el contador de rate limit, asi que
 * comprobar veinte imagenes cada seis horas no gasta cuota. Bajar el cuerpo del
 * manifest si la consume, y por eso solo se hace cuando el HEAD no resuelve.
 */
import {
  NeedsCredentialsError,
  RegistryRateLimitedError,
  TokenCache,
  basicAuthHeader,
  parseChallenge,
  parseRetryAfter,
  requestToken,
} from './auth.js';
import type { ImageReference } from './reference.js';
import type { RegistryCredentials } from '../db/repositories/index.js';

/**
 * El orden importa: el indice OCI va primero porque es lo que sirve hoy Docker
 * Hub incluso para imagenes clasicas, y es el tipo cuyo digest coincide con el
 * `RepoDigests` local.
 */
const ACCEPT_MANIFEST = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

export interface ManifestHead {
  digest: string | null;
  mediaType: string | null;
  status: number;
  rateLimit: { remaining: number | null; total: number | null };
}

export interface ManifestIndexChild {
  digest: string;
  mediaType: string;
  platform?: { architecture?: string; os?: string; variant?: string };
}

export interface Platform {
  architecture: string | null;
  os: string | null;
  variant: string | null;
}

/**
 * Lo que se puede averiguar de una version publicada sin descargarla.
 *
 * Todo es opcional a proposito: cada registry publica lo que quiere y muchas
 * imagenes no llevan etiquetas OCI. Un campo a null significa "no se ha podido
 * averiguar", y quien lo consuma debe seguir funcionando igual.
 */
export interface RemoteRelease {
  /** Fecha de publicacion, o null si no es fiable. Ver `plausibleDate`. */
  createdAt: number | null;
  sourceUrl: string | null;
  revision: string | null;
  version: string | null;
}

/**
 * Etiquetas OCI estandar de las que sale la informacion de version.
 *
 * `revision` es el commit exacto, que es lo que permite construir una
 * comparacion entre la version que tienes y la publicada.
 */
export const OCI_SOURCE = 'org.opencontainers.image.source';
export const OCI_REVISION = 'org.opencontainers.image.revision';
export const OCI_VERSION = 'org.opencontainers.image.version';
export const OCI_CREATED = 'org.opencontainers.image.created';

export class RegistryClient {
  readonly #tokens = new TokenCache();

  /**
   * Cabeceras autenticadas para un repositorio, resolviendo el challenge.
   *
   * Se hace una peticion "a ciegas" primero: si el registry es publico y no
   * emite challenge (caso de quay.io, verificado), nos ahorramos por completo
   * el viaje al servidor de tokens.
   */
  async #authorizedHeaders(
    ref: ImageReference,
    credentials: RegistryCredentials | null,
    challenge: ReturnType<typeof parseChallenge>,
  ): Promise<Record<string, string>> {
    if (!challenge) return {};

    if (challenge.scheme === 'basic') {
      if (!credentials) throw new NeedsCredentialsError(ref.host);
      return { Authorization: basicAuthHeader(credentials) };
    }

    const scope = challenge.scope ?? `repository:${ref.repository}:pull`;
    const token = await this.#tokens.get(ref.host, ref.repository, scope, () =>
      requestToken(challenge, ref.repository, credentials, ref.host),
    );
    return { Authorization: `Bearer ${token}` };
  }

  async headManifest(
    ref: ImageReference,
    credentials: RegistryCredentials | null,
  ): Promise<ManifestHead> {
    const url = `https://${ref.host}/v2/${ref.repository}/manifests/${encodeURIComponent(ref.tag)}`;
    const baseHeaders = { Accept: ACCEPT_MANIFEST };

    let response = await fetch(url, {
      method: 'HEAD',
      headers: baseHeaders,
      signal: AbortSignal.timeout(20_000),
    });

    if (response.status === 401) {
      const challenge = parseChallenge(response.headers.get('www-authenticate'));
      const auth = await this.#authorizedHeaders(ref, credentials, challenge);
      response = await fetch(url, {
        method: 'HEAD',
        headers: { ...baseHeaders, ...auth },
        signal: AbortSignal.timeout(20_000),
      });
    }

    const rateLimit = readRateLimit(response.headers);

    if (response.status === 429) {
      throw new RegistryRateLimitedError(
        ref.host,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new NeedsCredentialsError(ref.host);
    }
    if (!response.ok) {
      return { digest: null, mediaType: null, status: response.status, rateLimit };
    }

    return {
      digest: response.headers.get('docker-content-digest'),
      mediaType: response.headers.get('content-type'),
      status: response.status,
      rateLimit,
    };
  }

  /**
   * Descarga el cuerpo del indice para localizar el manifest de una plataforma
   * concreta. Solo se llama cuando el digest del indice no coincide con ninguno
   * de los locales, que es el caso minoritario.
   */
  async fetchIndexChildren(
    ref: ImageReference,
    credentials: RegistryCredentials | null,
  ): Promise<ManifestIndexChild[]> {
    const url = `https://${ref.host}/v2/${ref.repository}/manifests/${encodeURIComponent(ref.tag)}`;
    const baseHeaders = { Accept: ACCEPT_MANIFEST };

    let response = await fetch(url, { headers: baseHeaders, signal: AbortSignal.timeout(30_000) });
    if (response.status === 401) {
      const challenge = parseChallenge(response.headers.get('www-authenticate'));
      const auth = await this.#authorizedHeaders(ref, credentials, challenge);
      response = await fetch(url, {
        headers: { ...baseHeaders, ...auth },
        signal: AbortSignal.timeout(30_000),
      });
    }
    if (!response.ok) return [];

    const body = (await response.json()) as {
      manifests?: ManifestIndexChild[];
      mediaType?: string;
    };
    return body.manifests ?? [];
  }

  async listTags(
    ref: ImageReference,
    credentials: RegistryCredentials | null,
    maxPages = 10,
  ): Promise<string[]> {
    // Atajo para Docker Hub: su API propia ordena por fecha de publicacion.
    // La del registry devuelve orden lexicografico, asi que la primera pagina
    // de `postgres` son los tags de la version 10 y no sirven de nada.
    if (ref.host === 'registry-1.docker.io') {
      const fromHub = await this.#listTagsFromDockerHub(ref);
      if (fromHub.length > 0) return fromHub;
    }

    const tags: string[] = [];
    let url: string | null =
      `https://${ref.host}/v2/${ref.repository}/tags/list?n=100`;
    let auth: Record<string, string> = {};

    for (let page = 0; page < maxPages && url; page += 1) {
      let response: Response = await fetch(url, {
        headers: { Accept: 'application/json', ...auth },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 401) {
        const challenge = parseChallenge(response.headers.get('www-authenticate'));
        auth = await this.#authorizedHeaders(ref, credentials, challenge);
        response = await fetch(url, {
          headers: { Accept: 'application/json', ...auth },
          signal: AbortSignal.timeout(30_000),
        });
      }
      if (!response.ok) break;

      const body = (await response.json()) as { tags?: string[] | null };
      if (body.tags) tags.push(...body.tags);

      url = nextLink(response.headers.get('link'), ref.host);
    }

    return tags;
  }

  /**
   * API publica de Docker Hub, distinta de la del registry. No consume el rate
   * limit de pulls y permite ordenar por fecha, que es justo lo que hace falta.
   */
  async #listTagsFromDockerHub(ref: ImageReference): Promise<string[]> {
    try {
      const url = `https://hub.docker.com/v2/repositories/${ref.repository}/tags?page_size=100&ordering=last_updated`;
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return [];
      const body = (await response.json()) as { results?: Array<{ name?: string }> };
      return (body.results ?? []).map((r) => r.name).filter((n): n is string => Boolean(n));
    } catch {
      // Si la API de Hub no responde se cae al listado estandar del registry.
      return [];
    }
  }

  /**
   * Averigua si el repositorio existe siquiera.
   *
   * Hace falta porque Docker Hub responde 401 tanto para un repositorio
   * privado como para uno inexistente: lo hace a proposito, para no filtrar
   * que repositorios privados existen. Sin esta comprobacion, una imagen
   * construida en local (`docker compose build` genera nombres como
   * `miproyecto-miservicio`) se consulta eternamente contra Hub y el usuario ve
   * un "requiere autenticacion" que no tiene ningun sentido.
   *
   * Devuelve null cuando no se puede determinar, que es distinto de false.
   */
  async repositoryExists(ref: ImageReference): Promise<boolean | null> {
    // La API publica de Hub si distingue: 404 significa que no existe.
    if (ref.host === 'registry-1.docker.io') {
      try {
        const response = await fetch(`https://hub.docker.com/v2/repositories/${ref.repository}/`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 404) return false;
        if (response.ok) return true;
        return null;
      } catch {
        return null;
      }
    }

    // En el resto de registries, un 404 en el manifest ya es concluyente y
    // habria llegado como tal en vez de como 401.
    return null;
  }

  /**
   * Fecha de publicacion y etiquetas de origen de la version remota.
   *
   * Cuesta hasta tres peticiones (indice, manifest de la plataforma y blob de
   * configuracion), asi que NO va en el camino caliente: solo se llama cuando
   * la comprobacion ya ha encontrado una novedad, que es lo raro.
   *
   * Nunca lanza. Todo esto es informacion adicional: que un registry no
   * publique etiquetas OCI no puede convertir una comprobacion correcta en un
   * error.
   */
  async fetchRelease(
    ref: ImageReference,
    credentials: RegistryCredentials | null,
    platform: Platform,
  ): Promise<RemoteRelease> {
    const empty: RemoteRelease = {
      createdAt: null,
      sourceUrl: null,
      revision: null,
      version: null,
    };

    try {
      // Docker Hub publica la fecha en su API propia, y es la fiable: la del
      // blob de configuracion la fijan las builds reproducibles a una constante.
      const hubDate =
        ref.host === 'registry-1.docker.io' ? await this.#hubTagDate(ref) : null;

      const manifest = await this.#fetchManifestJson(ref, credentials, ref.tag);
      if (!manifest) return { ...empty, createdAt: hubDate };

      // Anotaciones del indice: algunas imagenes las traen aqui y ahorran bajar
      // el blob de configuracion entero.
      const annotations = manifest.annotations ?? {};

      let config = manifest.config;
      if (!config && Array.isArray(manifest.manifests)) {
        // Es un indice: hay que bajar el manifest de nuestra plataforma.
        const child = pickPlatformChild(manifest.manifests, platform);
        if (!child) {
          return {
            createdAt: hubDate ?? plausibleDate(annotations[OCI_CREATED]),
            sourceUrl: annotations[OCI_SOURCE] ?? null,
            revision: annotations[OCI_REVISION] ?? null,
            version: annotations[OCI_VERSION] ?? null,
          };
        }
        const childManifest = await this.#fetchManifestJson(ref, credentials, child.digest);
        config = childManifest?.config;
        Object.assign(annotations, childManifest?.annotations ?? {});
      }

      if (!config?.digest) {
        return {
          createdAt: hubDate ?? plausibleDate(annotations[OCI_CREATED]),
          sourceUrl: annotations[OCI_SOURCE] ?? null,
          revision: annotations[OCI_REVISION] ?? null,
          version: annotations[OCI_VERSION] ?? null,
        };
      }

      const blob = await this.#fetchConfigBlob(ref, credentials, config.digest);
      const labels = { ...annotations, ...(blob?.config?.Labels ?? {}) };

      return {
        createdAt: hubDate ?? plausibleDate(blob?.created ?? annotations[OCI_CREATED]),
        sourceUrl: labels[OCI_SOURCE] ?? null,
        revision: labels[OCI_REVISION] ?? null,
        version: labels[OCI_VERSION] ?? null,
      };
    } catch {
      return empty;
    }
  }

  /** Fecha del tag segun la API publica de Hub, que no gasta cuota de pulls. */
  async #hubTagDate(ref: ImageReference): Promise<number | null> {
    try {
      const url = `https://hub.docker.com/v2/repositories/${ref.repository}/tags/${encodeURIComponent(ref.tag)}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return null;
      const body = (await response.json()) as { last_updated?: string };
      return plausibleDate(body.last_updated);
    } catch {
      return null;
    }
  }

  async #fetchManifestJson(
    ref: ImageReference,
    credentials: RegistryCredentials | null,
    reference: string,
  ): Promise<ManifestJson | null> {
    const url = `https://${ref.host}/v2/${ref.repository}/manifests/${encodeURIComponent(reference)}`;
    const response = await this.#getWithAuth(url, ref, credentials, ACCEPT_MANIFEST);
    if (!response?.ok) return null;
    return (await response.json()) as ManifestJson;
  }

  async #fetchConfigBlob(
    ref: ImageReference,
    credentials: RegistryCredentials | null,
    digest: string,
  ): Promise<ConfigBlob | null> {
    const url = `https://${ref.host}/v2/${ref.repository}/blobs/${encodeURIComponent(digest)}`;
    const response = await this.#getWithAuth(url, ref, credentials, 'application/json, */*');
    if (!response?.ok) return null;
    return (await response.json()) as ConfigBlob;
  }

  /** GET resolviendo el challenge una sola vez, como el resto de metodos. */
  async #getWithAuth(
    url: string,
    ref: ImageReference,
    credentials: RegistryCredentials | null,
    accept: string,
  ): Promise<Response | null> {
    try {
      let response = await fetch(url, {
        headers: { Accept: accept },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 401) {
        const challenge = parseChallenge(response.headers.get('www-authenticate'));
        const auth = await this.#authorizedHeaders(ref, credentials, challenge);
        response = await fetch(url, {
          headers: { Accept: accept, ...auth },
          signal: AbortSignal.timeout(20_000),
        });
      }
      return response;
    } catch {
      return null;
    }
  }

  invalidateHost(host: string): void {
    this.#tokens.invalidate(host);
  }
}

interface ManifestJson {
  manifests?: ManifestIndexChild[];
  config?: { digest?: string };
  annotations?: Record<string, string>;
}

interface ConfigBlob {
  created?: string;
  config?: { Labels?: Record<string, string> | null };
}

/**
 * Convierte una fecha ISO en epoch, descartando las que no significan nada.
 *
 * Existe por un problema real: las builds reproducibles fijan `created` a una
 * constante, casi siempre el epoch de Unix (1970) o el 1 de enero de 1980 que
 * usa SOURCE_DATE_EPOCH en algunas cadenas. Tomarlas por buenas haria que una
 * imagen recien publicada pareciera tener cincuenta anos y la cuarentena la
 * dejara pasar siempre, que es justo lo contrario de lo que se pide.
 *
 * Ante la duda devuelve null, y quien llama decide. La politica de la app es
 * dejar pasar la actualizacion cuando la fecha se desconoce, y decirlo.
 */
export function plausibleDate(value: string | undefined | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  // Antes de 2000 no hay imagenes de contenedor: es una constante de build.
  if (ms < Date.UTC(2000, 0, 1)) return null;
  // Una fecha en el futuro tampoco es de fiar; se admite un dia de margen por
  // relojes desajustados.
  if (ms > Date.now() + 86_400_000) return null;
  return ms;
}

/**
 * Decide si hay actualizacion comparando conjuntos de digests.
 *
 * El detalle que hace falta acertar: `RepoDigests` es una LISTA y puede
 * contener tanto el digest del indice como el del manifest de la arquitectura
 * local. Verificado en vivo: `nginx:alpine` tiene dos entradas. Comparar contra
 * un unico string da falsos "hay actualizacion" cada vez que el digest guardado
 * es el que no toca.
 */
export function compareDigests(
  localDigests: string[],
  remote: ManifestHead,
): { upToDate: boolean; needsIndexLookup: boolean } {
  if (!remote.digest) return { upToDate: false, needsIndexLookup: false };

  const local = new Set(localDigests);
  if (local.has(remote.digest)) return { upToDate: true, needsIndexLookup: false };

  // No coincide con el indice. Puede que el digest local sea el del manifest
  // por arquitectura, asi que merece la pena mirar dentro del indice antes de
  // dar por hecho que hay novedad.
  return { upToDate: false, needsIndexLookup: isIndexMediaType(remote.mediaType) };
}

export function isIndexMediaType(mediaType: string | null): boolean {
  if (!mediaType) return false;
  return (
    mediaType.includes('image.index') || mediaType.includes('manifest.list')
  );
}

/**
 * Elige del indice el manifest que corresponde a la plataforma local. Sin esto
 * compararíamos el digest de arm64 contra el de amd64 y siempre habria
 * "actualizacion".
 */
export function pickPlatformChild(
  children: ManifestIndexChild[],
  platform: Platform,
): ManifestIndexChild | null {
  const arch = platform.architecture ?? 'amd64';
  const os = platform.os ?? 'linux';

  const matches = children.filter(
    (child) =>
      child.platform?.architecture === arch &&
      child.platform?.os === os &&
      // Los indices incluyen entradas de atestacion con plataforma "unknown"
      // que hay que descartar o se elegirian por error.
      child.platform?.architecture !== 'unknown',
  );

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;

  // Con varias coincidencias, la variante desempata: arm64/v8 frente a arm64.
  const exact = matches.find((child) => child.platform?.variant === platform.variant);
  return exact ?? matches[0] ?? null;
}

function readRateLimit(headers: Headers): { remaining: number | null; total: number | null } {
  // Formato de Docker Hub: "100;w=21600". Solo interesa el numero.
  const parse = (value: string | null): number | null => {
    if (!value) return null;
    const n = Number.parseInt(value.split(';')[0] ?? '', 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    remaining: parse(headers.get('ratelimit-remaining')),
    total: parse(headers.get('ratelimit-limit')),
  };
}

/** Paginacion RFC 5988 del registry: `Link: </v2/...>; rel="next"`. */
function nextLink(header: string | null, host: string): string | null {
  if (!header) return null;
  const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(header);
  if (!match?.[1]) return null;
  const target = match[1];
  return target.startsWith('http') ? target : `https://${host}${target}`;
}
