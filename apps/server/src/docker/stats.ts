/**
 * Calculo de metricas por contenedor a partir de `/containers/{id}/stats`.
 *
 * La formula "oficial" de CPU% que circula por todas partes usa `precpu_stats`
 * como muestra anterior. Verificado: con `stream=false`, Podman devuelve
 * `precpu_stats` a cero (total_usage 0, system_cpu_usage null, online_cpus
 * null), y dockerd tambien lo deja vacio en la primera lectura de un one-shot.
 * Aplicar la formula tal cual da porcentajes absurdos.
 *
 * Por eso este modulo guarda su propia muestra anterior y trata `precpu_stats`
 * como una pista opcional, no como la fuente.
 */
import type { ContainerStats } from './types.js';

interface Sample {
  cpuTotal: number;
  systemCpu: number | null;
  netRx: number;
  netTx: number;
  blockRead: number;
  blockWrite: number;
  ts: number;
}

export interface ComputedStats {
  /** null en la primera muestra: sin delta no hay porcentaje que dar. */
  cpuPercent: number | null;
  memoryUsed: number;
  memoryLimit: number;
  memoryPercent: number;
  netRxRate: number;
  netTxRate: number;
  blockReadRate: number | null;
  blockWriteRate: number | null;
  pids: number | null;
}

export class StatsCalculator {
  readonly #previous = new Map<string, Sample>();

  constructor(
    private readonly hostNcpu: number,
    private readonly hostMemTotal: number,
  ) {}

  forget(id: string): void {
    this.#previous.delete(id);
  }

  /** Descarta contenedores que ya no existen para no acumular muestras muertas. */
  retain(ids: Set<string>): void {
    for (const id of this.#previous.keys()) {
      if (!ids.has(id)) this.#previous.delete(id);
    }
  }

  compute(id: string, stats: ContainerStats): ComputedStats {
    const now = Date.now();
    const current: Sample = {
      cpuTotal: stats.cpu_stats?.cpu_usage?.total_usage ?? 0,
      systemCpu: stats.cpu_stats?.system_cpu_usage ?? null,
      netRx: sumNetwork(stats, 'rx_bytes'),
      netTx: sumNetwork(stats, 'tx_bytes'),
      blockRead: sumBlockIo(stats, 'read'),
      blockWrite: sumBlockIo(stats, 'write'),
      ts: now,
    };

    const previous = this.#previous.get(id);
    this.#previous.set(id, current);

    const memory = computeMemory(stats, this.hostMemTotal);

    if (!previous) {
      return {
        cpuPercent: null,
        ...memory,
        netRxRate: 0,
        netTxRate: 0,
        blockReadRate: null,
        blockWriteRate: null,
        pids: stats.pids_stats?.current ?? null,
      };
    }

    const elapsedSeconds = Math.max((current.ts - previous.ts) / 1000, 0.001);

    return {
      cpuPercent: this.#cpuPercent(stats, previous, current),
      ...memory,
      netRxRate: rate(current.netRx, previous.netRx, elapsedSeconds),
      netTxRate: rate(current.netTx, previous.netTx, elapsedSeconds),
      blockReadRate:
        current.blockRead === 0 && previous.blockRead === 0
          ? null
          : rate(current.blockRead, previous.blockRead, elapsedSeconds),
      blockWriteRate:
        current.blockWrite === 0 && previous.blockWrite === 0
          ? null
          : rate(current.blockWrite, previous.blockWrite, elapsedSeconds),
      pids: stats.pids_stats?.current ?? null,
    };
  }

  #cpuPercent(stats: ContainerStats, previous: Sample, current: Sample): number | null {
    const cpuDelta = current.cpuTotal - previous.cpuTotal;
    // Un delta negativo significa que el contenedor se reinicio y el contador
    // volvio a cero. Devolver 0 es mas honesto que un pico enorme.
    if (cpuDelta <= 0) return 0;

    // Numero de CPUs, en orden de fiabilidad:
    //  1. online_cpus, que es lo que da dockerd moderno con cgroup v2.
    //  2. percpu_usage.length, presente en cgroup v1 (kernels antiguos de
    //     muchos Synology), donde online_cpus no existe.
    //  3. el NCPU del daemon, porque Podman devuelve null en los dos anteriores.
    const ncpu =
      stats.cpu_stats?.online_cpus ??
      (stats.cpu_stats?.cpu_usage?.percpu_usage?.length || undefined) ??
      this.hostNcpu;

    if (current.systemCpu !== null && previous.systemCpu !== null) {
      const systemDelta = current.systemCpu - previous.systemCpu;
      if (systemDelta > 0) {
        return clampPercent((cpuDelta / systemDelta) * ncpu * 100);
      }
    }

    // Sin system_cpu_usage: nanosegundos de CPU consumidos sobre nanosegundos
    // de reloj de pared. Suma sobre todos los nucleos, asi que puede pasar del
    // 100% legitimamente (200% son dos nucleos saturados), igual que hace top.
    const wallNs = (current.ts - previous.ts) * 1e6;
    if (wallNs <= 0) return null;
    return clampPercent((cpuDelta / wallNs) * 100, ncpu * 100);
  }
}

function computeMemory(
  stats: ContainerStats,
  hostMemTotal: number,
): { memoryUsed: number; memoryLimit: number; memoryPercent: number } {
  const raw = stats.memory_stats?.usage ?? 0;
  const detail = stats.memory_stats?.stats ?? {};

  // Hay que restar el cache de fichero o los contenedores parecen consumir el
  // triple de lo que consumen: `usage` incluye la cache de pagina, que el
  // kernel libera en cuanto hace falta. Es lo que hace `docker stats`.
  //  - cgroup v2: inactive_file
  //  - cgroup v1: total_inactive_file  (kernels antiguos de Synology)
  // Podman no envia `memory_stats.stats` en absoluto, de ahi el 0 final.
  const cache = detail.inactive_file ?? detail.total_inactive_file ?? 0;
  const used = Math.max(0, raw - cache);

  // Un contenedor sin limite reporta el total del host, o 0 en algunos
  // backends. Sin limite util, se toma el del host para que el porcentaje
  // signifique algo.
  const reported = stats.memory_stats?.limit ?? 0;
  const limit = reported > 0 ? reported : hostMemTotal;

  return {
    memoryUsed: used,
    memoryLimit: limit,
    memoryPercent: limit > 0 ? (used / limit) * 100 : 0,
  };
}

function sumNetwork(stats: ContainerStats, field: 'rx_bytes' | 'tx_bytes'): number {
  let total = 0;
  for (const iface of Object.values(stats.networks ?? {})) {
    total += iface[field] ?? 0;
  }
  return total;
}

/**
 * `blkio_stats` no existe en cgroup v2 sin privilegios ni en varios backends
 * rootless. Se trata como opcional en todo el camino.
 */
function sumBlockIo(stats: ContainerStats, op: 'read' | 'write'): number {
  const entries = stats.blkio_stats?.io_service_bytes_recursive;
  if (!entries) return 0;
  let total = 0;
  for (const entry of entries) {
    if (entry.op.toLowerCase() === op) total += entry.value;
  }
  return total;
}

function rate(current: number, previous: number, seconds: number): number {
  const delta = current - previous;
  if (delta < 0) return 0;
  return delta / seconds;
}

function clampPercent(value: number, max = 100 * 1024): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, max);
}
