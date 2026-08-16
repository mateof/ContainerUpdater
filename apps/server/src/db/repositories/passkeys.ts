/**
 * Credenciales WebAuthn.
 *
 * Aqui no hay nada secreto: la clave publica es publica por definicion y la
 * privada nunca sale del autenticador. Por eso, a diferencia de los registries,
 * esta tabla no pasa por el llavero de cifrado.
 */
import type { Db } from '../index.js';

export interface PasskeyRow {
  id: number;
  user_id: number;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  aaguid: string | null;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export function createPasskeyRepository(db: Db) {
  return {
    listForUser(userId: number): PasskeyRow[] {
      return db
        .prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at')
        .all(userId) as PasskeyRow[];
    },

    /**
     * Busca por identificador de credencial, sin filtrar por usuario.
     *
     * Es lo que permite el login sin escribir el nombre: el autenticador dice
     * que credencial usa y de ahi sale el usuario. El identificador es unico a
     * nivel global precisamente para que esta busqueda no sea ambigua.
     */
    findByCredentialId(credentialId: string): PasskeyRow | undefined {
      return db
        .prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?')
        .get(credentialId) as PasskeyRow | undefined;
    },

    /** Si hay alguna en todo el sistema. Decide si se ofrece el boton de entrar. */
    anyRegistered(): boolean {
      const row = db.prepare('SELECT 1 AS found FROM webauthn_credentials LIMIT 1').get() as
        | { found: number }
        | undefined;
      return row !== undefined;
    },

    countForUser(userId: number): number {
      const row = db
        .prepare('SELECT COUNT(*) AS total FROM webauthn_credentials WHERE user_id = ?')
        .get(userId) as { total: number };
      return row.total;
    },

    create(input: {
      userId: number;
      credentialId: string;
      publicKey: string;
      counter: number;
      transports: string[] | null;
      aaguid: string | null;
      name: string;
    }): void {
      db.prepare(
        `INSERT INTO webauthn_credentials
           (user_id, credential_id, public_key, counter, transports, aaguid, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.userId,
        input.credentialId,
        input.publicKey,
        input.counter,
        input.transports ? JSON.stringify(input.transports) : null,
        input.aaguid,
        input.name,
        Date.now(),
      );
    },

    /** Tras cada uso: el contador sirve para detectar credenciales clonadas. */
    recordUse(credentialId: string, counter: number): void {
      db.prepare(
        'UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?',
      ).run(counter, Date.now(), credentialId);
    },

    /** Devuelve false si no era suya, para no dejar borrar la de otro usuario. */
    remove(id: number, userId: number): boolean {
      const result = db
        .prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?')
        .run(id, userId);
      return result.changes > 0;
    },

    rename(id: number, userId: number, name: string): boolean {
      const result = db
        .prepare('UPDATE webauthn_credentials SET name = ? WHERE id = ? AND user_id = ?')
        .run(name, id, userId);
      return result.changes > 0;
    },
  };
}

export function parseTransports(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
