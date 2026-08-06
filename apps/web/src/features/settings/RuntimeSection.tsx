import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { api } from '@/api/client';
import { Badge, Banner, Card, SectionTitle, Skeleton, cx } from '@/components/ui';

/**
 * Diagnostico del entorno.
 *
 * Responde a la pregunta que se hace todo el mundo cuando algo no sale: donde
 * cree la aplicacion que esta y que puede tocar. Un montaje mal puesto se
 * manifiesta como "no detecta mis proyectos", y sin esta pantalla no hay forma
 * de saber si el problema es el socket, las rutas o los permisos.
 */
export function RuntimeSection(): ReactNode {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({ queryKey: ['runtime'], queryFn: () => api.runtime() });

  if (isLoading || !data) {
    return (
      <Card className="p-5">
        <SectionTitle title={t('settings.runtime')} />
        <Skeleton className="h-32 w-full" />
      </Card>
    );
  }

  const composeGap = data.compose.projectsFound - data.compose.projectsUsable;

  return (
    <Card className="p-5">
      <SectionTitle title={t('settings.runtime')} description={t('settings.runtimeHelp')} />

      {!data.socket.readable ? (
        <Banner tone="danger" title={t('settings.socketDenied')}>
          {t('settings.socketDeniedHelp', { path: data.socket.path })}
        </Banner>
      ) : null}

      {composeGap > 0 ? (
        <Banner tone="warn" title={t('settings.composeGap', { count: composeGap })}>
          {t('settings.composeGapHelp')}
        </Banner>
      ) : null}

      <dl className="mt-3 space-y-2 text-[0.8125rem]">
        <Row label={t('settings.platform')}>
          <span className="flex flex-wrap items-center justify-end gap-2">
            <span>{data.platform.name}</span>
            {/* Se distingue lo comprobado de lo declarado a partir de la
                documentacion: dar por verificado lo que no se ha probado es
                peor que no decir nada. */}
            {data.platform.verified ? (
              <Badge tone="ok">{t('settings.verified')}</Badge>
            ) : (
              <Badge tone="warn">{t('settings.unverified')}</Badge>
            )}
          </span>
        </Row>

        {data.platform.evidence ? (
          <Row label={t('settings.detectedBy')} muted>
            {data.platform.evidence}
          </Row>
        ) : null}

        <Row label={t('settings.runtimeEngine')}>
          {data.runtime.connected ? (
            <span className="flex items-center gap-2">
              <Badge tone="ok">{data.runtime.flavor}</Badge>
              {data.runtime.version} · API {data.runtime.apiVersion}
            </span>
          ) : (
            <Badge tone="danger">{t('errors.dockerUnavailable')}</Badge>
          )}
        </Row>

        <Row label={t('settings.socket')} mono>
          <span className="flex items-center justify-end gap-2">
            {data.socket.path}
            {data.socket.detected ? <Badge>{t('settings.autoDetected')}</Badge> : null}
          </span>
        </Row>

        <Row label={t('settings.composeRoots')} mono>
          {data.compose.roots.length > 0 ? (
            <span className="flex flex-col items-end gap-0.5">
              {data.compose.roots.map((root) => (
                <span key={root}>{root}</span>
              ))}
              {!data.compose.explicit ? <Badge>{t('settings.autoDetected')}</Badge> : null}
            </span>
          ) : (
            <Badge tone="warn">{t('common.none')}</Badge>
          )}
        </Row>

        <Row label={t('settings.projectsDetected')}>
          {data.compose.projectsUsable} / {data.compose.projectsFound}
        </Row>

        <Row label={t('settings.hostMetrics')}>
          {data.metrics.hostProcAvailable ? (
            <Badge tone="ok">{data.metrics.hostProcPath}</Badge>
          ) : (
            <Badge tone="warn">{t('dashboard.metricsUnavailable')}</Badge>
          )}
        </Row>
      </dl>
    </Card>
  );
}

function Row({
  label,
  children,
  mono,
  muted,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  muted?: boolean;
}): ReactNode {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] pb-2 last:border-0">
      <dt className="shrink-0 text-[var(--text-muted)]">{label}</dt>
      <dd
        className={cx(
          'min-w-0 break-all text-right',
          mono && 'font-mono text-[0.75rem]',
          muted && 'text-[var(--text-muted)]',
        )}
      >
        {children}
      </dd>
    </div>
  );
}
