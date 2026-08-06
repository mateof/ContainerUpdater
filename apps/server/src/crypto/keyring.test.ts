import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { Keyring, KeyringLockedError } from './keyring.js';
import type { Db } from '../db/index.js';

/** Base en memoria con lo minimo que necesita el llavero. */
function makeDb(): Db {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)`);
  return db;
}

const KEY = randomBytes(32).toString('base64');

describe('Keyring', () => {
  it('cifra y descifra con la misma clave maestra', () => {
    const db = makeDb();
    const ring = Keyring.create(db, { key: KEY });
    expect(ring.healthy).toBe(true);

    const sealed = ring.seal('mi-token-secreto', Keyring.registryAad(1));
    expect(sealed.ct).not.toContain('mi-token-secreto');
    expect(ring.open(sealed, Keyring.registryAad(1))).toBe('mi-token-secreto');
  });

  it('usa un IV distinto en cada escritura', () => {
    // Reutilizar el IV con la misma clave rompe AES-GCM por completo, no solo
    // lo debilita.
    const ring = Keyring.create(makeDb(), { key: KEY });
    const first = ring.seal('mismo-valor', Keyring.registryAad(1));
    const second = ring.seal('mismo-valor', Keyring.registryAad(1));
    expect(first.iv).not.toBe(second.iv);
    expect(first.ct).not.toBe(second.ct);
  });

  it('impide mover un secreto de una fila a otra', () => {
    // El AAD ata el ciphertext a su fila: sin esto, copiar el blob del registry
    // 1 al 2 en la base de datos descifraria el secreto del primero.
    const ring = Keyring.create(makeDb(), { key: KEY });
    const sealed = ring.seal('secreto-del-uno', Keyring.registryAad(1));
    expect(() => ring.open(sealed, Keyring.registryAad(2))).toThrow();
  });

  it('detecta un ciphertext manipulado', () => {
    const ring = Keyring.create(makeDb(), { key: KEY });
    const sealed = ring.seal('valor', Keyring.registryAad(1));
    const tampered = { ...sealed, ct: Buffer.from('otracosa').toString('base64') };
    expect(() => ring.open(tampered, Keyring.registryAad(1))).toThrow();
  });

  it('sigue leyendo los secretos tras reabrir con la misma clave', () => {
    // La DEK se guarda envuelta, asi que reiniciar el proceso no debe perder
    // acceso a lo ya cifrado.
    const db = makeDb();
    const first = Keyring.create(db, { key: KEY });
    const sealed = first.seal('persistente', Keyring.registryAad(7));

    const second = Keyring.create(db, { key: KEY });
    expect(second.healthy).toBe(true);
    expect(second.open(sealed, Keyring.registryAad(7))).toBe('persistente');
  });

  it('queda bloqueado, pero no revienta, con una clave maestra distinta', () => {
    // Perder la clave no debe impedir arrancar: los registries publicos siguen
    // funcionando y el usuario ve un aviso en vez de un contenedor en bucle.
    const db = makeDb();
    Keyring.create(db, { key: KEY });

    const wrong = Keyring.create(db, { key: randomBytes(32).toString('base64') });
    expect(wrong.healthy).toBe(false);
    expect(wrong.reason).toBeTruthy();
    expect(() => wrong.seal('x', 'aad')).toThrow(KeyringLockedError);
  });

  it('queda bloqueado si no hay ninguna clave configurada', () => {
    const ring = Keyring.create(makeDb(), {});
    expect(ring.healthy).toBe(false);
  });

  it('acepta una passphrase derivando la clave', () => {
    const db = makeDb();
    const first = Keyring.create(db, { passphrase: 'una frase larga de prueba' });
    expect(first.healthy).toBe(true);

    const sealed = first.seal('valor', Keyring.registryAad(1));
    // La sal se guarda, asi que la misma passphrase deriva la misma clave.
    const second = Keyring.create(db, { passphrase: 'una frase larga de prueba' });
    expect(second.open(sealed, Keyring.registryAad(1))).toBe('valor');
  });

  it('rechaza una clave que no tenga 32 bytes', () => {
    expect(() => Keyring.create(makeDb(), { key: 'ZGVtYXNpYWRvY29ydG8=' })).toThrow(/32 bytes/);
  });
});
