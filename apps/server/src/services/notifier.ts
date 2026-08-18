/**
 * Envio de avisos con deduplicacion.
 *
 * El requisito es que un aviso ya enviado no se repita, pero que una version
 * genuinamente nueva si vuelva a avisar. Se resuelve con una clave que incluye
 * el digest remoto: mientras `latest` apunte a la misma imagen la clave no
 * cambia y no se reenvia; en cuanto apunta a otra, la clave es distinta y el
 * aviso sale solo.
 */
import { buildReleaseInfo, translate, type Locale } from '@cu/shared';
import { dedupeKey } from '../db/repositories/index.js';
import type { Repositories } from '../db/repositories/index.js';
import type { CheckOutcome } from './checker.js';
import type { ContainerAlert } from './watchdog.js';
import type { Logger } from '../logger.js';

export interface OutboundMessage {
  chatId: number;
  text: string;
  /** Botones inline. El bot los traduce a su propio formato. */
  buttons?: Array<Array<{ text: string; data: string }>>;
}

/**
 * Canal de salida. Se define como interfaz para que el notifier no dependa del
 * bot y se pueda probar sin red, y para que anadir otro canal (correo, webhook)
 * no obligue a tocar este fichero.
 */
export interface NotificationChannel {
  readonly name: string;
  readonly ready: boolean;
  send(message: OutboundMessage): Promise<{ messageId: number | null }>;
}

export class NotifierService {
  #channel: NotificationChannel | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly log: Logger,
  ) {}

  setChannel(channel: NotificationChannel | null): void {
    this.#channel = channel;
  }

  get ready(): boolean {
    return this.#channel?.ready ?? false;
  }

  /** Avisa de las imagenes con novedad, una vez por digest y destinatario. */
  async notifyUpdatesAvailable(outcomes: CheckOutcome[]): Promise<void> {
    const settings = this.repos.settings.getAll();
    if (!settings.notifyOnUpdateAvailable || !this.ready) return;

    const recipients = this.repos.telegram.listNotifiable();
    if (recipients.length === 0) return;

    for (const outcome of outcomes) {
      if (!outcome.hasUpdate) continue;

      const policy = this.repos.inventory.getPolicy(outcome.ref);
      if (!policy.notify) continue;
      if (policy.pausedUntil && policy.pausedUntil > Date.now()) continue;

      // Si la imagen se va a actualizar sola, avisar de que "hay novedad" es
      // ruido: el aviso util es el de "ya se ha actualizado".
      if (policy.autoUpdate && settings.autoUpdateEnabled) continue;

      // El digest identifica la version. En modo semver puede no haberlo, y
      // entonces la etiqueta candidata hace de identificador.
      const version = outcome.remoteDigest ?? outcome.candidateTag ?? 'unknown';

      for (const recipient of recipients) {
        const locale = recipient.locale ?? settings.defaultLocale;
        const body = this.#buildUpdateMessage(outcome, locale);

        await this.#sendDeduplicated({
          kind: 'update_available',
          imageRef: outcome.ref,
          digest: version,
          chatId: recipient.chatId,
          text: body,
          buttons: [
            [
              { text: translate(locale, 'telegram.btnUpdateNow'), data: `upd:${outcome.ref}` },
              { text: translate(locale, 'telegram.btnIgnore'), data: `ign:${outcome.ref}:${version}` },
            ],
            [{ text: translate(locale, 'telegram.btnEnableAuto'), data: `auto:${outcome.ref}` }],
          ],
        });
      }
    }
  }

  async notifyUpdateApplied(input: {
    imageRef: string;
    containerName: string;
    fromTag: string | null;
    toTag: string | null;
    automatic: boolean;
  }): Promise<void> {
    const settings = this.repos.settings.getAll();
    if (!settings.notifyOnUpdateApplied || !this.ready) return;

    for (const recipient of this.repos.telegram.listNotifiable()) {
      const locale = recipient.locale ?? settings.defaultLocale;
      const text = input.automatic
        ? translate(locale, 'telegram.autoUpdateApplied', {
            ref: escapeHtml(input.imageRef),
            from: escapeHtml(input.fromTag ?? '?'),
            to: escapeHtml(input.toTag ?? input.fromTag ?? '?'),
          })
        : translate(locale, 'telegram.updateApplied', {
            ref: escapeHtml(input.imageRef),
            container: escapeHtml(input.containerName),
          });

      await this.#send({ chatId: recipient.chatId, text });
    }
  }

  async notifyFailure(input: {
    imageRef: string;
    error: string;
    rolledBack: boolean;
  }): Promise<void> {
    const settings = this.repos.settings.getAll();
    if (!settings.notifyOnFailure || !this.ready) return;

    for (const recipient of this.repos.telegram.listNotifiable()) {
      const locale = recipient.locale ?? settings.defaultLocale;
      const text = input.rolledBack
        ? translate(locale, 'telegram.updateRolledBack', { ref: escapeHtml(input.imageRef) })
        : translate(locale, 'telegram.updateFailed', {
            ref: escapeHtml(input.imageRef),
            error: escapeHtml(input.error.slice(0, 500)),
          });

      await this.#send({ chatId: recipient.chatId, text });
    }
  }

  /**
   * Avisa de un contenedor caido, en bucle o recuperado.
   *
   * Sin deduplicacion por clave, a diferencia de los avisos de actualizacion:
   * aqui la deduplicacion ya la hace el vigilante, que solo emite en las
   * TRANSICIONES. Anadir otra capa aqui solo podria hacer que se perdiera un
   * aviso legitimo, por ejemplo el de que algo se cayo dos veces en un dia.
   */
  async notifyContainerAlert(alert: ContainerAlert): Promise<void> {
    const settings = this.repos.settings.getAll();
    if (!this.ready) return;
    if (alert.kind === 'recovered') {
      if (!settings.notifyOnContainerRecovered) return;
    } else if (!settings.notifyOnContainerDown) {
      return;
    }

    for (const recipient of this.repos.telegram.listNotifiable()) {
      const locale = recipient.locale ?? settings.defaultLocale;
      const name = escapeHtml(alert.name);

      let text: string;
      switch (alert.kind) {
        case 'down':
          text = translate(locale, 'telegram.containerDown', {
            name,
            code: String(alert.exitCode ?? '?'),
          });
          break;
        case 'restart-loop':
          text = translate(locale, 'telegram.containerRestartLoop', {
            name,
            count: String(alert.restartCount),
          });
          break;
        case 'unhealthy':
          text = translate(locale, 'telegram.containerUnhealthy', { name });
          break;
        case 'recovered':
          text = translate(locale, 'telegram.containerRecovered', { name });
          break;
      }

      await this.#send({
        chatId: recipient.chatId,
        text,
        buttons:
          alert.kind === 'recovered'
            ? undefined
            : [[{ text: translate(locale, 'telegram.btnLogs'), data: `logs:${alert.name}` }]],
      });
    }
  }

  #buildUpdateMessage(outcome: CheckOutcome, locale: Locale): string {
    const ref = escapeHtml(outcome.ref);
    const header = translate(locale, 'telegram.updateAvailable', { ref });

    const detail = outcome.candidateTag
      ? translate(locale, 'telegram.updateAvailableSemver', {
          tag: escapeHtml(outcome.candidateTag),
          current: escapeHtml(ref.split(':').at(-1) ?? ''),
        })
      : translate(locale, 'telegram.updateAvailableDigest', {
          tag: escapeHtml(ref.split(':').at(-1) ?? ''),
        });

    // Enlace a que cambia. Es la diferencia entre decidir a ciegas y decidir:
    // el aviso llega al movil y desde ahi se ve el diff sin abrir el panel.
    const row = this.repos.inventory.findImage(outcome.ref);
    const release = row
      ? buildReleaseInfo({
          sourceUrl: row.remote_source_url ?? row.local_source_url,
          localRevision: row.local_revision,
          remoteRevision: row.remote_revision,
          remoteVersion: row.remote_version,
          publishedAt: row.remote_created_at,
        })
      : null;

    const link = release?.compareUrl ?? release?.releasesUrl ?? null;
    const changes = link
      ? `\n<a href="${escapeHtml(link)}">${translate(locale, 'telegram.whatChanged')}</a>`
      : '';

    return `${header}\n${detail}${changes}`;
  }

  /**
   * Reserva, envia y confirma.
   *
   * El orden es lo que da la garantia: si el envio falla se borra la reserva y
   * el aviso se reintentara en la siguiente comprobacion. Enviar primero y
   * apuntar despues perderia la marca si el proceso muere en medio, y avisaria
   * dos veces.
   */
  async #sendDeduplicated(input: {
    kind: string;
    imageRef: string;
    digest: string;
    chatId: number;
    text: string;
    buttons?: OutboundMessage['buttons'];
  }): Promise<void> {
    const key = dedupeKey({
      channel: this.#channel?.name ?? 'none',
      kind: input.kind,
      imageRef: input.imageRef,
      digest: input.digest,
      chatId: input.chatId,
    });

    const reserved = this.repos.notifications.reserve({
      dedupeKey: key,
      channel: this.#channel?.name ?? 'none',
      kind: input.kind,
      imageRef: input.imageRef,
      digest: input.digest,
      chatId: input.chatId,
    });
    if (!reserved) return;

    try {
      const result = await this.#send({
        chatId: input.chatId,
        text: input.text,
        buttons: input.buttons,
      });
      this.repos.notifications.confirm(key, result?.messageId ?? null);
    } catch (error) {
      this.repos.notifications.release(key);
      this.log.warn(`No se ha podido enviar el aviso de ${input.imageRef}`, error);
    }
  }

  async #send(message: OutboundMessage): Promise<{ messageId: number | null } | null> {
    if (!this.#channel?.ready) return null;
    return this.#channel.send(message);
  }
}

/**
 * Escapado para `parse_mode: HTML` de Telegram.
 *
 * Se usa HTML y no MarkdownV2 porque las referencias de imagen llevan `.`,
 * `-`, `_` y `/`, y MarkdownV2 obliga a escapar cada uno de esos caracteres:
 * es una fuente garantizada de mensajes rotos. En HTML solo hay tres.
 */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
