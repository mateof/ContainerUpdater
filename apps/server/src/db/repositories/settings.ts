import type { Db } from '../index.js';
import type { AppSettings, Locale } from '@cu/shared';

const DEFAULTS: AppSettings = {
  // Cada 6 horas y no cada hora: en un Synology con hibernacion, comprobar a
  // menudo despierta los discos sin que nadie publique imagenes tan rapido.
  checkCron: '0 */6 * * *',
  autoUpdateEnabled: true,
  notifyOnUpdateAvailable: true,
  notifyOnUpdateApplied: true,
  notifyOnFailure: true,
  notifyOnContainerDown: true,
  notifyOnContainerRecovered: true,
  restartLoopThreshold: 3,
  // 24 horas por defecto y no 0: el valor que protege sin que nadie tenga que
  // saber que existe. Quien quiera las versiones al momento lo baja a 0.
  defaultMinAgeHours: 24,
  serviceHost: '',
  maintenanceWindowEnabled: false,
  maintenanceStartHour: 4,
  maintenanceEndHour: 6,
  metricsIntervalSeconds: 5,
  metricsHistoryEnabled: false,
  historyRetentionDays: 30,
  registryConcurrency: 3,
  defaultLocale: 'es',
  allowTelegramGroups: false,
};

export function createSettingsRepository(db: Db) {
  const read = db.prepare('SELECT key, value FROM settings');
  const write = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );

  return {
    /**
     * Los ajustes se guardan clave a clave con el valor en JSON, no como una
     * fila unica: asi un ajuste nuevo no necesita migracion ni pisa los que ya
     * habia si dos escrituras se cruzan.
     */
    getAll(): AppSettings {
      const rows = read.all() as Array<{ key: string; value: string }>;
      const stored: Record<string, unknown> = {};
      for (const row of rows) {
        if (!row.key.startsWith('app.')) continue;
        try {
          stored[row.key.slice(4)] = JSON.parse(row.value);
        } catch {
          // Un valor corrupto no debe impedir arrancar: se ignora y manda el default.
        }
      }
      return { ...DEFAULTS, ...stored } as AppSettings;
    },

    update(patch: Partial<AppSettings>): AppSettings {
      const now = Date.now();
      const apply = db.transaction(() => {
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) continue;
          write.run(`app.${key}`, JSON.stringify(value), now);
        }
      });
      apply();
      return this.getAll();
    },

    getRaw(key: string): string | null {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },

    setRaw(key: string, value: string): void {
      write.run(key, value, Date.now());
    },

    getNumber(key: string): number | null {
      const raw = this.getRaw(key);
      if (raw === null) return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    },

    defaultLocale(): Locale {
      return this.getAll().defaultLocale;
    },
  };
}

export function createTagCacheRepository(db: Db) {
  return {
    /**
     * Listar tags es caro (varias paginas por repo), asi que se cachea un dia.
     * El camino caliente de deteccion no lo usa: solo el modo semver.
     */
    get(host: string, repository: string, maxAgeMs = 24 * 3600_000): string[] | null {
      const row = db
        .prepare('SELECT tags, fetched_at FROM tag_cache WHERE host = ? AND repository = ?')
        .get(host, repository) as { tags: string; fetched_at: number } | undefined;
      if (!row) return null;
      if (Date.now() - row.fetched_at > maxAgeMs) return null;
      try {
        return JSON.parse(row.tags) as string[];
      } catch {
        return null;
      }
    },

    set(host: string, repository: string, tags: string[]): void {
      db.prepare(
        `INSERT INTO tag_cache (host, repository, tags, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(host, repository) DO UPDATE SET
           tags = excluded.tags, fetched_at = excluded.fetched_at`,
      ).run(host, repository, JSON.stringify(tags), Date.now());
    },

    invalidateOlderThan(ms: number): number {
      return db.prepare('DELETE FROM tag_cache WHERE fetched_at < ?').run(Date.now() - ms).changes;
    },
  };
}

export type SettingsRepository = ReturnType<typeof createSettingsRepository>;
export type TagCacheRepository = ReturnType<typeof createTagCacheRepository>;
