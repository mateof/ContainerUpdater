import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { ContainerSummary } from '@cu/shared';
import { api } from '@/api/client';
import { useLive } from '@/hooks/LiveContext';
import { Badge, Button, Card, Modal, Spinner, StatusDot, cx } from '@/components/ui';
import { Meter } from '@/components/Chart';
import {
  displayImage,
  formatBytes,
  formatDateTime,
  formatPercent,
  formatRate,
  formatRelative,
  shortDigest,
} from '@/lib/format';
import { CONTAINER_STATE_LABEL, CONTAINER_STATE_TONE, HEALTH_LABEL } from '@/lib/labels';

type Tab = 'general' | 'network' | 'storage' | 'config';

/**
 * Detalle completo de un contenedor.
 *
 * La fila de la lista da un vistazo; esto es para indagar. Se agrupa en
 * pestanas porque un `inspect` tiene decenas de campos y volcarlos en una lista
 * plana es exactamente lo que hace ilegible la salida de `docker inspect`.
 */
export function ContainerDetailDialog({
  container,
  onClose,
  onShowLogs,
}: {
  container: ContainerSummary;
  onClose: () => void;
  onShowLogs: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const live = useLive();
  const [tab, setTab] = useState<Tab>('general');

  const { data, isLoading } = useQuery({
    queryKey: ['container', container.id],
    queryFn: () => api.container(container.id),
  });

  const inspect = data?.container;
  const metrics = live.metrics.at(-1)?.containers.find((entry) => entry.id === container.id);

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'general', label: t('containers.tabGeneral') },
    { key: 'network', label: t('containers.tabNetwork') },
    { key: 'storage', label: t('containers.tabStorage') },
    { key: 'config', label: t('containers.tabConfig') },
  ];

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      wide
      resizable
      storageKey="container-detail"
      title={container.name}
      description={displayImage(container.image)}
      footer={
        <>
          <Button variant="ghost" onClick={onShowLogs}>
            {t('containers.logs')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Cabecera con lo que se mira primero, siempre visible. */}
        <div className="flex flex-wrap items-center gap-2">
          <StatusDot state={container.state === 'running' ? 'running' : 'stopped'} />
          <Badge tone={CONTAINER_STATE_TONE[container.state]}>
            {t(CONTAINER_STATE_LABEL[container.state])}
          </Badge>
          {container.health !== 'none' ? (
            <Badge tone={container.health === 'healthy' ? 'ok' : 'warn'}>
              {t(HEALTH_LABEL[container.health])}
            </Badge>
          ) : null}
          {container.projectName ? <Badge tone="info">{container.projectName}</Badge> : null}
          {container.isSelf ? <Badge tone="info">{t('containers.self')}</Badge> : null}
        </div>

        {/* Metricas en vivo, si el contenedor esta en marcha. */}
        {metrics ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="p-3">
              <p className="text-[0.6875rem] text-[var(--text-muted)]">{t('containers.cpu')}</p>
              <p className="text-lg font-semibold tabular-nums">
                {formatPercent(metrics.cpuPercent, 1)}
              </p>
              <Meter value={metrics.cpuPercent ?? 0} />
            </Card>
            <Card className="p-3">
              <p className="text-[0.6875rem] text-[var(--text-muted)]">{t('containers.memory')}</p>
              <p className="text-lg font-semibold tabular-nums">{formatBytes(metrics.memoryUsed)}</p>
              <Meter value={metrics.memoryPercent} />
            </Card>
            <Card className="p-3">
              <p className="text-[0.6875rem] text-[var(--text-muted)]">{t('containers.network')}</p>
              <p className="text-[0.8125rem] tabular-nums mt-1">↓ {formatRate(metrics.netRxRate)}</p>
              <p className="text-[0.8125rem] tabular-nums">↑ {formatRate(metrics.netTxRate)}</p>
            </Card>
          </div>
        ) : null}

        <div className="flex gap-1 border-b border-[var(--border)]">
          {tabs.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              className={cx(
                'relative px-3 py-2 text-[0.8125rem] font-medium transition-colors duration-[var(--dur-fast)]',
                tab === entry.key
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text)]',
              )}
            >
              {entry.label}
              {tab === entry.key ? (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[var(--accent)]" />
              ) : null}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner className="size-5" />
          </div>
        ) : !inspect ? (
          <p className="py-6 text-center text-[0.8125rem] text-[var(--text-muted)]">
            {t('common.error')}
          </p>
        ) : (
          <div className="space-y-1">
            {tab === 'general' ? (
              <>
                <Row label={t('containers.name')}>{inspect.Name?.replace(/^\//, '')}</Row>
                <Row label={t('images.reference')} mono>
                  {displayImage(container.image)}
                </Row>
                <Row label={t('images.digest')} mono>
                  {shortDigest(inspect.Image, 16)}
                </Row>
                <Row label={t('containers.state')}>{inspect.State?.Status}</Row>
                <Row label={t('containers.uptime')}>
                  {inspect.State?.StartedAt
                    ? formatRelative(new Date(inspect.State.StartedAt).getTime())
                    : '-'}
                </Row>
                <Row label={t('images.created')}>
                  {inspect.Created ? formatDateTime(new Date(inspect.Created).getTime()) : '-'}
                </Row>
                <Row label={t('containers.restarts')}>{inspect.RestartCount ?? 0}</Row>
                {inspect.State?.Health ? (
                  <Row label={t('containers.health')}>
                    {inspect.State.Health.Status}
                    {inspect.State.Health.FailingStreak
                      ? ` (${inspect.State.Health.FailingStreak})`
                      : ''}
                  </Row>
                ) : null}
                {container.serviceName ? (
                  <Row label={t('containers.service')}>{container.serviceName}</Row>
                ) : null}
                <Row label={t('settings.registryAuthType')}>
                  {inspect.HostConfig?.RestartPolicy?.Name ?? '-'}
                </Row>
              </>
            ) : null}

            {tab === 'network' ? (
              <>
                <Row label="Modo">{inspect.HostConfig?.NetworkMode ?? '-'}</Row>
                {Object.entries(inspect.NetworkSettings?.Networks ?? {}).map(([name, net]) => (
                  <div key={name} className="border-b border-[var(--border)] py-2">
                    <p className="text-[0.8125rem] font-medium">{name}</p>
                    <div className="mt-1 grid gap-x-4 gap-y-0.5 text-[0.75rem] sm:grid-cols-2">
                      <Detail label="IP">{net.IPAddress || '-'}</Detail>
                      <Detail label="MAC">{net.MacAddress || '-'}</Detail>
                      {net.Aliases?.length ? (
                        <Detail label="Alias">{net.Aliases.join(', ')}</Detail>
                      ) : null}
                    </div>
                  </div>
                ))}

                {container.ports.length > 0 ? (
                  <div className="pt-2">
                    <p className="mb-1 text-[0.75rem] font-medium">{t('containers.ports')}</p>
                    <ul className="space-y-0.5">
                      {container.ports.map((port, index) => (
                        <li
                          key={`${port.privatePort}-${index}`}
                          className="font-mono text-[0.75rem] text-[var(--text-muted)]"
                        >
                          {port.publicPort
                            ? `${port.ip ?? '0.0.0.0'}:${port.publicPort} → ${port.privatePort}/${port.type}`
                            : `${port.privatePort}/${port.type} (no publicado)`}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : null}

            {tab === 'storage' ? (
              (inspect.Mounts ?? []).length === 0 ? (
                <p className="py-4 text-center text-[0.8125rem] text-[var(--text-muted)]">
                  {t('common.empty')}
                </p>
              ) : (
                (inspect.Mounts ?? []).map((mount, index) => (
                  <div key={index} className="border-b border-[var(--border)] py-2">
                    <div className="flex items-center gap-2">
                      <Badge tone={mount.Type === 'bind' ? 'info' : 'neutral'}>{mount.Type}</Badge>
                      <span className="font-mono text-[0.75rem]">{mount.Destination}</span>
                      {mount.RW === false ? <Badge tone="warn">solo lectura</Badge> : null}
                    </div>
                    <p className="mt-0.5 break-all font-mono text-[0.6875rem] text-[var(--text-muted)]">
                      {mount.Name || mount.Source}
                    </p>
                  </div>
                ))
              )
            ) : null}

            {tab === 'config' ? (
              <>
                {inspect.Config?.Cmd?.length ? (
                  <Row label="Cmd" mono>
                    {inspect.Config.Cmd.join(' ')}
                  </Row>
                ) : null}
                {inspect.Config?.Entrypoint?.length ? (
                  <Row label="Entrypoint" mono>
                    {inspect.Config.Entrypoint.join(' ')}
                  </Row>
                ) : null}
                {inspect.Config?.WorkingDir ? (
                  <Row label="WorkingDir" mono>
                    {inspect.Config.WorkingDir}
                  </Row>
                ) : null}
                {inspect.Config?.User ? <Row label="User">{inspect.Config.User}</Row> : null}

                <div className="pt-3">
                  <p className="mb-1 text-[0.75rem] font-medium">
                    {t('containers.environment')}{' '}
                    <span className="font-normal text-[var(--text-faint)]">
                      ({(inspect.Config?.Env ?? []).length})
                    </span>
                  </p>
                  <div className="max-h-48 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-inset)] p-2">
                    {(inspect.Config?.Env ?? []).map((entry, index) => {
                      const separator = entry.indexOf('=');
                      const key = separator > 0 ? entry.slice(0, separator) : entry;
                      const value = separator > 0 ? entry.slice(separator + 1) : '';
                      // Los valores que parecen credenciales se ocultan: este
                      // panel se mira con gente delante y una contrasena no
                      // deberia aparecer por pulsar en un contenedor.
                      const secret = /pass|secret|token|key|pwd|auth/i.test(key);
                      return (
                        <div key={index} className="font-mono text-[0.6875rem] leading-relaxed">
                          <span className="text-[var(--accent)]">{key}</span>
                          <span className="text-[var(--text-faint)]">=</span>
                          <span className="break-all text-[var(--text-muted)]">
                            {secret ? '••••••••' : value}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {Object.keys(inspect.Config?.Labels ?? {}).length > 0 ? (
                  <div className="pt-3">
                    <p className="mb-1 text-[0.75rem] font-medium">Labels</p>
                    <div className="max-h-40 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-inset)] p-2">
                      {Object.entries(inspect.Config?.Labels ?? {}).map(([key, value]) => (
                        <div key={key} className="font-mono text-[0.6875rem] leading-relaxed">
                          <span className="text-[var(--info)]">{key}</span>
                          <span className="text-[var(--text-faint)]">=</span>
                          <span className="break-all text-[var(--text-muted)]">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Row({
  label,
  children,
  mono,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--border)] py-1.5 text-[0.8125rem] last:border-0">
      <span className="shrink-0 text-[var(--text-muted)]">{label}</span>
      <span className={cx('min-w-0 truncate text-right', mono && 'font-mono text-[0.75rem]')}>
        {children}
      </span>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex gap-2">
      <span className="text-[var(--text-muted)]">{label}:</span>
      <span className="min-w-0 truncate font-mono">{children}</span>
    </div>
  );
}
