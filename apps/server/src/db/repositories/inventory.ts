import type { Db } from '../index.js';
import type {
  ImagePolicy,
  ImageSource,
  RecreateScope,
  SemverChannel,
  TrackMode,
  UpdateStatus,
} from '@cu/shared';

export interface ImageRow {
  id: number;
  normalized_ref: string;
  host: string;
  repository: string;
  tag: string;
  image_id: string | null;
  architecture: string | null;
  os: string | null;
  variant: string | null;
  local_digests: string;
  source: ImageSource;
  size_bytes: number | null;
  image_created_at: number | null;
  status: UpdateStatus;
  remote_digest: string | null;
  candidate_tag: string | null;
  last_checked_at: number | null;
  last_error: string | null;
  first_seen_at: number;
  last_seen_at: number;
  in_use: number;
  remote_created_at: number | null;
  remote_source_url: string | null;
  remote_revision: string | null;
  remote_version: string | null;
  local_source_url: string | null;
  local_revision: string | null;
  installed_version: string | null;
  installed_version_method: string | null;
  installed_version_for: string | null;
}

export interface ProjectRow {
  id: number;
  project_name: string;
  working_dir: string;
  config_files: string;
  yaml_accessible: number;
  last_error: string | null;
  last_verified_at: number | null;
}

export interface PolicyRow {
  image_ref: string;
  auto_update: number;
  track_mode: TrackMode;
  semver_channel: SemverChannel;
  notify: number;
  recreate_scope: RecreateScope;
  remove_image_on_force: number;
  cleanup_old_image: number;
  paused_until: number | null;
  ignored_digest: string | null;
  min_age_hours: number | null;
}

export const DEFAULT_POLICY: Omit<ImagePolicy, 'imageRef'> = {
  autoUpdate: false,
  trackMode: 'digest',
  semverChannel: 'minor',
  notify: true,
  recreateScope: 'service',
  removeImageOnForce: false,
  cleanupOldImage: true,
  pausedUntil: null,
  ignoredDigest: null,
  minAgeHours: null,
};

export function createInventoryRepository(db: Db) {
  const upsertImage = db.prepare(
    `INSERT INTO tracked_images
       (normalized_ref, host, repository, tag, image_id, architecture, os, variant,
        local_digests, source, size_bytes, image_created_at, local_source_url,
        local_revision, in_use, first_seen_at, last_seen_at)
     VALUES (@ref, @host, @repository, @tag, @imageId, @architecture, @os, @variant,
             @localDigests, @source, @sizeBytes, @imageCreatedAt, @localSourceUrl,
             @localRevision, @inUse, @now, @now)
     ON CONFLICT(normalized_ref) DO UPDATE SET
       image_id = excluded.image_id,
       architecture = excluded.architecture,
       os = excluded.os,
       variant = excluded.variant,
       local_digests = excluded.local_digests,
       -- Una imagen confirmada como construida en local sigue siendolo aunque
       -- la heuristica del inventario diga otra cosa: el registry ya dijo que
       -- ese repositorio no existe y esa respuesta manda sobre la suposicion.
       source = CASE
                  WHEN tracked_images.source = 'local-build' THEN 'local-build'
                  ELSE excluded.source
                END,
       size_bytes = excluded.size_bytes,
       image_created_at = excluded.image_created_at,
       local_source_url = excluded.local_source_url,
       local_revision = excluded.local_revision,
       in_use = excluded.in_use,
       last_seen_at = excluded.last_seen_at`,
  );

  return {
    upsertImage(input: {
      ref: string;
      host: string;
      repository: string;
      tag: string;
      imageId: string | null;
      architecture: string | null;
      os: string | null;
      variant: string | null;
      localDigests: string[];
      source: ImageSource;
      sizeBytes: number | null;
      imageCreatedAt: number | null;
      /** `org.opencontainers.image.source` de la imagen instalada. */
      localSourceUrl: string | null;
      /** `org.opencontainers.image.revision` de la instalada: el commit. */
      localRevision: string | null;
      /** Si algun contenedor la usa. Las que no, no se comprueban. */
      inUse: boolean;
    }): void {
      upsertImage.run({
        ...input,
        inUse: input.inUse ? 1 : 0,
        localDigests: JSON.stringify(input.localDigests),
        now: Date.now(),
      });
    },

    listImages(): ImageRow[] {
      return db
        .prepare('SELECT * FROM tracked_images ORDER BY normalized_ref')
        .all() as ImageRow[];
    },

    findImage(ref: string): ImageRow | undefined {
      return db.prepare('SELECT * FROM tracked_images WHERE normalized_ref = ?').get(ref) as
        | ImageRow
        | undefined;
    },

    /** Busqueda laxa para el bot, donde el usuario escribe `nginx` y no la ref completa. */
    searchImages(needle: string): ImageRow[] {
      return db
        .prepare(
          `SELECT * FROM tracked_images
            WHERE normalized_ref LIKE '%' || ? || '%'
               OR repository LIKE '%' || ? || '%'
            ORDER BY normalized_ref
            LIMIT 20`,
        )
        .all(needle, needle) as ImageRow[];
    },

    /** Imagenes que tiene sentido comprobar: las locales y las fijadas no. */
    /**
     * Las que merece la pena consultar contra el registry.
     *
     * Se excluyen las huerfanas: preguntar por la version nueva de una imagen
     * que no usa ningun contenedor gasta peticiones (y cuota de Docker Hub)
     * para nada. Se siguen listando en la interfaz, solo que sin comprobar.
     */
    listCheckable(): ImageRow[] {
      return db
        .prepare(
          `SELECT * FROM tracked_images
            WHERE source = 'registry' AND in_use = 1
            ORDER BY normalized_ref`,
        )
        .all() as ImageRow[];
    },

    recordCheck(input: {
      ref: string;
      status: UpdateStatus;
      remoteDigest: string | null;
      candidateTag: string | null;
      error: string | null;
    }): void {
      db.prepare(
        `UPDATE tracked_images
            SET status = ?, remote_digest = ?, candidate_tag = ?, last_error = ?, last_checked_at = ?
          WHERE normalized_ref = ?`,
      ).run(
        input.status,
        input.remoteDigest,
        input.candidateTag,
        input.error,
        Date.now(),
        input.ref,
      );
    },

    /**
     * Guarda lo que se sabe de la version publicada.
     *
     * Se escribe aparte de `recordCheck` porque se averigua en otro momento: el
     * camino caliente de la comprobacion es un HEAD, y esto exige bajar el blob
     * de configuracion. Solo se hace cuando hay novedad, que es lo raro.
     */
    recordRelease(input: {
      ref: string;
      createdAt: number | null;
      sourceUrl: string | null;
      revision: string | null;
      version: string | null;
    }): void {
      db.prepare(
        `UPDATE tracked_images
            SET remote_created_at = ?, remote_source_url = ?, remote_revision = ?,
                remote_version = ?
          WHERE normalized_ref = ?`,
      ).run(
        input.createdAt,
        input.sourceUrl,
        input.revision,
        input.version,
        input.ref,
      );
    },

    /**
     * Guarda la version instalada y para que digest se averiguo.
     *
     * El digest es lo que evita enseñar un dato rancio: al actualizar la imagen
     * cambia, deja de coincidir y el valor se vuelve a resolver solo.
     */
    recordInstalledVersion(input: {
      ref: string;
      version: string | null;
      method: string | null;
      forDigest: string | null;
    }): void {
      db.prepare(
        `UPDATE tracked_images
            SET installed_version = ?, installed_version_method = ?, installed_version_for = ?
          WHERE normalized_ref = ?`,
      ).run(input.version, input.method, input.forDigest, input.ref);
    },

    /**
     * Olvida lo que se sabia de la version publicada.
     *
     * Hace falta al quedarse al dia: si no, una imagen ya actualizada seguiria
     * enseñando la comparacion de commits de la actualizacion anterior, que ya
     * no compara nada.
     */
    clearRelease(ref: string): void {
      db.prepare(
        `UPDATE tracked_images
            SET remote_created_at = NULL, remote_source_url = NULL,
                remote_revision = NULL, remote_version = NULL
          WHERE normalized_ref = ?`,
      ).run(ref);
    },

    /**
     * Marca una imagen como construida en local.
     *
     * Se invoca cuando el registry confirma que el repositorio no existe. A
     * partir de ahi queda fuera de las comprobaciones y del auto-update, porque
     * no hay nada remoto con lo que compararla y un pull bajaria una imagen
     * ajena que casualmente se llame igual.
     */
    markAsLocalBuild(ref: string): void {
      db.prepare(
        `UPDATE tracked_images SET source = 'local-build', status = 'unknown' WHERE normalized_ref = ?`,
      ).run(ref);
    },

    /** Imagenes que ya no existen en el host. Se limpian tras cada inventario. */
    pruneImagesNotSeenSince(ts: number): number {
      return db.prepare('DELETE FROM tracked_images WHERE last_seen_at < ?').run(ts).changes;
    },

    countUpdatesAvailable(): number {
      return (
        db
          .prepare(`SELECT COUNT(*) AS n FROM tracked_images WHERE status = 'update-available'`)
          .get() as { n: number }
      ).n;
    },

    // -- Politicas ----------------------------------------------------------

    getPolicy(ref: string): ImagePolicy {
      const row = db.prepare('SELECT * FROM image_policies WHERE image_ref = ?').get(ref) as
        | PolicyRow
        | undefined;
      if (!row) return { imageRef: ref, ...DEFAULT_POLICY };
      return policyFromRow(row);
    },

    getAllPolicies(): Map<string, ImagePolicy> {
      const rows = db.prepare('SELECT * FROM image_policies').all() as PolicyRow[];
      return new Map(rows.map((row) => [row.image_ref, policyFromRow(row)]));
    },

    savePolicy(policy: ImagePolicy): void {
      db.prepare(
        `INSERT INTO image_policies
           (image_ref, auto_update, track_mode, semver_channel, notify, recreate_scope,
            remove_image_on_force, cleanup_old_image, paused_until, ignored_digest,
            min_age_hours, updated_at)
         VALUES (@imageRef, @autoUpdate, @trackMode, @semverChannel, @notify, @recreateScope,
                 @removeImageOnForce, @cleanupOldImage, @pausedUntil, @ignoredDigest,
                 @minAgeHours, @updatedAt)
         ON CONFLICT(image_ref) DO UPDATE SET
           auto_update = excluded.auto_update,
           track_mode = excluded.track_mode,
           semver_channel = excluded.semver_channel,
           notify = excluded.notify,
           recreate_scope = excluded.recreate_scope,
           remove_image_on_force = excluded.remove_image_on_force,
           cleanup_old_image = excluded.cleanup_old_image,
           paused_until = excluded.paused_until,
           ignored_digest = excluded.ignored_digest,
           min_age_hours = excluded.min_age_hours,
           updated_at = excluded.updated_at`,
      ).run({
        imageRef: policy.imageRef,
        autoUpdate: policy.autoUpdate ? 1 : 0,
        trackMode: policy.trackMode,
        semverChannel: policy.semverChannel,
        notify: policy.notify ? 1 : 0,
        recreateScope: policy.recreateScope,
        removeImageOnForce: policy.removeImageOnForce ? 1 : 0,
        cleanupOldImage: policy.cleanupOldImage ? 1 : 0,
        pausedUntil: policy.pausedUntil,
        ignoredDigest: policy.ignoredDigest,
        minAgeHours: policy.minAgeHours,
        updatedAt: Date.now(),
      });
    },

    // -- Proyectos ----------------------------------------------------------

    upsertProject(input: {
      name: string;
      workingDir: string;
      configFiles: string[];
      yamlAccessible: boolean;
      error: string | null;
    }): void {
      db.prepare(
        `INSERT INTO compose_projects
           (project_name, working_dir, config_files, yaml_accessible, last_error, last_verified_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_name, working_dir) DO UPDATE SET
           config_files = excluded.config_files,
           yaml_accessible = excluded.yaml_accessible,
           last_error = excluded.last_error,
           last_verified_at = excluded.last_verified_at`,
      ).run(
        input.name,
        input.workingDir,
        JSON.stringify(input.configFiles),
        input.yamlAccessible ? 1 : 0,
        input.error,
        Date.now(),
        Date.now(),
      );
    },

    listProjects(): ProjectRow[] {
      return db
        .prepare('SELECT * FROM compose_projects ORDER BY project_name, working_dir')
        .all() as ProjectRow[];
    },

    findProject(name: string, workingDir: string): ProjectRow | undefined {
      return db
        .prepare('SELECT * FROM compose_projects WHERE project_name = ? AND working_dir = ?')
        .get(name, workingDir) as ProjectRow | undefined;
    },

    pruneProjectsNotVerifiedSince(ts: number): number {
      return db
        .prepare('DELETE FROM compose_projects WHERE last_verified_at < ?')
        .run(ts).changes;
    },
  };
}

/**
 * Fila de politica a objeto de dominio.
 *
 * Existe como funcion suelta porque antes este mapeo estaba escrito dos veces,
 * en `getPolicy` y en `getAllPolicies`. Dos copias del mismo mapeo es como se
 * anade un campo y una de las dos pantallas se queda sin el sin que nada falle.
 */
function policyFromRow(row: PolicyRow): ImagePolicy {
  return {
    imageRef: row.image_ref,
    autoUpdate: row.auto_update === 1,
    trackMode: row.track_mode,
    semverChannel: row.semver_channel,
    notify: row.notify === 1,
    recreateScope: row.recreate_scope,
    removeImageOnForce: row.remove_image_on_force === 1,
    cleanupOldImage: row.cleanup_old_image === 1,
    pausedUntil: row.paused_until,
    ignoredDigest: row.ignored_digest,
    minAgeHours: row.min_age_hours,
  };
}

export type InventoryRepository = ReturnType<typeof createInventoryRepository>;
