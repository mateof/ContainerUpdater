/**
 * Vigilancia de contenedores caidos.
 *
 * Es la unica parte de la aplicacion que avisa de algo que no es una
 * actualizacion, y por eso merece explicacion: en un NAS domestico, "esto lleva
 * tres dias parado y no me habia enterado" pasa mas que "una actualizacion
 * rompio algo". Los datos ya estaban ahi (el inventario se refresca cada pocos
 * minutos y lee estado, salud y reinicios); lo unico que faltaba era decidir
 * cuando eso merece un mensaje.
 *
 * Los avisos son de TRANSICION, no de situacion: se manda uno cuando algo pasa
 * de bien a mal, y otro cuando vuelve. Un aviso cada cinco minutos mientras
 * siga caido convertiria la funcion en algo que todo el mundo silencia.
 */
import type { AppSettings, ContainerSummary } from '@cu/shared';
import type { AlertKind, Repositories } from '../db/repositories/index.js';
import type { Logger } from '../logger.js';

export interface ContainerAlert {
  name: string;
  kind: AlertKind | 'recovered';
  /** Lo que se habia avisado antes, cuando esto es una recuperacion. */
  previousKind: AlertKind | null;
  exitCode: number | null;
  restartCount: number;
}

/**
 * Cuanto se ignora a un contenedor despues de que lo toquemos nosotros.
 *
 * Una actualizacion lo para, lo borra y lo crea de nuevo: sin este silencio,
 * cada actualizacion correcta dispararia una alarma de caida. Diez minutos
 * cubren de sobra una descarga y un arranque lentos en un NAS.
 */
export const MUTE_MS = 10 * 60_000;

export class WatchdogService {
  constructor(
    private readonly repos: Repositories,
    private readonly log: Logger,
  ) {}

  /** Silencia un contenedor porque vamos a tocarlo nosotros. */
  mute(name: string | null | undefined): void {
    if (!name) return;
    this.repos.watch.mute(name, MUTE_MS);
  }

  /**
   * Compara el estado actual con el anterior y devuelve lo que hay que avisar.
   *
   * Es puro respecto a la red: solo lee y escribe la tabla de vigilancia. Quien
   * llama decide que hacer con los avisos, lo que permite probarlo sin Telegram.
   */
  evaluate(containers: ContainerSummary[], settings: AppSettings): ContainerAlert[] {
    const alerts: ContainerAlert[] = [];
    const now = Date.now();

    for (const container of containers) {
      // La propia aplicacion no se vigila: si se cae, no hay nadie para
      // contarlo, y durante su propia actualizacion pasaria por parada.
      if (container.isSelf) continue;

      const previous = this.repos.watch.get(container.name);
      const muted = previous?.muted_until != null && previous.muted_until > now;

      const kind = classify(container, previous?.last_restarts ?? null, settings);

      if (muted) {
        // Se sigue guardando el estado para no perder el hilo, pero no se avisa
        // ni se marca nada como alertado.
        this.repos.watch.save({
          name: container.name,
          state: container.state,
          health: container.health,
          restarts: container.restartCount,
          alertedKind: previous?.alerted_kind ?? null,
          alertedAt: previous?.alerted_at ?? null,
        });
        continue;
      }

      const alerted = previous?.alerted_kind ?? null;

      if (kind && kind !== alerted) {
        alerts.push({
          name: container.name,
          kind,
          previousKind: alerted,
          exitCode: container.exitCode,
          restartCount: container.restartCount,
        });
      } else if (!kind && alerted) {
        alerts.push({
          name: container.name,
          kind: 'recovered',
          previousKind: alerted,
          exitCode: container.exitCode,
          restartCount: container.restartCount,
        });
      }

      this.repos.watch.save({
        name: container.name,
        state: container.state,
        health: container.health,
        restarts: container.restartCount,
        alertedKind: kind,
        alertedAt: kind ? (kind === alerted ? (previous?.alerted_at ?? now) : now) : null,
      });
    }

    // Un contenedor borrado no deja aviso pendiente: si ya no existe, no hay
    // nada que recuperar y su fila solo estorbaria.
    this.repos.watch.pruneMissing(containers.map((container) => container.name));

    if (alerts.length > 0) {
      this.log.debug(`Vigilancia: ${alerts.length} cambio(s) de estado que avisar`);
    }
    return alerts;
  }
}

/**
 * Que le pasa a un contenedor, o null si esta bien.
 *
 * El orden de las reglas importa: el bucle de reinicios se comprueba antes que
 * la caida porque un contenedor en bucle alterna entre los dos estados, y
 * avisar de "se ha parado" cada vez que pasa por ahi seria ruido continuo.
 */
export function classify(
  container: ContainerSummary,
  previousRestarts: number | null,
  settings: AppSettings,
): AlertKind | null {
  if (container.state === 'restarting') return 'restart-loop';

  // Reinicios acumulados desde la ultima pasada. Con `restart: unless-stopped`
  // un contenedor roto puede aparecer "corriendo" en el momento del muestreo y
  // aun asi llevar veinte reinicios detras.
  if (previousRestarts !== null && container.restartCount - previousRestarts >= settings.restartLoopThreshold) {
    return 'restart-loop';
  }

  if (container.state === 'exited' || container.state === 'dead') {
    // Salir con 0 es una parada limpia: casi siempre alguien que lo paro a
    // proposito. Avisar de eso seria avisar de lo que el propio usuario acaba
    // de hacer.
    if (container.exitCode === 0) return null;
    // Sin dato de salida no se afirma nada: puede ser un contenedor que nunca
    // llego a arrancar y que el usuario dejo asi.
    if (container.exitCode === null) return null;
    return 'down';
  }

  if (container.state === 'running' && container.health === 'unhealthy') return 'unhealthy';

  return null;
}
