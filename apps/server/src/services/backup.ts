/**
 * Exportacion e importacion de la configuracion.
 *
 * Lo que se guarda y lo que no es la decision importante de este fichero.
 *
 * NO se exportan secretos: ni contrasenas de registry, ni el secreto del
 * segundo factor, ni passkeys. Un fichero que se descarga y acaba en la carpeta
 * de descargas, en un correo o en un disco compartido no es sitio para eso, y
 * todo lo omitido se vuelve a dar de alta en unos minutos. Se exportan los
 * registries SIN su secreto justamente para saber cuales hay que volver a
 * poner: una lista de lo que falta vale mas que nada.
 *
 * Lo que de verdad cuesta rehacer, y por eso es el nucleo de la copia, son las
 * politicas por imagen: que se actualiza solo, con cuanta cuarentena, en que
 * canal de version y con que alcance de recreacion.
 */
import type {
  AppSettings,
  BackupFile,
  ImagePolicy,
  RestoreReport,
} from '@cu/shared';
import type { Repositories } from '../db/repositories/index.js';
import type { Logger } from '../logger.js';

export class BackupService {
  constructor(
    private readonly repos: Repositories,
    private readonly appVersion: string,
    private readonly log: Logger,
  ) {}

  export(): BackupFile {
    return {
      version: 1,
      createdAt: Date.now(),
      appVersion: this.appVersion,
      settings: this.repos.settings.getAll(),
      policies: [...this.repos.inventory.getAllPolicies().values()],
      registries: this.repos.registries.list().map((registry) => ({
        name: registry.name,
        host: registry.host,
        authType: registry.authType,
        username: registry.username,
        // Se declara que habia secreto, pero no cual. Al restaurar, esto se
        // traduce en un registry marcado como pendiente de credenciales.
        hasSecret: registry.hasSecret,
      })),
      telegramUsers: this.repos.telegram.listUsers().map((user) => ({
        chatId: user.chatId,
        username: user.username,
        role: user.role,
        locale: user.locale,
      })),
    };
  }

  /**
   * Aplica una copia.
   *
   * Politica ante lo que ya existe: los ajustes y las politicas se pisan (es lo
   * que se quiere al restaurar), pero los registries y los usuarios de Telegram
   * que ya estan NO se tocan. Un registry existente tiene su secreto funcionando
   * y pisarlo con una entrada sin secreto lo dejaria roto, que es peor que no
   * importarlo.
   *
   * Todo lo omitido se devuelve en `skipped`. Una restauracion que dice "hecho"
   * y se ha saltado la mitad es peor que una que falla.
   */
  restore(file: BackupFile, options: { settings: boolean; policies: boolean }): RestoreReport {
    const report: RestoreReport = {
      settings: false,
      policies: 0,
      registries: 0,
      telegramUsers: 0,
      skipped: [],
    };

    if (file.version !== 1) {
      throw new UnsupportedBackupError(file.version);
    }

    if (options.settings) {
      this.repos.settings.update(sanitizeSettings(file.settings));
      report.settings = true;
    }

    if (options.policies) {
      for (const policy of file.policies) {
        if (!policy?.imageRef) continue;
        this.repos.inventory.savePolicy(policy as ImagePolicy);
        report.policies += 1;
      }
    }

    const existingHosts = new Set(this.repos.registries.list().map((registry) => registry.host));
    for (const registry of file.registries ?? []) {
      if (existingHosts.has(registry.host)) {
        report.skipped.push(`registry:${registry.host}`);
        continue;
      }
      // Entra sin secreto y en estado `untested`, que es exactamente lo que es.
      // Se vera marcado en Ajustes como pendiente de credenciales.
      this.repos.registries.create({
        name: registry.name,
        host: registry.host,
        authType: registry.authType,
        username: registry.username ?? undefined,
      });
      report.registries += 1;
      if (registry.hasSecret) report.skipped.push(`secreto:${registry.host}`);
    }

    /**
     * Los usuarios de Telegram se exportan pero NO se restauran, a proposito.
     *
     * Dar de alta un chat autorizado desde un fichero se saltaria el codigo de
     * vinculacion de un solo uso, que no es burocracia: es la prueba de que
     * quien pide el acceso controla ese chat. Si bastara con importar un JSON,
     * cualquiera que pudiera subir una copia se anadiria a si mismo como
     * administrador del bot.
     *
     * Lo que si aporta la copia es la LISTA: saber a quien hay que volver a
     * vincular, que es el trabajo que de verdad da pereza recordar.
     */
    for (const user of file.telegramUsers ?? []) {
      report.skipped.push(`telegram:${user.username ?? user.chatId}`);
    }

    this.log.info(
      `Copia restaurada: ${report.policies} politicas, ${report.registries} registries`,
    );
    return report;
  }
}

export class UnsupportedBackupError extends Error {
  constructor(readonly fileVersion: unknown) {
    super(`Formato de copia no reconocido (version ${String(fileVersion)})`);
    this.name = 'UnsupportedBackupError';
  }
}

/**
 * Quita de los ajustes lo que no debe viajar entre instalaciones.
 *
 * El idioma por defecto y el cron si son configuracion del usuario y se
 * restauran. Lo que no se toca son los ajustes que describen la MAQUINA y no la
 * preferencia: restaurar en un NAS distinto el intervalo de metricas de otro
 * equipo no tiene por que ser correcto, pero tampoco hace dano, asi que la
 * lista de exclusion se queda vacia a proposito y documentada. Si algun dia hay
 * un ajuste que dependa del hardware, se anade aqui.
 */
function sanitizeSettings(settings: AppSettings): Partial<AppSettings> {
  return { ...settings };
}
