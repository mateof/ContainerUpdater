/**
 * Segundo factor: secreto TOTP y codigos de recuperacion.
 *
 * El secreto va cifrado con el llavero, igual que las credenciales de registry:
 * quien lo lea puede generar codigos validos para siempre. Los codigos de
 * recuperacion solo se guardan hasheados.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../index.js';
import { Keyring, KeyringLockedError, type SerializedSealed } from '../../crypto/keyring.js';

export interface TotpRow {
  user_id: number;
  secret_ct: string;
  iv: string;
  tag: string;
  key_version: number;
  confirmed_at: number | null;
  last_step: number | null;
  created_at: number;
}

/** Igual que los tokens de sesion: alta entropia, no hace falta Argon2. */
function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('base64');
}

export function createTotpRepository(db: Db, keyring: Keyring) {
  return {
    find(userId: number): TotpRow | undefined {
      return db.prepare('SELECT * FROM user_totp WHERE user_id = ?').get(userId) as
        | TotpRow
        | undefined;
    },

    /** Si el usuario tiene el segundo factor ACTIVO, no solo empezado. */
    isEnabled(userId: number): boolean {
      const row = this.find(userId);
      return row !== undefined && row.confirmed_at !== null;
    },

    /**
     * Guarda un secreto nuevo, sin confirmar.
     *
     * Reemplaza cualquier intento anterior: si alguien empieza a activarlo dos
     * veces, vale el ultimo QR que ha visto, que es el que tiene delante.
     */
    startEnrollment(userId: number, secret: string): void {
      const sealed = keyring.seal(secret, Keyring.totpAad(userId));
      db.prepare(
        `INSERT INTO user_totp (user_id, secret_ct, iv, tag, key_version, created_at)
         VALUES (@userId, @ct, @iv, @tag, @v, @now)
         ON CONFLICT(user_id) DO UPDATE SET
           secret_ct = excluded.secret_ct,
           iv = excluded.iv,
           tag = excluded.tag,
           key_version = excluded.key_version,
           confirmed_at = NULL,
           last_step = NULL,
           created_at = excluded.created_at`,
      ).run({
        userId,
        ct: sealed.ct,
        iv: sealed.iv,
        tag: sealed.tag,
        v: sealed.v,
        now: Date.now(),
      });
    },

    /**
     * Devuelve el secreto en claro, o null si no se puede descifrar.
     *
     * Null en vez de lanzar: con el llavero bloqueado hay que poder decirle al
     * usuario que su segundo factor no se puede comprobar, no reventar el login.
     */
    readSecret(userId: number): string | null {
      const row = this.find(userId);
      if (!row) return null;

      const sealed: SerializedSealed = {
        ct: row.secret_ct,
        iv: row.iv,
        tag: row.tag,
        v: row.key_version,
      };
      try {
        return keyring.open(sealed, Keyring.totpAad(userId, row.key_version));
      } catch (error) {
        if (error instanceof KeyringLockedError) return null;
        return null;
      }
    },

    confirm(userId: number, step: number): void {
      db.prepare('UPDATE user_totp SET confirmed_at = ?, last_step = ? WHERE user_id = ?').run(
        Date.now(),
        step,
        userId,
      );
    },

    /** Tras cada uso, para que ese codigo no valga otra vez. */
    recordStep(userId: number, step: number): void {
      db.prepare('UPDATE user_totp SET last_step = ? WHERE user_id = ?').run(step, userId);
    },

    disable(userId: number): void {
      db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
    },

    // -- Codigos de recuperacion ---------------------------------------------

    replaceRecoveryCodes(userId: number, codes: string[]): void {
      const insert = db.prepare(
        'INSERT INTO user_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)',
      );
      db.transaction(() => {
        db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
        const now = Date.now();
        for (const code of codes) insert.run(userId, hashCode(code), now);
      })();
    },

    countUnusedRecoveryCodes(userId: number): number {
      const row = db
        .prepare(
          'SELECT COUNT(*) AS total FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL',
        )
        .get(userId) as { total: number };
      return row.total;
    },

    /**
     * Gasta un codigo de recuperacion.
     *
     * El `WHERE used_at IS NULL` va dentro del UPDATE a proposito: comprobar
     * primero y actualizar despues permitiria que dos intentos simultaneos
     * gastaran el mismo codigo dos veces.
     */
    consumeRecoveryCode(userId: number, code: string): boolean {
      const result = db
        .prepare(
          `UPDATE user_recovery_codes SET used_at = ?
            WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
        )
        .run(Date.now(), userId, hashCode(code));
      return result.changes > 0;
    },
  };
}
