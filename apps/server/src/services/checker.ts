/**
 * Comprobacion de actualizaciones.
 *
 * Recorre las imagenes vigiladas y decide si hay novedad, por digest, por
 * version o por ambas cosas.
 */
import type { CheckRun, TrackMode, UpdateStatus } from '@cu/shared';
import {
  NeedsCredentialsError,
  RegistryRateLimitedError,
} from '../registry/auth.js';
import {
  RegistryClient,
  compareDigests,
  pickPlatformChild,
} from '../registry/manifest.js';
import { parseImageReference } from '../registry/reference.js';
import { findUpgradeCandidate } from '../registry/semver.js';
import type { ImageRow, Repositories } from '../db/repositories/index.js';
import type { DockerApi } from '../docker/api.js';
import type { Logger } from '../logger.js';

export interface CheckOutcome {
  ref: string;
  status: UpdateStatus;
  hasUpdate: boolean;
  localDigest: string | null;
  remoteDigest: string | null;
  candidateTag: string | null;
  error: string | null;
}

export interface CheckSummary {
  run: CheckRun;
  outcomes: CheckOutcome[];
}

/**
 * Corta las peticiones a un host que esta fallando de forma sistematica.
 *
 * Sin esto, un registry caido convierte cada comprobacion en decenas de
 * timeouts de 20 segundos y el check tarda mas que el intervalo entre checks.
 */
class CircuitBreaker {
  readonly #failures = new Map<string, { count: number; openUntil: number }>();

  isOpen(host: string): boolean {
    const entry = this.#failures.get(host);
    return entry !== undefined && entry.openUntil > Date.now();
  }

  recordSuccess(host: string): void {
    this.#failures.delete(host);
  }

  recordFailure(host: string): void {
    const entry = this.#failures.get(host) ?? { count: 0, openUntil: 0 };
    entry.count += 1;
    if (entry.count >= 3) {
      // Espera exponencial con techo de 30 minutos.
      const backoff = Math.min(2 ** (entry.count - 3) * 60_000, 30 * 60_000);
      entry.openUntil = Date.now() + backoff;
    }
    this.#failures.set(host, entry);
  }

  /** Pausa impuesta por el propio registry mediante Retry-After. */
  openFor(host: string, seconds: number): void {
    this.#failures.set(host, { count: 3, openUntil: Date.now() + seconds * 1000 });
  }
}

export class CheckerService {
  readonly #registry = new RegistryClient();
  readonly #breaker = new CircuitBreaker();
  #running = false;

  constructor(
    private readonly repos: Repositories,
    private readonly docker: DockerApi,
    private readonly log: Logger,
  ) {}

  get running(): boolean {
    return this.#running;
  }

  async runCheck(
    trigger: string,
    options: { refs?: string[]; onProgress?: (ref: string, run: CheckRun) => void } = {},
  ): Promise<CheckSummary> {
    if (this.#running) throw new Error('Ya hay una comprobacion en curso');
    this.#running = true;

    const runId = this.repos.history.startRun(trigger);
    const settings = this.repos.settings.getAll();

    const candidates = options.refs
      ? options.refs
          .map((ref) => this.repos.inventory.findImage(ref))
          .filter((row): row is ImageRow => row !== undefined)
      : this.repos.inventory.listCheckable();

    const outcomes: CheckOutcome[] = [];
    let updatesFound = 0;
    let errors = 0;

    try {
      await mapWithConcurrency(candidates, settings.registryConcurrency, async (row) => {
        // Jitter para no golpear el registry en rafaga con veinte peticiones
        // simultaneas nada mas arrancar el cron.
        await sleep(Math.random() * 400);

        const startedAt = Date.now();
        const outcome = await this.#checkImage(row);
        outcomes.push(outcome);

        if (outcome.hasUpdate) updatesFound += 1;
        if (outcome.error) errors += 1;

        this.repos.inventory.recordCheck({
          ref: outcome.ref,
          status: outcome.status,
          remoteDigest: outcome.remoteDigest,
          candidateTag: outcome.candidateTag,
          error: outcome.error,
        });

        this.repos.history.recordResult({
          runId,
          imageRef: outcome.ref,
          localDigest: outcome.localDigest,
          remoteDigest: outcome.remoteDigest,
          hasUpdate: outcome.hasUpdate,
          candidateTag: outcome.candidateTag,
          httpStatus: null,
          durationMs: Date.now() - startedAt,
          error: outcome.error,
        });

        const run = this.repos.history.getRun(runId);
        if (run) options.onProgress?.(outcome.ref, run);
      });

      this.repos.history.finishRun(runId, {
        imagesChecked: candidates.length,
        updatesFound,
        errors,
      });
      this.repos.settings.setRaw('last_check_at', String(Date.now()));
    } catch (error) {
      this.repos.history.finishRun(runId, {
        imagesChecked: candidates.length,
        updatesFound,
        errors: errors + 1,
        failed: true,
      });
      throw error;
    } finally {
      this.#running = false;
    }

    const run = this.repos.history.getRun(runId);
    if (!run) throw new Error('No se ha podido leer el resultado de la comprobacion');
    return { run, outcomes };
  }

  async #checkImage(row: ImageRow): Promise<CheckOutcome> {
    const ref = parseImageReference(row.normalized_ref);
    const localDigests = parseDigests(row.local_digests);
    const policy = this.repos.inventory.getPolicy(row.normalized_ref);

    const base: CheckOutcome = {
      ref: row.normalized_ref,
      status: 'unknown',
      hasUpdate: false,
      localDigest: localDigests[0] ?? null,
      remoteDigest: null,
      candidateTag: null,
      error: null,
    };

    if (this.#breaker.isOpen(ref.host)) {
      return { ...base, status: 'error', error: `Pausado temporalmente: ${ref.host} esta fallando` };
    }

    const credentials = this.repos.registries.getCredentials(ref.host);

    try {
      const mode: TrackMode = policy.trackMode;
      let hasUpdate = false;
      let remoteDigest: string | null = null;
      let candidateTag: string | null = null;

      if (mode === 'digest' || mode === 'both') {
        const result = await this.#checkDigest(ref, localDigests, credentials);
        remoteDigest = result.remoteDigest;
        hasUpdate = result.hasUpdate;
      }

      if (mode === 'semver' || mode === 'both') {
        candidateTag = await this.#checkSemver(ref, policy.semverChannel, credentials);
        if (candidateTag) hasUpdate = true;
      }

      this.#breaker.recordSuccess(ref.host);
      this.repos.registries.setStatus(ref.host, 'ok', null);

      // Un digest que el usuario decidio ignorar no vuelve a contar como
      // novedad hasta que aparezca otro distinto.
      if (hasUpdate && remoteDigest && policy.ignoredDigest === remoteDigest && !candidateTag) {
        hasUpdate = false;
      }

      return {
        ...base,
        status: hasUpdate ? 'update-available' : 'up-to-date',
        hasUpdate,
        remoteDigest,
        candidateTag,
      };
    } catch (error) {
      if (error instanceof NeedsCredentialsError) {
        // Un 401 puede significar tres cosas muy distintas y hay que separarlas
        // o el usuario recibe un mensaje que no le sirve para nada.
        if (!credentials) {
          const exists = await this.#registry.repositoryExists(ref);
          if (exists === false) {
            // El repositorio no existe: la imagen se construyo aqui. Se marca
            // como tal para dejar de consultarla en cada comprobacion.
            this.repos.inventory.markAsLocalBuild(row.normalized_ref);
            return {
              ...base,
              status: 'unknown',
              error:
                'No existe en el registry: parece construida en esta maquina. ' +
                'Se deja de comprobar.',
            };
          }

          this.repos.registries.setStatus(ref.host, 'needs-reauth', 'Requiere credenciales');
          return {
            ...base,
            status: 'error',
            error: `${ref.host} requiere autenticacion. Anade sus credenciales en Ajustes.`,
          };
        }

        this.repos.registries.setStatus(
          ref.host,
          'needs-reauth',
          'Las credenciales no dan acceso a este repositorio',
        );
        return {
          ...base,
          status: 'error',
          error: `Las credenciales de ${ref.host} no dan acceso a ${ref.repository}.`,
        };
      }
      if (error instanceof RegistryRateLimitedError) {
        this.#breaker.openFor(ref.host, error.retryAfterSeconds);
        return {
          ...base,
          status: 'error',
          error: `${ref.host} ha limitado las peticiones. Reintento en ${error.retryAfterSeconds}s.`,
        };
      }

      this.#breaker.recordFailure(ref.host);
      this.log.warn(`Fallo comprobando ${row.normalized_ref}`, error);
      return { ...base, status: 'error', error: (error as Error).message };
    }
  }

  async #checkDigest(
    ref: ReturnType<typeof parseImageReference>,
    localDigests: string[],
    credentials: ReturnType<Repositories['registries']['getCredentials']>,
  ): Promise<{ hasUpdate: boolean; remoteDigest: string | null }> {
    const head = await this.#registry.headManifest(ref, credentials);

    if (head.rateLimit.remaining !== null) {
      this.repos.registries.setRateLimit(ref.host, head.rateLimit.remaining, head.rateLimit.total);
    }
    if (!head.digest) {
      throw new Error(`El registry no ha devuelto digest (HTTP ${head.status})`);
    }
    if (localDigests.length === 0) {
      // Sin digest local no se puede afirmar nada. Se informa del remoto para
      // que el usuario lo vea, pero no se declara actualizacion.
      return { hasUpdate: false, remoteDigest: head.digest };
    }

    const comparison = compareDigests(localDigests, head);
    if (comparison.upToDate) return { hasUpdate: false, remoteDigest: head.digest };

    // El digest local puede ser el del manifest de nuestra arquitectura en vez
    // del indice. Solo en ese caso vale la pena bajar el cuerpo del indice.
    if (comparison.needsIndexLookup) {
      const children = await this.#registry.fetchIndexChildren(ref, credentials);
      const local = await this.#localPlatform(ref.normalized);
      const child = pickPlatformChild(children, local);
      if (child && localDigests.includes(child.digest)) {
        return { hasUpdate: false, remoteDigest: head.digest };
      }
    }

    return { hasUpdate: true, remoteDigest: head.digest };
  }

  async #checkSemver(
    ref: ReturnType<typeof parseImageReference>,
    channel: 'patch' | 'minor' | 'major',
    credentials: ReturnType<Repositories['registries']['getCredentials']>,
  ): Promise<string | null> {
    let tags = this.repos.tagCache.get(ref.host, ref.repository);
    if (!tags) {
      tags = await this.#registry.listTags(ref, credentials);
      if (tags.length > 0) this.repos.tagCache.set(ref.host, ref.repository, tags);
    }
    const candidate = findUpgradeCandidate(ref.tag, tags, channel);
    return candidate?.tag ?? null;
  }

  /**
   * Plataforma de la imagen local. Sin esto compararíamos el manifest de arm64
   * contra el de amd64 y siempre habria "actualizacion".
   */
  async #localPlatform(
    ref: string,
  ): Promise<{ architecture: string | null; os: string | null; variant: string | null }> {
    try {
      const image = await this.docker.inspectImage(ref);
      return {
        architecture: image.Architecture ?? null,
        os: image.Os ?? null,
        variant: image.Variant ?? null,
      };
    } catch {
      return { architecture: null, os: null, variant: null };
    }
  }
}

export function parseDigests(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Limitador de concurrencia. Descartado `p-limit`: son quince lineas y una
 * dependencia menos que auditar.
 */
export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
