/**
 * Segundo factor con codigo temporal.
 *
 * ## Es opcional, y eso condiciona el diseno
 *
 * Esta aplicacion gestiona todos los contenedores de un NAS. Quedarse fuera por
 * haber perdido el movil no es una molestia, es perder el acceso al panel que
 * arranca y para todo. De ahi tres decisiones que no se deben deshacer:
 *
 * 1. **No se activa hasta confirmarlo con un codigo valido.** Guardar el secreto
 *    y darlo por activo dejaria fuera a quien no llegara a escanear el QR.
 * 2. **Codigos de recuperacion desde el primer momento**, y se muestran una sola
 *    vez, al activarlo.
 * 3. **Con el llavero bloqueado NO se exige.** El secreto esta cifrado con el; si
 *    no se puede descifrar, nadie podria entrar nunca. Se registra en el log y se
 *    deja pasar con la contrasena, que es el mal menor frente a un panel
 *    inaccesible para siempre.
 *
 * ## Compatibilidad
 *
 * SHA-1, seis digitos, treinta segundos. Es lo unico que interpretan igual todas
 * las aplicaciones: Google Authenticator y Microsoft Authenticator ignoran el
 * parametro `algorithm` y asumen SHA-1. Ver `crypto/totp.ts`.
 */
import { randomBytes } from 'node:crypto';
import {
  generateRecoveryCodes,
  generateSecret,
  normalizeRecoveryCode,
  otpauthUri,
  verifyCode,
} from '../crypto/totp.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Logger } from '../logger.js';

export class TotpError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not-enrolled'
      | 'already-enabled'
      | 'invalid-code'
      | 'reused-code'
      | 'keyring-locked'
      | 'ticket-expired',
  ) {
    super(message);
    this.name = 'TotpError';
  }
}

/**
 * Ventana del ticket entre el paso de contrasena y el del codigo.
 *
 * Corta a proposito: mientras vive, quien tenga el ticket ya ha demostrado
 * saber la contrasena y solo le falta el segundo factor.
 */
const TICKET_TTL_MS = 5 * 60_000;

interface PendingLogin {
  userId: number;
  expiresAt: number;
}

export class TotpService {
  /**
   * Logins a medias, en memoria.
   *
   * No van a disco: viven cinco minutos y un reinicio solo obliga a volver a
   * escribir la contrasena. Escribirlos en SQLite castigaria el disco del NAS
   * en cada intento de login.
   */
  readonly #pending = new Map<string, PendingLogin>();

  constructor(
    private readonly repos: Repositories,
    private readonly log: Logger,
  ) {}

  isEnabled(userId: number): boolean {
    return this.repos.totp.isEnabled(userId);
  }

  status(userId: number): { enabled: boolean; recoveryCodesLeft: number } {
    return {
      enabled: this.repos.totp.isEnabled(userId),
      recoveryCodesLeft: this.repos.totp.countUnusedRecoveryCodes(userId),
    };
  }

  /**
   * Empieza el alta: secreto nuevo y URI para el QR.
   *
   * Todavia no queda activo. Se activa en `confirm`, con un codigo valido
   * delante.
   */
  startEnrollment(input: { userId: number; username: string }): { secret: string; uri: string } {
    if (this.repos.totp.isEnabled(input.userId)) {
      throw new TotpError('El segundo factor ya esta activo', 'already-enabled');
    }
    if (!this.repos.keyringHealthy()) {
      throw new TotpError('El llavero esta bloqueado', 'keyring-locked');
    }

    const secret = generateSecret();
    this.repos.totp.startEnrollment(input.userId, secret);

    return {
      secret,
      uri: otpauthUri({ secret, account: input.username, issuer: 'ContainerUpdater' }),
    };
  }

  /**
   * Confirma el alta y devuelve los codigos de recuperacion.
   *
   * Es la unica vez que se muestran: se guardan hasheados, asi que despues ya no
   * se pueden volver a ensenar. La interfaz lo advierte antes de cerrar.
   */
  confirmEnrollment(input: { userId: number; code: string }): { recoveryCodes: string[] } {
    const secret = this.repos.totp.readSecret(input.userId);
    if (!secret) throw new TotpError('No hay ningun alta empezada', 'not-enrolled');

    const result = verifyCode(secret, input.code);
    if (!result.valid || result.step === null) {
      throw new TotpError('El codigo no es correcto', 'invalid-code');
    }

    this.repos.totp.confirm(input.userId, result.step);

    const codes = generateRecoveryCodes();
    this.repos.totp.replaceRecoveryCodes(input.userId, codes.map(normalizeRecoveryCode));

    this.log.info(`Segundo factor activado para el usuario ${input.userId}`);
    return { recoveryCodes: codes };
  }

  /** Regenera los codigos, invalidando los anteriores. */
  regenerateRecoveryCodes(userId: number): string[] {
    if (!this.repos.totp.isEnabled(userId)) {
      throw new TotpError('El segundo factor no esta activo', 'not-enrolled');
    }
    const codes = generateRecoveryCodes();
    this.repos.totp.replaceRecoveryCodes(userId, codes.map(normalizeRecoveryCode));
    return codes;
  }

  disable(userId: number): void {
    this.repos.totp.disable(userId);
    this.log.info(`Segundo factor desactivado para el usuario ${userId}`);
  }

  // -- Login en dos pasos ----------------------------------------------------

  /**
   * Guarda un login a medias y devuelve el ticket del segundo paso.
   *
   * Hace falta porque la contrasena sola ya no puede dar sesion: si el primer
   * paso la devolviera, el segundo factor no serviria de nada.
   */
  createTicket(userId: number): string {
    this.#purge();
    const ticket = randomBytes(32).toString('base64url');
    this.#pending.set(ticket, { userId, expiresAt: Date.now() + TICKET_TTL_MS });
    return ticket;
  }

  /**
   * Completa el segundo paso.
   *
   * Acepta el codigo de la aplicacion o uno de recuperacion, decidiendo por la
   * forma: seis digitos es TOTP, lo demas se prueba como recuperacion. Asi el
   * usuario no tiene que elegir en un momento en el que probablemente ya esta
   * agobiado por no poder entrar.
   */
  verifyTicket(input: { ticket: string; code: string }): { userId: number; usedRecovery: boolean } {
    this.#purge();
    const pending = this.#pending.get(input.ticket);
    if (!pending) {
      throw new TotpError('La sesion de login ha caducado. Vuelve a empezar.', 'ticket-expired');
    }

    const digits = input.code.replace(/\s/g, '');
    const isTotpShaped = /^\d{6}$/.test(digits);

    if (isTotpShaped) {
      const userId = this.#verifyTotp(pending.userId, digits);
      // Solo se consume el ticket cuando el codigo es bueno: si se gastara en
      // cada intento, un digito mal tecleado obligaria a repetir la contrasena.
      this.#pending.delete(input.ticket);
      return { userId, usedRecovery: false };
    }

    if (!this.repos.totp.consumeRecoveryCode(pending.userId, normalizeRecoveryCode(input.code))) {
      throw new TotpError('El codigo no es correcto', 'invalid-code');
    }

    this.#pending.delete(input.ticket);
    this.log.warn(
      `El usuario ${pending.userId} ha entrado con un codigo de recuperacion. ` +
        `Le quedan ${this.repos.totp.countUnusedRecoveryCodes(pending.userId)}.`,
    );
    return { userId: pending.userId, usedRecovery: true };
  }

  #verifyTotp(userId: number, code: string): number {
    const secret = this.repos.totp.readSecret(userId);
    if (!secret) throw new TotpError('No se puede comprobar el codigo', 'keyring-locked');

    const result = verifyCode(secret, code);
    if (!result.valid || result.step === null) {
      throw new TotpError('El codigo no es correcto', 'invalid-code');
    }

    /**
     * Un codigo no vale dos veces.
     *
     * Con el margen de un intervalo a cada lado, uno sirve hasta minuto y medio.
     * Sin esta comprobacion, quien lo viera por encima del hombro podria usarlo
     * despues aunque el legitimo ya hubiera entrado.
     */
    const row = this.repos.totp.find(userId);
    if (row?.last_step !== null && row !== undefined && result.step <= row.last_step) {
      throw new TotpError('Ese codigo ya se ha usado. Espera al siguiente.', 'reused-code');
    }

    this.repos.totp.recordStep(userId, result.step);
    return userId;
  }

  #purge(): void {
    const now = Date.now();
    for (const [ticket, pending] of this.#pending) {
      if (pending.expiresAt <= now) this.#pending.delete(ticket);
    }
  }
}
