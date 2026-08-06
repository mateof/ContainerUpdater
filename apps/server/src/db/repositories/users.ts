import type { Db } from '../index.js';
import type { CurrentUser, Locale } from '@cu/shared';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: 'admin' | 'operator' | 'viewer';
  locale: Locale;
  must_change_password: number;
  failed_attempts: number;
  locked_until: number | null;
  last_login_at: number | null;
}

export interface SessionRow {
  id: string;
  user_id: number;
  token_hash: string;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
}

export function createUserRepository(db: Db) {
  return {
    count(): number {
      return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    },

    findByUsername(username: string): UserRow | undefined {
      return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
        | UserRow
        | undefined;
    },

    findById(id: number): UserRow | undefined {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    },

    create(input: {
      username: string;
      passwordHash: string;
      role?: 'admin' | 'operator' | 'viewer';
      locale?: Locale;
      mustChangePassword?: boolean;
    }): number {
      const now = Date.now();
      const info = db
        .prepare(
          `INSERT INTO users
             (username, password_hash, role, locale, must_change_password, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.username,
          input.passwordHash,
          input.role ?? 'admin',
          input.locale ?? 'es',
          input.mustChangePassword ? 1 : 0,
          now,
          now,
        );
      return Number(info.lastInsertRowid);
    },

    setPassword(id: number, passwordHash: string): void {
      db.prepare(
        `UPDATE users
            SET password_hash = ?, must_change_password = 0, updated_at = ?
          WHERE id = ?`,
      ).run(passwordHash, Date.now(), id);
    },

    setLocale(id: number, locale: Locale): void {
      db.prepare('UPDATE users SET locale = ?, updated_at = ? WHERE id = ?').run(
        locale,
        Date.now(),
        id,
      );
    },

    /**
     * Backoff exponencial persistente. El bloqueo vive en la fila y no en
     * memoria, asi que reiniciar el contenedor no regala intentos.
     */
    registerFailedAttempt(id: number): void {
      const row = db.prepare('SELECT failed_attempts FROM users WHERE id = ?').get(id) as
        | { failed_attempts: number }
        | undefined;
      if (!row) return;
      const attempts = row.failed_attempts + 1;
      // A partir del cuarto intento: 1s, 2s, 4s... con techo de 15 minutos.
      const delay = attempts <= 3 ? 0 : Math.min(2 ** (attempts - 4) * 1000, 15 * 60_000);
      db.prepare(
        'UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?',
      ).run(attempts, delay > 0 ? Date.now() + delay : null, Date.now(), id);
    },

    registerSuccessfulLogin(id: number): void {
      db.prepare(
        `UPDATE users
            SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ?
          WHERE id = ?`,
      ).run(Date.now(), Date.now(), id);
    },

    toCurrentUser(row: UserRow): CurrentUser {
      return {
        id: row.id,
        username: row.username,
        role: row.role,
        locale: row.locale,
        mustChangePassword: row.must_change_password === 1,
      };
    },
  };
}

export function createSessionRepository(db: Db) {
  return {
    create(input: {
      id: string;
      userId: number;
      tokenHash: string;
      expiresAt: number;
      userAgent?: string;
      ip?: string;
      rotatedFrom?: string;
    }): void {
      const now = Date.now();
      db.prepare(
        `INSERT INTO sessions
           (id, user_id, token_hash, rotated_from, user_agent, ip, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.userId,
        input.tokenHash,
        input.rotatedFrom ?? null,
        input.userAgent ?? null,
        input.ip ?? null,
        now,
        now,
        input.expiresAt,
      );
    },

    findByTokenHash(tokenHash: string): SessionRow | undefined {
      return db
        .prepare(
          `SELECT * FROM sessions
            WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
        )
        .get(tokenHash, Date.now()) as SessionRow | undefined;
    },

    touch(id: string, expiresAt: number): void {
      db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(
        Date.now(),
        expiresAt,
        id,
      );
    },

    revoke(id: string): void {
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(Date.now(), id);
    },

    revokeAllForUser(userId: number): void {
      db.prepare(
        'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      ).run(Date.now(), userId);
    },

    purgeExpired(): number {
      // Se conservan 30 dias tras caducar para poder investigar un robo de
      // token (la columna rotated_from encadena las rotaciones).
      const cutoff = Date.now() - 30 * 24 * 3600_000;
      return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(cutoff).changes;
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
export type SessionRepository = ReturnType<typeof createSessionRepository>;
