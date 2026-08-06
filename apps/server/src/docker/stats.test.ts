import { describe, expect, it } from 'vitest';
import { StatsCalculator } from './stats.js';
import type { ContainerStats } from './types.js';

/** Muestra al estilo de dockerd, con system_cpu_usage y stats de memoria. */
function dockerSample(cpuTotal: number, systemCpu: number): ContainerStats {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: cpuTotal },
      system_cpu_usage: systemCpu,
      online_cpus: 4,
    },
    memory_stats: { usage: 500_000_000, limit: 1_000_000_000, stats: { inactive_file: 100_000_000 } },
    networks: { eth0: { rx_bytes: 1000, tx_bytes: 500 } },
  };
}

/**
 * Muestra al estilo de Podman con `stream=false`. Verificado en vivo:
 * precpu_stats llega vacio, system_cpu_usage y online_cpus son null y
 * memory_stats.stats no existe.
 */
function podmanSample(cpuTotal: number): ContainerStats {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: cpuTotal, percpu_usage: [] },
      system_cpu_usage: null,
      online_cpus: null,
    },
    precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: null, online_cpus: null },
    memory_stats: { usage: 500_000_000, limit: 1_000_000_000 },
    networks: { eth0: { rx_bytes: 1000, tx_bytes: 500 } },
  };
}

describe('StatsCalculator', () => {
  it('no inventa un cero en la primera muestra', () => {
    // Sin muestra anterior no hay delta. Devolver 0 pintaria un valle falso al
    // arrancar la grafica.
    const calc = new StatsCalculator(4, 8_000_000_000);
    expect(calc.compute('a', dockerSample(1_000_000, 10_000_000)).cpuPercent).toBeNull();
  });

  it('aplica la formula de Docker cuando hay system_cpu_usage', () => {
    const calc = new StatsCalculator(4, 8_000_000_000);
    calc.compute('a', dockerSample(1_000_000, 10_000_000));
    // 1_000_000 de delta de contenedor sobre 10_000_000 del sistema, por 4 CPUs
    // = 40%.
    const result = calc.compute('a', dockerSample(2_000_000, 20_000_000));
    expect(result.cpuPercent).toBeCloseTo(40, 1);
  });

  it('calcula el CPU aunque precpu_stats venga vacio, como en Podman', async () => {
    const calc = new StatsCalculator(4, 8_000_000_000);
    calc.compute('a', podmanSample(0));
    // Sin system_cpu_usage, el calculo usa el reloj de pared. Hay que dejar
    // pasar tiempo real o el delta seria cero. En produccion el intervalo de
    // muestreo son segundos, asi que el caso no se da.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = calc.compute('a', podmanSample(1_000_000));
    // La formula estandar con precpu a cero daria un valor sin sentido; con
    // muestreo propio sale un numero finito y positivo.
    expect(result.cpuPercent).not.toBeNull();
    expect(Number.isFinite(result.cpuPercent!)).toBe(true);
    expect(result.cpuPercent!).toBeGreaterThanOrEqual(0);
  });

  it('devuelve 0 si el contador retrocede por un reinicio', () => {
    const calc = new StatsCalculator(4, 8_000_000_000);
    calc.compute('a', dockerSample(5_000_000, 10_000_000));
    expect(calc.compute('a', dockerSample(1_000_000, 20_000_000)).cpuPercent).toBe(0);
  });

  it('resta el cache de fichero de la memoria usada', () => {
    // Sin restar inactive_file, el contenedor parece consumir 500 MB cuando en
    // realidad usa 400 MB y el resto es cache que el kernel libera solo.
    const calc = new StatsCalculator(4, 8_000_000_000);
    const result = calc.compute('a', dockerSample(1_000, 10_000));
    expect(result.memoryUsed).toBe(400_000_000);
    expect(result.memoryPercent).toBeCloseTo(40, 1);
  });

  it('acepta cgroup v1, donde el campo se llama total_inactive_file', () => {
    const calc = new StatsCalculator(4, 8_000_000_000);
    const sample: ContainerStats = {
      cpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 1000, online_cpus: 2 },
      memory_stats: {
        usage: 300_000_000,
        limit: 1_000_000_000,
        stats: { total_inactive_file: 50_000_000 },
      },
    };
    expect(calc.compute('a', sample).memoryUsed).toBe(250_000_000);
  });

  it('usa la memoria del host cuando el contenedor no declara limite', () => {
    const calc = new StatsCalculator(4, 8_000_000_000);
    const sample: ContainerStats = {
      cpu_stats: { cpu_usage: { total_usage: 1 } },
      memory_stats: { usage: 1_000_000, limit: 0 },
    };
    expect(calc.compute('a', sample).memoryLimit).toBe(8_000_000_000);
  });

  it('trata el disco como opcional, porque falta en cgroup v2 sin privilegios', () => {
    const calc = new StatsCalculator(4, 8_000_000_000);
    calc.compute('a', podmanSample(0));
    const result = calc.compute('a', podmanSample(1000));
    expect(result.blockReadRate).toBeNull();
    expect(result.blockWriteRate).toBeNull();
  });

  it('olvida los contenedores que ya no existen', () => {
    const calc = new StatsCalculator(4, 8_000_000_000);
    calc.compute('a', dockerSample(1000, 10_000));
    calc.retain(new Set(['b']));
    // Al haberse olvidado, vuelve a comportarse como una primera muestra.
    expect(calc.compute('a', dockerSample(2000, 20_000)).cpuPercent).toBeNull();
  });
});
