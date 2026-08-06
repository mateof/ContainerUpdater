/**
 * Apertura y migracion de la base de datos SQLite.
 */
import Database from 'better-sqlite3';
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

export function openDatabase(file: string): Db {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);

  // WAL: permite leer mientras se escribe, que es justo el patron de esta app
  // (el scheduler escribe resultados mientras la UI consulta el inventario).
  db.pragma('journal_mode = WAL');
  // NORMAL en lugar de FULL: en un NAS, un fsync por transaccion castiga el
  // disco sin aportar nada. Con WAL, NORMAL solo arriesga las ultimas
  // transacciones ante un corte de corriente, y aqui eso es un check perdido.
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db);
  return db;
}

/**
 * Migraciones por `PRAGMA user_version`, aplicadas en transaccion.
 *
 * Descartado un ORM con migraciones: el esquema es fijo y conocido, y una
 * dependencia menos es una dependencia menos que compilar en arm64.
 */
export function migrate(db: Db): void {
  const dir = resolveMigrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const current = db.pragma('user_version', { simple: true }) as number;

  for (const file of files) {
    const version = Number.parseInt(file.slice(0, 3), 10);
    if (!Number.isFinite(version)) {
      throw new Error(`Migracion con nombre invalido: ${file} (se espera NNN_nombre.sql)`);
    }
    if (version <= current) continue;

    const sql = readFileSync(join(dir, file), 'utf8');
    // No se puede usar db.transaction() con exec de multiples sentencias que
    // incluyan pragmas, asi que se controla la transaccion a mano.
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Fallo aplicando la migracion ${file}: ${(error as Error).message}`);
    }
  }
}

/**
 * En desarrollo las migraciones estan junto al fuente; en el build de esbuild
 * se copian a `dist/migrations`. Se prueban ambas rutas en vez de depender de
 * NODE_ENV, que puede venir mal puesto.
 */
function resolveMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'migrations'), join(here, '..', 'migrations')];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(`No se encuentra la carpeta de migraciones. Probado: ${candidates.join(', ')}`);
}
