/**
 * Llavero de cifrado para las credenciales de registry.
 *
 * Envelope encryption: una clave maestra (KEK) que viene del entorno envuelve
 * una clave de datos (DEK) generada en el primer arranque. Las filas se cifran
 * con la DEK.
 *
 * Por que envelope y no cifrar directamente con la KEK: rotar la clave maestra
 * pasa a ser re-envolver un unico DEK en lugar de re-cifrar cada fila. Tambien
 * permite que la KEK cambie de formato (base64 o passphrase) sin tocar datos.
 *
 * Todo con `node:crypto`. Descartado libsodium: otra dependencia nativa que
 * compilar en arm64 a cambio de nada que AES-256-GCM no cubra ya.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import type { Db } from '../db/index.js';

export interface Sealed {
  ct: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

export const KEY_VERSION = 1;

const CANARY_PLAINTEXT = 'containerupdater-keyring-canary-v1';
const CANARY_AAD = 'keyring:canary:1';

export class KeyringLockedError extends Error {
  constructor() {
    super('El llavero esta bloqueado: no se puede leer ni escribir credenciales');
    this.name = 'KeyringLockedError';
  }
}

export class Keyring {
  /**
   * `healthy` en false significa que hay datos cifrados que no podemos
   * descifrar (clave maestra distinta o ausente). La app arranca igual: perder
   * la clave no debe impedir vigilar imagenes publicas ni entrar en la web.
   */
  readonly healthy: boolean;
  readonly reason: string | null;
  readonly #dek: Buffer | null;

  private constructor(dek: Buffer | null, reason: string | null) {
    this.#dek = dek;
    this.healthy = dek !== null;
    this.reason = reason;
  }

  static create(db: Db, opts: { key?: string; passphrase?: string }): Keyring {
    const kek = deriveKek(db, opts);
    if (!kek) {
      return new Keyring(
        null,
        'No hay clave maestra configurada (CU_ENCRYPTION_KEY o CU_MASTER_PASSPHRASE)',
      );
    }

    const wrapped = readSetting(db, 'dek_wrapped');
    if (!wrapped) {
      // Primer arranque: generamos la DEK y la envolvemos.
      const dek = randomBytes(32);
      writeSetting(db, 'dek_wrapped', JSON.stringify(seal(kek, dek, 'keyring:dek:1')));
      const ring = new Keyring(dek, null);
      writeSetting(db, 'kek_canary', JSON.stringify(ring.seal(CANARY_PLAINTEXT, CANARY_AAD)));
      return ring;
    }

    let dek: Buffer;
    try {
      dek = open(kek, JSON.parse(wrapped) as SerializedSealed, 'keyring:dek:1');
    } catch {
      return new Keyring(
        null,
        'La clave maestra no coincide con la que cifro los datos guardados',
      );
    }

    const ring = new Keyring(dek, null);

    // El canario detecta una DEK que se desenvuelve pero no descifra (por
    // ejemplo, base de datos restaurada de otra instalacion).
    const canary = readSetting(db, 'kek_canary');
    if (canary) {
      try {
        const plain = ring.open(JSON.parse(canary) as SerializedSealed, CANARY_AAD);
        const expected = Buffer.from(CANARY_PLAINTEXT, 'utf8');
        const actual = Buffer.from(plain, 'utf8');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          return new Keyring(null, 'El canario del llavero no coincide');
        }
      } catch {
        return new Keyring(null, 'No se ha podido verificar el canario del llavero');
      }
    } else {
      writeSetting(db, 'kek_canary', JSON.stringify(ring.seal(CANARY_PLAINTEXT, CANARY_AAD)));
    }

    return ring;
  }

  /** Llavero explicitamente bloqueado. Solo para tests y modo degradado. */
  static locked(reason: string): Keyring {
    return new Keyring(null, reason);
  }

  seal(plaintext: string, aad: string): SerializedSealed {
    if (!this.#dek) throw new KeyringLockedError();
    return seal(this.#dek, Buffer.from(plaintext, 'utf8'), aad);
  }

  open(sealed: SerializedSealed, aad: string): string {
    if (!this.#dek) throw new KeyringLockedError();
    return open(this.#dek, sealed, aad).toString('utf8');
  }

  /**
   * AAD de una fila de registry. Ata el ciphertext a su fila y a la version de
   * clave, de modo que copiar el blob de una fila a otra (o degradarlo a una
   * key_version antigua) falle la autenticacion en vez de descifrar el secreto
   * de otro registry.
   */
  static registryAad(registryId: number, keyVersion = KEY_VERSION): string {
    return `registries:${registryId}:${keyVersion}`;
  }
}

export interface SerializedSealed {
  ct: string;
  iv: string;
  tag: string;
  v: number;
}

function seal(key: Buffer, plaintext: Buffer, aad: string): SerializedSealed {
  // IV de 12 bytes aleatorio en CADA escritura. Reutilizarlo con la misma clave
  // rompe GCM por completo, no solo debilita.
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ct: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    v: KEY_VERSION,
  };
}

function open(key: Buffer, sealed: SerializedSealed, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]);
}

function deriveKek(db: Db, opts: { key?: string; passphrase?: string }): Buffer | null {
  if (opts.key) {
    const raw = Buffer.from(opts.key, 'base64');
    if (raw.length !== 32) {
      throw new Error(
        'CU_ENCRYPTION_KEY debe ser exactamente 32 bytes en base64. ' +
          "Genera una con: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      );
    }
    return raw;
  }

  if (opts.passphrase) {
    let salt = readSetting(db, 'kek_salt');
    if (!salt) {
      salt = randomBytes(16).toString('base64');
      writeSetting(db, 'kek_salt', salt);
    }
    // scrypt y no Argon2: viene en node:crypto, se ejecuta una sola vez al
    // arrancar y evita meter otra dependencia nativa en el camino de arranque.
    // N=2^16 tarda del orden de decimas de segundo, aceptable una vez.
    return scryptSync(opts.passphrase, Buffer.from(salt, 'base64'), 32, {
      N: 2 ** 16,
      r: 8,
      p: 1,
      maxmem: 128 * 1024 * 1024,
    });
  }

  return null;
}

function readSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}
