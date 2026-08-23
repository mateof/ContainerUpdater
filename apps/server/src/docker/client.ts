/**
 * Cliente HTTP contra el daemon de Docker.
 *
 * Se habla directamente con la API por `node:http` en vez de usar dockerode.
 * Motivos: dockerode arrastra dependencias y una capa de callbacks que aqui no
 * aporta, necesitamos control fino de la negociacion de version (el backend
 * puede ser Podman, que anuncia una API bastante mas antigua), y el streaming
 * de stats y logs se maneja mejor a mano.
 */
import http from 'node:http';
import { Buffer } from 'node:buffer';
import type { Logger } from '../logger.js';

/** Version maxima que pedimos. Se capa a la que anuncie el servidor. */
const PREFERRED_API_VERSION = '1.44';

export class DockerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'DockerError';
  }
}

export class DockerUnavailableError extends Error {
  constructor(cause: string) {
    super(`No hay conexion con Docker: ${cause}`);
    this.name = 'DockerUnavailableError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'HEAD';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** `0` = sin limite, para flujos que no terminan (los eventos del daemon). */
  timeoutMs?: number;
  /** Cierra el flujo desde fuera, para el apagado ordenado. */
  signal?: AbortSignal;
  /** No anteponer el prefijo de version. Solo para /version y /_ping. */
  raw?: boolean;
}

export interface DockerVersionInfo {
  version: string;
  apiVersion: string;
  minApiVersion: string;
  flavor: 'docker' | 'podman' | 'unknown';
  os: string;
  arch: string;
}

export class DockerClient {
  #apiVersion: string | null = null;
  #info: DockerVersionInfo | null = null;
  #ncpu = 1;
  #memTotal = 0;

  private readonly connection:
    | { kind: 'unix'; socketPath: string }
    | { kind: 'tcp'; host: string; port: number };

  constructor(
    dockerHost: string,
    private readonly log: Logger,
  ) {
    this.connection = parseDockerHost(dockerHost);
  }

  get versionInfo(): DockerVersionInfo | null {
    return this.#info;
  }

  get ncpu(): number {
    return this.#ncpu;
  }

  get hostMemTotal(): number {
    return this.#memTotal;
  }

  get connected(): boolean {
    return this.#info !== null;
  }

  /**
   * Negocia la version de API y cachea datos del host.
   *
   * Pedir una version superior a la que anuncia el servidor devuelve 400 en
   * todas las llamadas, asi que se toma el minimo. Verificado: Podman anuncia
   * ApiVersion 1.41, muy por debajo de lo que da un dockerd moderno.
   */
  async connect(): Promise<DockerVersionInfo> {
    const version = (await this.request<{
      Version: string;
      ApiVersion: string;
      MinAPIVersion?: string;
      Os: string;
      Arch: string;
      Components?: Array<{ Name: string }>;
    }>({ path: '/version', raw: true })) ?? null;

    if (!version) throw new DockerUnavailableError('respuesta vacia de /version');

    const serverApi = version.ApiVersion ?? '1.24';
    this.#apiVersion = lowerVersion(PREFERRED_API_VERSION, serverApi);

    const componentNames = (version.Components ?? []).map((c) => c.Name).join(' ').toLowerCase();
    const flavor: DockerVersionInfo['flavor'] = componentNames.includes('podman')
      ? 'podman'
      : componentNames.includes('engine') || version.Version
        ? 'docker'
        : 'unknown';

    this.#info = {
      version: version.Version,
      apiVersion: serverApi,
      minApiVersion: version.MinAPIVersion ?? '1.24',
      flavor,
      os: version.Os,
      arch: version.Arch,
    };

    try {
      const info = await this.request<{ NCPU?: number; MemTotal?: number }>({ path: '/info' });
      // Podman puede devolver NCPU a 0. Un 0 aqui haria que el CPU% saliera
      // siempre 0, asi que se cae a 1 como minimo defendible.
      this.#ncpu = info?.NCPU && info.NCPU > 0 ? info.NCPU : 1;
      this.#memTotal = info?.MemTotal ?? 0;
    } catch (error) {
      this.log.warn('No se ha podido leer /info del daemon', error);
    }

    this.log.info(
      `Docker conectado: ${this.#info.flavor} ${this.#info.version} (API ${serverApi}, usando v${this.#apiVersion})`,
    );
    return this.#info;
  }

  async ping(): Promise<boolean> {
    try {
      await this.request({ path: '/_ping', raw: true, timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const { text, status } = await this.rawRequest(options);
    if (status >= 400) {
      throw new DockerError(extractMessage(text, status), status, text);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /**
   * Peticion que devuelve el cuerpo crudo. Se usa para respuestas que no son
   * JSON (logs multiplexados) y para las que son un flujo de objetos JSON
   * separados por saltos de linea (progreso del pull).
   */
  async rawRequest(options: RequestOptions): Promise<{ text: string; status: number }> {
    const path = options.raw ? options.path : `/v${this.#apiVersion ?? '1.24'}${options.path}`;
    const payload =
      options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8');

    const headers: Record<string, string> = {
      Host: 'docker',
      Accept: 'application/json',
      ...options.headers,
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }

    const requestOptions: http.RequestOptions = {
      method: options.method ?? 'GET',
      path,
      headers,
      ...(this.connection.kind === 'unix'
        ? { socketPath: this.connection.socketPath }
        : { host: this.connection.host, port: this.connection.port }),
    };

    return new Promise((resolve, reject) => {
      const req = http.request(requestOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            text: Buffer.concat(chunks).toString('utf8'),
            status: res.statusCode ?? 0,
          }),
        );
        res.on('error', reject);
      });

      // Timeout generoso por defecto: un pull de imagen grande en un NAS con
      // ADSL puede tardar bastante y cortarlo a medias deja basura.
      req.setTimeout(options.timeoutMs ?? 120_000, () => {
        req.destroy(new Error(`Tiempo de espera agotado en ${options.method ?? 'GET'} ${path}`));
      });

      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
          reject(
            new DockerUnavailableError(
              this.connection.kind === 'unix'
                ? `no se encuentra el socket ${this.connection.socketPath}. ` +
                  'Comprueba que has montado -v /var/run/docker.sock:/var/run/docker.sock'
                : `no se puede conectar a ${this.connection.host}:${this.connection.port}`,
            ),
          );
          return;
        }
        reject(error);
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * Consume una respuesta en streaming linea a linea. La usa el pull, cuya
   * respuesta es un flujo de objetos JSON de progreso que hay que leer entero
   * para saber si termino bien: un pull fallido puede devolver 200 y comunicar
   * el error solo dentro del cuerpo.
   */
  async streamLines(
    options: RequestOptions,
    onLine: (line: string) => void,
  ): Promise<void> {
    const path = options.raw ? options.path : `/v${this.#apiVersion ?? '1.24'}${options.path}`;
    const requestOptions: http.RequestOptions = {
      method: options.method ?? 'POST',
      path,
      headers: { Host: 'docker', Accept: 'application/json', ...options.headers },
      ...(this.connection.kind === 'unix'
        ? { socketPath: this.connection.socketPath }
        : { host: this.connection.host, port: this.connection.port }),
    };

    return new Promise((resolve, reject) => {
      const req = http.request(requestOptions, (res) => {
        let buffer = '';
        let errorBody = '';

        res.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if ((res.statusCode ?? 0) >= 400) {
            errorBody += text;
            return;
          }
          buffer += text;
          let index: number;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line) onLine(line);
          }
        });

        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(
              new DockerError(
                extractMessage(errorBody, res.statusCode ?? 0),
                res.statusCode ?? 0,
                errorBody,
              ),
            );
            return;
          }
          const rest = buffer.trim();
          if (rest) onLine(rest);
          resolve();
        });

        res.on('error', reject);
      });

      /**
       * `timeoutMs: 0` significa "sin limite".
       *
       * Hace falta para el flujo de eventos del daemon, que por definicion no
       * termina: con el limite de media hora la conexion se cortaria sola cada
       * treinta minutos y el panel dejaria de enterarse de los cambios durante
       * el hueco hasta que alguien reconectara.
       */
      const limite = options.timeoutMs ?? 30 * 60_000;
      if (limite > 0) {
        req.setTimeout(limite, () => {
          req.destroy(new Error('Tiempo de espera agotado durante la descarga'));
        });
      }

      if (options.signal) {
        if (options.signal.aborted) {
          req.destroy();
          resolve();
          return;
        }
        options.signal.addEventListener(
          'abort',
          () => {
            // Cerrar a proposito no es un fallo: se resuelve en vez de
            // rechazar, o el cierre ordenado del servicio pareceria un error.
            req.destroy();
            resolve();
          },
          { once: true },
        );
      }

      req.on('error', reject);
      req.end();
    });
  }
}

/**
 * Acepta `unix:///var/run/docker.sock`, `tcp://host:2375`, `http://host:2375`
 * y una ruta de socket a secas.
 */
export function parseDockerHost(
  value: string,
): { kind: 'unix'; socketPath: string } | { kind: 'tcp'; host: string; port: number } {
  if (value.startsWith('unix://')) {
    return { kind: 'unix', socketPath: value.slice('unix://'.length) };
  }
  if (value.startsWith('tcp://') || value.startsWith('http://')) {
    const url = new URL(value.replace(/^tcp:\/\//, 'http://'));
    return { kind: 'tcp', host: url.hostname, port: Number(url.port || 2375) };
  }
  if (value.startsWith('/')) {
    return { kind: 'unix', socketPath: value };
  }
  throw new Error(
    `DOCKER_HOST no reconocido: ${value}. Se esperaba unix:///ruta/al.sock o tcp://host:puerto`,
  );
}

/** Compara versiones tipo "1.41" y devuelve la menor. */
export function lowerVersion(a: string, b: string): string {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return a;
    if (va > vb) return b;
  }
  return a;
}

function extractMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; cause?: string };
    if (parsed.message) return parsed.message;
  } catch {
    // El cuerpo no era JSON: se usa tal cual, recortado.
  }
  const trimmed = body.trim().slice(0, 300);
  return trimmed || `Docker respondio ${status}`;
}
