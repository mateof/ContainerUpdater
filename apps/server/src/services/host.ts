/**
 * Metricas del sistema anfitrion.
 *
 * Se lee `/proc` del host montado en solo lectura. Descartado
 * `systeminformation`: lee rutas de `/proc` fijas, es decir las del namespace
 * del contenedor, no las del NAS, y no admite prefijo. Devolveria la memoria y
 * la CPU del propio contenedor haciendolas pasar por las del sistema.
 *
 * Un lector propio son unas pocas decenas de lineas, no tiene dependencias y
 * dice la verdad.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { HostMetrics } from '@cu/shared';
import type { Logger } from '../logger.js';

const execFileAsync = promisify(execFile);

interface CpuSample {
  idle: number;
  total: number;
}

export class HostMetricsService {
  #previousCpu: CpuSample | null = null;
  #previousPerCore: CpuSample[] = [];
  #available: boolean | null = null;

  /** Los discos se muestrean aparte y muy de tarde en tarde. Ver #readDisks. */
  #diskCache: { at: number; disks: HostMetrics['disks'] } = { at: 0, disks: [] };

  constructor(
    private readonly procPath: string | null,
    private readonly diskPaths: string[],
    private readonly log: Logger,
  ) {}

  async available(): Promise<boolean> {
    if (this.#available !== null) return this.#available;
    if (!this.procPath) {
      this.#available = false;
      return false;
    }
    try {
      await readFile(join(this.procPath, 'stat'), 'utf8');
      this.#available = true;
    } catch {
      this.log.warn(
        `No se puede leer ${this.procPath}. Monta /proc:/host/proc:ro para ver las metricas reales del NAS.`,
      );
      this.#available = false;
    }
    return this.#available;
  }

  async read(): Promise<HostMetrics | null> {
    if (!(await this.available()) || !this.procPath) return null;

    try {
      const [statRaw, memRaw, loadRaw, uptimeRaw] = await Promise.all([
        readFile(join(this.procPath, 'stat'), 'utf8'),
        readFile(join(this.procPath, 'meminfo'), 'utf8'),
        readFile(join(this.procPath, 'loadavg'), 'utf8').catch(() => '0 0 0'),
        readFile(join(this.procPath, 'uptime'), 'utf8').catch(() => '0'),
      ]);

      const cpu = this.#parseCpu(statRaw);
      const memory = parseMeminfo(memRaw);
      const load = loadRaw.trim().split(/\s+/).slice(0, 3).map(Number);

      return {
        cpuPercent: cpu.total,
        cpuPerCore: cpu.perCore,
        memTotal: memory.total,
        memAvailable: memory.available,
        memUsed: memory.total - memory.available,
        swapTotal: memory.swapTotal,
        swapUsed: memory.swapTotal - memory.swapFree,
        loadAvg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
        uptimeSeconds: Math.floor(Number(uptimeRaw.trim().split(/\s+/)[0] ?? 0)),
        ncpu: cpu.perCore.length || 1,
        disks: await this.#readDisks(),
        source: 'host-proc',
        ts: Date.now(),
      };
    } catch (error) {
      this.log.warn('Fallo leyendo las metricas del host', error);
      return null;
    }
  }

  /**
   * Respaldo cuando no hay `/proc` del host.
   *
   * `system_cpu_usage` del endpoint de stats es el total de CPU del HOST en
   * nanosegundos, no el del contenedor, asi que sirve para derivar el uso real
   * del sistema siempre que haya algun contenedor en marcha del que leerlo.
   */
  buildFallback(input: {
    systemCpuDelta: number | null;
    wallMs: number;
    ncpu: number;
    memTotal: number;
  }): HostMetrics {
    let cpuPercent: number | null = null;
    if (input.systemCpuDelta !== null && input.wallMs > 0 && input.ncpu > 0) {
      const wallNs = input.wallMs * 1e6;
      cpuPercent = Math.min(100, Math.max(0, (input.systemCpuDelta / (wallNs * input.ncpu)) * 100));
    }

    return {
      cpuPercent,
      cpuPerCore: [],
      memTotal: input.memTotal,
      memAvailable: 0,
      memUsed: 0,
      swapTotal: 0,
      swapUsed: 0,
      loadAvg: [0, 0, 0],
      uptimeSeconds: 0,
      ncpu: input.ncpu,
      disks: [],
      source: input.systemCpuDelta !== null ? 'docker-fallback' : 'unavailable',
      ts: Date.now(),
    };
  }

  #parseCpu(stat: string): { total: number | null; perCore: number[] } {
    const lines = stat.split('\n').filter((line) => line.startsWith('cpu'));
    const aggregate = lines.find((line) => line.startsWith('cpu '));
    const cores = lines.filter((line) => /^cpu\d+/.test(line));

    const total = aggregate ? this.#deltaPercent(parseCpuLine(aggregate), this.#previousCpu) : null;
    if (aggregate) this.#previousCpu = parseCpuLine(aggregate);

    const perCore: number[] = [];
    cores.forEach((line, index) => {
      const sample = parseCpuLine(line);
      const previous = this.#previousPerCore[index];
      const percent = this.#deltaPercent(sample, previous ?? null);
      perCore.push(percent ?? 0);
      this.#previousPerCore[index] = sample;
    });

    return { total, perCore };
  }

  #deltaPercent(current: CpuSample, previous: CpuSample | null): number | null {
    // Primera lectura: sin muestra anterior no hay porcentaje. Devolver 0
    // pintaria un valle falso en la grafica al arrancar.
    if (!previous) return null;
    const totalDelta = current.total - previous.total;
    const idleDelta = current.idle - previous.idle;
    if (totalDelta <= 0) return 0;
    return Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100));
  }

  /**
   * Uso de disco.
   *
   * Se cachea cinco minutos a proposito: `df` toca los sistemas de fichero y en
   * un Synology con los discos hibernados eso los despierta. No merece la pena
   * despertar el RAID cada cinco segundos para pintar una barra.
   */
  async #readDisks(): Promise<HostMetrics['disks']> {
    if (Date.now() - this.#diskCache.at < 5 * 60_000) return this.#diskCache.disks;
    if (this.diskPaths.length === 0) {
      this.#diskCache = { at: Date.now(), disks: [] };
      return [];
    }

    const disks: HostMetrics['disks'] = [];
    for (const path of this.diskPaths) {
      try {
        // execFile sin shell: la ruta viene de la configuracion, pero no hay
        // motivo para darle un interprete de comandos.
        const { stdout } = await execFileAsync('df', ['-P', '-k', path], { timeout: 10_000 });
        const line = stdout.trim().split('\n').at(-1);
        if (!line) continue;
        const parts = line.trim().split(/\s+/);
        const total = Number(parts[1]) * 1024;
        const used = Number(parts[2]) * 1024;
        const available = Number(parts[3]) * 1024;
        if (Number.isFinite(total)) disks.push({ path, total, used, available });
      } catch (error) {
        this.log.debug(`No se ha podido leer el uso de ${path}`, error);
      }
    }

    this.#diskCache = { at: Date.now(), disks };
    return disks;
  }
}

/** Formato: `cpu user nice system idle iowait irq softirq steal ...` en jiffies. */
function parseCpuLine(line: string): CpuSample {
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (values[3] ?? 0) + (values[4] ?? 0); // idle + iowait
  const total = values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  return { idle, total };
}

function parseMeminfo(content: string): {
  total: number;
  available: number;
  swapTotal: number;
  swapFree: number;
} {
  const values = new Map<string, number>();
  for (const line of content.split('\n')) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (match?.[1] && match[2]) values.set(match[1], Number(match[2]) * 1024);
  }

  const total = values.get('MemTotal') ?? 0;
  // MemAvailable y no MemFree: en un NAS con cache de ficheros, MemFree es casi
  // siempre ridiculamente bajo y daria la impresion de que no queda memoria.
  // MemAvailable es la estimacion del kernel de lo que se puede usar de verdad.
  const available = values.get('MemAvailable') ?? values.get('MemFree') ?? 0;

  return {
    total,
    available,
    swapTotal: values.get('SwapTotal') ?? 0,
    swapFree: values.get('SwapFree') ?? 0,
  };
}
