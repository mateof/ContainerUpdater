/**
 * Autenticacion: hashing, sesiones y bootstrap del primer usuario.
 *
 * Sesion con token opaco en cookie httpOnly, no JWT. El motivo decisivo es el
 * SSE de metricas: `EventSource` no permite cabeceras, asi que con JWT habria
 * que meter el token en la query string (y por tanto en los logs del proxy de
 * DSM). Con cookie funciona sin trabajo extra. Ademas la revocacion es borrar
 * una fila, no mantener una lista negra.
 */
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Locale } from '@cu/shared';
import type { Repositories, UserRow } from '../db/repositories/index.js';
import type { Logger } from '../logger.js';

/** Perfil OWASP para Argon2id. 19 MiB por verificacion. */
const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hash de una contrasena que no existe, contra el que se verifica cuando el
 * usuario no esta en la base de datos. Sin esto, un login de usuario inexistente
 * responde en microsegundos y uno existente en decenas de milisegundos, lo que
 * permite enumerar usuarios cronometrando. Se calcula una vez al arrancar.
 */
let dummyHash: string | null = null;

/**
 * Semaforo de verificaciones concurrentes. Argon2id reserva 19 MiB por
 * verificacion: sin tope, una rafaga de intentos agota la RAM de un NAS
 * modesto. Dos en paralelo es de sobra para uso normal.
 */
const MAX_CONCURRENT_VERIFY = 2;
let inFlight = 0;
const waiting: Array<() => void> = [];

async function withVerifySlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_CONCURRENT_VERIFY) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    waiting.shift()?.();
  }
}

export type LoginResult =
  | { ok: true; user: UserRow; token: string; expiresAt: number }
  | { ok: false; reason: 'invalid' | 'locked'; retryAfterMs?: number };

export class AuthService {
  constructor(
    private readonly repos: Repositories,
    private readonly log: Logger,
    private readonly sessionDays: number,
  ) {}

  async init(): Promise<void> {
    if (!dummyHash) {
      dummyHash = await argon2Hash(randomBytes(32).toString('hex'), ARGON2_OPTIONS);
    }
  }

  get needsSetup(): boolean {
    return this.repos.users.count() === 0;
  }

  async hashPassword(password: string): Promise<string> {
    return argon2Hash(password, ARGON2_OPTIONS);
  }

  /**
   * Crea el usuario administrador si no hay ninguno.
   *
   * Si no se han pasado credenciales por entorno, genera una contrasena y la
   * imprime una sola vez. Es el patron que ya conocen los usuarios de NAS:
   * `docker logs container-updater` y dentro esta la clave inicial.
   */
  async bootstrap(opts: {
    username?: string;
    password?: string;
    locale: Locale;
  }): Promise<{ created: boolean; username?: string; generatedPassword?: string }> {
    if (!this.needsSetup) return { created: false };

    if (opts.username && opts.password) {
      const hashed = await this.hashPassword(opts.password);
      this.repos.users.create({
        username: opts.username,
        passwordHash: hashed,
        locale: opts.locale,
        // Aunque venga del entorno se obliga a cambiarla: esa variable queda en
        // el docker-compose.yml y en el inspect del contenedor.
        mustChangePassword: true,
      });
      return { created: true, username: opts.username };
    }

    if (opts.username || opts.password) {
      this.log.warn(
        'CU_ADMIN_USER y CU_ADMIN_PASSWORD deben definirse juntas. Se genera una contrasena.',
      );
    }

    const username = opts.username ?? 'admin';
    // 24 caracteres base64url: suficiente entropia para que no importe que
    // quede en los logs del contenedor hasta que se cambie.
    const password = randomBytes(18).toString('base64url');
    const hashed = await this.hashPassword(password);
    this.repos.users.create({
      username,
      passwordHash: hashed,
      locale: opts.locale,
      mustChangePassword: true,
    });
    return { created: true, username, generatedPassword: password };
  }

  async login(
    username: string,
    password: string,
    context: { ip?: string; userAgent?: string },
  ): Promise<LoginResult> {
    const user = this.repos.users.findByUsername(username);

    if (!user) {
      // Se verifica igualmente contra el hash dummy para que el tiempo de
      // respuesta no revele si el usuario existe.
      await withVerifySlot(() => argon2Verify(dummyHash!, password).catch(() => false));
      return { ok: false, reason: 'invalid' };
    }

    if (user.locked_until && user.locked_until > Date.now()) {
      return { ok: false, reason: 'locked', retryAfterMs: user.locked_until - Date.now() };
    }

    const valid = await withVerifySlot(() =>
      argon2Verify(user.password_hash, password).catch(() => false),
    );

    if (!valid) {
      this.repos.users.registerFailedAttempt(user.id);
      this.repos.history.audit({
        actorType: 'user',
        actorId: String(user.id),
        action: 'auth.login.failed',
        ip: context.ip ?? null,
      });
      return { ok: false, reason: 'invalid' };
    }

    this.repos.users.registerSuccessfulLogin(user.id);
    const session = this.createSession(user.id, context);
    this.repos.history.audit({
      actorType: 'user',
      actorId: String(user.id),
      action: 'auth.login.ok',
      ip: context.ip ?? null,
    });

    return { ok: true, user, token: session.token, expiresAt: session.expiresAt };
  }

  createSession(
    userId: number,
    context: { ip?: string; userAgent?: string; rotatedFrom?: string },
  ): { token: string; expiresAt: number; id: string } {
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const expiresAt = Date.now() + this.sessionDays * 24 * 3600_000;
    this.repos.sessions.create({
      id,
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      ip: context.ip,
      userAgent: context.userAgent,
      rotatedFrom: context.rotatedFrom,
    });
    return { token, expiresAt, id };
  }

  /**
   * Resuelve la sesion de una peticion. Renovacion deslizante: cada uso empuja
   * la caducidad, de forma que quien usa el panel a diario no tiene que volver
   * a entrar, pero una sesion olvidada caduca sola.
   */
  resolveSession(token: string): { user: UserRow; sessionId: string } | null {
    const row = this.repos.sessions.findByTokenHash(hashToken(token));
    if (!row) return null;

    const user = this.repos.users.findById(row.user_id);
    if (!user) return null;

    const expiresAt = Date.now() + this.sessionDays * 24 * 3600_000;
    this.repos.sessions.touch(row.id, expiresAt);
    return { user, sessionId: row.id };
  }

  logout(token: string): void {
    const row = this.repos.sessions.findByTokenHash(hashToken(token));
    if (row) this.repos.sessions.revoke(row.id);
  }

  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const user = this.repos.users.findById(userId);
    if (!user) return false;

    const valid = await withVerifySlot(() =>
      argon2Verify(user.password_hash, currentPassword).catch(() => false),
    );
    if (!valid) return false;

    this.repos.users.setPassword(userId, await this.hashPassword(newPassword));
    // Cambiar la contrasena invalida el resto de sesiones: es lo que espera
    // quien la cambia justamente porque cree que se la han robado.
    this.repos.sessions.revokeAllForUser(userId);
    this.repos.history.audit({
      actorType: 'user',
      actorId: String(userId),
      action: 'auth.password.changed',
    });
    return true;
  }
}

/**
 * En base de datos solo vive sha256(token). Un SHA-256 simple basta porque el
 * token tiene 256 bits de entropia: no hay diccionario que atacar, a diferencia
 * de una contrasena elegida por una persona.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
