/**
 * TOTP (RFC 6238), el codigo de seis digitos que cambia cada 30 segundos.
 *
 * Escrito a mano con `node:crypto` en vez de traer una dependencia, por dos
 * motivos: son cuarenta lineas, y sobre todo porque asi se puede comprobar
 * contra los **vectores oficiales del RFC**, que es una verificacion mucho mas
 * fuerte que confiar en que una libreria los cumpla. Ver `totp.test.ts`.
 *
 * ## Por que SHA-1, seis digitos y treinta segundos
 *
 * El RFC admite SHA-256 y SHA-512, mas digitos y otros periodos, y sobre el
 * papel SHA-256 suena mejor. En la practica **Google Authenticator y Microsoft
 * Authenticator ignoran el parametro `algorithm`** y asumen SHA-1 siempre: si se
 * emite un secreto SHA-256, esas aplicaciones generan codigos que no coinciden y
 * el usuario ve "codigo incorrecto" sin ninguna pista de por que.
 *
 * No es una debilidad real: TOTP usa HMAC-SHA1, y los ataques conocidos contra
 * SHA-1 son de colision, que no afectan a HMAC. Se elige lo que funciona en
 * todas partes, que es justo lo que se ha pedido.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Base32 sin relleno.
 *
 * Es el formato que esperan las aplicaciones de autenticacion, y el relleno con
 * `=` sobra: varias lo rechazan al pegarlo a mano.
 */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return output;
}

export function base32Decode(input: string): Buffer {
  // Se aceptan minusculas, espacios y relleno: la gente copia y pega el secreto
  // de sitios que lo presentan en grupos de cuatro.
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Caracter no valido en base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/** 20 bytes (160 bits) es lo que recomienda el RFC 4226 y lo que emiten todos. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** El numero de intervalo de 30 segundos desde epoch. */
export function stepFor(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * Genera el codigo para un intervalo concreto.
 *
 * El "truncado dinamico" del final no es un capricho: el ultimo nibble del HMAC
 * dice desde que byte leer, de forma que el codigo no dependa siempre de la
 * misma parte del hash.
 */
export function generateCode(secret: string, step: number): string {
  const key = base32Decode(secret);

  const counter = Buffer.alloc(8);
  // El contador es de 64 bits. En JavaScript, un entero por encima de 2^32 no
  // cabe en una escritura de 32 bits, asi que se parte en dos mitades.
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Comprueba un codigo y devuelve el intervalo con el que ha cuadrado.
 *
 * `window` admite intervalos de margen a cada lado. Uno (30 segundos arriba y
 * abajo) es lo habitual: cubre el desfase de reloj del movil y el tiempo que se
 * tarda en teclear, sin ampliar de mas la ventana en la que un codigo capturado
 * sigue sirviendo.
 *
 * Devuelve el intervalo para que quien llama pueda guardarlo y rechazar que ese
 * mismo codigo se reutilice. Sin eso, un codigo vale durante minuto y medio y
 * puede usarse varias veces.
 */
export function verifyCode(
  secret: string,
  code: string,
  options: { atMs?: number; window?: number } = {},
): { valid: boolean; step: number | null } {
  const digits = code.replace(/\s/g, '');
  if (!/^\d+$/.test(digits) || digits.length !== TOTP_DIGITS) return { valid: false, step: null };

  const current = stepFor(options.atMs ?? Date.now());
  const window = options.window ?? 1;

  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (equals(generateCode(secret, step), digits)) return { valid: true, step };
  }
  return { valid: false, step: null };
}

/**
 * Comparacion en tiempo constante.
 *
 * Con seis digitos el margen es estrecho, pero comparar con `===` filtra por
 * tiempo cuantos digitos iniciales se han acertado, y eso reduce un espacio de
 * un millon a diez intentos por posicion.
 */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * URI `otpauth://` que se mete en el QR.
 *
 * Los parametros van explicitos aunque coincidan con los valores por defecto:
 * las aplicaciones que si los leen no tienen que suponer nada, y las que no los
 * leen asumen exactamente estos.
 */
export function otpauthUri(input: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Codigos de recuperacion.
 *
 * Base32 sin vocales problematicas y en grupos, para poder copiarlos a mano de
 * un papel sin confundir caracteres. Diez codigos de 10 caracteres dan unos 50
 * bits cada uno: sobra para no poder adivinarlos, y son cortos de teclear.
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Se normaliza antes de comparar: la gente los teclea con o sin guion. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}
