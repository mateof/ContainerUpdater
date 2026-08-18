import type { Db } from '../index.js';
import type { ContainerState, HealthState } from '@cu/shared';

/** Que se ha avisado de un contenedor. `null` = no hay aviso vivo. */
export type AlertKind = 'down' | 'restart-loop' | 'unhealthy';

export interface WatchRow {
  name: string;
  last_state: ContainerState;
  last_health: HealthState;
  last_restarts: number;
  alerted_kind: AlertKind | null;
  alerted_at: number | null;
  muted_until: number | null;
  updated_at: number;
}

/**
 * Estado de vigilancia de cada contenedor.
 *
 * La clave es el NOMBRE y no el id. Al recrear un contenedor (que es justo lo
 * que hace una actualizacion) el id cambia por completo, asi que con el id cada
 * actualizacion pareceria un contenedor que desaparece y otro que nace, y el
 * historial de estados no serviria para nada.
 */
export function createWatchRepository(db: Db) {
  return {
    get(name: string): WatchRow | undefined {
      return db.prepare('SELECT * FROM container_watch WHERE name = ?').get(name) as
        | WatchRow
        | undefined;
    },

    all(): WatchRow[] {
      return db.prepare('SELECT * FROM container_watch').all() as WatchRow[];
    },

    save(input: {
      name: string;
      state: ContainerState;
      health: HealthState;
      restarts: number;
      alertedKind: AlertKind | null;
      alertedAt: number | null;
    }): void {
      db.prepare(
        `INSERT INTO container_watch
           (name, last_state, last_health, last_restarts, alerted_kind, alerted_at, updated_at)
         VALUES (@name, @state, @health, @restarts, @alertedKind, @alertedAt, @now)
         ON CONFLICT(name) DO UPDATE SET
           last_state = excluded.last_state,
           last_health = excluded.last_health,
           last_restarts = excluded.last_restarts,
           alerted_kind = excluded.alerted_kind,
           alerted_at = excluded.alerted_at,
           updated_at = excluded.updated_at`,
      ).run({ ...input, now: Date.now() });
    },

    /**
     * Silencia un contenedor un rato.
     *
     * Lo llama el updater antes de tocarlo. Durante una actualizacion el
     * contenedor pasa por parado, borrado y recreado: sin esto, cada
     * actualizacion correcta dispararia una alarma de caida, que es la forma
     * mas rapida de que alguien apague los avisos para siempre.
     *
     * Se hace `INSERT OR IGNORE` primero porque el contenedor puede no estar
     * todavia en la tabla, y entonces el UPDATE no afectaria a ninguna fila y
     * el silencio no se aplicaria.
     */
    mute(name: string, ms: number): void {
      const until = Date.now() + ms;
      db.prepare(
        `INSERT INTO container_watch (name, last_state, last_health, muted_until, updated_at)
         VALUES (?, 'running', 'none', ?, ?)
         ON CONFLICT(name) DO UPDATE SET muted_until = excluded.muted_until`,
      ).run(name, until, Date.now());
    },

    isMuted(name: string): boolean {
      const row = this.get(name);
      return row?.muted_until !== null && row?.muted_until !== undefined && row.muted_until > Date.now();
    },

    /** Contenedores que ya no existen. Se limpian tras cada pasada. */
    pruneMissing(names: string[]): number {
      if (names.length === 0) return db.prepare('DELETE FROM container_watch').run().changes;
      const placeholders = names.map(() => '?').join(',');
      return db
        .prepare(`DELETE FROM container_watch WHERE name NOT IN (${placeholders})`)
        .run(...names).changes;
    },
  };
}

export type WatchRepository = ReturnType<typeof createWatchRepository>;
