import type { AppSettings, ImagePolicy, UpdateHold } from './types.js';

/**
 * Las dos reglas que retienen una actualizacion automatica: la cuarentena y la
 * ventana de mantenimiento.
 *
 * Estan aqui, en codigo puro y compartido, por dos razones. Una es que se
 * pueden probar sin base de datos ni red. La otra es que la interfaz necesita
 * explicar por que algo no se ha actualizado ANTES de que ocurra, y si esa
 * explicacion la calculara el servidor por su lado y la pantalla por el suyo,
 * acabarian discrepando el dia que alguien cambie una de las dos.
 */

/** Horas de cuarentena efectivas: la de la imagen manda sobre la global. */
export function effectiveMinAgeHours(policy: ImagePolicy, settings: AppSettings): number {
  return policy.minAgeHours ?? settings.defaultMinAgeHours;
}

/**
 * Si una franja horaria contiene un momento dado.
 *
 * Admite franjas que cruzan medianoche (de 22 a 6), que es justo el caso que
 * alguien querria para un NAS. Con `inicio === fin` la franja es el dia entero:
 * es lo que menos sorprende de las tres opciones, porque una franja vacia
 * dejaria el auto-update apagado para siempre sin decirlo en ningun sitio.
 */
export function isWithinHours(date: Date, startHour: number, endHour: number): boolean {
  const hour = date.getHours();
  if (startHour === endHour) return true;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/** Cuando empieza la proxima franja, a partir de un momento dado. */
export function nextWindowStart(date: Date, startHour: number): number {
  const next = new Date(date);
  next.setMinutes(0, 0, 0);
  next.setHours(startHour);
  if (next.getTime() <= date.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export interface HoldInput {
  policy: ImagePolicy;
  settings: AppSettings;
  /** Cuando se publico la version nueva. null = no se ha podido averiguar. */
  publishedAt: number | null;
  now: number;
}

/**
 * Por que una actualizacion automatica no entra todavia, si es que no entra.
 *
 * Decision importante ante la fecha desconocida: se DEJA PASAR. Retener algo
 * indefinidamente porque no sabemos leer su fecha convertiria un registry que
 * no publica etiquetas OCI en un auto-update que no funciona y que nadie sabria
 * por que. La interfaz dice que la fecha se desconoce, que es lo honesto.
 */
export function updateHold(input: HoldInput): UpdateHold | null {
  const { policy, settings, publishedAt, now } = input;

  const minAge = effectiveMinAgeHours(policy, settings);
  if (minAge > 0 && publishedAt !== null) {
    const readyAt = publishedAt + minAge * 3600_000;
    if (readyAt > now) return { reason: 'quarantine', until: readyAt };
  }

  if (settings.maintenanceWindowEnabled) {
    const date = new Date(now);
    if (!isWithinHours(date, settings.maintenanceStartHour, settings.maintenanceEndHour)) {
      return {
        reason: 'maintenance-window',
        until: nextWindowStart(date, settings.maintenanceStartHour),
      };
    }
  }

  return null;
}
