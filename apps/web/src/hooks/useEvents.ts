import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CheckRun, MetricsSnapshot, UpdateJob } from '@cu/shared';

/** Mismo tamano que el buffer del servidor: 10 minutos a 5 segundos. */
const MAX_POINTS = 120;

export interface LiveState {
  metrics: MetricsSnapshot[];
  connected: boolean;
  /**
   * Trabajos recibidos por SSE, indexados por id. Se guardan TODOS y no solo el
   * ultimo porque desde que se ejecutan en segundo plano puede haber uno
   * corriendo y varios esperando turno, y la pantalla de Actualizaciones los
   * muestra a la vez.
   */
  jobs: Map<number, UpdateJob>;
  /** El que se esta ejecutando ahora mismo, si hay alguno. */
  activeJob: UpdateJob | null;
  /**
   * Trabajos sin terminar indexados por referencia de imagen y por id de
   * contenedor, para que cada fila de las listas sepa de un vistazo si esta
   * siendo actualizada sin recorrer todos los trabajos.
   */
  activeByImage: Map<string, UpdateJob>;
  activeByContainer: Map<string, UpdateJob>;
  /**
   * Indexados por clave de proyecto.
   *
   * Los trabajos de proyecto no llevan `containerId`, asi que no aparecen en
   * `activeByContainer` y la tarjeta no tenia forma de saber que estaba
   * trabajando.
   */
  activeByProject: Map<string, UpdateJob>;
  activeRun: CheckRun | null;
  checkingImage: string | null;
}

/**
 * Canal de eventos en vivo.
 *
 * `EventSource` manda la cookie de sesion sin configuracion y reconecta solo
 * cuando se corta. La conexion se cierra al ocultar la pestana: sin
 * suscriptores, el servidor deja de muestrear y el NAS descansa. Esa es la
 * mitad del ahorro de recursos del diseno, y hacerlo aqui es una linea.
 */
export function useEvents(enabled: boolean): LiveState {
  const [metrics, setMetrics] = useState<MetricsSnapshot[]>([]);
  const [connected, setConnected] = useState(false);
  const [jobs, setJobs] = useState<Map<number, UpdateJob>>(() => new Map());
  const [activeRun, setActiveRun] = useState<CheckRun | null>(null);
  const [checkingImage, setCheckingImage] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let closed = false;

    const connect = (): void => {
      if (closed || sourceRef.current) return;
      const source = new EventSource('/api/events');
      sourceRef.current = source;

      source.addEventListener('open', () => setConnected(true));

      source.addEventListener('metrics-snapshot', (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { history: MetricsSnapshot[] };
        setMetrics(data.history.slice(-MAX_POINTS));
        setConnected(true);
      });

      source.addEventListener('metrics', (event) => {
        const snapshot = JSON.parse((event as MessageEvent).data) as MetricsSnapshot;
        setMetrics((previous) => {
          const next = [...previous, snapshot];
          return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
        });
      });

      source.addEventListener('job-progress', (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { job: UpdateJob };
        setJobs((current) => {
          // Mapa nuevo en cada evento: mutar el existente no dispararia el
          // re-render y el log se quedaria congelado en pantalla.
          const next = new Map(current);
          next.set(data.job.id, data.job);
          return next;
        });

        if (data.job.status !== 'running' && data.job.status !== 'queued') {
          void queryClient.invalidateQueries({ queryKey: ['jobs'] });
          void queryClient.invalidateQueries({ queryKey: ['images'] });
          void queryClient.invalidateQueries({ queryKey: ['containers'] });
          void queryClient.invalidateQueries({ queryKey: ['status'] });
          // Los proyectos tambien: su contador de actualizaciones sale del
          // estado de las imagenes, que el servidor acaba de reconciliar. Sin
          // esto, actualizar un proyecto entero terminaba bien pero la tarjeta
          // seguia diciendo que tenia actualizaciones hasta recargar la pagina
          // o hasta el siguiente ciclo de comprobacion, que puede tardar horas.
          void queryClient.invalidateQueries({ queryKey: ['projects'] });
        }
      });

      source.addEventListener('check-progress', (event) => {
        const data = JSON.parse((event as MessageEvent).data) as {
          run: CheckRun;
          currentImage: string | null;
        };
        setActiveRun(data.run);
        setCheckingImage(data.currentImage);
      });

      source.addEventListener('check-done', (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { run: CheckRun };
        setActiveRun(data.run);
        setCheckingImage(null);
        void queryClient.invalidateQueries({ queryKey: ['images'] });
        void queryClient.invalidateQueries({ queryKey: ['status'] });
      });

      source.addEventListener('inventory-changed', () => {
        void queryClient.invalidateQueries({ queryKey: ['containers'] });
        void queryClient.invalidateQueries({ queryKey: ['projects'] });
        void queryClient.invalidateQueries({ queryKey: ['images'] });
      });

      source.addEventListener('error', () => {
        setConnected(false);
        // EventSource reintenta solo, pero si el servidor cerro limpiamente el
        // objeto queda inservible y hay que crear uno nuevo.
        if (source.readyState === EventSource.CLOSED) {
          sourceRef.current = null;
          if (!closed) setTimeout(connect, 3000);
        }
      });
    };

    const disconnect = (): void => {
      sourceRef.current?.close();
      sourceRef.current = null;
      setConnected(false);
    };

    // Con la pestana oculta nadie mira las graficas: cerrar la conexion hace
    // que el servidor pare el muestreo por completo.
    const onVisibilityChange = (): void => {
      if (document.hidden) disconnect();
      else connect();
    };

    if (!document.hidden) connect();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      disconnect();
    };
  }, [enabled, queryClient]);

  const activeJob = useMemo(() => {
    for (const job of jobs.values()) {
      if (job.status === 'running') return job;
    }
    return null;
  }, [jobs]);

  const { activeByImage, activeByContainer, activeByProject } = useMemo(() => {
    const byImage = new Map<string, UpdateJob>();
    const byContainer = new Map<string, UpdateJob>();
    const byProject = new Map<string, UpdateJob>();

    for (const job of jobs.values()) {
      if (job.status !== 'running' && job.status !== 'queued') continue;
      // Si hubiera varios para la misma imagen, se queda el que ya corre: es el
      // que interesa mostrar.
      const existing = byImage.get(job.imageRef);
      if (!existing || job.status === 'running') byImage.set(job.imageRef, job);
      if (job.containerId) byContainer.set(job.containerId, job);
      if (job.projectKey) {
        // Mismo criterio que con las imagenes: manda el que ya corre sobre el
        // que espera turno.
        const enCurso = byProject.get(job.projectKey);
        if (!enCurso || job.status === 'running') byProject.set(job.projectKey, job);
      }
    }

    return { activeByImage: byImage, activeByContainer: byContainer, activeByProject: byProject };
  }, [jobs]);

  return {
    metrics,
    connected,
    jobs,
    activeJob,
    activeByImage,
    activeByContainer,
    activeByProject,
    activeRun,
    checkingImage,
  };
}
