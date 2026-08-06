/**
 * Ejecucion de Docker Compose.
 *
 * Regla absoluta: `spawn` con `shell: false`, nunca `exec` ni plantillas de
 * cadena. Los nombres de proyecto y servicio vienen de labels que controla
 * quien haya creado el contenedor, asi que se tratan como entrada no confiable.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { RecreateScope } from '@cu/shared';
import { checkComposeAccessibility } from './projects.js';
import type { Logger } from '../logger.js';

/**
 * Nombres validos de proyecto y servicio.
 *
 * Con `shell: false` la inyeccion de comandos ya es imposible, pero la
 * validacion sigue haciendo falta por otro motivo: un nombre que empiece por
 * `-` lo interpretaria compose como una opcion, no como un valor.
 */
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export class UnsafePathError extends Error {
  constructor(path: string) {
    super(`La ruta ${path} queda fuera de las carpetas permitidas`);
    this.name = 'UnsafePathError';
  }
}

export class ComposeError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'ComposeError';
  }
}

export interface ComposeTarget {
  projectName: string;
  workingDir: string;
  configFiles: string[];
}

export interface ComposeOptions {
  scope: RecreateScope;
  serviceName?: string;
  forceRecreate?: boolean;
  onOutput?: (line: string) => void;
  /** Identifica el trabajo para poder cancelar su proceso. */
  jobId?: number;
}

export class ComposeRunner {
  /** Procesos de compose vivos, por trabajo, para poder cancelarlos. */
  readonly #running = new Map<number, ChildProcess>();

  constructor(
    private readonly dockerBin: string,
    private readonly allowedRoots: string[],
    private readonly timeoutMs: number,
    private readonly dockerHost: string,
    private readonly log: Logger,
  ) {}

  /**
   * Valida el YAML antes de tocar nada.
   *
   * Esto no es opcional en Synology: Container Manager guarda las variables de
   * entorno del proyecto en su propio almacen, asi que puede no haber ningun
   * `.env` junto al YAML. Si el fichero referencia `${DB_PASSWORD}` y esa
   * variable no esta, `up` falla a mitad y deja el stack a medio levantar. Con
   * `config --quiet` el fallo ocurre antes de haber parado nada.
   */
  async validate(target: ComposeTarget): Promise<void> {
    const { files, cwd } = await this.#resolveTarget(target);
    try {
      await this.#run(['--project-name', target.projectName, ...flagFiles(files), 'config', '--quiet'], cwd);
    } catch (error) {
      const composeError = error as ComposeError;
      throw new ComposeError(
        `El fichero del proyecto no es valido: ${firstMeaningfulLine(composeError.stderr)}`,
        composeError.stdout ?? '',
        composeError.stderr ?? '',
      );
    }
  }

  async pull(target: ComposeTarget, options: ComposeOptions): Promise<void> {
    const { files, cwd } = await this.#resolveTarget(target);
    const args = [
      '--project-name',
      target.projectName,
      '--project-directory',
      cwd,
      ...flagFiles(files),
      'pull',
    ];
    if (options.scope === 'service' && options.serviceName) {
      assertSafeName(options.serviceName);
      args.push(options.serviceName);
    }
    await this.#run(args, cwd, options.onOutput, options.jobId);
  }

  async up(target: ComposeTarget, options: ComposeOptions): Promise<void> {
    const { files, cwd } = await this.#resolveTarget(target);

    const args = [
      '--project-name',
      target.projectName,
      // Sin --project-directory, compose resuelve las rutas relativas de los
      // binds respecto al directorio del primer -f, que no siempre coincide.
      '--project-directory',
      cwd,
      ...flagFiles(files),
      'up',
      '--detach',
      '--pull',
      'always',
    ];

    if (options.forceRecreate) args.push('--force-recreate');

    if (options.scope === 'service' && options.serviceName) {
      assertSafeName(options.serviceName);
      // --no-deps es lo que evita tumbar la base de datos del stack para
      // actualizar el frontend. Es el default deliberadamente.
      args.push('--no-deps', options.serviceName);
    }

    await this.#run(args, cwd, options.onOutput, options.jobId);
  }

  async restart(target: ComposeTarget, options: ComposeOptions): Promise<void> {
    const { files, cwd } = await this.#resolveTarget(target);
    const args = [
      '--project-name',
      target.projectName,
      '--project-directory',
      cwd,
      ...flagFiles(files),
      'restart',
    ];
    if (options.scope === 'service' && options.serviceName) {
      assertSafeName(options.serviceName);
      args.push(options.serviceName);
    }
    await this.#run(args, cwd, options.onOutput, options.jobId);
  }

  async #resolveTarget(target: ComposeTarget): Promise<{ files: string[]; cwd: string }> {
    assertSafeName(target.projectName);

    const check = await checkComposeAccessibility(
      { workingDir: target.workingDir, configFiles: target.configFiles },
      this.allowedRoots,
    );
    if (!check.accessible || !check.resolvedWorkingDir) {
      throw new UnsafePathError(check.reason ?? target.workingDir);
    }
    return { files: check.resolvedFiles, cwd: check.resolvedWorkingDir };
  }

  /**
   * Ejecuta compose con la salida en directo.
   *
   * Se usa `spawn` y no `execFile` por dos motivos que resultaron ser el mismo
   * problema: `execFile` acumula toda la salida y solo la entrega al terminar,
   * asi que durante una descarga larga el registro se ve vacio y parece que no
   * pasa nada; y ademas no deja acceso al proceso, con lo que un trabajo
   * atascado no se podia cancelar.
   *
   * El proceso se registra en `#running` para poder matarlo desde fuera.
   */
  async #run(
    args: string[],
    cwd: string,
    onOutput?: (line: string) => void,
    jobId?: number,
  ): Promise<string> {
    const full = ['compose', ...args];
    this.log.debug(`Ejecutando: ${this.dockerBin} ${full.join(' ')}`);

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.dockerBin, full, {
        cwd,
        // Entorno explicito y minimo. Heredar `process.env` filtraria
        // CU_ENCRYPTION_KEY y el token de Telegram a un subproceso que
        // perfectamente puede volcar su entorno en un mensaje de error.
        env: {
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          HOME: '/tmp',
          DOCKER_HOST: this.dockerHost,
          COMPOSE_PROGRESS: 'plain',
          NO_COLOR: '1',
          TZ: process.env.TZ ?? 'UTC',
        },
        shell: false,
      });

      if (jobId !== undefined) this.#running.set(jobId, child);

      let stdout = '';
      let stderr = '';
      let settled = false;

      // Se acumula por trozos y se emite por lineas completas: los trozos no
      // respetan los saltos de linea y partirian los mensajes por la mitad.
      const makeReader = (collect: (text: string) => void) => {
        let buffer = '';
        return (chunk: Buffer): void => {
          const text = chunk.toString('utf8');
          collect(text);
          buffer += text;
          let index: number;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trimEnd();
            buffer = buffer.slice(index + 1);
            if (line) onOutput?.(line);
          }
        };
      };

      child.stdout?.on('data', makeReader((text) => (stdout += text)));
      // Compose escribe su progreso por stderr aunque todo vaya bien.
      child.stderr?.on('data', makeReader((text) => (stderr += text)));

      /**
       * Corte por tiempo, en dos fases.
       *
       * Un SIGTERM a secas no siempre basta: si el CLI esta bloqueado en una
       * descarga puede ignorarlo y el trabajo se queda colgado indefinidamente,
       * que es exactamente lo que hay que evitar. Se le da margen para salir
       * bien y, si no lo hace, SIGKILL.
       */
      const timer = setTimeout(() => {
        onOutput?.(
          `Tiempo limite de ${Math.round(this.timeoutMs / 60000)} minutos superado, deteniendo`,
        );
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 10_000).unref();
      }, this.timeoutMs);

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (jobId !== undefined) this.#running.delete(jobId);
        fn();
      };

      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(() => {
          if (error.code === 'ENOENT') {
            reject(
              new ComposeError(
                `No se encuentra el binario "${this.dockerBin}". La imagen debe incluir el CLI de Docker y el plugin de Compose.`,
                stdout,
                stderr,
              ),
            );
            return;
          }
          reject(new ComposeError(error.message, stdout, stderr));
        });
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        finish(() => {
          if (signal) {
            reject(
              new ComposeError(
                signal === 'SIGTERM' || signal === 'SIGKILL'
                  ? 'Docker Compose se ha detenido (cancelado o tiempo limite superado)'
                  : `Docker Compose ha terminado por la senal ${signal}`,
                stdout,
                stderr,
              ),
            );
            return;
          }
          if (code !== 0) {
            reject(new ComposeError(firstMeaningfulLine(stderr) || `codigo ${code}`, stdout, stderr));
            return;
          }
          resolve(stdout);
        });
      });
    });
  }

  /** Mata el proceso de compose de un trabajo. Devuelve false si ya no corria. */
  cancel(jobId: number): boolean {
    const child = this.#running.get(jobId);
    if (!child) return false;
    child.kill('SIGTERM');
    // Red de seguridad: si no se va por las buenas, se fuerza.
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 5000).unref();
    return true;
  }

}

function flagFiles(files: string[]): string[] {
  return files.flatMap((file) => ['-f', file]);
}

function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new UnsafePathError(`nombre no valido: ${name}`);
  }
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
}

/**
 * Compose escribe muchas lineas de progreso antes del error real. Se busca la
 * ultima linea con contenido, que es donde suele estar el motivo.
 */
function firstMeaningfulLine(stderr: string): string {
  const lines = splitLines(stderr).filter(
    (line) => !/^(\s*(Container|Network|Volume|Image)\s|\s*[-|]\s*$)/.test(line),
  );
  return lines.at(-1) ?? '';
}
