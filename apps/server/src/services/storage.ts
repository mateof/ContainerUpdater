/**
 * Espacio en disco: que ocupa cada cosa y que se puede soltar.
 *
 * La diferencia de trato respecto a las imagenes es deliberada. Una imagen
 * huerfana se vuelve a descargar; los datos de un volumen no vuelven. Por eso
 * aqui NO hay limpieza masiva de volumenes: se listan uno a uno, con su tamano
 * y de que proyecto venian, y se borran de uno en uno. `docker volume prune`
 * existe para quien quiera ese riesgo, y no hace falta que lo ofrezcamos desde
 * un boton.
 */
import type { StorageUsage, UnusedVolume } from '@cu/shared';
import type { DockerApi } from '../docker/api.js';
import type { VolumeListItem } from '../docker/types.js';
import type { Logger } from '../logger.js';

/** Etiqueta con la que Compose marca los volumenes que crea. */
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

export class StorageService {
  constructor(
    private readonly docker: DockerApi,
    private readonly log: Logger,
  ) {}

  async usage(): Promise<StorageUsage> {
    /**
     * Hacen falta las DOS llamadas, y no es redundancia.
     *
     * Comprobado en vivo contra Podman: `/system/df` calcula los tamanos pero
     * devuelve los volumenes SIN sus etiquetas, mientras que `/volumes` trae las
     * etiquetas pero no el tamano. Sin cruzarlas, ningun volumen mostraria de
     * que proyecto viene, que es justo el dato que permite decidir si sobra.
     */
    const [df, list] = await Promise.all([
      this.docker.systemDf(),
      this.docker.listVolumes().catch(() => ({ Volumes: [] })),
    ]);
    const labelsByName = new Map(
      (list.Volumes ?? []).map((volume) => [volume.Name, volume.Labels ?? null]),
    );
    let partial = false;

    const images = df.Images ?? [];
    const imagesTotal = sum(images.map((image) => image.Size ?? 0));
    // Reclamable = lo que no usa ningun contenedor. Es la misma definicion que
    // usa `docker system df`, para que los numeros cuadren con el CLI.
    const imagesReclaimable = sum(
      images.filter((image) => (image.Containers ?? 0) <= 0).map((image) => image.Size ?? 0),
    );

    const containers = df.Containers ?? [];
    const volumes = df.Volumes ?? [];
    const cache = df.BuildCache;
    if (!cache) partial = true;

    const unusedVolumes = volumes
      .filter((volume) => (volume.UsageData?.RefCount ?? 0) <= 0)
      .map((volume) =>
        // `??` no vale aqui: comprobado en vivo, `/system/df` devuelve
        // `Labels: {}` (objeto VACIO, no nulo), asi que ganaria siempre y las
        // etiquetas buenas de `/volumes` no se usarian nunca.
        toUnusedVolume({ ...volume, Labels: pickLabels(volume.Labels, labelsByName.get(volume.Name)) }),
      )
      .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));

    return {
      images: { total: imagesTotal, reclaimable: imagesReclaimable, count: images.length },
      containers: {
        total: sum(containers.map((container) => container.SizeRw ?? 0)),
        count: containers.length,
      },
      volumes: {
        total: sum(volumes.map((volume) => volume.UsageData?.Size ?? 0)),
        reclaimable: sum(unusedVolumes.map((volume) => volume.sizeBytes ?? 0)),
        count: volumes.length,
      },
      buildCache: {
        total: sum((cache ?? []).map((entry) => entry.Size ?? 0)),
        reclaimable: sum(
          (cache ?? []).filter((entry) => !entry.InUse).map((entry) => entry.Size ?? 0),
        ),
        count: cache?.length ?? 0,
      },
      unusedVolumes,
      partial,
    };
  }

  /**
   * Borra un volumen concreto.
   *
   * Se vuelve a comprobar aqui que sigue sin usarse, y no solo en la pantalla:
   * entre que el usuario abrio la lista y pulso el boton puede haber arrancado
   * un contenedor. Sin esta comprobacion, `force` borraria datos vivos.
   */
  async removeVolume(name: string): Promise<void> {
    const list = await this.docker.listVolumes();
    const volume = (list.Volumes ?? []).find((entry) => entry.Name === name);
    if (!volume) throw new VolumeNotFoundError(name);

    const refCount = volume.UsageData?.RefCount ?? 0;
    if (refCount > 0) throw new VolumeInUseError(name, refCount);

    // Nunca con force: si el daemon dice que esta en uso, se le hace caso.
    await this.docker.removeVolume(name, false);
    this.log.info(`Volumen borrado: ${name}`);
  }

  async pruneBuildCache(): Promise<number> {
    const freed = await this.docker.pruneBuildCache();
    this.log.info(`Cache de construccion limpiada: ${freed} bytes`);
    return freed;
  }
}

export class VolumeInUseError extends Error {
  constructor(
    readonly volumeName: string,
    readonly refCount: number,
  ) {
    super(`El volumen ${volumeName} lo usan ${refCount} contenedor(es)`);
    this.name = 'VolumeInUseError';
  }
}

export class VolumeNotFoundError extends Error {
  constructor(readonly volumeName: string) {
    super(`No existe el volumen ${volumeName}`);
    this.name = 'VolumeNotFoundError';
  }
}

function toUnusedVolume(volume: VolumeListItem): UnusedVolume {
  const created = volume.CreatedAt ? Date.parse(volume.CreatedAt) : Number.NaN;
  return {
    name: volume.Name,
    driver: volume.Driver ?? 'local',
    mountpoint: volume.Mountpoint ?? '',
    createdAt: Number.isFinite(created) ? created : null,
    // Puede faltar: solo `/system/df` calcula tamanos, y no en todos los
    // runtimes. Un null se muestra como desconocido en vez de como cero, que
    // haria parecer vacio un volumen con diez gigas dentro.
    sizeBytes: volume.UsageData?.Size ?? null,
    projectName: volume.Labels?.[COMPOSE_PROJECT_LABEL] ?? null,
  };
}

/** El primero que traiga algo. Un objeto vacio cuenta como "no trae nada". */
export function pickLabels(
  ...candidates: Array<Record<string, string> | null | undefined>
): Record<string, string> | null {
  for (const labels of candidates) {
    if (labels && Object.keys(labels).length > 0) return labels;
  }
  return null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
