/**
 * Normalizacion de referencias de imagen.
 *
 * `nginx:alpine` y `docker.io/library/nginx:alpine` son la misma imagen, pero
 * solo la segunda forma sirve para hablar con la API del registry. Todo el
 * resto del codigo trabaja con la forma normalizada.
 */

export const DOCKER_HUB_HOST = 'registry-1.docker.io';

export interface ImageReference {
  /** Host del registry con el que se habla por HTTPS. */
  host: string;
  /** Ruta del repositorio, con el `library/` implicito de Hub ya resuelto. */
  repository: string;
  tag: string;
  /** Digest explicito si la referencia venia anclada con `@sha256:...`. */
  digest: string | null;
  /** Forma canonica `host/repo:tag`, que se usa como clave primaria. */
  normalized: string;
  /** Como lo escribio el usuario, para mostrarlo tal cual en la interfaz. */
  original: string;
}

export class InvalidReferenceError extends Error {
  constructor(ref: string) {
    super(`Referencia de imagen no valida: ${ref}`);
    this.name = 'InvalidReferenceError';
  }
}

/**
 * Un componente es un host y no parte del repositorio si lleva un punto (un
 * dominio), dos puntos (un puerto) o es exactamente `localhost`. Es la misma
 * heuristica que usa el propio Docker, y es la razon por la que `mateof/app`
 * va a Hub mientras que `ghcr.io/mateof/app` no.
 */
function looksLikeHost(component: string): boolean {
  return component.includes('.') || component.includes(':') || component === 'localhost';
}

export function parseImageReference(input: string): ImageReference {
  const original = input.trim();
  if (!original) throw new InvalidReferenceError(input);

  let rest = original;
  let digest: string | null = null;

  const atIndex = rest.lastIndexOf('@');
  if (atIndex > 0) {
    digest = rest.slice(atIndex + 1);
    rest = rest.slice(0, atIndex);
    if (!/^[a-z0-9]+:[a-f0-9]{32,}$/i.test(digest)) throw new InvalidReferenceError(input);
  }

  let host: string;
  let remainder: string;
  const slashIndex = rest.indexOf('/');

  if (slashIndex > 0 && looksLikeHost(rest.slice(0, slashIndex))) {
    host = rest.slice(0, slashIndex);
    remainder = rest.slice(slashIndex + 1);
  } else {
    host = DOCKER_HUB_HOST;
    remainder = rest;
  }

  // Los tres nombres de Docker Hub apuntan al mismo sitio; se unifican para no
  // guardar la misma imagen tres veces con claves distintas.
  if (host === 'docker.io' || host === 'index.docker.io' || host === 'registry.hub.docker.com') {
    host = DOCKER_HUB_HOST;
  }

  // El separador del tag es el ultimo `:` que no forme parte de un puerto, es
  // decir el que aparezca despues del ultimo `/`.
  let tag = 'latest';
  const lastSlash = remainder.lastIndexOf('/');
  const colonIndex = remainder.indexOf(':', lastSlash + 1);
  if (colonIndex >= 0) {
    tag = remainder.slice(colonIndex + 1);
    remainder = remainder.slice(0, colonIndex);
  }

  if (!remainder) throw new InvalidReferenceError(input);

  // Solo Docker Hub tiene namespace implicito: `nginx` es `library/nginx`,
  // pero `ghcr.io/nginx` es literalmente el repositorio `nginx` de ese host.
  let repository = remainder;
  if (host === DOCKER_HUB_HOST && !repository.includes('/')) {
    repository = `library/${repository}`;
  }

  if (!/^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/i.test(repository)) {
    throw new InvalidReferenceError(input);
  }
  if (digest === null && !/^[\w][\w.-]{0,127}$/.test(tag)) {
    throw new InvalidReferenceError(input);
  }

  return {
    host,
    repository,
    tag,
    digest,
    normalized: `${host}/${repository}:${tag}`,
    original,
  };
}

/**
 * Nombre con el que el daemon conoce la imagen.
 *
 * NO es lo mismo que `normalized`. `registry-1.docker.io` es el host con el que
 * se habla la API del registry, pero el daemon guarda las imagenes de Docker
 * Hub como `nginx:alpine`, sin host y sin el `library/` implicito. Pedirle
 * `registry-1.docker.io/library/nginx:alpine` devuelve "No such image" aunque
 * la imagen acabe de descargarse.
 *
 * Se usa en todo lo que hable con el daemon: inspeccionar, crear un contenedor
 * o borrar una imagen. Para hablar con el registry se usa `normalized`.
 */
export function localImageName(ref: ImageReference): string {
  return `${localRepositoryName(ref)}:${ref.tag}`;
}

/** Igual que `localImageName` pero sin la etiqueta, que algunas APIs piden aparte. */
export function localRepositoryName(ref: ImageReference): string {
  if (ref.host === DOCKER_HUB_HOST) {
    return ref.repository.replace(/^library\//, '');
  }
  return `${ref.host}/${ref.repository}`;
}

/** Forma legible para la interfaz: se quitan los adornos que el usuario no escribio. */
export function displayReference(ref: ImageReference): string {
  const repo =
    ref.host === DOCKER_HUB_HOST
      ? ref.repository.replace(/^library\//, '')
      : `${ref.host}/${ref.repository}`;
  return `${repo}:${ref.tag}`;
}

/**
 * Extrae el digest de una entrada de `RepoDigests`, que tiene la forma
 * `repositorio@sha256:...`, comprobando ademas que sea del repositorio que nos
 * interesa. Una imagen retageada puede arrastrar digests de otro repositorio y
 * compararlos daria un falso "al dia".
 */
export function digestsForRepository(
  repoDigests: string[] | null | undefined,
  ref: ImageReference,
): string[] {
  if (!repoDigests) return [];
  const shortRepo = ref.repository.replace(/^library\//, '');
  const accepted = new Set([
    ref.repository,
    shortRepo,
    `${ref.host}/${ref.repository}`,
    `${ref.host}/${shortRepo}`,
    `docker.io/${ref.repository}`,
    `docker.io/${shortRepo}`,
  ]);

  const result: string[] = [];
  for (const entry of repoDigests) {
    const at = entry.lastIndexOf('@');
    if (at < 0) continue;
    if (!accepted.has(entry.slice(0, at))) continue;
    result.push(entry.slice(at + 1));
  }
  return result;
}
