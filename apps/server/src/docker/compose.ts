/**
 * Ejecucion de Docker Compose.
 *
 * Regla absoluta: `execFile` con `shell: false`, nunca `exec` ni plantillas de
 * cadena. Los nombres de proyecto y servicio vienen de labels que controla
 * quien haya creado el contenedor, asi que se tratan como entrada no confiable.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RecreateScope } from '@cu/shared';
import { checkComposeAccessibility } from './projects.js';
import type { Logger } from '../logger.js';

const execFileAsync = promisify(execFile);

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
}

export class ComposeRunner {
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
    await this.#run(args, cwd, options.onOutput);
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

    await this.#run(args, cwd, options.onOutput);
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
    await this.#run(args, cwd, options.onOutput);
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

  async #run(args: string[], cwd: string, onOutput?: (line: string) => void): Promise<string> {
    const full = ['compose', ...args];
    this.log.debug(`Ejecutando: ${this.dockerBin} ${full.join(' ')}`);

    try {
      const { stdout, stderr } = await execFileAsync(this.dockerBin, full, {
        cwd,
        // Entorno explicito y minimo. Heredar `process.env` filtraria
        // CU_ENCRYPTION_KEY y el token de Telegram a un subproceso que
        // perfectamente puede volcar su entorno en un mensaje de error.
        env: {
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          HOME: '/tmp',
          DOCKER_HOST: this.dockerHost,
          COMPOSE_PROGRESS: 'plain',
          // Sin esto compose escribe secuencias ANSI que ensucian el log del
          // trabajo que luego se muestra en la interfaz.
          NO_COLOR: '1',
          TZ: process.env.TZ ?? 'UTC',
        },
        timeout: this.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        shell: false,
      });

      // Compose escribe su progreso por stderr aunque todo vaya bien.
      for (const line of splitLines(stderr)) onOutput?.(line);
      for (const line of splitLines(stdout)) onOutput?.(line);
      return stdout;
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string; killed?: boolean };
      const stdout = err.stdout ?? '';
      const stderr = err.stderr ?? '';
      for (const line of splitLines(stderr)) onOutput?.(line);

      if (err.killed) {
        throw new ComposeError(
          `Docker Compose ha excedido el tiempo limite de ${Math.round(this.timeoutMs / 60000)} minutos`,
          stdout,
          stderr,
        );
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ComposeError(
          `No se encuentra el binario "${this.dockerBin}". La imagen debe incluir el CLI de Docker y el plugin de Compose.`,
          stdout,
          stderr,
        );
      }
      throw new ComposeError(firstMeaningfulLine(stderr) || err.message, stdout, stderr);
    }
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
