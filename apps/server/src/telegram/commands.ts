/**
 * Comandos del bot.
 *
 * Cada comando tiene alias en ingles porque el catalogo esta en los dos
 * idiomas y seria raro obligar a escribir `/imagenes` con la interfaz en
 * ingles.
 */
import { InlineKeyboard, type Bot, type Context } from 'grammy';
import { isLocale, translate } from '@cu/shared';
import { escapeHtml } from '../services/notifier.js';
import type { Repositories } from '../db/repositories/index.js';
import type { CheckerService } from '../services/checker.js';
import type { InventoryService } from '../services/inventory.js';
import type { MetricsService } from '../services/metrics.js';
import type { UpdaterService } from '../services/updater.js';
import { SelfUpdateRejectedError, UpdateInProgressError } from '../services/updater.js';
import type { DockerApi } from '../docker/api.js';
import type { Logger } from '../logger.js';

export interface BotServices {
  inventory: InventoryService;
  checker: CheckerService;
  updater: UpdaterService;
  metrics: MetricsService;
  docker: DockerApi;
  runCheckCycle: (trigger: string) => Promise<void>;
}

export interface NonceIssuer {
  issue(action: string, ttlMs?: number): string;
  consume(nonce: string): string | null;
}

export function registerCommands(
  bot: Bot,
  repos: Repositories,
  services: BotServices,
  nonces: NonceIssuer,
  log: Logger,
): void {
  // -- Vinculacion ----------------------------------------------------------

  bot.command('start', async (ctx) => {
    const session = ctx.session;
    if (!session) return;

    const code = (ctx.match ?? '').toString().trim();

    if (!code) {
      // Un chat ya vinculado que escribe /start a secas ve la ayuda.
      await ctx.reply(session.t('telegram.help'), { parse_mode: 'HTML' });
      return;
    }

    // Tope de intentos por chat: el codigo tiene 10 caracteres de un alfabeto
    // de 32, pero un atacante con reintentos ilimitados podria probar.
    if (!allowLinkAttempt(ctx.chat.id)) {
      await ctx.reply(session.t('telegram.linkTooManyAttempts'));
      return;
    }

    const result = repos.telegram.redeemLinkCode(code, {
      chatId: ctx.chat.id,
      tgUserId: ctx.from?.id ?? null,
      username: ctx.from?.username ?? null,
      firstName: ctx.from?.first_name ?? null,
    });

    if (!result.ok) {
      const key = result.reason === 'used' ? 'telegram.linkUsed' : 'telegram.linkInvalid';
      await ctx.reply(session.t(key));
      repos.history.audit({
        actorType: 'telegram',
        actorId: String(ctx.chat.id),
        action: 'telegram.link.failed',
        detail: result.reason,
      });
      return;
    }

    repos.history.audit({
      actorType: 'telegram',
      actorId: String(ctx.chat.id),
      action: 'telegram.link.ok',
    });
    await ctx.reply(session.t('telegram.linked'));
    await ctx.reply(session.t('telegram.help'), { parse_mode: 'HTML' });
  });

  // -- Consulta -------------------------------------------------------------

  onCommands(bot, ['ayuda', 'help'], async (ctx) => {
    await ctx.reply(ctx.session!.t('telegram.help'), { parse_mode: 'HTML' });
  });

  onCommands(bot, ['imagenes', 'images'], async (ctx) => {
    const t = ctx.session!.t;
    const images = repos.inventory.listImages();
    if (images.length === 0) {
      await ctx.reply(t('telegram.noImages'));
      return;
    }

    const icon = (status: string): string => {
      if (status === 'update-available') return '\u{1F195}';
      if (status === 'up-to-date') return '✅';
      if (status === 'error') return '⚠️';
      if (status === 'pinned') return '\u{1F4CC}';
      return '❓';
    };

    const lines = images.map((image) => {
      const policy = repos.inventory.getPolicy(image.normalized_ref);
      const auto = policy.autoUpdate ? ' \u{1F504}' : '';
      const candidate = image.candidate_tag ? ` → ${escapeHtml(image.candidate_tag)}` : '';
      return `${icon(image.status)} <code>${escapeHtml(image.normalized_ref)}</code>${candidate}${auto}`;
    });

    for (const chunk of chunkLines(lines)) {
      await ctx.reply(chunk, { parse_mode: 'HTML' });
    }
  });

  onCommands(bot, ['proyectos', 'projects'], async (ctx) => {
    const t = ctx.session!.t;
    const projects = services.inventory.snapshot.projects;
    if (projects.length === 0) {
      await ctx.reply(t('telegram.noProjects'));
      return;
    }

    const lines = projects.map((project) => {
      const marker = project.updatesAvailable > 0 ? '\u{1F195}' : '✅';
      const strategy = project.yamlAccessible ? 'compose' : 'recreate';
      return (
        `${marker} <b>${escapeHtml(project.name)}</b> (${project.containers.length}) [${strategy}]\n` +
        `   <code>${escapeHtml(project.workingDir)}</code>`
      );
    });

    for (const chunk of chunkLines(lines)) {
      await ctx.reply(chunk, { parse_mode: 'HTML' });
    }
  });

  onCommands(bot, ['estado', 'status'], async (ctx) => {
    const t = ctx.session!.t;
    const snapshot = services.metrics.latest;
    const containers = services.inventory.snapshot.containers;
    const running = containers.filter((c) => c.state === 'running').length;
    const updates = repos.inventory.countUpdatesAvailable();

    const lines = [t('telegram.statusHeader')];

    if (snapshot) {
      if (snapshot.host.cpuPercent !== null) {
        lines.push(t('telegram.statusCpu', { value: snapshot.host.cpuPercent.toFixed(1) }));
      }
      if (snapshot.host.memTotal > 0) {
        lines.push(
          t('telegram.statusMemory', {
            used: formatBytes(snapshot.host.memUsed),
            total: formatBytes(snapshot.host.memTotal),
            percent: ((snapshot.host.memUsed / snapshot.host.memTotal) * 100).toFixed(0),
          }),
        );
      }
      if (snapshot.host.uptimeSeconds > 0) {
        lines.push(t('telegram.statusUptime', { value: formatDuration(snapshot.host.uptimeSeconds) }));
      }
    }

    lines.push(t('telegram.statusContainers', { running, total: containers.length }));
    lines.push(updates > 0 ? t('telegram.statusUpdates', { count: updates }) : t('telegram.statusNoUpdates'));

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  onCommands(bot, ['logs'], async (ctx) => {
    const t = ctx.session!.t;
    const args = readArgs(ctx);
    const name = args[0];
    if (!name) {
      await ctx.reply(t('telegram.usage', { usage: '/logs <contenedor> [lineas]' }), {
        parse_mode: 'HTML',
      });
      return;
    }

    const container = services.inventory.snapshot.containers.find(
      (c) => c.name === name || c.name.includes(name) || c.id.startsWith(name),
    );
    if (!container) {
      await ctx.reply(t('telegram.containerNotFound', { name: escapeHtml(name) }), {
        parse_mode: 'HTML',
      });
      return;
    }

    // Tope de 50 lineas: un mensaje de Telegram admite 4096 caracteres y
    // trocear un log largo en veinte mensajes no ayuda a nadie.
    const tail = Math.min(Math.max(Number(args[1]) || 20, 1), 50);
    const logs = await services.docker.containerLogs(container.id, tail);
    const trimmed = logs.slice(-3500);
    await ctx.reply(
      `<b>${escapeHtml(container.name)}</b>\n<pre>${escapeHtml(trimmed || '(vacio)')}</pre>`,
      { parse_mode: 'HTML' },
    );
  });

  onCommands(bot, ['idioma', 'language'], async (ctx) => {
    const value = readArgs(ctx)[0]?.toLowerCase();
    if (!isLocale(value)) {
      await ctx.reply(ctx.session!.t('telegram.usage', { usage: '/idioma es|en' }), {
        parse_mode: 'HTML',
      });
      return;
    }
    repos.telegram.setLocale(ctx.session!.chatId, value);
    await ctx.reply(translate(value, 'telegram.localeChanged'));
  });

  // -- Acciones -------------------------------------------------------------

  onCommands(bot, ['comprobar', 'check'], async (ctx) => {
    const t = ctx.session!.t;
    if (!canOperate(ctx)) return;

    await ctx.reply(t('telegram.checkStarted'));
    try {
      await services.runCheckCycle('telegram');
      const run = repos.history.listRuns(1)[0];
      if (run) {
        await ctx.reply(
          t('telegram.checkDone', {
            checked: run.imagesChecked,
            updates: run.updatesFound,
            errors: run.errors,
          }),
        );
      }
    } catch (error) {
      await ctx.reply(t('telegram.error', { error: escapeHtml((error as Error).message) }), {
        parse_mode: 'HTML',
      });
    }
  });

  onCommands(bot, ['actualizar', 'update'], (ctx) => confirmUpdate(ctx, 'update'));
  onCommands(bot, ['forzar', 'force'], (ctx) => confirmUpdate(ctx, 'force'));

  onCommands(bot, ['auto'], async (ctx) => {
    const t = ctx.session!.t;
    if (!canOperate(ctx)) return;

    const args = readArgs(ctx);
    const needle = args[0];
    const value = args[1]?.toLowerCase();
    if (!needle || (value !== 'on' && value !== 'off')) {
      await ctx.reply(t('telegram.usage', { usage: '/auto <imagen> on|off' }), {
        parse_mode: 'HTML',
      });
      return;
    }

    const image = await resolveImage(ctx, needle);
    if (!image) return;

    const policy = repos.inventory.getPolicy(image);
    repos.inventory.savePolicy({ ...policy, autoUpdate: value === 'on' });
    await ctx.reply(
      t(value === 'on' ? 'telegram.autoOn' : 'telegram.autoOff', { ref: escapeHtml(image) }),
      { parse_mode: 'HTML' },
    );
  });

  // -- Botones inline -------------------------------------------------------

  bot.on('callback_query:data', async (ctx) => {
    const session = ctx.session;
    if (!session) {
      await ctx.answerCallbackQuery();
      return;
    }

    const action = nonces.consume(ctx.callbackQuery.data);
    if (!action) {
      await ctx.answerCallbackQuery({ text: session.t('telegram.expired') });
      return;
    }

    const [kind, ...rest] = action.split(':');
    const ref = rest.join(':');

    try {
      if (kind === 'cancel') {
        await ctx.answerCallbackQuery({ text: session.t('telegram.cancelled') });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        return;
      }

      if (kind === 'auto') {
        const policy = repos.inventory.getPolicy(ref);
        repos.inventory.savePolicy({ ...policy, autoUpdate: true });
        await ctx.answerCallbackQuery();
        await ctx.reply(session.t('telegram.autoOn', { ref: escapeHtml(ref) }), {
          parse_mode: 'HTML',
        });
        return;
      }

      if (kind === 'ign') {
        // El formato es ign:<ref>:<digest>, y la referencia lleva dos puntos.
        const separator = ref.lastIndexOf(':');
        const imageRef = ref.slice(0, separator);
        const digest = ref.slice(separator + 1);
        const policy = repos.inventory.getPolicy(imageRef);
        repos.inventory.savePolicy({ ...policy, ignoredDigest: digest });
        await ctx.answerCallbackQuery();
        await ctx.reply(session.t('telegram.ignored', { ref: escapeHtml(imageRef) }), {
          parse_mode: 'HTML',
        });
        return;
      }

      if (kind === 'upd' || kind === 'frc') {
        await ctx.answerCallbackQuery({ text: session.t('telegram.working') });
        await runUpdate(ctx, ref, kind === 'frc' ? 'force' : 'update');
        return;
      }

      await ctx.answerCallbackQuery();
    } catch (error) {
      log.error('Fallo procesando un boton del bot', error);
      await ctx
        .answerCallbackQuery({ text: session.t('telegram.error', { error: 'error' }) })
        .catch(() => undefined);
    }
  });

  // -- Ayudantes ------------------------------------------------------------

  async function confirmUpdate(ctx: Context, mode: 'update' | 'force'): Promise<void> {
    const t = ctx.session!.t;
    if (!canOperate(ctx)) return;

    const needle = readArgs(ctx)[0];
    if (!needle) {
      await ctx.reply(
        t('telegram.usage', { usage: mode === 'force' ? '/forzar <imagen>' : '/actualizar <imagen>' }),
        { parse_mode: 'HTML' },
      );
      return;
    }

    const image = await resolveImage(ctx, needle);
    if (!image) return;

    // Toda accion destructiva pide confirmacion explicita. Un dedo torpe en el
    // movil no deberia recrear un contenedor.
    const keyboard = new InlineKeyboard()
      .text(t('telegram.btnConfirm'), nonces.issue(`${mode === 'force' ? 'frc' : 'upd'}:${image}`))
      .text(t('telegram.btnCancel'), nonces.issue('cancel:'));

    await ctx.reply(
      t(mode === 'force' ? 'telegram.confirmForce' : 'telegram.confirmUpdate', {
        ref: escapeHtml(image),
      }),
      { parse_mode: 'HTML', reply_markup: keyboard },
    );
  }

  async function runUpdate(ctx: Context, imageRef: string, mode: 'update' | 'force'): Promise<void> {
    const t = ctx.session!.t;
    try {
      // Un aviso inmediato: el trabajo puede tardar minutos, o esperar turno si
      // hay otro en marcha, y un chat en silencio parece que se ha perdido.
      await ctx.reply(t('telegram.working'));

      const job = await services.updater.update({
        imageRef,
        mode,
        trigger: 'telegram',
        actorChatId: ctx.chat?.id ?? null,
        // El borrado previo de la imagen no se ofrece desde Telegram: es la
        // unica ruta sin rollback y no debe poder dispararse desde el movil.
        removeImageFirst: false,
      });

      await ctx.reply(
        t('telegram.updateApplied', {
          ref: escapeHtml(job.imageRef),
          container: escapeHtml(job.containerName ?? ''),
        }),
        { parse_mode: 'HTML' },
      );
    } catch (error) {
      if (error instanceof SelfUpdateRejectedError) {
        await ctx.reply(t('telegram.selfUpdateRejected'));
        return;
      }
      if (error instanceof UpdateInProgressError) {
        await ctx.reply(t('telegram.updateInProgress'));
        return;
      }
      const rolledBack = (error as { rolledBack?: boolean }).rolledBack === true;
      await ctx.reply(
        rolledBack
          ? t('telegram.updateRolledBack', { ref: escapeHtml(imageRef) })
          : t('telegram.updateFailed', {
              ref: escapeHtml(imageRef),
              error: escapeHtml((error as Error).message.slice(0, 400)),
            }),
        { parse_mode: 'HTML' },
      );
    }
  }

  /** Resuelve lo que escribio el usuario a una referencia completa. */
  async function resolveImage(ctx: Context, needle: string): Promise<string | null> {
    const t = ctx.session!.t;

    const exact = repos.inventory.findImage(needle);
    if (exact) return exact.normalized_ref;

    const matches = repos.inventory.searchImages(needle);
    if (matches.length === 0) {
      await ctx.reply(t('telegram.imageNotFound', { ref: escapeHtml(needle) }), {
        parse_mode: 'HTML',
      });
      return null;
    }
    if (matches.length === 1) return matches[0]!.normalized_ref;

    await ctx.reply(
      t('telegram.imageAmbiguous', {
        matches: matches.map((m) => `<code>${escapeHtml(m.normalized_ref)}</code>`).join('\n'),
      }),
      { parse_mode: 'HTML' },
    );
    return null;
  }

  function canOperate(ctx: Context): boolean {
    const role = ctx.session?.role ?? 'viewer';
    if (role === 'viewer') {
      void ctx.reply(ctx.session!.t('telegram.notAuthorized'));
      return false;
    }
    return true;
  }
}

/** Registra el mismo handler para varios alias de comando. */
function onCommands(
  bot: Bot,
  commands: string[],
  handler: (ctx: Context) => Promise<void> | void,
): void {
  for (const command of commands) {
    bot.command(command, async (ctx) => {
      if (!ctx.session) return;
      await handler(ctx);
    });
  }
}

function readArgs(ctx: Context): string[] {
  const text = ctx.message?.text ?? '';
  return text.split(/\s+/).slice(1).filter(Boolean);
}

/** Telegram corta los mensajes a 4096 caracteres. */
function chunkLines(lines: string[], limit = 3500): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = '';
    }
    current += `${line}\n`;
  }
  if (current) chunks.push(current);
  return chunks;
}

const linkAttempts = new Map<number, { count: number; windowStart: number }>();

function allowLinkAttempt(chatId: number): boolean {
  const now = Date.now();
  const entry = linkAttempts.get(chatId);
  if (!entry || now - entry.windowStart > 3600_000) {
    linkAttempts.set(chatId, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= 5;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
