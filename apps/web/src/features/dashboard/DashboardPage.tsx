import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { api } from '@/api/client';
import { useLive } from '@/hooks/LiveContext';
import { Chart, Meter } from '@/components/Chart';
import { Badge, Banner, Button, Card, EmptyState, Skeleton, StatusDot, cx } from '@/components/ui';
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconCpu,
  IconDisk,
  IconMemory,
  IconRefresh,
} from '@/components/icons';
import {
  displayImage,
  formatBytes,
  formatDuration,
  formatPercent,
  formatRelative,
} from '@/lib/format';
import { JOB_STATUS_LABEL, JOB_STATUS_TONE } from '@/lib/labels';

export function DashboardPage(): ReactNode {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const live = useLive();

  const { data: status } = useQuery({ queryKey: ['status'], queryFn: () => api.status() });
  const { data: containersData, isLoading: containersLoading } = useQuery({
    queryKey: ['containers'],
    queryFn: () => api.containers(),
  });
  const { data: imagesData } = useQuery({ queryKey: ['images'], queryFn: () => api.images() });
  const { data: jobsData } = useQuery({ queryKey: ['jobs'], queryFn: () => api.jobs() });

  const runCheck = useMutation({
    mutationFn: () => api.runCheck(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['status'] }),
  });

  const containers = containersData?.containers ?? [];
  const images = imagesData?.images ?? [];
  const running = containers.filter((container) => container.state === 'running');
  const withUpdates = images.filter((image) => image.status === 'update-available');

  const latest = live.metrics.at(-1);
  const host = latest?.host;

  const timestamps = useMemo(() => live.metrics.map((snapshot) => snapshot.host.ts), [live.metrics]);

  const cpuSeries = useMemo(
    () => [
      {
        label: 'CPU',
        values: live.metrics.map((snapshot) => snapshot.host.cpuPercent),
        color: 'var(--accent)',
        fill: true,
      },
    ],
    [live.metrics],
  );

  const memorySeries = useMemo(
    () => [
      {
        label: 'RAM',
        values: live.metrics.map((snapshot) =>
          snapshot.host.memTotal > 0 ? (snapshot.host.memUsed / snapshot.host.memTotal) * 100 : null,
        ),
        color: 'var(--info)',
        fill: true,
      },
    ],
    [live.metrics],
  );

  // Se ordenan por consumo actual y se muestran los cinco primeros: en un panel
  // con treinta contenedores, lo que interesa de un vistazo es quien se come la
  // maquina, no la lista entera.
  const topConsumers = useMemo(() => {
    if (!latest) return [];
    return [...latest.containers]
      .filter((metric) => metric.cpuPercent !== null)
      .sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0))
      .slice(0, 5);
  }, [latest]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
          <p className="text-[0.8125rem] text-[var(--text-muted)] mt-0.5">
            {t('dashboard.lastCheck')}: {formatRelative(status?.lastCheckAt)}
            {status?.nextCheckAt ? (
              <> · {t('dashboard.nextCheck')}: {formatRelative(status.nextCheckAt)}</>
            ) : null}
          </p>
        </div>

        <Button
          variant="primary"
          icon={<IconRefresh size={16} />}
          loading={runCheck.isPending || status?.checkRunning}
          onClick={() => runCheck.mutate()}
        >
          {status?.checkRunning ? t('dashboard.checking') : t('dashboard.checkNow')}
        </Button>
      </header>

      {status && !status.dockerConnected ? (
        <Banner tone="danger" title={t('errors.dockerUnavailable')}>
          {t('settings.dockerDisconnected')}
        </Banner>
      ) : null}

      {status && !status.keyringHealthy ? (
        <Banner tone="warn" title={t('errors.keyringLocked')}>
          {t('settings.keyringDegraded')}
        </Banner>
      ) : null}

      {live.activeRun && live.activeRun.status === 'running' ? (
        <Banner tone="info" title={t('dashboard.checking')}>
          {live.checkingImage ? displayImage(live.checkingImage) : null}
        </Banner>
      ) : null}

      {/* Tarjetas de resumen */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          icon={<IconCpu size={16} />}
          label={t('dashboard.hostCpu')}
          value={host?.cpuPercent !== null && host ? formatPercent(host.cpuPercent, 0) : '-'}
          detail={host?.ncpu ? `${host.ncpu} nucleos` : undefined}
          meter={host?.cpuPercent ?? undefined}
        />
        <StatTile
          icon={<IconMemory size={16} />}
          label={t('dashboard.hostMemory')}
          value={host && host.memTotal > 0 ? formatBytes(host.memUsed) : '-'}
          detail={host && host.memTotal > 0 ? `de ${formatBytes(host.memTotal)}` : undefined}
          meter={host && host.memTotal > 0 ? (host.memUsed / host.memTotal) * 100 : undefined}
        />
        <StatTile
          icon={<IconClock size={16} />}
          label={t('dashboard.containersRunning')}
          value={containersLoading ? '-' : `${running.length}`}
          detail={`de ${containers.length}`}
        />
        <StatTile
          icon={withUpdates.length > 0 ? <IconAlert size={16} /> : <IconCheck size={16} />}
          label={t('dashboard.updatesAvailable')}
          value={`${withUpdates.length}`}
          detail={withUpdates.length === 0 ? t('dashboard.updatesAvailableNone') : undefined}
          tone={withUpdates.length > 0 ? 'accent' : 'ok'}
          to="/images"
        />
      </div>

      {/* Graficas */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[0.8125rem] font-semibold">{t('dashboard.hostCpu')}</h2>
            <span className="text-[0.8125rem] tabular-nums text-[var(--text-muted)]">
              {host?.cpuPercent !== null && host ? formatPercent(host.cpuPercent) : '-'}
            </span>
          </div>
          {live.metrics.length > 1 ? (
            <Chart
              timestamps={timestamps}
              series={cpuSeries}
              maxY={100}
              formatValue={(value) => `${value.toFixed(0)}%`}
            />
          ) : (
            <Skeleton className="h-[160px] w-full" />
          )}
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[0.8125rem] font-semibold">{t('dashboard.hostMemory')}</h2>
            <span className="text-[0.8125rem] tabular-nums text-[var(--text-muted)]">
              {host && host.memTotal > 0
                ? `${formatBytes(host.memUsed)} / ${formatBytes(host.memTotal)}`
                : '-'}
            </span>
          </div>
          {live.metrics.length > 1 ? (
            <Chart
              timestamps={timestamps}
              series={memorySeries}
              maxY={100}
              formatValue={(value) => `${value.toFixed(0)}%`}
            />
          ) : (
            <Skeleton className="h-[160px] w-full" />
          )}
        </Card>
      </div>

      {host?.source === 'docker-fallback' || host?.source === 'unavailable' ? (
        <Banner tone="info" title={t('dashboard.metricsUnavailable')}>
          {t('dashboard.metricsFallback')}
        </Banner>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Mayor consumo */}
        <Card className="p-4">
          <h2 className="text-[0.8125rem] font-semibold mb-3">{t('dashboard.topConsumers')}</h2>
          {topConsumers.length === 0 ? (
            <div className="space-y-2">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-9 w-full" />
              ))}
            </div>
          ) : (
            <ul className="space-y-2.5">
              {topConsumers.map((metric) => (
                <li key={metric.id} className="flex items-center gap-3">
                  <StatusDot state="running" />
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{metric.name}</span>
                  <div className="w-24 shrink-0">
                    <Meter value={metric.cpuPercent ?? 0} />
                  </div>
                  <span className="w-14 shrink-0 text-right text-[0.75rem] tabular-nums text-[var(--text-muted)]">
                    {formatPercent(metric.cpuPercent, 1)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Actividad reciente */}
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[0.8125rem] font-semibold">{t('dashboard.recentJobs')}</h2>
            <Link
              to="/updates"
              className="text-[0.75rem] text-[var(--accent)] hover:underline"
            >
              {t('common.showMore')}
            </Link>
          </div>
          {(jobsData?.jobs.length ?? 0) === 0 ? (
            <EmptyState title={t('common.empty')} />
          ) : (
            <ul className="space-y-2">
              {jobsData?.jobs.slice(0, 5).map((job) => (
                <li key={job.id} className="flex items-center gap-3 text-[0.8125rem]">
                  <Badge tone={JOB_STATUS_TONE[job.status]}>
                    {t(JOB_STATUS_LABEL[job.status])}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem]">
                    {displayImage(job.imageRef)}
                  </span>
                  <span className="shrink-0 text-[0.75rem] text-[var(--text-muted)]">
                    {formatRelative(job.startedAt ?? job.finishedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Discos */}
      {host && host.disks.length > 0 ? (
        <Card className="p-4">
          <h2 className="text-[0.8125rem] font-semibold mb-3 flex items-center gap-2">
            <IconDisk size={15} />
            {t('dashboard.hostDisk')}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {host.disks.map((disk) => (
              <div key={disk.path}>
                <div className="flex justify-between text-[0.75rem] mb-1.5">
                  <span className="truncate font-mono">{disk.path}</span>
                  <span className="text-[var(--text-muted)] tabular-nums shrink-0 ml-2">
                    {formatBytes(disk.used)} / {formatBytes(disk.total)}
                  </span>
                </div>
                <Meter value={disk.used} max={disk.total} />
              </div>
            ))}
          </div>
          {host.uptimeSeconds > 0 ? (
            <p className="mt-3 text-[0.75rem] text-[var(--text-muted)]">
              {t('dashboard.uptime')}: {formatDuration(host.uptimeSeconds)}
            </p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  detail,
  meter,
  tone,
  to,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
  meter?: number;
  tone?: 'accent' | 'ok';
  to?: string;
}): ReactNode {
  const content = (
    <Card
      className={cx(
        'p-4 h-full transition-transform duration-[var(--dur-fast)]',
        to && 'hover:-translate-y-0.5 cursor-pointer',
      )}
      glow={tone === 'accent'}
    >
      <div className="flex items-center gap-2 text-[var(--text-muted)] mb-2">
        <span className={cx(tone === 'accent' && 'text-[var(--accent)]', tone === 'ok' && 'text-[var(--ok)]')}>
          {icon}
        </span>
        <span className="min-w-0 truncate text-[0.75rem] font-medium">{label}</span>
      </div>
      <p className="text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {detail ? <p className="text-[0.75rem] text-[var(--text-muted)] mt-0.5">{detail}</p> : null}
      {meter !== undefined ? (
        <div className="mt-2.5">
          <Meter value={meter} />
        </div>
      ) : null}
    </Card>
  );

  return to ? <Link to={to}>{content}</Link> : content;
}
