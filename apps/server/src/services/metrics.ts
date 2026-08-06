/**
 * Muestreo de metricas y difusion por SSE.
 *
 * Dos decisiones marcan el rendimiento en un NAS modesto:
 *
 * 1. Un unico muestreador global, no uno por cliente conectado. Diez pestanas
 *    abiertas generan exactamente el mismo trabajo que una.
 * 2. El muestreador solo corre si hay alguien mirando. Sin suscriptores, la app
 *    no toca el socket de Docker y el NAS queda en paz.
 *
 * Descartado `stats?stream=true` mantenido abierto por contenedor: treinta
 * contenedores serian treinta conexiones permanentes y treinta mensajes por
 * segundo, que es mucho mas de lo que hace falta para pintar una grafica.
 */
import type { ContainerMetrics, MetricsSnapshot, ServerEvent } from '@cu/shared';
import { StatsCalculator } from '../docker/stats.js';
import { mapWithConcurrency } from './checker.js';
import type { DockerApi } from '../docker/api.js';
import type { HostMetricsService } from './host.js';
import type { InventoryService } from './inventory.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Logger } from '../logger.js';

/** 10 minutos de historia a 5 segundos por muestra. */
const RING_SIZE = 120;

/** Margen antes de parar el muestreo al irse el ultimo cliente. */
const IDLE_GRACE_MS = 30_000;

export type EventListener = (event: ServerEvent) => void;

export class MetricsService {
  readonly #ring: MetricsSnapshot[] = [];
  readonly #listeners = new Set<EventListener>();
  #calculator: StatsCalculator | null = null;
  #timer: NodeJS.Timeout | null = null;
  #stopTimer: NodeJS.Timeout | null = null;
  #sampling = false;
  #lastSystemCpu: number | null = null;
  #lastSampleAt = 0;
  #rollupBuffer = new Map<string, { cpu: number[]; mem: number[] }>();
  #lastRollupAt = Date.now();

  constructor(
    private readonly docker: DockerApi,
    private readonly inventory: InventoryService,
    private readonly host: HostMetricsService,
    private readonly repos: Repositories,
    private readonly log: Logger,
  ) {}

  get history(): MetricsSnapshot[] {
    return [...this.#ring];
  }

  get latest(): MetricsSnapshot | null {
    return this.#ring.at(-1) ?? null;
  }

  /**
   * Registra un oyente de eventos y arranca el muestreo si hacia falta.
   * Devuelve la funcion para darse de baja.
   */
  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    this.#ensureSampling();
    return () => {
      this.#listeners.delete(listener);
      this.#scheduleStopIfIdle();
    };
  }

  /** Difunde un evento que no viene del muestreador (trabajos, checks). */
  broadcast(event: ServerEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log.debug('Un oyente SSE ha fallado', error);
      }
    }
  }

  #ensureSampling(): void {
    if (this.#stopTimer) {
      clearTimeout(this.#stopTimer);
      this.#stopTimer = null;
    }
    if (this.#timer) return;

    const intervalMs = this.repos.settings.getAll().metricsIntervalSeconds * 1000;
    this.log.debug(`Arrancando el muestreo de metricas cada ${intervalMs}ms`);
    // Una muestra inmediata para que el cliente no espere al primer tick.
    void this.#sample();
    this.#timer = setInterval(() => void this.#sample(), intervalMs);
  }

  #scheduleStopIfIdle(): void {
    if (this.#listeners.size > 0 || this.#stopTimer) return;
    this.#stopTimer = setTimeout(() => {
      if (this.#listeners.size > 0) return;
      this.stop();
      this.log.debug('Muestreo de metricas detenido: no hay clientes conectados');
    }, IDLE_GRACE_MS);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#timer = null;
    this.#stopTimer = null;
  }

  async #sample(): Promise<void> {
    // Si un ciclo tarda mas que el intervalo (NAS cargado), se salta el
    // siguiente en vez de encolar peticiones que ya no interesan.
    if (this.#sampling) return;
    this.#sampling = true;

    try {
      if (!this.#calculator) {
        this.#calculator = new StatsCalculator(
          this.docker.client.ncpu,
          this.docker.client.hostMemTotal,
        );
      }

      const running = this.inventory.snapshot.containers.filter((c) => c.state === 'running');
      this.#calculator.retain(new Set(running.map((c) => c.id)));

      const containers: ContainerMetrics[] = [];
      let systemCpu: number | null = null;

      await mapWithConcurrency(running, 4, async (container) => {
        try {
          const raw = await this.docker.stats(container.id);
          systemCpu ??= raw.cpu_stats?.system_cpu_usage ?? null;
          const computed = this.#calculator!.compute(container.id, raw);
          containers.push({ id: container.id, name: container.name, ...computed, ts: Date.now() });
        } catch (error) {
          this.log.debug(`No se han podido leer las stats de ${container.name}`, error);
        }
      });

      containers.sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0));

      const hostMetrics =
        (await this.host.read()) ??
        this.host.buildFallback({
          systemCpuDelta:
            systemCpu !== null && this.#lastSystemCpu !== null ? systemCpu - this.#lastSystemCpu : null,
          wallMs: this.#lastSampleAt > 0 ? Date.now() - this.#lastSampleAt : 0,
          ncpu: this.docker.client.ncpu,
          memTotal: this.docker.client.hostMemTotal,
        });

      this.#lastSystemCpu = systemCpu;
      this.#lastSampleAt = Date.now();

      const snapshot: MetricsSnapshot = { host: hostMetrics, containers };

      this.#ring.push(snapshot);
      if (this.#ring.length > RING_SIZE) this.#ring.shift();

      this.#accumulateRollup(containers);
      this.broadcast({ type: 'metrics', payload: snapshot });
    } catch (error) {
      this.log.debug('Fallo en el ciclo de muestreo', error);
    } finally {
      this.#sampling = false;
    }
  }

  /**
   * Agrega a disco en tramos de cinco minutos, y solo si el usuario activa el
   * historico. Escribir cada muestra despertaria los discos del NAS
   * continuamente para guardar datos que casi nadie mira.
   */
  #accumulateRollup(containers: ContainerMetrics[]): void {
    if (!this.repos.settings.getAll().metricsHistoryEnabled) {
      if (this.#rollupBuffer.size > 0) this.#rollupBuffer.clear();
      return;
    }

    for (const metric of containers) {
      const entry = this.#rollupBuffer.get(metric.id) ?? { cpu: [], mem: [] };
      if (metric.cpuPercent !== null) entry.cpu.push(metric.cpuPercent);
      entry.mem.push(metric.memoryPercent);
      this.#rollupBuffer.set(metric.id, entry);
    }

    if (Date.now() - this.#lastRollupAt < 5 * 60_000) return;
    this.#lastRollupAt = Date.now();
    this.#rollupBuffer.clear();
  }
}
