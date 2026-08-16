/**
 * Inicio de sesion con passkeys (WebAuthn).
 *
 * ## Lo que hay que saber antes de tocar esto
 *
 * WebAuthn no funciona en cualquier sitio, y las dos restricciones las impone el
 * NAVEGADOR, no esta aplicacion:
 *
 * 1. Exige **contexto seguro**: HTTPS, o `localhost`. En `http://192.168.1.50:8099`
 *    el navegador ni siquiera expone la API.
 * 2. El identificador del sitio (RP ID) tiene que ser un **dominio**. Una IP no
 *    vale, ni siquiera con HTTPS.
 *
 * O sea que en el acceso tipico a un NAS por IP y HTTP plano los passkeys NO
 * estan disponibles, y no hay nada que se pueda programar para evitarlo: hace
 * falta un nombre de dominio servido por HTTPS (en DSM, el proxy inverso con un
 * certificado). Por eso la contrasena sigue siendo el camino principal y esto es
 * una alternativa, nunca un sustituto: quedarse fuera del panel del NAS por
 * haber quitado la contrasena seria mucho peor que teclearla.
 *
 * ## Compatibilidad con Bitwarden
 *
 * Bitwarden actua como autenticador WebAuthn normal, asi que lo que hace falta
 * es NO pedir nada exotico. Cada decision de abajo esta tomada para eso:
 *
 * - `attestation: 'none'`. Bitwarden no aporta attestation util, y exigirla
 *   rechazaria su registro.
 * - ES256 y RS256. Son los dos algoritmos que implementa todo el mundo;
 *   Bitwarden firma con ES256.
 * - Sin restringir `authenticatorAttachment`. Segun el navegador y el sistema,
 *   la extension de Bitwarden aparece como plataforma o como itinerante;
 *   fijarlo dejaria fuera la mitad de los casos.
 * - `residentKey` y `userVerification` en `preferred`, no en `required`.
 *   `required` da mas garantias sobre el papel, pero rechaza autenticadores con
 *   poco almacenamiento o sin PIN configurado. Bitwarden crea credenciales
 *   descubribles igualmente, con lo que el login sin escribir el usuario sigue
 *   funcionando.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Repositories } from '../db/repositories/index.js';
import { parseTransports } from '../db/repositories/passkeys.js';
import type { Logger } from '../logger.js';

export class PasskeyError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not-available'
      | 'no-challenge'
      | 'verification-failed'
      | 'unknown-credential'
      | 'counter-regressed'
      | 'already-registered',
  ) {
    super(message);
    this.name = 'PasskeyError';
  }
}

/** Ventana de vida de un reto. Suficiente para buscar la llave y confirmar. */
const CHALLENGE_TTL_MS = 5 * 60_000;

interface PendingChallenge {
  challenge: string;
  userId: number | null;
  expiresAt: number;
}

/**
 * Contexto del sitio, derivado de la peticion.
 *
 * Se calcula por peticion y no se configura una sola vez porque la misma
 * instancia se alcanza por varias direcciones (la IP en la LAN, el dominio a
 * traves del proxy), y el RP ID tiene que corresponder con el origen desde el
 * que se esta usando o el navegador rechaza la operacion.
 */
export interface RelyingParty {
  id: string;
  origin: string;
  /** Si este origen admite WebAuthn. La interfaz lo consulta para explicarlo. */
  usable: boolean;
  reason: 'insecure-origin' | 'ip-address' | null;
}

/** Una IP no puede ser RP ID, ni en IPv4 ni en IPv6. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function describeRelyingParty(input: {
  host: string | undefined;
  proto: string | undefined;
  configuredId?: string;
  configuredOrigin?: string;
}): RelyingParty {
  const host = (input.host ?? '').trim();
  // El puerto no forma parte del RP ID, pero si del origen.
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const secure = input.proto === 'https' || hostname === 'localhost' || hostname === '127.0.0.1';
  const isIp = IPV4.test(hostname) || hostname.includes(':');

  const id = input.configuredId ?? hostname;
  const origin = input.configuredOrigin ?? `${input.proto ?? 'http'}://${host}`;

  // Con valores configurados a mano se confia en quien los puso: sabra por que.
  if (input.configuredId || input.configuredOrigin) {
    return { id, origin, usable: true, reason: null };
  }
  if (!secure) return { id, origin, usable: false, reason: 'insecure-origin' };
  // localhost es una IP a efectos de texto pero si vale como RP ID.
  if (isIp && hostname !== '127.0.0.1') {
    return { id, origin, usable: false, reason: 'ip-address' };
  }
  return { id, origin, usable: true, reason: null };
}

export class PasskeyService {
  /**
   * Retos pendientes, en memoria.
   *
   * No van a disco a proposito: viven cinco minutos, y un reinicio a mitad de un
   * registro solo obliga a repetirlo. Escribirlos en SQLite anadiria escrituras
   * al disco del NAS por algo que se tira enseguida.
   */
  readonly #challenges = new Map<string, PendingChallenge>();

  constructor(
    private readonly repos: Repositories,
    private readonly log: Logger,
  ) {}

  #store(key: string, challenge: string, userId: number | null): void {
    this.#purge();
    this.#challenges.set(key, { challenge, userId, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  }

  #take(key: string): PendingChallenge {
    this.#purge();
    const pending = this.#challenges.get(key);
    // De un solo uso: un reto reutilizable permitiria repetir una respuesta
    // capturada, que es justo lo que el reto existe para impedir.
    this.#challenges.delete(key);
    if (!pending) {
      throw new PasskeyError('El reto ha caducado o no existe. Vuelve a intentarlo.', 'no-challenge');
    }
    return pending;
  }

  /**
   * Convierte los fallos de la libreria en un rechazo limpio.
   *
   * Ante un origen que no cuadra, un reto que no coincide o una firma mal
   * formada, la libreria lanza un `Error` normal. Sin esto se escapaba hasta
   * Fastify y salia como 500: un rechazo de seguridad correcto presentandose
   * como que el servidor esta roto, que ademas invita a reintentar. El motivo
   * exacto queda en el log y al cliente le llega solo que no se ha verificado,
   * porque detallarselo a quien no ha entrado no ayuda a nadie util.
   */
  async #guard<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      this.log.warn(`WebAuthn ha rechazado el ${what}: ${(error as Error).message}`);
      throw new PasskeyError('No se ha podido verificar', 'verification-failed');
    }
  }

  #purge(): void {
    const now = Date.now();
    for (const [key, pending] of this.#challenges) {
      if (pending.expiresAt <= now) this.#challenges.delete(key);
    }
  }

  async registrationOptions(input: {
    userId: number;
    username: string;
    rp: RelyingParty;
    sessionKey: string;
  }) {
    if (!input.rp.usable) {
      throw new PasskeyError('Este origen no admite passkeys', 'not-available');
    }

    const existing = this.repos.passkeys.listForUser(input.userId);

    const options = await generateRegistrationOptions({
      rpName: 'ContainerUpdater',
      rpID: input.rp.id,
      // El identificador de usuario tiene que ser opaco y estable. Se usa el id
      // interno y no el nombre: cambiar de nombre no debe invalidar las llaves.
      userID: new TextEncoder().encode(String(input.userId)),
      userName: input.username,
      userDisplayName: input.username,
      attestationType: 'none',
      // Impide registrar dos veces la misma llave: el autenticador avisa en vez
      // de crear un duplicado que luego confunde en la lista.
      excludeCredentials: existing.map((row) => ({
        id: row.credential_id,
        transports: parseTransports(row.transports) as never,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      supportedAlgorithmIDs: [-7, -257],
    });

    this.#store(`reg:${input.sessionKey}`, options.challenge, input.userId);
    return options;
  }

  async verifyRegistration(input: {
    userId: number;
    response: RegistrationResponseJSON;
    name: string;
    rp: RelyingParty;
    sessionKey: string;
  }): Promise<{ name: string }> {
    const pending = this.#take(`reg:${input.sessionKey}`);

    if (pending.userId !== input.userId) {
      throw new PasskeyError('El reto no corresponde a este usuario', 'verification-failed');
    }
    if (this.repos.passkeys.findByCredentialId(input.response.id)) {
      throw new PasskeyError('Esa llave ya esta registrada', 'already-registered');
    }

    const verification = await this.#guard('registro', () =>
      verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: pending.challenge,
        expectedOrigin: input.rp.origin,
        expectedRPID: input.rp.id,
        // No se exige verificacion de usuario: `preferred` en las opciones
        // significa que puede no haberla, y exigirla aqui rechazaria justo lo
        // que alli se acepto.
        requireUserVerification: false,
      }),
    );

    if (!verification.verified || !verification.registrationInfo) {
      throw new PasskeyError('No se ha podido verificar la llave', 'verification-failed');
    }

    const { credential, aaguid } = verification.registrationInfo;

    this.repos.passkeys.create({
      userId: input.userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64'),
      counter: credential.counter,
      transports: credential.transports ? [...credential.transports] : null,
      aaguid: aaguid ?? null,
      name: input.name,
    });

    this.log.info(`Passkey "${input.name}" registrada para el usuario ${input.userId}`);
    return { name: input.name };
  }

  /**
   * Opciones de login.
   *
   * No se envia `allowCredentials`: se deja que el autenticador ofrezca las
   * credenciales que tenga para este sitio. Es lo que permite entrar sin
   * escribir el usuario, y ademas evita revelar a quien no ha entrado todavia
   * cuantas llaves hay registradas.
   */
  async authenticationOptions(input: { rp: RelyingParty; sessionKey: string }) {
    if (!input.rp.usable) {
      throw new PasskeyError('Este origen no admite passkeys', 'not-available');
    }

    const options = await generateAuthenticationOptions({
      rpID: input.rp.id,
      userVerification: 'preferred',
    });

    this.#store(`auth:${input.sessionKey}`, options.challenge, null);
    return options;
  }

  async verifyAuthentication(input: {
    response: AuthenticationResponseJSON;
    rp: RelyingParty;
    sessionKey: string;
  }): Promise<{ userId: number }> {
    const pending = this.#take(`auth:${input.sessionKey}`);

    const row = this.repos.passkeys.findByCredentialId(input.response.id);
    if (!row) {
      throw new PasskeyError('Esa llave no esta registrada', 'unknown-credential');
    }

    const verification = await this.#guard('login', () =>
      verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: pending.challenge,
        expectedOrigin: input.rp.origin,
        expectedRPID: input.rp.id,
        credential: {
          id: row.credential_id,
          publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64')),
          counter: row.counter,
          transports: parseTransports(row.transports) as never,
        },
        requireUserVerification: false,
      }),
    );

    if (!verification.verified) {
      throw new PasskeyError('La firma no es valida', 'verification-failed');
    }

    /**
     * Contador de firmas.
     *
     * Solo delata un clonado cuando el autenticador lo lleva de verdad. Los de
     * software, Bitwarden incluido, devuelven siempre cero, asi que un cero
     * nuevo frente a un cero guardado es lo normal. Rechazarlo dejaria fuera
     * justo al gestor que se quiere soportar.
     */
    const next = verification.authenticationInfo.newCounter;
    if (row.counter > 0 && next <= row.counter) {
      this.log.warn(
        `La passkey "${row.name}" ha presentado un contador que no avanza ` +
          `(${next} <= ${row.counter}). Puede estar clonada.`,
      );
      throw new PasskeyError('La llave parece clonada', 'counter-regressed');
    }

    this.repos.passkeys.recordUse(row.credential_id, next);
    return { userId: row.user_id };
  }
}
