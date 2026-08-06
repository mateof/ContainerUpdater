/**
 * Bot de Telegram.
 *
 * Long polling y no webhook: el NAS esta detras de NAT y un webhook obligaria a
 * abrir un puerto al exterior y a tener un certificado valido. El long polling
 * solo hace HTTPS saliente, que ya funciona sin tocar el router.
 *
 * grammY en lugar de telegraf (mantenimiento irregular) o node-telegram-bot-api
 * (API antigua y tipos pobres).
 */
import { Bot, GrammyError, HttpError, InlineKeyboard } from 'grammy';
import { translate, isLocale, type Locale } from '@cu/shared';
import { escapeHtml, type NotificationChannel, type OutboundMessage } from '../services/notifier.js';
import { registerCommands } from './commands.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Logger } from '../logger.js';
import type { BotServices } from './commands.js';

/**
 * Contexto de un mensaje autorizado. Se rellena en el middleware de allowlist,
 * asi que los handlers pueden darlo por hecho.
 */
export interface BotSession {
  chatId: number;
  role: 'admin' | 'operator' | 'viewer';
  locale: Locale;
  t: (key: string, params?: Record<string, string | number>) => string;
}

declare module 'grammy' {
  interface Context {
    session?: BotSession;
  }
}

/**
 * Almacen de nonces para los botones inline.
 *
 * Sin esto, un boton "Actualizar ahora" que quede en el historial del chat
 * podria pulsarse meses despues y disparar una actualizacion que nadie espera.
 * Con TTL corto, un boton viejo simplemente caduca.
 */
class NonceStore {
  readonly #entries = new Map<string, { action: string; expiresAt: number }>();

  issue(action: string, ttlMs = 2 * 60_000): string {
    this.#prune();
    const nonce = Math.random().toString(36).slice(2, 10);
    this.#entries.set(nonce, { action, expiresAt: Date.now() + ttlMs });
    return nonce;
  }

  consume(nonce: string): string | null {
    const entry = this.#entries.get(nonce);
    if (!entry) return null;
    this.#entries.delete(nonce);
    if (entry.expiresAt < Date.now()) return null;
    return entry.action;
  }

  #prune(): void {
    const now = Date.now();
    for (const [nonce, entry] of this.#entries) {
      if (entry.expiresAt < now) this.#entries.delete(nonce);
    }
  }
}

export class TelegramBot implements NotificationChannel {
  readonly name = 'telegram';
  readonly nonces = new NonceStore();

  #bot: Bot | null = null;
  #running = false;
  #username: string | null = null;
  #error: string | null = null;

  constructor(
    private readonly token: string | undefined,
    private readonly repos: Repositories,
    private readonly services: BotServices,
    private readonly log: Logger,
  ) {}

  get ready(): boolean {
    return this.#running;
  }

  get username(): string | null {
    return this.#username;
  }

  get lastError(): string | null {
    return this.#error;
  }

  get configured(): boolean {
    return Boolean(this.token);
  }

  /**
   * Arranca el bot. Un token ausente o invalido nunca debe tumbar la app: el
   * panel web tiene que seguir funcionando aunque Telegram no.
   */
  async start(): Promise<void> {
    if (!this.token) {
      this.log.info('Sin CU_TELEGRAM_BOT_TOKEN: el bot queda desactivado');
      return;
    }

    try {
      const bot = new Bot(this.token);
      this.#bot = bot;

      bot.catch((error) => {
        const err = error.error;
        if (err instanceof GrammyError) {
          this.log.error(`Telegram ha rechazado la peticion: ${err.description}`);
        } else if (err instanceof HttpError) {
          this.log.warn('No se ha podido contactar con Telegram', err);
        } else {
          this.log.error('Error en el bot', err);
        }
      });

      this.#installAllowlist(bot);
      registerCommands(bot, this.repos, this.services, this.nonces, this.log);

      const me = await bot.api.getMe();
      this.#username = me.username;

      // `drop_pending_updates` es importante: tras un reinicio del NAS, Telegram
      // tiene encolados los mensajes de mientras estuvo apagado. Sin esto, el
      // bot ejecutaria un /actualizar de hace horas nada mas arrancar.
      void bot.start({
        drop_pending_updates: true,
        onStart: () => {
          this.#running = true;
          this.log.info(`Bot de Telegram activo como @${me.username}`);
        },
      });

      await bot.api.setMyCommands([
        { command: 'ayuda', description: 'Ayuda / Help' },
        { command: 'imagenes', description: 'Listar imagenes' },
        { command: 'estado', description: 'Estado del sistema' },
        { command: 'comprobar', description: 'Buscar actualizaciones' },
        { command: 'actualizar', description: 'Actualizar una imagen' },
        { command: 'forzar', description: 'Forzar la actualizacion' },
        { command: 'auto', description: 'Auto-actualizacion on/off' },
        { command: 'proyectos', description: 'Listar proyectos' },
        { command: 'logs', description: 'Ver registros' },
        { command: 'idioma', description: 'Cambiar idioma' },
      ]);
    } catch (error) {
      this.#error = (error as Error).message;
      this.#running = false;
      this.log.error('No se ha podido arrancar el bot de Telegram', error);
    }
  }

  /**
   * Allowlist. Es el primer middleware, antes de cualquier handler, para que un
   * chat no autorizado no llegue nunca a la logica de comandos.
   *
   * Se comprueba `chat.id` y tambien `from.id`. En un chat privado coinciden,
   * pero si algun dia se habilitan los grupos, mirar solo el chat dejaria
   * actuar a cualquier miembro del grupo.
   */
  #installAllowlist(bot: Bot): void {
    bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;

      const settings = this.repos.settings.getAll();
      const defaultLocale = settings.defaultLocale;

      if (ctx.chat?.type !== 'private' && !settings.allowTelegramGroups) {
        // Silencio absoluto en grupos: contestar confirmaria que el bot existe.
        return;
      }

      const entry = this.repos.telegram.findActive(chatId);

      if (!entry) {
        // La vinculacion es la unica puerta de entrada para un chat desconocido.
        const text = ctx.message?.text ?? '';
        if (/^\/start\s+\S+/.test(text)) {
          ctx.session = {
            chatId,
            role: 'viewer',
            locale: defaultLocale,
            t: (key, params) => translate(defaultLocale, key, params),
          };
          return next();
        }

        await ctx.reply(translate(defaultLocale, 'telegram.notAuthorized'));
        this.repos.history.audit({
          actorType: 'telegram',
          actorId: String(chatId),
          action: 'telegram.denied',
          detail: ctx.from?.username ?? null,
        });
        return;
      }

      const locale = entry.locale ?? defaultLocale;
      ctx.session = {
        chatId,
        role: entry.role,
        locale,
        t: (key, params) => translate(locale, key, params),
      };
      this.repos.telegram.touch(chatId);
      return next();
    });
  }

  async send(message: OutboundMessage): Promise<{ messageId: number | null }> {
    if (!this.#bot || !this.#running) return { messageId: null };

    let keyboard: InlineKeyboard | undefined;
    if (message.buttons) {
      keyboard = new InlineKeyboard();
      for (const row of message.buttons) {
        for (const button of row) {
          // Telegram limita callback_data a 64 bytes, y una referencia de
          // imagen se pasa de largo. Se guarda la accion en memoria y solo
          // viaja el nonce.
          keyboard.text(button.text, this.nonces.issue(button.data, 24 * 3600_000));
        }
        keyboard.row();
      }
    }

    const sent = await this.#bot.api.sendMessage(message.chatId, message.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    });
    return { messageId: sent.message_id };
  }

  /** Apagado ordenado: sin esto queda un getUpdates colgado y el siguiente arranque da 409. */
  async stop(): Promise<void> {
    if (!this.#bot) return;
    this.#running = false;
    await this.#bot.stop().catch(() => undefined);
  }
}

export { escapeHtml, isLocale };
