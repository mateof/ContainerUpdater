/**
 * Tareas programadas.
 *
 * croner en lugar de node-cron: soporta zona horaria y trae `protect` contra
 * solapamientos de serie. Descartados BullMQ y Agenda, que exigen Redis o
 * MongoDB para programar cuatro tareas en un NAS.
 */
import { Cron } from 'croner';
import type { Repositories } from '../db/repositories/index.js';
import type { CheckerService } from '../services/checker.js';
import type { InventoryService } from '../services/inventory.js';
import type { NotifierService } from '../services/notifier.js';
import type { UpdaterService } from '../services/updater.js';
import type { MetricsService } from '../services/metrics.js';
import type { WatchdogService } from '../services/watchdog.js';
import type { Logger } from '../logger.js';

export interface SchedulerDeps {
  repos: Repositories;
  checker: CheckerService;
  inventory: InventoryService;
  updater: UpdaterService;
  notifier: NotifierService;
  metrics: MetricsService;
  watchdog: WatchdogService;
  timezone: string;
  log: Logger;
}

export class Scheduler {
  readonly #jobs: Cron[] = [];
  #checkJob: Cron | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  /**
   * Evalua el estado de los contenedores y avisa de los cambios.
   *
   * Los fallos se tragan a proposito: que no se pueda mandar un aviso no puede
   * tumbar el refresco del inventario, que es lo que mantiene el panel al dia.
   */
  async #runWatchdog(containers: Parameters<WatchdogService['evaluate']>[0]): Promise<void> {
    const { repos, watchdog, notifier, metrics, log } = this.deps;
    try {
      const alerts = watchdog.evaluate(containers, repos.settings.getAll());
      for (const alert of alerts) {
        metrics.broadcast({
          type: 'container-alert',
          payload: { name: alert.name, kind: alert.kind },
        });
        await notifier.notifyContainerAlert(alert);
      }
    } catch (error) {
      log.warn('Fallo la vigilancia de contenedores', error);
    }
  }

  start(): void {
    const { repos, log, timezone } = this.deps;

    // Un trabajo que seguia en marcha al arrancar murio con el proceso
    // anterior. Sin esto, su fila queda "running" para siempre y el usuario ve
    // una actualizacion eterna que no avanza.
    const interrupted = repos.history.failInterruptedJobs();
    if (interrupted > 0) log.warn(`${interrupted} trabajos interrumpidos por el reinicio`);
    repos.history.failStaleRuns(30 * 60_000);

    this.#scheduleChecks();

    // El inventario es barato (dos llamadas al socket) y mantiene el panel al
    // dia aunque alguien toque contenedores desde Container Manager.
    this.#jobs.push(
      new Cron('*/5 * * * *', { timezone, protect: true, name: 'refresh-inventory' }, async () => {
        try {
          const snapshot = await this.deps.inventory.refresh();
          // La vigilancia se engancha aqui y no en su propio cron a proposito:
          // los datos que necesita son justo los que el refresco acaba de traer,
          // y un cron aparte los volveria a pedir o miraria una foto vieja.
          await this.#runWatchdog(snapshot.containers);
        } catch (error) {
          log.debug('Fallo refrescando el inventario', error);
        }
      }),
    );

    /**
     * Las automaticas, con su propio reloj.
     *
     * Cada media hora, y NO atado a las comprobaciones: lo que decide si algo
     * puede entrar es su cuarentena y la franja horaria, y las dos cosas cambian
     * con el reloj, no cuando toca preguntar a los registries. Media hora es
     * suficientemente fino para una franja de un par de horas y suficientemente
     * espaciado para no despertar los discos del NAS.
     */
    this.#jobs.push(
      new Cron('*/30 * * * *', { timezone, protect: true, name: 'auto-updates' }, () => {
        void this.applyAutoUpdates();
      }),
    );

    this.#jobs.push(
      new Cron('0 4 * * *', { timezone, protect: true, name: 'refresh-tags' }, () => {
        repos.tagCache.invalidateOlderThan(24 * 3600_000);
      }),
    );

    this.#jobs.push(
      new Cron('0 5 * * *', { timezone, protect: true, name: 'prune-history' }, () => {
        const settings = repos.settings.getAll();
        repos.history.prune(settings.historyRetentionDays);
        log.debug('Historial purgado');
      }),
    );

    this.#jobs.push(
      new Cron('0 * * * *', { timezone, protect: true, name: 'expire-sessions' }, () => {
        repos.sessions.purgeExpired();
        repos.telegram.purgeExpiredCodes();
      }),
    );

    this.#scheduleCatchUp();
  }

  /** Reprograma la comprobacion tras cambiar el cron en Ajustes. */
  reschedule(): void {
    this.#checkJob?.stop();
    this.#checkJob = null;
    this.#scheduleChecks();
  }

  get nextCheckAt(): number | null {
    const next = this.#checkJob?.nextRun();
    return next ? next.getTime() : null;
  }

  #scheduleChecks(): void {
    const { repos, log, timezone } = this.deps;
    const cron = repos.settings.getAll().checkCron;

    try {
      this.#checkJob = new Cron(cron, { timezone, protect: true, name: 'check-updates' }, () => {
        void this.runCheckCycle('schedule');
      });
      log.info(`Comprobaciones programadas: ${cron} (${timezone})`);
    } catch (error) {
      log.error(`Expresion cron no valida (${cron}), se usa cada 6 horas`, error);
      this.#checkJob = new Cron('0 */6 * * *', { timezone, protect: true }, () => {
        void this.runCheckCycle('schedule');
      });
    }
  }

  /**
   * Comprobacion de recuperacion al arrancar.
   *
   * Un NAS se apaga por las noches y se reinicia por actualizaciones de DSM. Si
   * el cron cae siempre durante ese apagado, sin este ajuste la app no
   * comprobaria nunca y el usuario no se enteraria de que no funciona.
   */
  #scheduleCatchUp(): void {
    const { repos, log } = this.deps;
    const lastCheck = repos.settings.getNumber('last_check_at');
    if (lastCheck === null) {
      log.info('Primera ejecucion: se comprobara dentro de un minuto');
      setTimeout(() => void this.runCheckCycle('startup'), 60_000);
      return;
    }

    // Se compara contra seis horas y no contra el intervalo configurado porque
    // parsear el cron para saber su periodo no aporta nada aqui.
    if (Date.now() - lastCheck > 6 * 3600_000) {
      log.info('Ha pasado tiempo desde la ultima comprobacion: se recupera en un minuto');
      setTimeout(() => void this.runCheckCycle('startup'), 60_000);
    }
  }

  /**
   * Ciclo completo: refrescar inventario, comprobar, avisar y auto-actualizar.
   * Se expone porque el boton "Comprobar ahora" y el comando del bot hacen lo
   * mismo que el cron.
   */
  async runCheckCycle(trigger: string): Promise<void> {
    const { checker, inventory, notifier, updater, metrics, repos, log } = this.deps;

    try {
      await inventory.refresh();

      const summary = await checker.runCheck(trigger, {
        onProgress: (ref, run) => {
          metrics.broadcast({ type: 'check-progress', payload: { run, currentImage: ref } });
        },
      });

      metrics.broadcast({ type: 'check-done', payload: { run: summary.run } });
      await notifier.notifyUpdatesAvailable(summary.outcomes);

      await this.applyAutoUpdates();

      metrics.broadcast({ type: 'inventory-changed', payload: {} });
    } catch (error) {
      log.error('Fallo el ciclo de comprobacion', error);
    }
  }

  /**
   * Aplica las automaticas que ya puedan aplicarse, y avisa del resultado.
   *
   * Se ejecuta desde DOS sitios y esa es la razon de existir de este metodo:
   * despues de cada comprobacion, y ademas por su cuenta cada media hora.
   *
   * Lo segundo hace falta porque antes esto solo corria pegado a la
   * comprobacion, y eso convertia el cron de comprobaciones en el que decidia
   * de verdad cuando se actualizaba. Con el cron por defecto (00, 06, 12 y 18)
   * y una ventana de mantenimiento de 04:00 a 08:00, la unica oportunidad del
   * dia era la comprobacion de las 06:00; si en ese momento la version aun
   * estaba en cuarentena, la siguiente ocasion era 24 horas despues. Y con una
   * ventana de 02:00 a 04:00, donde no cae ninguna comprobacion, el auto-update
   * no se habria ejecutado NUNCA, sin ningun aviso de que eso pasaba.
   *
   * Correr aparte es barato: no hace ninguna peticion a los registries, solo
   * mira que imagenes ya se sabe que tienen novedad y cuales han cumplido ya su
   * cuarentena o han entrado en la franja horaria.
   */
  async applyAutoUpdates(): Promise<void> {
    const { repos, updater, notifier, log } = this.deps;

    if (!repos.settings.getAll().autoUpdateEnabled) return;

    try {
      const jobs = await updater.runAutoUpdates();
      for (const job of jobs) {
        if (job.status === 'success') {
          await notifier.notifyUpdateApplied({
            imageRef: job.imageRef,
            containerName: job.containerName ?? '',
            fromTag: job.fromTag,
            toTag: job.toTag,
            automatic: true,
          });
        } else if (job.status === 'failed' || job.status === 'rolled-back') {
          await notifier.notifyFailure({
            imageRef: job.imageRef,
            error: job.error ?? 'error desconocido',
            rolledBack: job.status === 'rolled-back',
          });
        }
      }
    } catch (error) {
      log.error('Fallo aplicando las actualizaciones automaticas', error);
    }
  }

  stop(): void {
    this.#checkJob?.stop();
    for (const job of this.#jobs) job.stop();
    this.#jobs.length = 0;
  }
}
