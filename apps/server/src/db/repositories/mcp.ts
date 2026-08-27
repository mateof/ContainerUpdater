import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../index.js';
import { isMcpScope, type McpScope, type McpToken } from '@cu/shared';

interface TokenRow {
  id: number;
  name: string;
  token_hash: string;
  hint: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

/** Prefijo reconocible, para que un token que se escape se identifique al vuelo. */
const PREFIX = 'cu_mcp_';

function hash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function toToken(row: TokenRow): McpToken {
  let scopes: McpScope[] = [];
  try {
    const parsed = JSON.parse(row.scopes) as unknown;
    if (Array.isArray(parsed)) scopes = parsed.filter(isMcpScope);
  } catch {
    // Un token con permisos ilegibles se queda SIN permisos, no con todos.
  }
  return {
    id: row.id,
    name: row.name,
    scopes,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    hint: row.hint,
  };
}

export function createMcpRepository(db: Db) {
  return {
    list(): McpToken[] {
      const rows = db
        .prepare('SELECT * FROM mcp_tokens ORDER BY created_at DESC')
        .all() as TokenRow[];
      return rows.map(toToken);
    },

    /**
     * Crea un token y devuelve el secreto UNA vez.
     *
     * 32 bytes de aleatoriedad criptografica: no hay que recordarlo ni teclearlo,
     * asi que no gana nada siendo corto y pierde mucho.
     */
    create(input: {
      name: string;
      scopes: McpScope[];
      userId: number | null;
      expiresAt: number | null;
    }): { token: McpToken; secret: string } {
      const secret = `${PREFIX}${randomBytes(32).toString('base64url')}`;
      const hint = secret.slice(0, PREFIX.length + 6);

      const info = db
        .prepare(
          `INSERT INTO mcp_tokens (name, token_hash, hint, scopes, created_by, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.name,
          hash(secret),
          hint,
          JSON.stringify(input.scopes),
          input.userId,
          Date.now(),
          input.expiresAt,
        );

      const row = db
        .prepare('SELECT * FROM mcp_tokens WHERE id = ?')
        .get(Number(info.lastInsertRowid)) as TokenRow;
      return { token: toToken(row), secret };
    },

    /**
     * Resuelve un secreto a su token, si vale.
     *
     * La comparacion final es en tiempo constante. El hash ya se busca por
     * indice, asi que el ataque por tiempos aqui es teorico, pero comparar
     * secretos con `===` es la clase de atajo que un dia se copia a un sitio
     * donde si importa.
     */
    resolve(secret: string): McpToken | null {
      if (!secret.startsWith(PREFIX)) return null;

      const digest = hash(secret);
      const row = db.prepare('SELECT * FROM mcp_tokens WHERE token_hash = ?').get(digest) as
        | TokenRow
        | undefined;
      if (!row) return null;

      const esperado = Buffer.from(row.token_hash, 'utf8');
      const recibido = Buffer.from(digest, 'utf8');
      if (esperado.length !== recibido.length || !timingSafeEqual(esperado, recibido)) return null;

      if (row.expires_at !== null && row.expires_at < Date.now()) return null;

      return toToken(row);
    },

    touch(id: number): void {
      db.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
    },

    revoke(id: number): boolean {
      return db.prepare('DELETE FROM mcp_tokens WHERE id = ?').run(id).changes > 0;
    },

    /** Cuantos tokens hay vivos. La interfaz lo usa para avisar si hay alguno. */
    countActive(): number {
      return (
        db
          .prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE expires_at IS NULL OR expires_at > ?')
          .get(Date.now()) as { n: number }
      ).n;
    },
  };
}

export type McpRepository = ReturnType<typeof createMcpRepository>;
