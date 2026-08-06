import type { Db } from '../index.js';
import type { RegistryAuthType, RegistryConfig, RegistryStatus } from '@cu/shared';
import { Keyring, type SerializedSealed } from '../../crypto/keyring.js';

interface RegistryRow {
  id: number;
  name: string;
  host: string;
  auth_type: RegistryAuthType;
  username: string | null;
  secret_ct: Buffer | null;
  secret_iv: Buffer | null;
  secret_tag: Buffer | null;
  key_version: number;
  status: RegistryStatus;
  last_error: string | null;
  rate_remaining: number | null;
  rate_total: number | null;
  last_verified_at: number | null;
}

export interface RegistryCredentials {
  username: string;
  secret: string;
}

export function createRegistryRepository(db: Db, keyring: Keyring) {
  function toConfig(row: RegistryRow): RegistryConfig {
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      authType: row.auth_type,
      username: row.username,
      hasSecret: row.secret_ct !== null,
      status: row.status,
      lastVerifiedAt: row.last_verified_at,
      rateLimitRemaining: row.rate_remaining,
      rateLimitTotal: row.rate_total,
    };
  }

  return {
    list(): RegistryConfig[] {
      const rows = db.prepare('SELECT * FROM registries ORDER BY host').all() as RegistryRow[];
      return rows.map(toConfig);
    },

    findByHost(host: string): RegistryConfig | undefined {
      const row = db.prepare('SELECT * FROM registries WHERE host = ?').get(host) as
        | RegistryRow
        | undefined;
      return row ? toConfig(row) : undefined;
    },

    /**
     * Devuelve las credenciales en claro para hablar con el registry.
     *
     * Si el llavero esta bloqueado devuelve null en vez de lanzar: sin
     * credenciales todavia se pueden comprobar los repos publicos, y tumbar el
     * check entero por no poder descifrar uno privado seria peor.
     */
    getCredentials(host: string): RegistryCredentials | null {
      const row = db.prepare('SELECT * FROM registries WHERE host = ?').get(host) as
        | RegistryRow
        | undefined;
      if (!row || !row.secret_ct || !row.secret_iv || !row.secret_tag) return null;
      if (!keyring.healthy) return null;

      try {
        const sealed: SerializedSealed = {
          ct: row.secret_ct.toString('base64'),
          iv: row.secret_iv.toString('base64'),
          tag: row.secret_tag.toString('base64'),
          v: row.key_version,
        };
        const secret = keyring.open(sealed, Keyring.registryAad(row.id, row.key_version));
        return { username: row.username ?? '', secret };
      } catch {
        db.prepare('UPDATE registries SET status = ?, last_error = ? WHERE id = ?').run(
          'needs-reauth',
          'No se ha podido descifrar el secreto guardado',
          row.id,
        );
        return null;
      }
    },

    create(input: {
      name: string;
      host: string;
      authType: RegistryAuthType;
      username?: string;
      secret?: string;
    }): number {
      const now = Date.now();
      const info = db
        .prepare(
          `INSERT INTO registries (name, host, auth_type, username, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'untested', ?, ?)`,
        )
        .run(input.name, input.host, input.authType, input.username ?? null, now, now);
      const id = Number(info.lastInsertRowid);

      // El secreto se cifra en un segundo paso porque el AAD incluye el id de
      // la fila, que no se conoce hasta despues del INSERT.
      if (input.secret) this.setSecret(id, input.secret);
      return id;
    },

    update(
      id: number,
      input: {
        name?: string;
        authType?: RegistryAuthType;
        username?: string | null;
        secret?: string;
      },
    ): void {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.name !== undefined) {
        sets.push('name = ?');
        params.push(input.name);
      }
      if (input.authType !== undefined) {
        sets.push('auth_type = ?');
        params.push(input.authType);
      }
      if (input.username !== undefined) {
        sets.push('username = ?');
        params.push(input.username);
      }
      if (sets.length > 0) {
        sets.push('updated_at = ?');
        params.push(Date.now(), id);
        db.prepare(`UPDATE registries SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      }
      // Un secreto vacio significa "conserva el que hay", no "borralo": es lo
      // que espera un formulario que no muestra el valor guardado.
      if (input.secret) this.setSecret(id, input.secret);
    },

    setSecret(id: number, secret: string): void {
      const sealed = keyring.seal(secret, Keyring.registryAad(id));
      db.prepare(
        `UPDATE registries
            SET secret_ct = ?, secret_iv = ?, secret_tag = ?, key_version = ?,
                status = 'untested', updated_at = ?
          WHERE id = ?`,
      ).run(
        Buffer.from(sealed.ct, 'base64'),
        Buffer.from(sealed.iv, 'base64'),
        Buffer.from(sealed.tag, 'base64'),
        sealed.v,
        Date.now(),
        id,
      );
    },

    remove(id: number): void {
      db.prepare('DELETE FROM registries WHERE id = ?').run(id);
    },

    setStatus(host: string, status: RegistryStatus, error: string | null): void {
      db.prepare(
        `UPDATE registries
            SET status = ?, last_error = ?, last_verified_at = ?, updated_at = ?
          WHERE host = ?`,
      ).run(status, error, Date.now(), Date.now(), host);
    },

    setRateLimit(host: string, remaining: number | null, total: number | null): void {
      db.prepare('UPDATE registries SET rate_remaining = ?, rate_total = ? WHERE host = ?').run(
        remaining,
        total,
        host,
      );
    },

    /** Marca todo como necesitado de credenciales tras perder la clave maestra. */
    markAllNeedingReauth(): void {
      db.prepare(
        `UPDATE registries SET status = 'needs-reauth' WHERE secret_ct IS NOT NULL`,
      ).run();
    },

    /** Accion manual y explicita del usuario. Nunca se dispara sola. */
    forgetAllSecrets(): number {
      return db.prepare(
        `UPDATE registries
            SET secret_ct = NULL, secret_iv = NULL, secret_tag = NULL, status = 'untested'
          WHERE secret_ct IS NOT NULL`,
      ).run().changes;
    },
  };
}

export type RegistryRepository = ReturnType<typeof createRegistryRepository>;
