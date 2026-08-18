/**
 * Operaciones de alto nivel sobre la API de Docker.
 */
import { Buffer } from 'node:buffer';
import { DockerClient, DockerError } from './client.js';
import type {
  ContainerInspect,
  ContainerListItem,
  ContainerStats,
  CreateContainerBody,
  ImageInspect,
  ImageListItem,
  NetworkAttachment,
  SystemDf,
  VolumeListItem,
} from './types.js';
import type { RegistryCredentials } from '../db/repositories/index.js';
import { localRepositoryName, type ImageReference } from '../registry/reference.js';
import type { Logger } from '../logger.js';

export class DockerApi {
  constructor(
    readonly client: DockerClient,
    private readonly log: Logger,
  ) {}

  // -- Contenedores ---------------------------------------------------------

  listContainers(all = true): Promise<ContainerListItem[]> {
    return this.client.request<ContainerListItem[]>({
      path: `/containers/json?all=${all ? 1 : 0}`,
    });
  }

  inspectContainer(id: string): Promise<ContainerInspect> {
    return this.client.request<ContainerInspect>({ path: `/containers/${id}/json` });
  }

  async startContainer(id: string): Promise<void> {
    await this.client.request({ method: 'POST', path: `/containers/${id}/start` });
  }

  async stopContainer(id: string, timeoutSeconds = 10): Promise<void> {
    await this.client.request({
      method: 'POST',
      path: `/containers/${id}/stop?t=${timeoutSeconds}`,
      // El daemon espera hasta `t` segundos antes del SIGKILL, asi que el
      // timeout de red debe ser mayor o cortariamos nosotros primero.
      timeoutMs: (timeoutSeconds + 30) * 1000,
    });
  }

  async restartContainer(id: string, timeoutSeconds = 10): Promise<void> {
    await this.client.request({
      method: 'POST',
      path: `/containers/${id}/restart?t=${timeoutSeconds}`,
      timeoutMs: (timeoutSeconds + 60) * 1000,
    });
  }

  async renameContainer(id: string, name: string): Promise<void> {
    await this.client.request({
      method: 'POST',
      path: `/containers/${id}/rename?name=${encodeURIComponent(name)}`,
    });
  }

  async removeContainer(id: string, force = false): Promise<void> {
    await this.client.request({
      method: 'DELETE',
      path: `/containers/${id}?force=${force ? 1 : 0}&v=0`,
    });
  }

  async createContainer(name: string, body: CreateContainerBody): Promise<string> {
    const result = await this.client.request<{ Id: string; Warnings?: string[] }>({
      method: 'POST',
      path: `/containers/create?name=${encodeURIComponent(name)}`,
      body,
    });
    for (const warning of result.Warnings ?? []) {
      this.log.warn(`Docker avisa al crear ${name}: ${warning}`);
    }
    return result.Id;
  }

  /**
   * Logs de un contenedor.
   *
   * Sin TTY, Docker multiplexa stdout y stderr con una cabecera binaria de 8
   * bytes por trama. Volcar el cuerpo tal cual mete bytes de control en medio
   * del texto, asi que hay que demultiplexar.
   */
  async containerLogs(id: string, tail = 200): Promise<string> {
    const { text, status } = await this.client.rawRequest({
      path: `/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=0`,
      headers: { Accept: 'application/octet-stream' },
    });
    if (status >= 400) throw new DockerError(`No se han podido leer los logs`, status, text);

    const inspect = await this.inspectContainer(id).catch(() => null);
    if (inspect?.Config.Tty) return text;
    return demultiplexLogs(Buffer.from(text, 'binary'));
  }

  stats(id: string): Promise<ContainerStats> {
    return this.client.request<ContainerStats>({
      path: `/containers/${id}/stats?stream=false&one-shot=false`,
      timeoutMs: 15_000,
    });
  }

  // -- Imagenes -------------------------------------------------------------

  listImages(): Promise<ImageListItem[]> {
    return this.client.request<ImageListItem[]>({ path: '/images/json?all=0' });
  }

  inspectImage(ref: string): Promise<ImageInspect> {
    return this.client.request<ImageInspect>({
      path: `/images/${encodeURIComponent(ref)}/json`,
    });
  }

  /**
   * Descarga una imagen.
   *
   * El endpoint responde 200 aunque el pull falle y comunica el error dentro
   * del flujo de progreso, asi que hay que leerlo entero y buscar el campo
   * `error`. Devolver sin comprobarlo haria que un pull fallido pasara por
   * bueno y el recreate siguiera adelante con la imagen vieja.
   */
  async pullImage(
    ref: ImageReference,
    credentials: RegistryCredentials | null,
    onProgress?: (message: string) => void,
  ): Promise<void> {
    // El daemon espera el nombre con el que guarda la imagen, no el host de la
    // API del registry. Misma conversion que en el resto del codigo, en un
    // unico sitio para que no puedan divergir.
    const fromImage = localRepositoryName(ref);

    const headers: Record<string, string> = {};
    if (credentials) {
      // X-Registry-Auth va en base64url, no en base64 estandar: el estandar
      // puede incluir '+' y '/', que rompen la cabecera HTTP.
      headers['X-Registry-Auth'] = Buffer.from(
        JSON.stringify({
          username: credentials.username,
          password: credentials.secret,
          serveraddress: ref.host,
        }),
      ).toString('base64url');
    }

    let lastError: string | null = null;
    const seen = new Set<string>();

    await this.client.streamLines(
      {
        method: 'POST',
        path: `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(ref.tag)}`,
        headers,
        timeoutMs: 60 * 60_000,
      },
      (line) => {
        try {
          const event = JSON.parse(line) as {
            status?: string;
            error?: string;
            errorDetail?: { message?: string };
            id?: string;
          };
          if (event.error || event.errorDetail?.message) {
            lastError = event.errorDetail?.message ?? event.error ?? 'error desconocido';
            return;
          }
          // El progreso por capa genera cientos de lineas identicas; solo se
          // reporta cada estado una vez para no inundar el log del trabajo.
          if (event.status && !seen.has(event.status)) {
            seen.add(event.status);
            onProgress?.(event.status);
          }
        } catch {
          // Linea no JSON: el daemon a veces intercala texto plano.
        }
      },
    );

    if (lastError) throw new Error(`No se ha podido descargar la imagen: ${lastError}`);
  }

  async removeImage(ref: string, force = false): Promise<void> {
    await this.client.request({
      method: 'DELETE',
      path: `/images/${encodeURIComponent(ref)}?force=${force ? 1 : 0}&noprune=0`,
    });
  }

  /**
   * Pone una etiqueta a una imagen que ya esta en disco.
   *
   * Lo usa la vuelta atras, y es el paso que la hace funcionar con Compose: el
   * fichero del proyecto nombra la etiqueta (`algo:latest`), no el digest, asi
   * que hasta que la etiqueta no apunte a la version vieja, levantar el
   * proyecto seguiria trayendo la nueva.
   */
  async tagImage(source: string, repo: string, tag: string): Promise<void> {
    await this.client.request({
      method: 'POST',
      path: `/images/${encodeURIComponent(source)}/tag?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
    });
  }

  // -- Almacenamiento -------------------------------------------------------

  /**
   * Uso de disco por tipo de objeto.
   *
   * Puede tardar segundos: el daemon recorre el disco para calcularlo. No se
   * llama desde ningun bucle, solo cuando el usuario abre la pantalla.
   */
  systemDf(): Promise<SystemDf> {
    return this.client.request<SystemDf>({ path: '/system/df', timeoutMs: 60_000 });
  }

  listVolumes(): Promise<{ Volumes?: VolumeListItem[] | null }> {
    return this.client.request<{ Volumes?: VolumeListItem[] | null }>({ path: '/volumes' });
  }

  async removeVolume(name: string, force = false): Promise<void> {
    await this.client.request({
      method: 'DELETE',
      path: `/volumes/${encodeURIComponent(name)}?force=${force ? 1 : 0}`,
    });
  }

  /**
   * Limpia la cache de construccion.
   *
   * Devuelve cuanto se ha liberado. Puede no existir: Podman no siempre expone
   * este endpoint en su API compatible, y ahi devuelve 404. Se traduce a cero
   * liberado en vez de a un error, porque no tener cache que limpiar no es un
   * fallo.
   */
  async pruneBuildCache(): Promise<number> {
    try {
      const result = await this.client.request<{ SpaceReclaimed?: number }>({
        method: 'POST',
        path: '/build/prune',
        timeoutMs: 120_000,
      });
      return result.SpaceReclaimed ?? 0;
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return 0;
      throw error;
    }
  }

  // -- Redes ----------------------------------------------------------------

  async connectNetwork(networkId: string, containerId: string, config: NetworkAttachment): Promise<void> {
    await this.client.request({
      method: 'POST',
      path: `/networks/${encodeURIComponent(networkId)}/connect`,
      body: {
        Container: containerId,
        EndpointConfig: {
          Aliases: config.Aliases ?? undefined,
          IPAMConfig: config.IPAMConfig ?? undefined,
          Links: config.Links ?? undefined,
          DriverOpts: config.DriverOpts ?? undefined,
        },
      },
    });
  }
}

/**
 * Demultiplexa el formato de flujo de Docker.
 *
 * Cada trama son 8 bytes de cabecera: byte 0 = flujo (1 stdout, 2 stderr),
 * bytes 1-3 sin usar, bytes 4-7 = longitud en big endian.
 */
export function demultiplexLogs(buffer: Buffer): string {
  const parts: string[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    // Si el primer byte no es un tipo de flujo valido, el contenido no venia
    // multiplexado (algunos daemons y Podman lo devuelven en crudo).
    if (streamType !== 0 && streamType !== 1 && streamType !== 2) {
      return buffer.toString('utf8');
    }
    const length = buffer.readUInt32BE(offset + 4);
    if (length > buffer.length - offset - 8) break;
    parts.push(buffer.subarray(offset + 8, offset + 8 + length).toString('utf8'));
    offset += 8 + length;
  }

  return parts.length > 0 ? parts.join('') : buffer.toString('utf8');
}
