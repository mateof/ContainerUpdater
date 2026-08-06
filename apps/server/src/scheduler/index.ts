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
import type { Logger } from '../logger.js';

export interface SchedulerDeps {
  repos: Repositories;
  checker: CheckerService;
  inventory: InventoryService;
  updater: UpdaterService;
  notifier: NotifierService;
  metrics: MetricsService;
  timezone: string;
  log: Logger;
}

export class Scheduler {
  readonly #jobs: Cron[] = [];
  #checkJob: Cron | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

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
          await this.deps.inventory.refresh();
        } catch (error) {
          log.debug('Fallo refrescando el inventario', error);
        }
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

      const settings = repos.settings.getAll();
      if (settings.autoUpdateEnabled) {
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
      }

      metrics.broadcast({ type: 'inventory-changed', payload: {} });
    } catch (error) {
      log.error('Fallo el ciclo de comprobacion', error);
    }
  }

  stop(): void {
    this.#checkJob?.stop();
    for (const job of this.#jobs) job.stop();
    this.#jobs.length = 0;
  }
}
