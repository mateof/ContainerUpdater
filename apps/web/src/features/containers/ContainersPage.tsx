import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { applyContainerFocus } from '@cu/shared';
import type { ContainerSummary } from '@cu/shared';
import { api } from '@/api/client';
import { useLive } from '@/hooks/LiveContext';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Menu,
  Skeleton,
  StatusDot,
  Tooltip,
  useToast,
} from '@/components/ui';
import { Meter } from '@/components/Chart';
import {
  IconContainer,
  IconLogs,
  IconMore,
  IconPlay,
  IconRestart,
  IconStop,
  IconPorts,
} from '@/components/icons';
import { CrossLink, FilterPills, FocusBanner, SearchBox } from '@/components/Filters';
import { PortLinks } from '@/components/PortLinks';
import { PortsDialog } from './PortsDialog';
import { displayImage, formatBytes, formatPercent, formatRate, formatRelative } from '@/lib/format';
import { CONTAINER_STATE_LABEL, CONTAINER_STATE_TONE, HEALTH_LABEL } from '@/lib/labels';
import { JobIndicator } from '@/components/JobIndicator';
import { LogsDialog } from './LogsDialog';
import { ContainerDetailDialog } from './ContainerDetailDialog';

type Filter = 'all' | 'running' | 'stopped' | 'unhealthy' | 'updates' | 'orphan';

export function ContainersPage(): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();
  const live = useLive();

  const [search, setSearch] = useState('');
  const [ports, setPorts] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');

  /**
   * Filtro que llega desde otra pantalla.
   *
   * Se llega aqui pulsando la imagen o el proyecto de una fila, y hay que
   * ensenar SOLO lo que corresponde: dejar la lista entera obligaria a buscar a
   * mano justo lo que se acaba de pedir.
   */
  const [params, setParams] = useSearchParams();
  const focusImage = params.get('image');
  const focusProject = params.get('project');
  /** Un contenedor concreto, por nombre: se llega desde "usada por" de su imagen. */
  const focusContainer = params.get('container');
  const clearFocus = (): void => setParams({}, { replace: true });
  const [logsFor, setLogsFor] = useState<ContainerSummary | null>(null);
  const [detailFor, setDetailFor] = useState<ContainerSummary | null>(null);
  const [confirm, setConfirm] = useState<{
    container: ContainerSummary;
    action: 'stop' | 'restart';
  } | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['containers'], queryFn: () => api.containers() });
  const containers = data?.containers ?? [];

  /**
   * Imagenes, solo para saber cuales tienen actualizacion.
   *
   * React Query la comparte con la pantalla de Imagenes, asi que no supone una
   * peticion extra si ya se ha visitado.
   */
  const { data: imageData } = useQuery({ queryKey: ['images'], queryFn: () => api.images() });
  const updatableImages = useMemo(
    () =>
      new Set(
        (imageData?.images ?? [])
          .filter((image) => image.status === 'update-available')
          .flatMap((image) => image.inUseBy),
      ),
    [imageData],
  );

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' | 'restart' }) =>
      api.containerAction(id, action),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['containers'] });
      setConfirm(null);
    },
    onError: () => notify(t('common.error'), 'danger'),
  });

  // Las metricas llegan por SSE en una lista aparte: se indexan por id para
  // poder pintarlas junto a cada contenedor sin recorrer el array por fila.
  const metricsById = useMemo(() => {
    const latest = live.metrics.at(-1);
    return new Map((latest?.containers ?? []).map((metric) => [metric.id, metric]));
  }, [live.metrics]);

  /**
   * Lo que llega de otra pantalla se aplica antes que nada.
   *
   * La logica vive en `@cu/shared` y tiene tests: aqui se perdio una vez sin que
   * el typecheck ni el build lo notaran, porque la pantalla seguia compilando
   * perfectamente sin filtrar nada.
   */
  const focused = useMemo(
    () =>
      applyContainerFocus(containers, {
        container: focusContainer,
        image: focusImage,
        project: focusProject,
      }),
    [containers, focusImage, focusProject, focusContainer],
  );

  /**
   * Al venir a por UN contenedor, se le abre el detalle directamente.
   *
   * "Llevame a el" no es dejarlo solo en una lista de uno: es ensenarlo. Se
   * hace una sola vez, para que cerrar el modal no lo vuelva a abrir.
   */
  const [openedFocus, setOpenedFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!focusContainer || openedFocus === focusContainer) return;
    const target = containers.find((container) => container.name === focusContainer);
    if (!target) return;
    setOpenedFocus(focusContainer);
    setDetailFor(target);
  }, [focusContainer, containers, openedFocus]);

  const matches = (container: ContainerSummary, which: Filter): boolean => {
    switch (which) {
      case 'running':
        return container.state === 'running';
      case 'stopped':
        return container.state !== 'running';
      case 'unhealthy':
        return container.health === 'unhealthy' || container.state === 'dead';
      case 'updates':
        return updatableImages.has(container.name);
      case 'orphan':
        return container.projectKey === null;
      default:
        return true;
    }
  };

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return focused.filter((container) => {
      if (
        needle &&
        !container.name.toLowerCase().includes(needle) &&
        !container.image.toLowerCase().includes(needle) &&
        !(container.projectName ?? '').toLowerCase().includes(needle) &&
        !(container.serviceName ?? '').toLowerCase().includes(needle)
      ) {
        return false;
      }
      return matches(container, filter);
    });
    // `matches` se redefine en cada render pero solo depende de lo que ya esta
    // en la lista de dependencias.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, search, filter, updatableImages]);

  const options = useMemo(
    () =>
      (
        [
          ['all', 'containers.filterAll'],
          ['running', 'containers.filterRunning'],
          ['stopped', 'containers.filterStopped'],
          ['unhealthy', 'containers.filterUnhealthy'],
          ['updates', 'containers.filterUpdates'],
          ['orphan', 'containers.filterOrphan'],
        ] as const
      ).map(([key, label]) => ({
        key,
        label: t(label),
        count: focused.filter((container) => matches(container, key)).length,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focused, updatableImages, t],
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t('containers.title')}</h1>
        {/* Los puertos estan repartidos por veinticuatro tarjetas, que es como
            no tenerlos. Este boton los junta y responde de un vistazo a "que
            tengo pillado y quien lo tiene". */}
        <Button size="sm" variant="ghost" icon={<IconPorts size={15} />} onClick={() => setPorts(true)}>
          {t('ports.button')}
        </Button>
        <SearchBox value={search} onChange={setSearch} placeholder={t('containers.searchHint')} />
      </header>

      {focusImage ? (
        <FocusBanner label={t('containers.focusImage')} value={focusImage} onClear={clearFocus} />
      ) : null}
      {focusProject ? (
        <FocusBanner
          label={t('containers.focusProject')}
          value={focused[0]?.projectName ?? focusProject}
          onClear={clearFocus}
        />
      ) : null}
      {focusContainer ? (
        <FocusBanner
          label={t('containers.focusContainer')}
          value={focusContainer}
          onClear={clearFocus}
        />
      ) : null}

      <FilterPills value={filter} onChange={setFilter} options={options} />

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-[72px] w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState icon={<IconContainer size={30} />} title={t('common.empty')} />
        </Card>
      ) : (
        <ul className="space-y-2">
          {filtered.map((container) => {
            const metrics = metricsById.get(container.id);
            const running = container.state === 'running';

            return (
              <li key={container.id} className="cu-list-row">
                <Card className="p-3 hover:border-[var(--border-strong)] transition-colors duration-[var(--dur-fast)]">
                  <div className="flex items-center gap-3">
                    <StatusDot
                      state={
                        container.health === 'unhealthy'
                          ? 'warn'
                          : running
                            ? 'running'
                            : 'stopped'
                      }
                    />

                    {/* La fila entera abre el detalle. Es donde el usuario
                        pulsa por instinto cuando quiere saber mas. */}
                    <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => setDetailFor(container)}
                      className="w-full min-w-0 text-left"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[0.8125rem] font-medium">{container.name}</span>
                        <Badge tone={CONTAINER_STATE_TONE[container.state]}>
                          {t(CONTAINER_STATE_LABEL[container.state])}
                        </Badge>
                        {container.health !== 'none' ? (
                          <Badge tone={container.health === 'healthy' ? 'ok' : 'warn'}>
                            {t(HEALTH_LABEL[container.health])}
                          </Badge>
                        ) : null}
                        {container.isSelf ? (
                          <Tooltip content={t('containers.selfWarning')}>
                            <Badge tone="info">{t('containers.self')}</Badge>
                          </Tooltip>
                        ) : null}
                      </div>

                    </button>

                      {/* Los metadatos van FUERA del boton: un enlace dentro de
                          un boton no es HTML valido, y aqui la imagen y el
                          proyecto tienen que poder navegar cada uno a su sitio. */}
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[0.6875rem] text-[var(--text-muted)]">
                        {container.imageRef ? (
                          <CrossLink
                            to={`/images?ref=${encodeURIComponent(container.imageRef)}`}
                            title={t('containers.goToImage')}
                            mono
                          >
                            {displayImage(container.image)}
                          </CrossLink>
                        ) : (
                          <span className="truncate font-mono">{displayImage(container.image)}</span>
                        )}
                        {container.projectName && container.projectKey ? (
                          <CrossLink
                            to={`/projects?key=${encodeURIComponent(container.projectKey)}`}
                            title={t('containers.goToProject')}
                          >
                            {container.projectName}
                          </CrossLink>
                        ) : null}
                        {/* Solo los publicados en la lista: los internos son
                            ruido aqui y salen en la ficha. */}
                        {container.ports.some((port) => port.publicPort) ? (
                          <PortLinks ports={container.ports.filter((port) => port.publicPort)} />
                        ) : null}
                        <span>{formatRelative(container.createdAt)}</span>
                      </div>
                    </div>

                    {/* Metricas en vivo, solo si el contenedor esta activo. */}
                    {running && metrics ? (
                      <div className="hidden shrink-0 items-center gap-4 lg:flex">
                        <div className="w-24">
                          <div className="mb-0.5 flex justify-between text-[0.625rem] text-[var(--text-muted)]">
                            <span>{t('containers.cpu')}</span>
                            <span className="tabular-nums">{formatPercent(metrics.cpuPercent, 0)}</span>
                          </div>
                          <Meter value={metrics.cpuPercent ?? 0} />
                        </div>
                        <div className="w-24">
                          <div className="mb-0.5 flex justify-between text-[0.625rem] text-[var(--text-muted)]">
                            <span>{t('containers.memory')}</span>
                            <span className="tabular-nums">{formatBytes(metrics.memoryUsed, 0)}</span>
                          </div>
                          <Meter value={metrics.memoryPercent} />
                        </div>
                        <div className="w-20 text-[0.625rem] text-[var(--text-muted)] tabular-nums">
                          <div>↓ {formatRate(metrics.netRxRate)}</div>
                          <div>↑ {formatRate(metrics.netTxRate)}</div>
                        </div>
                      </div>
                    ) : null}

                    <div className="flex shrink-0 items-center gap-1">
                      {/* Si este contenedor se esta recreando, se avisa aqui:
                          las acciones de arranque y parada no tienen sentido
                          mientras tanto. */}
                      {live.activeByContainer.get(container.id) ? (
                        <JobIndicator job={live.activeByContainer.get(container.id)!} size="icon" />
                      ) : null}

                      <Tooltip content={t('containers.logs')}>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t('containers.logs')}
                          onClick={() => setLogsFor(container)}
                        >
                          <IconLogs size={16} />
                        </Button>
                      </Tooltip>

                      {running ? (
                        <Tooltip content={t('containers.restart')}>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t('containers.restart')}
                            disabled={container.isSelf}
                            onClick={() => setConfirm({ container, action: 'restart' })}
                          >
                            <IconRestart size={16} />
                          </Button>
                        </Tooltip>
                      ) : (
                        <Tooltip content={t('containers.start')}>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t('containers.start')}
                            loading={act.isPending && act.variables?.id === container.id}
                            onClick={() => act.mutate({ id: container.id, action: 'start' })}
                          >
                            <IconPlay size={16} />
                          </Button>
                        </Tooltip>
                      )}

                      <Menu
                        trigger={
                          <Button size="icon" variant="ghost" aria-label={t('common.showMore')}>
                            <IconMore size={16} />
                          </Button>
                        }
                        items={[
                          {
                            key: 'logs',
                            label: t('containers.logs'),
                            onSelect: () => setLogsFor(container),
                          },
                          {
                            key: 'stop',
                            label: t('containers.stop'),
                            icon: <IconStop size={15} />,
                            danger: true,
                            disabled: !running || container.isSelf,
                            onSelect: () => setConfirm({ container, action: 'stop' }),
                          },
                        ]}
                      />
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {ports ? <PortsDialog onClose={() => setPorts(false)} /> : null}

      {logsFor ? <LogsDialog container={logsFor} onClose={() => setLogsFor(null)} /> : null}

      {detailFor ? (
        <ContainerDetailDialog
          container={detailFor}
          onClose={() => setDetailFor(null)}
          onShowLogs={() => {
            setLogsFor(detailFor);
            setDetailFor(null);
          }}
        />
      ) : null}

      {confirm ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirm(null)}
          title={confirm.action === 'stop' ? t('containers.stop') : t('containers.restart')}
          description={t(
            confirm.action === 'stop' ? 'containers.confirmStop' : 'containers.confirmRestart',
            { name: confirm.container.name },
          )}
          confirmLabel={t('common.confirm')}
          cancelLabel={t('common.cancel')}
          danger={confirm.action === 'stop'}
          loading={act.isPending}
          onConfirm={() => act.mutate({ id: confirm.container.id, action: confirm.action })}
        />
      ) : null}
    </div>
  );
}
