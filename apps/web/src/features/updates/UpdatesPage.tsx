import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { UpdateJob } from '@cu/shared';
import { api } from '@/api/client';
import { useLive } from '@/hooks/LiveContext';
import { Badge, Card, EmptyState, Modal, Skeleton, Button } from '@/components/ui';
import { IconUpdates } from '@/components/icons';
import { displayImage, formatDateTime, formatDuration, formatRelative } from '@/lib/format';
import { JOB_STATUS_LABEL, JOB_STATUS_TONE } from '@/lib/labels';
import { ActiveJobCard } from './ActiveJobCard';

export function UpdatesPage(): ReactNode {
  const { t } = useTranslation();
  const live = useLive();
  const [detail, setDetail] = useState<UpdateJob | null>(null);

  // Se llega aqui desde el indicador de una fila concreta, asi que hay que
  // llevar al usuario a ESE trabajo y no dejarlo buscandolo en la lista.
  const [params, setParams] = useSearchParams();
  const focusId = Number(params.get('job')) || null;

  const { data: jobsData, isLoading } = useQuery({ queryKey: ['jobs'], queryFn: () => api.jobs() });
  const { data: runsData } = useQuery({ queryKey: ['runs'], queryFn: () => api.checkRuns() });

  const runs = runsData?.runs ?? [];

  /**
   * Se fusiona el historial de la consulta con lo que llega por SSE.
   *
   * Los eventos son siempre más recientes que la consulta: traen cada línea de
   * log conforme se produce. Sin esta fusión, el trabajo en curso se vería
   * congelado en el estado que tuviera al cargar la página.
   */
  const jobs = useMemo(() => {
    const merged = new Map<number, UpdateJob>();
    for (const job of jobsData?.jobs ?? []) merged.set(job.id, job);
    for (const [id, job] of live.jobs) merged.set(id, job);
    return [...merged.values()].sort((a, b) => b.id - a.id);
  }, [jobsData?.jobs, live.jobs]);

  const active = useMemo(
    () => jobs.filter((job) => job.status === 'running' || job.status === 'queued'),
    [jobs],
  );
  const history = useMemo(
    () => jobs.filter((job) => job.status !== 'running' && job.status !== 'queued'),
    [jobs],
  );

  /**
   * Lleva el trabajo señalado a la vista y lo resalta un momento.
   *
   * Se espera a que `jobs` tenga contenido: al entrar directamente por la URL,
   * el elemento todavía no existe en el DOM cuando se monta el componente.
   * El parámetro se limpia después para que al recargar no vuelva a saltar.
   */
  useEffect(() => {
    if (!focusId || jobs.length === 0) return;

    const element = document.getElementById(`job-${focusId}`);
    if (!element) return;

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.add('cu-highlight');
    const timer = setTimeout(() => element.classList.remove('cu-highlight'), 2200);

    setParams({}, { replace: true });
    return () => clearTimeout(timer);
  }, [focusId, jobs.length, setParams]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t('updates.title')}</h1>
        {active.length > 1 ? (
          <Badge tone="info">{t('updates.queuePosition', { count: active.length - 1 })}</Badge>
        ) : null}
      </div>

      {/* En curso y en cola. Solo aparece cuando hay algo, para no dejar un
          hueco vacío permanente en la pantalla. */}
      {active.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-[0.8125rem] font-semibold text-[var(--text-muted)]">
            {t('updates.inProgress')}
          </h2>
          {active.map((job) => (
            <div key={job.id} id={`job-${job.id}`} className="rounded-[var(--radius)]">
              <ActiveJobCard job={job} />
            </div>
          ))}
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-[0.8125rem] font-semibold text-[var(--text-muted)]">
          {t('updates.history')}
        </h2>

        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-14 w-full" />
            ))}
          </div>
        ) : history.length === 0 ? (
          <Card>
            <EmptyState icon={<IconUpdates size={30} />} title={t('common.empty')} />
          </Card>
        ) : (
          <ul className="space-y-2">
            {history.map((job) => (
              <li key={job.id} id={`job-${job.id}`} className="cu-list-row rounded-[var(--radius)]">
                <Card className="p-3">
                  <button
                    type="button"
                    onClick={() => setDetail(job)}
                    className="flex w-full items-center gap-3 text-left"
                  >
                    <Badge tone={JOB_STATUS_TONE[job.status]}>{t(JOB_STATUS_LABEL[job.status])}</Badge>

                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[0.8125rem]">
                        {displayImage(job.imageRef)}
                      </p>
                      <p className="mt-0.5 text-[0.6875rem] text-[var(--text-muted)]">
                        {t(job.mode === 'force' ? 'updates.modeForce' : 'updates.modeUpdate')}
                        {' · '}
                        {t(
                          job.trigger === 'auto'
                            ? 'updates.triggerAuto'
                            : job.trigger === 'telegram'
                              ? 'updates.triggerTelegram'
                              : 'updates.triggerManual',
                        )}
                        {job.containerName ? ` · ${job.containerName}` : ''}
                      </p>
                    </div>

                    <div className="shrink-0 text-right text-[0.6875rem] text-[var(--text-muted)]">
                      <p>{formatRelative(job.startedAt ?? job.finishedAt)}</p>
                      {job.startedAt && job.finishedAt ? (
                        <p>{formatDuration((job.finishedAt - job.startedAt) / 1000)}</p>
                      ) : null}
                    </div>
                  </button>

                  {job.status === 'rolled-back' ? (
                    <p className="mt-2 rounded-[var(--radius-sm)] bg-[var(--warn-soft)] px-2.5 py-1.5 text-[0.6875rem] text-[var(--warn)]">
                      {t('updates.rolledBackNotice')}
                    </p>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-[0.8125rem] font-semibold text-[var(--text-muted)]">
          {t('updates.checkRuns')}
        </h2>
        {runs.length === 0 ? (
          <Card>
            <EmptyState title={t('common.empty')} />
          </Card>
        ) : (
          <Card className="divide-y divide-[var(--border)]">
            {runs.slice(0, 12).map((run) => (
              <div key={run.id} className="flex items-center gap-3 px-3 py-2 text-[0.8125rem]">
                <Badge tone={run.status === 'ok' ? 'ok' : run.status === 'failed' ? 'danger' : 'info'}>
                  {run.status}
                </Badge>
                <span className="flex-1 text-[var(--text-muted)]">
                  {formatDateTime(run.startedAt)}
                </span>
                <span className="tabular-nums text-[0.75rem] text-[var(--text-muted)]">
                  {run.imagesChecked} {t('updates.imagesChecked').toLowerCase()}
                </span>
                {run.updatesFound > 0 ? (
                  <Badge tone="accent">{run.updatesFound}</Badge>
                ) : null}
                {run.errors > 0 ? <Badge tone="danger">{run.errors}</Badge> : null}
              </div>
            ))}
          </Card>
        )}
      </section>

      {detail ? (
        <Modal
          open
          onOpenChange={(open) => !open && setDetail(null)}
          wide
          title={displayImage(detail.imageRef)}
          description={`${t('updates.job')} #${detail.id}`}
          footer={
            <Button variant="primary" onClick={() => setDetail(null)}>
              {t('common.close')}
            </Button>
          }
        >
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge tone={JOB_STATUS_TONE[detail.status]}>{t(JOB_STATUS_LABEL[detail.status])}</Badge>
              <Badge>{detail.strategy}</Badge>
              <Badge>{detail.mode}</Badge>
            </div>

            {detail.error ? (
              <p className="rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-[0.8125rem] text-[var(--danger)]">
                {detail.error}
              </p>
            ) : null}

            <pre className="max-h-[45vh] overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-inset)] p-3 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap break-all">
              {detail.log || t('common.empty')}
            </pre>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
