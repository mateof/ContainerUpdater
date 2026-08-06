import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

/**
 * Mecanismo de ejecucion de Compose: salida en directo y proceso cancelable.
 *
 * Se prueba el patron con procesos de sistema en vez de con Compose de verdad,
 * que necesitaria un daemon y un proyecto. Lo que puede romperse aqui es el
 * troceado de la salida y la terminacion, no la logica de Compose.
 *
 * El motivo de que exista: antes se usaba `execFile`, que acumula toda la
 * salida y solo la entrega al terminar. Durante una descarga larga el registro
 * se veia vacio y parecia que nada avanzaba, y ademas no habia forma de matar
 * un proceso atascado.
 */

interface RunResult {
  lines: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
}

function run(
  command: string,
  args: string[],
  onChild?: (child: ReturnType<typeof spawn>) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    const lines: string[] = [];
    let buffer = '';

    const read = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trimEnd();
        buffer = buffer.slice(index + 1);
        if (line) lines.push(line);
      }
    };

    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ lines, code, signal }));

    onChild?.(child);
  });
}

describe('ejecucion con salida en directo', () => {
  it('entrega la salida linea a linea', async () => {
    const result = await run('sh', ['-c', 'echo primera; echo segunda; echo tercera']);
    expect(result.lines).toEqual(['primera', 'segunda', 'tercera']);
    expect(result.code).toBe(0);
  });

  it('recompone las lineas partidas entre trozos', async () => {
    // Los trozos que llegan por el flujo no respetan los saltos de linea: sin
    // buffer intermedio, un mensaje se partiria por la mitad.
    const result = await run('sh', ['-c', 'printf "parte1"; sleep 0.1; printf "parte2\n"']);
    expect(result.lines).toEqual(['parte1parte2']);
  });

  it('captura tambien stderr, que es por donde escribe Compose', async () => {
    const result = await run('sh', ['-c', 'echo por-stderr >&2']);
    expect(result.lines).toEqual(['por-stderr']);
  });

  it('va emitiendo mientras el proceso sigue vivo', async () => {
    // Esto es lo que `execFile` no hacia: con el, estas lineas no aparecerian
    // hasta que el proceso terminase.
    const seen: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn('sh', ['-c', 'echo uno; sleep 0.3; echo dos'], { shell: false });
      child.stdout?.on('data', (chunk: Buffer) => {
        seen.push(chunk.toString().trim());
        // A mitad de camino ya se ha recibido la primera linea.
        if (seen.length === 1) expect(seen[0]).toBe('uno');
      });
      child.on('error', reject);
      child.on('close', () => resolve());
    });
    expect(seen).toHaveLength(2);
  });

  it('se puede matar un proceso largo y la promesa se resuelve', async () => {
    // Es lo que permite detener una actualizacion atascada: sin referencia al
    // proceso no habia forma de pararla y el trabajo quedaba colgado.
    const started = Date.now();
    const result = await run('sh', ['-c', 'sleep 30'], (child) => {
      setTimeout(() => child.kill('SIGTERM'), 100);
    });

    expect(result.signal).toBe('SIGTERM');
    // No ha esperado los 30 segundos.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('informa del codigo de salida cuando el comando falla', async () => {
    const result = await run('sh', ['-c', 'echo fallo >&2; exit 3']);
    expect(result.code).toBe(3);
    expect(result.lines).toContain('fallo');
  });
});
