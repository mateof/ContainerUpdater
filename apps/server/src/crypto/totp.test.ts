import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  otpauthUri,
  stepFor,
  verifyCode,
} from './totp.js';

/**
 * El secreto de los vectores del RFC 6238 es la cadena ASCII "12345678901234567890".
 * Los vectores lo dan en hexadecimal; aqui se pasa a base32, que es lo que
 * consume esta implementacion.
 */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('ida y vuelta', () => {
    const original = Buffer.from('12345678901234567890', 'ascii');
    expect(base32Decode(base32Encode(original)).equals(original)).toBe(true);
  });

  it('codifica sin relleno', () => {
    // Varias aplicaciones rechazan el `=` al pegar el secreto a mano.
    expect(base32Encode(Buffer.from('hola'))).not.toContain('=');
  });

  it('acepta minusculas, espacios y relleno al decodificar', () => {
    // La gente copia el secreto de sitios que lo presentan en grupos de cuatro.
    const canonical = base32Encode(Buffer.from('prueba'));
    const messy = canonical.toLowerCase().replace(/(.{4})/g, '$1 ');
    expect(base32Decode(messy).equals(base32Decode(canonical))).toBe(true);
  });

  it('rechaza caracteres que no son del alfabeto', () => {
    // El 0, el 1 y el 8 no estan en base32 precisamente para no confundirlos
    // con O, I y B al teclearlos.
    expect(() => base32Decode('AAAA0AAA')).toThrow();
  });
});

/**
 * Vectores oficiales del RFC 6238, apendice B, para HMAC-SHA1.
 *
 * Son la comprobacion que de verdad importa: si estos ocho valores salen, la
 * implementacion es interoperable con cualquier aplicacion que cumpla el
 * estandar, que es exactamente lo que se ha pedido (Google Authenticator,
 * Microsoft Authenticator, Bitwarden). El RFC los da con ocho digitos; aqui se
 * emiten seis, asi que se comparan los seis ultimos.
 */
describe('vectores del RFC 6238', () => {
  const VECTORS: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  for (const [seconds, expected] of VECTORS) {
    it(`t=${seconds} produce ${expected.slice(-6)}`, () => {
      const code = generateCode(RFC_SECRET, stepFor(seconds * 1000));
      expect(code).toBe(expected.slice(-6));
    });
  }

  it('la mitad alta del contador cuenta', () => {
    /*
     * Ningun vector del RFC llega a usarla: el mayor da un intervalo de 666
     * millones, que cabe de sobra en 32 bits. Asi que el contador se parte en
     * dos palabras sin que nada lo compruebe, y escribir solo la baja pasaria
     * los seis vectores igualmente.
     *
     * Si la mitad alta se ignorase, estos dos intervalos, que se diferencian
     * exactamente en 2^32, darian el mismo codigo.
     */
    const low = generateCode(RFC_SECRET, 5);
    const high = generateCode(RFC_SECRET, 2 ** 32 + 5);
    expect(high).not.toBe(low);
  });
});

describe('verifyCode', () => {
  const AT = 1111111111 * 1000;

  it('acepta el codigo del momento', () => {
    const code = generateCode(RFC_SECRET, stepFor(AT));
    expect(verifyCode(RFC_SECRET, code, { atMs: AT })).toEqual({
      valid: true,
      step: stepFor(AT),
    });
  });

  it('admite un intervalo de margen a cada lado', () => {
    // Cubre el desfase del reloj del movil y el tiempo de teclear.
    const previous = generateCode(RFC_SECRET, stepFor(AT) - 1);
    const next = generateCode(RFC_SECRET, stepFor(AT) + 1);
    expect(verifyCode(RFC_SECRET, previous, { atMs: AT }).valid).toBe(true);
    expect(verifyCode(RFC_SECRET, next, { atMs: AT }).valid).toBe(true);
  });

  it('rechaza dos intervalos atras', () => {
    const old = generateCode(RFC_SECRET, stepFor(AT) - 2);
    expect(verifyCode(RFC_SECRET, old, { atMs: AT }).valid).toBe(false);
  });

  it('devuelve el intervalo para poder impedir la reutilizacion', () => {
    // Sin esto un codigo sirve minuto y medio y se puede usar varias veces.
    const code = generateCode(RFC_SECRET, stepFor(AT) - 1);
    expect(verifyCode(RFC_SECRET, code, { atMs: AT }).step).toBe(stepFor(AT) - 1);
  });

  it('ignora los espacios que meten algunas aplicaciones', () => {
    const code = generateCode(RFC_SECRET, stepFor(AT));
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyCode(RFC_SECRET, spaced, { atMs: AT }).valid).toBe(true);
  });

  it('rechaza lo que no sean seis digitos', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34']) {
      expect(verifyCode(RFC_SECRET, bad, { atMs: AT }).valid, bad).toBe(false);
    }
  });
});

describe('otpauthUri', () => {
  it('lleva los parametros explicitos', () => {
    const uri = otpauthUri({ secret: 'ABCD', account: 'admin', issuer: 'ContainerUpdater' });
    // SHA1 explicito: Google y Microsoft ignoran el parametro y asumen SHA1, asi
    // que emitir otra cosa daria codigos que no cuadran.
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(uri.startsWith('otpauth://totp/ContainerUpdater:admin?')).toBe(true);
  });

  it('escapa lo que lleve caracteres raros', () => {
    const uri = otpauthUri({ secret: 'A', account: 'a b@c', issuer: 'Mi App' });
    expect(uri).toContain('Mi%20App:a%20b%40c');
  });
});

describe('codigos de recuperacion', () => {
  it('genera diez distintos y con formato legible', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  });

  it('se normalizan para poder teclearlos con o sin guion', () => {
    expect(normalizeRecoveryCode('abcde-fghij')).toBe('ABCDEFGHIJ');
    expect(normalizeRecoveryCode('ABCDE FGHIJ')).toBe('ABCDEFGHIJ');
  });
});
