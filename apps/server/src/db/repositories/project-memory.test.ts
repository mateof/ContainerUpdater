import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInventoryRepository } from './inventory.js';
import type { Db } from '../index.js';

/**
 * Que un proyecto bajado no se olvide al instante.
 *
 * Existe por un fallo visible en la aplicacion: al bajar un proyecto con `down`
 * desaparecia entero de la pantalla y no habia forma de volver a levantarlo
 * desde ahi. Los proyectos se deducen de las labels de sus contenedores, `down`
 * los borra, y la fila que quedaba en la base se purgaba en el mismo refresco.
 *
 * Ojo con la distincion, que no es evidente: `stop` para los contenedores pero
 * los conserva, y esos proyectos siempre se han visto bien. El que se esfumaba
 * era el que se bajaba del todo.
 */
/**
 * Base en memoria con el esquema REAL, aplicando las migraciones.
 *
 * Escribir aqui un `CREATE TABLE` a mano seria una copia que se queda vieja en
 * cuanto alguien anada una columna, y ademas el repositorio prepara sus
 * sentencias al construirse: cualquier discrepancia revienta al instante con un
 * error que no habla del fallo que se esta probando.
 */
function makeDb(): Db {
  const db = new Database(':memory:');
  const dir = fileURLToPath(new URL('../migrations', import.meta.url));
  for (const file of readdirSync(dir).sort()) {
    if (file.endsWith('.sql')) db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  return db as unknown as Db;
}

const DIA = 24 * 3600_000;

describe('memoria de proyectos sin contenedores', () => {
  it('sobrevive a un refresco en el que ya no tiene contenedores', () => {
    const repo = createInventoryRepository(makeDb());
    repo.upsertProject({
      name: 'demo',
      workingDir: '/srv/demo',
      configFiles: ['/srv/demo/docker-compose.yml'],
      yamlAccessible: true,
      error: null,
    });

    // Un refresco posterior: el proyecto ya no aparece porque `down` borro sus
    // contenedores, asi que su fila no se vuelve a verificar. Con la purga
    // anterior (borrar lo no verificado en este mismo ciclo) desaparecia aqui.
    repo.pruneProjectsNotVerifiedSince(Date.now() - 30 * DIA);

    expect(repo.listProjects().map((row) => row.project_name)).toEqual(['demo']);
  });

  it('pero se olvida cuando lleva mucho sin existir', () => {
    const db = makeDb();
    const repo = createInventoryRepository(db);
    repo.upsertProject({
      name: 'viejo',
      workingDir: '/srv/viejo',
      configFiles: [],
      yamlAccessible: true,
      error: null,
    });
    // Se envejece la fila a mano: hace 40 dias que no se le ven contenedores.
    db.prepare('UPDATE compose_projects SET last_verified_at = ?').run(Date.now() - 40 * DIA);

    repo.pruneProjectsNotVerifiedSince(Date.now() - 30 * DIA);

    // Un proyecto que lleva mas de un mes sin existir ya no es algo que se te
    // haya olvidado encender.
    expect(repo.listProjects()).toHaveLength(0);
  });
});
