/**
 * El panel al dia al instante, escuchando al daemon.
 *
 * Antes el inventario solo se refrescaba cada cinco minutos, asi que un
 * proyecto creado desde Container Manager podia tardar ese rato en aparecer y
 * daba la impresion de que no se habia enterado.
 *
 * Docker y Podman publican un flujo de eventos: una conexion abierta por la que
 * el daemon avisa cuando algo pasa. Sale MAS barato que sondear, no mas caro,
 * porque en reposo no se hace ni una consulta. El refresco periodico se
 * conserva de todas formas como red de seguridad, por si el flujo se corta sin
 * avisar.
 *
 * Dos cosas hay que acertar aqui o el remedio es peor:
 *
 * 1. **Agrupar las rafagas.** Un `compose up` de cinco servicios dispara
 *    decenas de eventos en un segundo. Refrescar en cada uno seria decenas de
 *    inventarios completos seguidos, que es justo lo que se queria evitar.
 * 2. **Ignorar lo que no cambia nada.** `exec_start` salta cada vez que alguien
 *    entra a un contenedor, y las comprobaciones de salud saltan solas. Ninguna
 *    de las dos cambia lo que el panel enseña.
 */
import type { DockerApi } from '../docker/api.js';
import type { DockerEvent } from '../docker/types.js';
import type { InventoryService } from './inventory.js';
import type { Logger } from '../logger.js';

/**
 * Acciones que cambian algo de lo que se ve.
 *
 * Lista explicita en vez de "todo menos unas cuantas": asi un tipo de evento
 * nuevo del daemon no empieza a provocar refrescos por sorpresa.
 */
const RELEVANTES = new Set([
  // Contenedores
  'create', 'start', 'stop', 'die', 'kill', 'destroy', 'remove', 'rename',
  'restart', 'pause', 'unpause', 'update', 'health_status',
  // Imagenes
  'pull', 'delete', 'untag', 'tag', 'push',
  // Volumenes y redes
  'volume_create', 'volume_remove', 'network_create', 'network_remove',
]);

/**
 * Espera antes de refrescar tras el primer evento de una rafaga.
 *
 * Un segundo y medio cubre de sobra el arranque de un stack entero sin que la
 * pantalla se note lenta: para quien mira, sigue siendo inmediato.
 */
const AGRUPACION_MS = 1500;

/** Tope entre refrescos, para que una tormenta de eventos no encadene pasadas. */
const MINIMO_ENTRE_REFRESCOS_MS = 3000;

export class DockerEventsWatcher {
  #abort: AbortController | null = null;
  #timer: NodeJS.Timeout | null = null;
  #ultimoRefresco = 0;
  #parado = false;

  constructor(
    private readonly docker: DockerApi,
    private readonly inventory: InventoryService,
    private readonly onRefreshed: () => void,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.#parado = false;
    void this.#connect();
  }

  stop(): void {
    this.#parado = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#abort?.abort();
    this.#abort = null;
  }

  /**
   * Conecta y se reengancha si el flujo cae.
   *
   * El daemon puede reiniciarse (una actualizacion de Docker Desktop, la maquina
   * de Podman al despertar) y ahi el flujo muere sin mas. Sin reintento, el
   * panel se quedaria dependiendo solo del refresco de cinco minutos y nadie se
   * enteraria de que ha perdido el directo.
   */
  async #connect(intento = 0): Promise<void> {
    if (this.#parado) return;

    this.#abort = new AbortController();
    try {
      if (intento === 0) this.log.info('Escuchando los eventos del daemon');
      await this.docker.streamEvents((event) => this.handleEvent(event), this.#abort.signal);
    } catch (error) {
      if (!this.#parado) this.log.debug('El flujo de eventos se ha cortado', error);
    }

    if (this.#parado) return;

    // Espera creciente con techo de un minuto: si el daemon esta caido, no tiene
    // sentido intentarlo diez veces por segundo.
    const espera = Math.min(2 ** Math.min(intento, 5) * 1000, 60_000);
    setTimeout(() => void this.#connect(intento + 1), espera);
  }

  /**
   * Publico a proposito: es la entrada del flujo y lo unico que merece prueba
   * de esta clase. Dejarlo privado obligaria a montar un socket falso para
   * comprobar una decision que es puro control de tiempos.
   */
  handleEvent(event: DockerEvent): void {
    const accion = (event.Action ?? event.status ?? '').split(':')[0] ?? '';
    if (!RELEVANTES.has(accion)) return;
    this.#scheduleRefresh();
  }

  /**
   * Programa un refresco agrupando lo que llegue mientras tanto.
   *
   * El temporizador NO se reinicia con cada evento: si se reiniciara, una
   * rafaga continua lo iria empujando y el refresco no llegaria nunca. Se fija
   * al primer evento y los demas se suben al mismo viaje.
   */
  #scheduleRefresh(): void {
    if (this.#timer) return;

    const desdeElUltimo = Date.now() - this.#ultimoRefresco;
    const espera = Math.max(AGRUPACION_MS, MINIMO_ENTRE_REFRESCOS_MS - desdeElUltimo);

    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#refresh();
    }, espera);
  }

  async #refresh(): Promise<void> {
    this.#ultimoRefresco = Date.now();
    try {
      await this.inventory.refresh();
      this.onRefreshed();
    } catch (error) {
      this.log.debug('Fallo el refresco disparado por un evento', error);
    }
  }
}
