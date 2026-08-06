import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../index.js';
import type { Locale, TelegramUser } from '@cu/shared';

interface TelegramUserRow {
  id: number;
  chat_id: number;
  tg_user_id: number | null;
  username: string | null;
  first_name: string | null;
  role: 'admin' | 'operator' | 'viewer';
  linked_user_id: number | null;
  locale: Locale | null;
  active: number;
  linked_at: number;
  last_seen_at: number | null;
}

export function createNotificationRepository(db: Db) {
  return {
    /**
     * Reserva la notificacion antes de enviarla.
     *
     * Devuelve false si ya se envio esa combinacion exacta. El orden importa:
     * reservar primero e insertar despues evita duplicados si hay dos
     * comprobaciones solapadas, y borrar la reserva cuando el envio falla evita
     * perder el aviso para siempre.
     */
    reserve(input: {
      dedupeKey: string;
      channel: string;
      kind: string;
      imageRef: string | null;
      digest: string | null;
      chatId: number | null;
    }): boolean {
      const info = db
        .prepare(
          `INSERT OR IGNORE INTO notifications_sent
             (dedupe_key, channel, kind, image_ref, digest, chat_id, reserved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.dedupeKey,
          input.channel,
          input.kind,
          input.imageRef,
          input.digest,
          input.chatId,
          Date.now(),
        );
      return info.changes > 0;
    },

    confirm(dedupeKey: string, messageId: number | null): void {
      db.prepare('UPDATE notifications_sent SET sent_at = ?, message_id = ? WHERE dedupe_key = ?').run(
        Date.now(),
        messageId,
        dedupeKey,
      );
    },

    /** Libera la reserva para que el aviso se pueda reintentar. */
    release(dedupeKey: string): void {
      db.prepare('DELETE FROM notifications_sent WHERE dedupe_key = ?').run(dedupeKey);
    },

    /** Olvida los avisos de una imagen, para volver a notificar desde cero. */
    forgetForImage(imageRef: string): void {
      db.prepare('DELETE FROM notifications_sent WHERE image_ref = ?').run(imageRef);
    },
  };
}

export function dedupeKey(parts: {
  channel: string;
  kind: string;
  imageRef: string;
  digest: string;
  chatId?: number;
}): string {
  const raw = [parts.channel, parts.kind, parts.imageRef, parts.digest, parts.chatId ?? '']
    .join('|');
  return createHash('sha256').update(raw).digest('hex');
}

export function createTelegramRepository(db: Db) {
  function toUser(row: TelegramUserRow): TelegramUser {
    return {
      id: row.id,
      chatId: row.chat_id,
      username: row.username,
      firstName: row.first_name,
      role: row.role,
      locale: row.locale,
      active: row.active === 1,
      linkedAt: row.linked_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  return {
    listUsers(): TelegramUser[] {
      const rows = db
        .prepare('SELECT * FROM telegram_users ORDER BY linked_at')
        .all() as TelegramUserRow[];
      return rows.map(toUser);
    },

    findActive(chatId: number): TelegramUser | undefined {
      const row = db
        .prepare('SELECT * FROM telegram_users WHERE chat_id = ? AND active = 1')
        .get(chatId) as TelegramUserRow | undefined;
      return row ? toUser(row) : undefined;
    },

    /** Destinatarios de las notificaciones automaticas. */
    listNotifiable(): TelegramUser[] {
      const rows = db
        .prepare(`SELECT * FROM telegram_users WHERE active = 1 AND role IN ('admin','operator')`)
        .all() as TelegramUserRow[];
      return rows.map(toUser);
    },

    touch(chatId: number): void {
      db.prepare('UPDATE telegram_users SET last_seen_at = ? WHERE chat_id = ?').run(
        Date.now(),
        chatId,
      );
    },

    setLocale(chatId: number, locale: Locale): void {
      db.prepare('UPDATE telegram_users SET locale = ? WHERE chat_id = ?').run(locale, chatId);
    },

    revoke(id: number): void {
      db.prepare('UPDATE telegram_users SET active = 0 WHERE id = ?').run(id);
    },

    // -- Vinculacion --------------------------------------------------------

    /**
     * Genera un codigo de un solo uso. Se devuelve en claro al usuario pero en
     * base de datos solo queda su hash, asi que un volcado de la BD no permite
     * vincular una cuenta.
     */
    createLinkCode(userId: number, ttlMs = 10 * 60_000): { code: string; expiresAt: number } {
      // Base32 sin caracteres ambiguos: se lee en voz alta y se teclea en el movil.
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const bytes = randomBytes(10);
      let code = '';
      for (const byte of bytes) code += alphabet[byte % alphabet.length];

      const expiresAt = Date.now() + ttlMs;
      db.prepare(
        `INSERT INTO telegram_link_codes (code_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      ).run(hashCode(code), userId, Date.now(), expiresAt);
      return { code, expiresAt };
    },

    /**
     * Canjea el codigo y vincula el chat, todo en una transaccion.
     *
     * El `WHERE used_at IS NULL` dentro del UPDATE es lo que garantiza el uso
     * unico: si dos chats canjean a la vez, solo uno ve `changes === 1`.
     */
    redeemLinkCode(
      code: string,
      chat: {
        chatId: number;
        tgUserId: number | null;
        username: string | null;
        firstName: string | null;
      },
    ): { ok: true; user: TelegramUser } | { ok: false; reason: 'invalid' | 'expired' | 'used' } {
      const redeem = db.transaction(() => {
        const row = db
          .prepare('SELECT * FROM telegram_link_codes WHERE code_hash = ?')
          .get(hashCode(code)) as
          | { code_hash: string; user_id: number; expires_at: number; used_at: number | null }
          | undefined;

        if (!row) return { ok: false as const, reason: 'invalid' as const };
        if (row.used_at !== null) return { ok: false as const, reason: 'used' as const };
        if (row.expires_at < Date.now()) return { ok: false as const, reason: 'expired' as const };

        const claimed = db
          .prepare(
            'UPDATE telegram_link_codes SET used_at = ?, used_by_chat = ? WHERE code_hash = ? AND used_at IS NULL',
          )
          .run(Date.now(), chat.chatId, row.code_hash);
        if (claimed.changes === 0) return { ok: false as const, reason: 'used' as const };

        db.prepare(
          `INSERT INTO telegram_users
             (chat_id, tg_user_id, username, first_name, role, linked_user_id, active, linked_at)
           VALUES (?, ?, ?, ?, 'admin', ?, 1, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             tg_user_id = excluded.tg_user_id,
             username = excluded.username,
             first_name = excluded.first_name,
             linked_user_id = excluded.linked_user_id,
             active = 1`,
        ).run(chat.chatId, chat.tgUserId, chat.username, chat.firstName, row.user_id, Date.now());

        const user = db
          .prepare('SELECT * FROM telegram_users WHERE chat_id = ?')
          .get(chat.chatId) as TelegramUserRow;
        return { ok: true as const, user: toUser(user) };
      });

      return redeem();
    },

    purgeExpiredCodes(): number {
      return db
        .prepare('DELETE FROM telegram_link_codes WHERE expires_at < ? OR used_at IS NOT NULL')
        .run(Date.now() - 24 * 3600_000).changes;
    },
  };
}

function hashCode(code: string): string {
  return createHash('sha256').update(code.toUpperCase()).digest('hex');
}

export type NotificationRepository = ReturnType<typeof createNotificationRepository>;
export type TelegramRepository = ReturnType<typeof createTelegramRepository>;
