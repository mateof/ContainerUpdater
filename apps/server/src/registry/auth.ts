/**
 * Autenticacion contra registries OCI, dirigida por el challenge.
 *
 * La clave de este modulo es que el endpoint de token NO se puede hardcodear.
 * Verificado en vivo: `lscr.io` responde
 *   www-authenticate: Bearer realm="https://ghcr.io/token", service="ghcr.io"
 * es decir, el registry al que se pide la imagen y el que emite el token son
 * hosts distintos. Cualquier cliente que asuma `auth.docker.io` para Hub y
 * `ghcr.io/token` para GHCR falla con linuxserver.io, que es de lo mas comun en
 * un NAS.
 *
 * Tambien verificado: `quay.io` publico contesta 200 sin ningun challenge, asi
 * que la rama "sin autenticacion" tiene que existir.
 */
import type { RegistryCredentials } from '../db/repositories/index.js';

export interface Challenge {
  scheme: 'bearer' | 'basic';
  realm?: string;
  service?: string;
  scope?: string;
}

export class NeedsCredentialsError extends Error {
  constructor(readonly host: string) {
    super(`El registry ${host} requiere autenticacion`);
    this.name = 'NeedsCredentialsError';
  }
}

export class RegistryRateLimitedError extends Error {
  constructor(
    readonly host: string,
    readonly retryAfterSeconds: number,
  ) {
    super(`El registry ${host} ha limitado las peticiones`);
    this.name = 'RegistryRateLimitedError';
  }
}

/**
 * Parsea la cabecera `WWW-Authenticate`.
 *
 * Se acepta que los parametros vengan en cualquier orden y con o sin comillas,
 * porque no todos los registries siguen la misma convencion.
 */
export function parseChallenge(header: string | null): Challenge | null {
  if (!header) return null;

  const schemeMatch = /^\s*(\w+)/.exec(header);
  if (!schemeMatch?.[1]) return null;
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme !== 'bearer' && scheme !== 'basic') return null;

  const challenge: Challenge = { scheme };
  const paramRe = /(\w+)="([^"]*)"|(\w+)=([^,\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = paramRe.exec(header)) !== null) {
    const key = (match[1] ?? match[3] ?? '').toLowerCase();
    const value = match[2] ?? match[4] ?? '';
    if (key === 'realm') challenge.realm = value;
    else if (key === 'service') challenge.service = value;
    else if (key === 'scope') challenge.scope = value;
  }
  return challenge;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Caché de tokens en memoria.
 *
 * La clave incluye el repositorio porque, verificado contra Docker Hub, el
 * token esta acotado a un repositorio concreto: reutilizar el de
 * `library/nginx` para pedir `library/postgres` devuelve 401. Cachear por host
 * a secas parece funcionar hasta que se comprueba la segunda imagen.
 *
 * Nunca se persiste a disco: son credenciales de vida corta y guardarlas solo
 * anadiria superficie de ataque.
 */
export class TokenCache {
  readonly #entries = new Map<string, CachedToken>();

  async get(
    host: string,
    repository: string,
    scope: string,
    fetcher: () => Promise<CachedToken>,
  ): Promise<string> {
    const key = `${host}|${repository}|${scope}`;
    const cached = this.#entries.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const fresh = await fetcher();
    this.#entries.set(key, fresh);
    return fresh.token;
  }

  invalidate(host: string): void {
    for (const key of this.#entries.keys()) {
      if (key.startsWith(`${host}|`)) this.#entries.delete(key);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}

export function basicAuthHeader(credentials: RegistryCredentials): string {
  const raw = `${credentials.username}:${credentials.secret}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

/**
 * Pide un token siguiendo el challenge.
 *
 * Detalle importante: GHCR devuelve **403** (no 401) cuando faltan credenciales
 * para un repositorio privado o cuando el repositorio no existe. Tratar el 403
 * como un error generico deja al usuario sin saber si tiene que anadir un token
 * o si se ha equivocado de nombre, asi que se distingue explicitamente.
 */
export async function requestToken(
  challenge: Challenge,
  repository: string,
  credentials: RegistryCredentials | null,
  host: string,
): Promise<CachedToken> {
  if (!challenge.realm) {
    throw new Error(`El registry ${host} pide autenticacion pero no indica realm`);
  }

  const url = new URL(challenge.realm);
  if (challenge.service) url.searchParams.set('service', challenge.service);
  url.searchParams.set('scope', challenge.scope ?? `repository:${repository}:pull`);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (credentials?.secret) headers.Authorization = basicAuthHeader(credentials);

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });

  if (response.status === 401 || response.status === 403) {
    throw new NeedsCredentialsError(host);
  }
  if (response.status === 429) {
    throw new RegistryRateLimitedError(host, parseRetryAfter(response.headers.get('retry-after')));
  }
  if (!response.ok) {
    throw new Error(`El servidor de tokens de ${host} respondio ${response.status}`);
  }

  const body = (await response.json()) as {
    token?: string;
    access_token?: string;
    expires_in?: number;
  };
  const token = body.token ?? body.access_token;
  if (!token) throw new Error(`El servidor de tokens de ${host} no ha devuelto ningun token`);

  // Se resta un minuto al vencimiento para no usar un token que caduque justo
  // durante la peticion. El default de 300s es el habitual cuando no se indica.
  const ttl = (body.expires_in ?? 300) * 1000;
  return { token, expiresAt: Date.now() + Math.max(ttl - 60_000, 30_000) };
}

export function parseRetryAfter(value: string | null): number {
  if (!value) return 60;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1, Math.min(seconds, 3600));
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(1, Math.min(Math.ceil((date - Date.now()) / 1000), 3600));
  }
  return 60;
}
