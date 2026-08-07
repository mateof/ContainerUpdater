/**
 * Proyectos cuyos ficheros ha escrito esta aplicacion.
 *
 * Cubre dos cosas distintas:
 *
 * - Los creados aqui (`created_here`), que hay que mantener visibles aunque
 *   todavia no tengan contenedores: el inventario deduce los proyectos de las
 *   labels de los CONTENEDORES, asi que uno recien creado o cuyo arranque ha
 *   fallado no existiria para nadie, que es justo cuando hay que entrar a
 *   corregir el YAML.
 * - Los de fuera que se han editado alguna vez, que se registran al guardar
 *   para poder colgar de ellos las versiones archivadas.
 *
 * La identidad es el DIRECTORIO, no el nombre: Container Manager deriva el
 * nombre de la carpeta y dos stacks distintos pueden llamarse igual (ADR-004).
 */
import type { Db } from '../index.js';
import { Keyring, KeyringLockedError, type SerializedSealed } from '../../crypto/keyring.js';

export interface ManagedProjectRow {
  id: number;
  name: string;
  dir: string;
  created_at: number;
  updated_at: number;
  created_by: number | null;
  /** 1 si se creo desde la aplicacion, 0 si solo se ha editado. */
  created_here: number;
}

export type ProjectFileKind = 'compose' | 'env';

export interface ProjectFileVersion {
  id: number;
  kind: ProjectFileKind;
  createdAt: number;
  actorUserId: number | null;
}

export function createManagedProjectRepository(db: Db, keyring: Keyring) {
  return {
    list(): ManagedProjectRow[] {
      return db
        .prepare('SELECT * FROM managed_projects ORDER BY name')
        .all() as ManagedProjectRow[];
    },

    /** Solo los creados aqui: son los que hay que mostrar sin contenedores. */
    listCreatedHere(): ManagedProjectRow[] {
      return db
        .prepare('SELECT * FROM managed_projects WHERE created_here = 1 ORDER BY name')
        .all() as ManagedProjectRow[];
    },

    /** Por directorio, que es la identidad real. */
    findByDir(dir: string): ManagedProjectRow | undefined {
      return db.prepare('SELECT * FROM managed_projects WHERE dir = ?').get(dir) as
        | ManagedProjectRow
        | undefined;
    },

    create(input: {
      name: string;
      dir: string;
      createdBy: number | null;
      createdHere: boolean;
    }): ManagedProjectRow {
      const now = Date.now();
      db.prepare(
        `INSERT INTO managed_projects (name, dir, created_at, updated_at, created_by, created_here)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(input.name, input.dir, now, now, input.createdBy, input.createdHere ? 1 : 0);

      const row = this.findByDir(input.dir);
      if (!row) throw new Error('No se ha podido registrar el proyecto');
      return row;
    },

    /**
     * Devuelve la fila del proyecto, creandola si hace falta.
     *
     * Se usa al editar uno de fuera: hace falta una fila a la que colgar las
     * versiones archivadas, pero no se marca como creado aqui porque no lo es y
     * eso cambiaria si debe seguir visible sin contenedores.
     */
    ensure(input: { name: string; dir: string; actorUserId: number | null }): ManagedProjectRow {
      return (
        this.findByDir(input.dir) ??
        this.create({
          name: input.name,
          dir: input.dir,
          createdBy: input.actorUserId,
          createdHere: false,
        })
      );
    },

    touch(id: number): void {
      db.prepare('UPDATE managed_projects SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    },

    remove(id: number): void {
      db.prepare('DELETE FROM managed_projects WHERE id = ?').run(id);
    },

    /**
     * Archiva el contenido anterior de un fichero, cifrado.
     *
     * Devuelve false si el llavero esta bloqueado, en cuyo caso NO se guarda
     * nada. Es deliberado: perder el historial es molesto, pero impedir guardar
     * un cambio porque no se puede archivar la version anterior seria mucho
     * peor. Quien llama lo registra en el log.
     */
    archive(input: {
      projectId: number;
      kind: ProjectFileKind;
      content: string;
      actorUserId: number | null;
    }): boolean {
      if (!keyring.healthy) return false;

      try {
        const sealed = keyring.seal(
          input.content,
          Keyring.projectFileAad(input.projectId, input.kind),
        );
        db.prepare(
          `INSERT INTO project_file_versions
             (project_id, kind, content_ct, iv, tag, key_version, created_at, actor_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.projectId,
          input.kind,
          sealed.ct,
          sealed.iv,
          sealed.tag,
          sealed.v,
          Date.now(),
          input.actorUserId,
        );
        return true;
      } catch (error) {
        if (error instanceof KeyringLockedError) return false;
        throw error;
      }
    },

    listVersions(projectId: number, kind: ProjectFileKind): ProjectFileVersion[] {
      const rows = db
        .prepare(
          `SELECT id, kind, created_at, actor_user_id
             FROM project_file_versions
            WHERE project_id = ? AND kind = ?
            ORDER BY created_at DESC
            LIMIT 20`,
        )
        .all(projectId, kind) as Array<{
        id: number;
        kind: ProjectFileKind;
        created_at: number;
        actor_user_id: number | null;
      }>;

      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        createdAt: row.created_at,
        actorUserId: row.actor_user_id,
      }));
    },

    /** Devuelve el contenido descifrado de una version archivada. */
    readVersion(projectId: number, versionId: number): string | null {
      const row = db
        .prepare(
          `SELECT kind, content_ct, iv, tag, key_version
             FROM project_file_versions
            WHERE id = ? AND project_id = ?`,
        )
        .get(versionId, projectId) as
        | { kind: ProjectFileKind; content_ct: string; iv: string; tag: string; key_version: number }
        | undefined;
      if (!row) return null;

      const sealed: SerializedSealed = {
        ct: row.content_ct,
        iv: row.iv,
        tag: row.tag,
        v: row.key_version,
      };
      try {
        return keyring.open(sealed, Keyring.projectFileAad(projectId, row.kind, row.key_version));
      } catch {
        // Llavero bloqueado o clave rotada sin re-envolver. No es motivo para
        // romper la pantalla: se comporta como si no hubiera copia.
        return null;
      }
    },

    /**
     * Poda el historial de un proyecto.
     *
     * Sin esto, editar un `.env` a diario deja cientos de copias cifradas de
     * contrasenas que nadie va a mirar. Se conservan las 20 ultimas por tipo.
     */
    prune(projectId: number, kind: ProjectFileKind, keep = 20): void {
      db.prepare(
        `DELETE FROM project_file_versions
          WHERE project_id = ? AND kind = ?
            AND id NOT IN (
              SELECT id FROM project_file_versions
               WHERE project_id = ? AND kind = ?
               ORDER BY created_at DESC LIMIT ?
            )`,
      ).run(projectId, kind, projectId, kind, keep);
    },
  };
}
