/**
 * Que version tienes instalada de verdad.
 *
 * El problema que resuelve: con una etiqueta rodante (`latest`, `stable`,
 * `alpine`) el nombre no dice nada, y en la pantalla solo se veia el digest, que
 * es un identificador exacto pero ilegible.
 *
 * **Las etiquetas OCI de la imagen NO valen para esto.** Comprobado sobre 18
 * imagenes reales: solo 6 traian `org.opencontainers.image.version`, y de esas,
 * `mongo:8.2` decia "24.04" y `redis/redis-stack:7.4.0-v0` decia "22.04". No es
 * un error suyo: heredan la etiqueta de su imagen base de Ubuntu y no la
 * sobrescriben. Enseñar eso como "version instalada" seria peor que no enseñar
 * nada, porque parece un dato bueno.
 *
 * Lo que si es exacto: preguntarle al registry QUE OTRAS ETIQUETAS apuntan al
 * mismo digest que tienes en disco. Si `latest` y `v3.7.2` son el mismo digest,
 * entonces tu `latest` es v3.7.2. No hay heuristica: es el mismo contenido.
 */
import { rcompare } from 'semver';
import { RegistryClient } from './manifest.js';
import { parseTag, type ParsedTag } from './semver.js';
import type { ImageReference } from './reference.js';
import type { RegistryCredentials } from '../db/repositories/index.js';

export interface ResolvedVersion {
  /** La etiqueta de version mas concreta que apunta a este digest. */
  version: string | null;
  /** Las demas que tambien apuntan ahi, por si interesa verlas. */
  aliases: string[];
  /** Como se ha averiguado, para poder decirlo en la interfaz. */
  method: 'tag' | 'hub' | 'registry' | null;
}

const VACIO: ResolvedVersion = { version: null, aliases: [], method: null };

/**
 * Etiquetas que no identifican una version aunque apunten al mismo sitio.
 *
 * Decir que tu `latest` es... `latest` no informa de nada.
 */
const RODANTES = new Set(['latest', 'stable', 'main', 'master', 'edge', 'nightly', 'dev']);

/**
 * Sufijos de arquitectura.
 *
 * Estas etiquetas apuntan al mismo contenido pero NO nombran una version:
 * nombran para que maquina esta compilada. Comprobado con
 * `redis/redis-stack:7.4.0-v0`, que resolvia a `7.4.0-v0-x86_64` y se enseñaba
 * como si fuera una version mas concreta que la que ya ponia en la etiqueta.
 * Ademas puntuan alto por llevar numeros (86, 64), asi que sin filtrarlas ganan.
 */
const ARQUITECTURAS =
  /(^|[-_.])(x86[-_]?64|amd64|arm64v8|arm64|aarch64|armv[67]l?|i386|s390x|ppc64le)([-_.]|$)/i;

/** Si una etiqueta parece nombrar una version. */
export function pareceVersion(tag: string): boolean {
  if (RODANTES.has(tag.toLowerCase())) return false;
  if (ARQUITECTURAS.test(tag)) return false;
  // Al menos un numero, que es lo minimo que tiene una version.
  return /\d/.test(tag);
}

/**
 * Cuanto de concreta es una etiqueta de version.
 *
 * Entre `v3`, `v3.7` y `v3.7.2` interesa la ultima: es la que responde de
 * verdad a "que tengo instalado". Se puntua por cantidad de numeros y, a
 * igualdad, por longitud.
 */
export function especificidad(tag: string): number {
  const numeros = tag.match(/\d+/g)?.length ?? 0;
  return numeros * 100 + tag.length;
}

/**
 * Ordena las candidatas por probabilidad de ser la respuesta: de mas nueva a
 * mas vieja.
 *
 * Es la diferencia entre encontrarla y no encontrarla. La primera version
 * ordenaba por "especificidad" (cuantos numeros lleva la etiqueta), y en un
 * repositorio de versiones (`0.1.0`, `0.2.0`, ... `0.36.0`) casi todas empatan:
 * el desempate lo daba el orden del registry, que las devuelve de mas vieja a
 * mas nueva. Con un tope de peticiones, se acababa consultando justo las mas
 * antiguas, que son las que menos probablemente apuntan a un `latest`.
 * Comprobado con un repositorio real de 28 etiquetas: la buena era la ultima.
 *
 * Las que no se pueden interpretar como version van al final, pero no se
 * descartan: alguna sera una fecha o un hash de commit.
 */
export function ordenarPorProbabilidad(tags: string[]): string[] {
  const conVersion: Array<{ tag: string; parsed: ParsedTag }> = [];
  const resto: string[] = [];

  for (const tag of tags) {
    const parsed = parseTag(tag);
    if (parsed) conVersion.push({ tag, parsed });
    else resto.push(tag);
  }

  conVersion.sort((a, b) => {
    const orden = rcompare(a.parsed.coerced, b.parsed.coerced);
    // A igualdad de version, la mas concreta primero: entre `1.2` y `1.2.3`
    // interesa antes la segunda.
    return orden !== 0 ? orden : especificidad(b.tag) - especificidad(a.tag);
  });

  return [...conVersion.map((entry) => entry.tag), ...resto];
}

function elegir(tags: string[], etiquetaActual: string): ResolvedVersion['version'] {
  const candidatas = tags
    .filter((tag) => tag !== etiquetaActual && pareceVersion(tag))
    .sort((a, b) => especificidad(b) - especificidad(a));
  return candidatas[0] ?? null;
}

export class VersionResolver {
  constructor(private readonly registry: RegistryClient = new RegistryClient()) {}

  /**
   * Resuelve la version instalada comparando digests.
   *
   * No lanza nunca: es informacion adicional, y un registry que no colabore no
   * puede romper la pantalla de imagenes.
   */
  async resolve(
    ref: ImageReference,
    localDigests: string[],
    credentials: RegistryCredentials | null,
  ): Promise<ResolvedVersion> {
    const locales = new Set(localDigests);
    const esHub = ref.host === 'registry-1.docker.io';

    /**
     * Si la propia etiqueta ya nombra una version, esa ES la respuesta.
     *
     * Parece obvio dicho asi, pero la primera version preguntaba al registry
     * siempre y tardaba 18 segundos en no averiguar nada para `mongo:8.2`, cuya
     * version pone en el nombre. Solo las etiquetas rodantes necesitan trabajo.
     */
    const porNombre: ResolvedVersion = pareceVersion(ref.tag)
      ? { version: ref.tag, aliases: [], method: 'tag' }
      : VACIO;

    if (localDigests.length === 0) return porNombre;

    try {
      if (esHub) {
        // Una sola peticion y no gasta cuota: sale a cuenta incluso cuando ya
        // sabemos la version por el nombre, porque la afina (`7-alpine` pasa a
        // ser `7.4.10-alpine3.21`).
        const desdeHub = await this.#porHub(ref, locales);
        if (desdeHub.version) return desdeHub;
        return porNombre;
      }

      // Fuera de Hub cada etiqueta cuesta una peticion, asi que solo se paga
      // cuando de verdad hace falta: con la etiqueta rodante y sin otra pista.
      if (porNombre.version) return porNombre;
      return await this.#porRegistry(ref, locales, credentials);
    } catch {
      return porNombre;
    }
  }

  /**
   * Docker Hub, en UNA sola peticion.
   *
   * Su API propia devuelve el digest de cada etiqueta, asi que el cruce sale de
   * una tacada. No gasta cuota de descargas.
   */
  async #porHub(ref: ImageReference, locales: Set<string>): Promise<ResolvedVersion> {
    const url = `https://hub.docker.com/v2/repositories/${ref.repository}/tags?page_size=100&ordering=last_updated`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return VACIO;

    const body = (await response.json()) as {
      results?: Array<{ name?: string; digest?: string; images?: Array<{ digest?: string }> }>;
    };

    const coincidencias: string[] = [];
    for (const tag of body.results ?? []) {
      if (!tag.name) continue;
      // Se miran los dos: el digest del indice y el de cada manifest por
      // arquitectura, porque el local puede ser cualquiera de ellos.
      const digests = new Set<string>();
      if (tag.digest) digests.add(tag.digest);
      for (const image of tag.images ?? []) if (image.digest) digests.add(image.digest);
      if ([...digests].some((digest) => locales.has(digest))) coincidencias.push(tag.name);
    }

    const version = elegir(coincidencias, ref.tag);
    return version
      ? { version, aliases: coincidencias.filter((t) => t !== version), method: 'hub' }
      : VACIO;
  }

  /**
   * Resto de registries: un HEAD por etiqueta candidata.
   *
   * Aqui no hay atajo, asi que se acota con fuerza: solo etiquetas que parezcan
   * una version, las mas concretas primero, y un tope de peticiones. Es un
   * compromiso consciente: si la version instalada es muy vieja y ha quedado
   * fuera del tope, se devuelve "no se ha podido averiguar" en vez de recorrer
   * cientos de etiquetas.
   */
  async #porRegistry(
    ref: ImageReference,
    locales: Set<string>,
    credentials: RegistryCredentials | null,
    tope = 20,
  ): Promise<ResolvedVersion> {
    const todas = await this.registry.listTags(ref, credentials);
    const candidatas = ordenarPorProbabilidad(
      todas.filter((tag) => tag !== ref.tag && pareceVersion(tag)),
    ).slice(0, tope);

    const coincidencias: string[] = [];
    for (const tag of candidatas) {
      const head = await this.registry.headManifest({ ...ref, tag }, credentials).catch(() => null);
      if (head?.digest && locales.has(head.digest)) {
        coincidencias.push(tag);
        // Se para en la PRIMERA. Como las candidatas van de mas nueva a mas
        // vieja, la primera que coincide ya es la respuesta; seguir solo
        // aportaria alias, y aqui cada alias cuesta una peticion mas. Medido:
        // recolectar hasta tres subia una resolucion de 2 a 11 segundos.
        break;
      }
    }

    const version = elegir(coincidencias, ref.tag);
    return version
      ? { version, aliases: coincidencias.filter((t) => t !== version), method: 'registry' }
      : VACIO;
  }
}
