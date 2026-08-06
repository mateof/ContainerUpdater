import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { ContainerSummary } from '@cu/shared';
import { api } from '@/api/client';
import { useLive } from '@/hooks/LiveContext';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  Menu,
  Skeleton,
  StatusDot,
  Tooltip,
  cx,
  useToast,
} from '@/components/ui';
import { Meter } from '@/components/Chart';
import {
  IconContainer,
  IconLogs,
  IconMore,
  IconPlay,
  IconRestart,
  IconSearch,
  IconStop,
} from '@/components/icons';
import { displayImage, formatBytes, formatPercent, formatRate, formatRelative } from '@/lib/format';
import { CONTAINER_STATE_LABEL, CONTAINER_STATE_TONE, HEALTH_LABEL } from '@/lib/labels';
import { JobIndicator } from '@/components/JobIndicator';
import { LogsDialog } from './LogsDialog';
import { ContainerDetailDialog } from './ContainerDetailDialog';

type Filter = 'all' | 'running' | 'stopped' | 'unhealthy';

export function ContainersPage(): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();
  const live = useLive();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [logsFor, setLogsFor] = useState<ContainerSummary | null>(null);
  const [detailFor, setDetailFor] = useState<ContainerSummary | null>(null);
  const [confirm, setConfirm] = useState<{
    container: ContainerSummary;
    action: 'stop' | 'restart';
  } | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['containers'], queryFn: () => api.containers() });
  const containers = data?.containers ?? [];

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

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return containers.filter((container) => {
      if (
        needle &&
        !container.name.toLowerCase().includes(needle) &&
        !container.image.toLowerCase().includes(needle)
      ) {
        return false;
      }
      if (filter === 'running') return container.state === 'running';
      if (filter === 'stopped') return container.state !== 'running';
      if (filter === 'unhealthy') return container.health === 'unhealthy' || container.state === 'dead';
      return true;
    });
  }, [containers, search, filter]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t('containers.title')}</h1>
        <div className="relative">
          <IconSearch
            size={15}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('common.search')}
            className="pl-8 w-48 sm:w-60"
            type="search"
          />
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ['all', 'containers.filterAll'],
            ['running', 'containers.filterRunning'],
            ['stopped', 'containers.filterStopped'],
            ['unhealthy', 'containers.filterUnhealthy'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={cx(
              'rounded-full px-3 py-1 text-[0.75rem] font-medium transition-colors duration-[var(--dur-fast)]',
              filter === key
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'bg-[var(--bg-inset)] text-[var(--text-muted)] hover:text-[var(--text)]',
            )}
          >
            {t(label)}
          </button>
        ))}
      </div>

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
                    <button
                      type="button"
                      onClick={() => setDetailFor(container)}
                      className="min-w-0 flex-1 text-left"
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

                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[0.6875rem] text-[var(--text-muted)]">
                        <span className="truncate font-mono">{displayImage(container.image)}</span>
                        {container.projectName ? <span>{container.projectName}</span> : null}
                        {container.ports.length > 0 ? (
                          <span>
                            {container.ports
                              .filter((port) => port.publicPort)
                              .map((port) => `${port.publicPort}:${port.privatePort}`)
                              .join(' ')}
                          </span>
                        ) : null}
                        <span>{formatRelative(container.createdAt)}</span>
                      </div>
                    </button>

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
