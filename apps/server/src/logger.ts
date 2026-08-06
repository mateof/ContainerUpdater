/**
 * Logger minimo.
 *
 * Los logs de esta app se leen casi siempre con `docker logs` en un terminal,
 * asi que el formato por defecto es legible por una persona en vez de JSON.
 * Se puede pasar a JSON con CU_LOG_JSON=1 para quien lo agregue en Loki.
 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVELS: Record<LogLevel, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

export interface Logger {
  fatal(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  debug(message: string, extra?: unknown): void;
  trace(message: string, extra?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(level: LogLevel = 'info', scope = 'app'): Logger {
  const threshold = LEVELS[level];
  const json = process.env.CU_LOG_JSON === '1';

  function emit(lvl: LogLevel, message: string, extra?: unknown): void {
    if (LEVELS[lvl] < threshold) return;
    const stream = LEVELS[lvl] >= LEVELS.error ? process.stderr : process.stdout;

    if (json) {
      stream.write(
        `${JSON.stringify({ ts: new Date().toISOString(), level: lvl, scope, message, extra: serialize(extra) })}\n`,
      );
      return;
    }

    const time = new Date().toISOString().slice(11, 23);
    let line = `${time} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    if (extra !== undefined) line += ` ${format(extra)}`;
    stream.write(`${line}\n`);
  }

  return {
    fatal: (m, e) => emit('fatal', m, e),
    error: (m, e) => emit('error', m, e),
    warn: (m, e) => emit('warn', m, e),
    info: (m, e) => emit('info', m, e),
    debug: (m, e) => emit('debug', m, e),
    trace: (m, e) => emit('trace', m, e),
    child: (childScope: string) => createLogger(level, `${scope}:${childScope}`),
  };
}

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function format(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
