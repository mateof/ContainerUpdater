import type { Db } from '../index.js';
import type {
  CheckRun,
  JobStatus,
  RollbackPoint,
  UpdateJob,
  UpdateMode,
  UpdateStrategy,
} from '@cu/shared';

interface RunRow {
  id: number;
  trigger: string;
  status: 'running' | 'ok' | 'failed';
  started_at: number;
  finished_at: number | null;
  images_checked: number;
  updates_found: number;
  errors: number;
}

interface JobRow {
  id: number;
  image_ref: string;
  container_id: string | null;
  container_name: string | null;
  project_key: string | null;
  mode: UpdateMode;
  strategy: UpdateStrategy;
  trigger: 'manual' | 'auto' | 'telegram';
  status: JobStatus;
  from_digest: string | null;
  to_digest: string | null;
  from_tag: string | null;
  to_tag: string | null;
  log: string;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
  rollback_digests: string | null;
  rollback_tag: string | null;
  created_at: number;
}

export function createHistoryRepository(db: Db) {
  return {
    // -- Comprobaciones -----------------------------------------------------

    startRun(trigger: string): number {
      const info = db
        .prepare('INSERT INTO check_runs (trigger, status, started_at) VALUES (?, ?, ?)')
        .run(trigger, 'running', Date.now());
      return Number(info.lastInsertRowid);
    },

    finishRun(
      id: number,
      stats: { imagesChecked: number; updatesFound: number; errors: number; failed?: boolean },
    ): void {
      db.prepare(
        `UPDATE check_runs
            SET status = ?, finished_at = ?, images_checked = ?, updates_found = ?, errors = ?
          WHERE id = ?`,
      ).run(
        stats.failed ? 'failed' : 'ok',
        Date.now(),
        stats.imagesChecked,
        stats.updatesFound,
        stats.errors,
        id,
      );
    },

    recordResult(input: {
      runId: number;
      imageRef: string;
      localDigest: string | null;
      remoteDigest: string | null;
      hasUpdate: boolean;
      candidateTag: string | null;
      httpStatus: number | null;
      durationMs: number;
      error: string | null;
    }): void {
      db.prepare(
        `INSERT INTO check_results
           (run_id, image_ref, local_digest, remote_digest, has_update, candidate_tag,
            http_status, duration_ms, error, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.runId,
        input.imageRef,
        input.localDigest,
        input.remoteDigest,
        input.hasUpdate ? 1 : 0,
        input.candidateTag,
        input.httpStatus,
        input.durationMs,
        input.error,
        Date.now(),
      );
    },

    getRun(id: number): CheckRun | undefined {
      const row = db.prepare('SELECT * FROM check_runs WHERE id = ?').get(id) as
        | RunRow
        | undefined;
      return row ? toCheckRun(row) : undefined;
    },

    listRuns(limit = 50): CheckRun[] {
      const rows = db
        .prepare('SELECT * FROM check_runs ORDER BY started_at DESC LIMIT ?')
        .all(limit) as RunRow[];
      return rows.map(toCheckRun);
    },

    /**
     * Cierra ejecuciones que quedaron abiertas por un reinicio. Sin esto, el
     * lock de "hay un check en marcha" no se libera nunca y la app deja de
     * comprobar en silencio.
     */
    failStaleRuns(olderThanMs: number): number {
      return db
        .prepare(
          `UPDATE check_runs SET status = 'failed', finished_at = ?
            WHERE status = 'running' AND started_at < ?`,
        )
        .run(Date.now(), Date.now() - olderThanMs).changes;
    },

    // -- Trabajos de actualizacion -----------------------------------------

    createJob(input: {
      imageRef: string;
      containerId: string | null;
      containerName: string | null;
      projectKey: string | null;
      mode: UpdateMode;
      strategy: UpdateStrategy;
      trigger: 'manual' | 'auto' | 'telegram';
      actorUserId: number | null;
      actorChatId: number | null;
      fromDigest: string | null;
      fromTag: string | null;
      /**
       * Digests locales ANTES de tocar nada: a donde se vuelve si sale mal.
       *
       * Se apunta al encolar y no al terminar por un motivo simple: al terminar
       * la imagen local ya es la nueva y la anterior puede haberse limpiado del
       * disco. Si no se guarda ahora, se pierde.
       */
      rollbackDigests?: string[] | null;
      rollbackTag?: string | null;
    }): number {
      const info = db
        .prepare(
          `INSERT INTO update_jobs
             (image_ref, container_id, container_name, project_key, mode, strategy, trigger,
              actor_user_id, actor_chat_id, status, from_digest, from_tag,
              rollback_digests, rollback_tag, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        )
        .run(
          input.imageRef,
          input.containerId,
          input.containerName,
          input.projectKey,
          input.mode,
          input.strategy,
          input.trigger,
          input.actorUserId,
          input.actorChatId,
          input.fromDigest,
          input.fromTag,
          input.rollbackDigests?.length ? JSON.stringify(input.rollbackDigests) : null,
          input.rollbackTag ?? null,
          Date.now(),
        );
      return Number(info.lastInsertRowid);
    },

    /**
     * Ultimo punto al que se puede volver para una imagen.
     *
     * Solo cuentan las actualizaciones que salieron bien: si fallo y se
     * revirtio sola, ya estas en la version vieja y no hay nada que deshacer.
     * Y se excluyen los propios `revert` para que no se pueda entrar en un
     * bucle de deshacer el deshacer.
     */
    findRollbackPoint(imageRef: string): RollbackPoint | null {
      const row = db
        .prepare(
          `SELECT * FROM update_jobs
            WHERE image_ref = ? AND status = 'success' AND mode IN ('update', 'force')
              AND rollback_digests IS NOT NULL
            ORDER BY finished_at DESC LIMIT 1`,
        )
        .get(imageRef) as JobRow | undefined;
      if (!row?.rollback_digests) return null;

      let digests: string[] = [];
      try {
        const parsed = JSON.parse(row.rollback_digests) as unknown;
        if (Array.isArray(parsed)) digests = parsed.filter((v): v is string => typeof v === 'string');
      } catch {
        return null;
      }
      if (digests.length === 0) return null;

      return {
        jobId: row.id,
        imageRef: row.image_ref,
        digests,
        tag: row.rollback_tag,
        appliedAt: row.finished_at ?? row.created_at,
        currentDigest: row.to_digest,
      };
    },

    markJobRunning(id: number): void {
      db.prepare(`UPDATE update_jobs SET status = 'running', started_at = ? WHERE id = ?`).run(
        Date.now(),
        id,
      );
    },

    appendJobLog(id: number, line: string): void {
      // El log se acumula en la fila. Tope implicito: las lineas de compose
      // rara vez pasan de unos KB y el historial se purga por retencion.
      db.prepare('UPDATE update_jobs SET log = log || ? WHERE id = ?').run(`${line}\n`, id);
    },

    finishJob(
      id: number,
      input: {
        status: JobStatus;
        toDigest?: string | null;
        toTag?: string | null;
        error?: string | null;
      },
    ): void {
      db.prepare(
        `UPDATE update_jobs
            SET status = ?, to_digest = COALESCE(?, to_digest), to_tag = COALESCE(?, to_tag),
                error = ?, finished_at = ?
          WHERE id = ?`,
      ).run(
        input.status,
        input.toDigest ?? null,
        input.toTag ?? null,
        input.error ?? null,
        Date.now(),
        id,
      );
    },

    getJob(id: number): UpdateJob | undefined {
      const row = db.prepare('SELECT * FROM update_jobs WHERE id = ?').get(id) as
        | JobRow
        | undefined;
      return row ? toJob(row) : undefined;
    },

    listJobs(limit = 50): UpdateJob[] {
      const rows = db
        .prepare('SELECT * FROM update_jobs ORDER BY created_at DESC LIMIT ?')
        .all(limit) as JobRow[];
      return rows.map(toJob);
    },

    /** Un trabajo que seguia "running" al arrancar murio con el proceso anterior. */
    failInterruptedJobs(): number {
      return db
        .prepare(
          `UPDATE update_jobs
              SET status = 'failed', error = 'Interrumpido por un reinicio del servicio',
                  finished_at = ?
            WHERE status IN ('running', 'queued')`,
        )
        .run(Date.now()).changes;
    },

    // -- Auditoria y purga --------------------------------------------------

    audit(input: {
      actorType: 'user' | 'telegram' | 'system';
      actorId: string | null;
      action: string;
      target?: string | null;
      detail?: string | null;
      ip?: string | null;
    }): void {
      db.prepare(
        `INSERT INTO audit_log (actor_type, actor_id, action, target, detail, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.actorType,
        input.actorId,
        input.action,
        input.target ?? null,
        input.detail ?? null,
        input.ip ?? null,
        Date.now(),
      );
    },

    prune(retentionDays: number): void {
      const cutoff = Date.now() - retentionDays * 24 * 3600_000;
      // check_results cae en cascada con su run.
      db.prepare('DELETE FROM check_runs WHERE started_at < ?').run(cutoff);
      db.prepare('DELETE FROM update_jobs WHERE created_at < ?').run(cutoff);
      db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff);
      db.prepare('DELETE FROM metrics_rollup WHERE bucket_ts < ?').run(cutoff);
      // Las notificaciones enviadas se conservan mas: son la memoria de "esto ya
      // lo avise" y purgarlas pronto haria repetir avisos viejos.
      db.prepare('DELETE FROM notifications_sent WHERE reserved_at < ?').run(
        Date.now() - 365 * 24 * 3600_000,
      );
    },
  };
}

function toCheckRun(row: RunRow): CheckRun {
  return {
    id: row.id,
    trigger: row.trigger as CheckRun['trigger'],
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    imagesChecked: row.images_checked,
    updatesFound: row.updates_found,
    errors: row.errors,
  };
}

function toJob(row: JobRow): UpdateJob {
  return {
    id: row.id,
    imageRef: row.image_ref,
    containerId: row.container_id,
    containerName: row.container_name,
    projectKey: row.project_key,
    mode: row.mode,
    strategy: row.strategy,
    trigger: row.trigger,
    status: row.status,
    fromDigest: row.from_digest,
    toDigest: row.to_digest,
    fromTag: row.from_tag,
    toTag: row.to_tag,
    log: row.log,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export type HistoryRepository = ReturnType<typeof createHistoryRepository>;
