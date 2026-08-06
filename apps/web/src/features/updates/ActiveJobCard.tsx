import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { UpdateJob } from '@cu/shared';
import { api, ApiError } from '@/api/client';
import { Badge, Banner, Button, Card, ConfirmDialog, Spinner, cx, useToast } from '@/components/ui';
import { IconClose } from '@/components/icons';
import { displayImage, formatDuration } from '@/lib/format';
import { JOB_STATUS_LABEL, JOB_STATUS_TONE } from '@/lib/labels';

/** A partir de aquí se avisa de que el trabajo lleva demasiado. */
const SLOW_AFTER_SECONDS = 10 * 60;

/**
 * Trabajo en curso con su salida en vivo.
 *
 * La salida llega por SSE línea a línea. El contenedor hace autoscroll salvo
 * que el usuario suba a leer algo: arrancarle la vista al final cada vez que
 * llega una línea haría imposible revisar un error mientras el trabajo sigue.
 */
export function ActiveJobCard({ job }: { job: UpdateJob }): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();
  const preRef = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const running = job.status === 'running';
  const queued = job.status === 'queued';

  // Cronómetro. Se recalcula desde startedAt en vez de acumular, así una
  // pestaña que estuvo en segundo plano no muestra un tiempo por debajo del real.
  useEffect(() => {
    if (!running || !job.startedAt) return;
    const tick = () => setElapsed(Math.floor((Date.now() - job.startedAt!) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running, job.startedAt]);

  // useLayoutEffect y no useEffect: desplazar después del pintado produce un
  // parpadeo visible en cada línea nueva.
  useLayoutEffect(() => {
    if (!follow || !preRef.current) return;
    preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [job.log, follow]);

  const cancel = useMutation({
    mutationFn: () => api.cancelJob(job.id),
    onSuccess: () => {
      notify(t('updates.cancelRequested'), 'info');
      setConfirmCancel(false);
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error) => {
      // El servidor explica por qué no se puede: se muestra tal cual en vez de
      // un "error" genérico que no ayuda a decidir qué hacer.
      const payload = error instanceof ApiError ? (error.payload as { reason?: string }) : undefined;
      notify(payload?.reason ?? t('common.error'), 'danger');
      setConfirmCancel(false);
    },
  });

  const slow = running && elapsed > SLOW_AFTER_SECONDS;

  return (
    <>
      <Card className="overflow-hidden" glow={running}>
        <div className="flex flex-wrap items-center gap-3 p-4">
          {running ? (
            <Spinner className="size-4 text-[var(--accent)]" />
          ) : (
            <span className="size-4 shrink-0 rounded-full border-2 border-dashed border-[var(--text-faint)]" />
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-mono text-[0.8125rem] font-medium">
                {displayImage(job.imageRef)}
              </span>
              <Badge tone={JOB_STATUS_TONE[job.status]} dot={running}>
                {t(queued ? 'updates.waiting' : JOB_STATUS_LABEL[job.status])}
              </Badge>
              <Badge>{job.strategy}</Badge>
              {job.mode === 'force' ? <Badge tone="warn">{t('updates.modeForce')}</Badge> : null}
            </div>

            <p className="mt-0.5 text-[0.6875rem] text-[var(--text-muted)]">
              {job.containerName ? `${job.containerName} · ` : ''}
              {running && job.startedAt
                ? t('updates.elapsed', { value: formatDuration(elapsed) })
                : t('updates.queued')}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {/* Solo tiene sentido con salida que seguir. El nombre dice lo que
                hace de verdad: no abre nada, mantiene la vista abajo. */}
            {running && job.log ? (
              <Button
                size="sm"
                variant={follow ? 'subtle' : 'ghost'}
                onClick={() => setFollow((value) => !value)}
                aria-pressed={follow}
              >
                {follow ? t('updates.autoScrollOn') : t('updates.autoScrollOff')}
              </Button>
            ) : null}

            <Button
              size="sm"
              variant="ghost"
              icon={<IconClose size={14} />}
              loading={cancel.isPending}
              onClick={() => setConfirmCancel(true)}
            >
              {t('updates.cancel')}
            </Button>
          </div>
        </div>

        {/* Un trabajo que lleva demasiado casi nunca se arregla solo. Se dice
            cuánto lleva y qué se puede hacer, en vez de dejar el spinner
            girando indefinidamente sin más información. */}
        {slow ? (
          <div className="px-4 pb-3">
            <Banner tone="warn" title={t('updates.takingLong')}>
              {t('updates.takingLongHelp')}
            </Banner>
          </div>
        ) : null}

        {job.log ? (
          <div className="border-t border-[var(--border)]">
            <div className="flex items-center justify-between px-4 pt-2.5 pb-1">
              <span className="text-[0.6875rem] font-medium text-[var(--text-muted)]">
                {t('updates.liveOutput')}
              </span>
              <span className="text-[0.625rem] text-[var(--text-faint)] tabular-nums">
                {job.log.trim().split('\n').length} {t('updates.lines')}
              </span>
            </div>
            <pre
              ref={preRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                const atBottom =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 40;
                // Volver al final reactiva el seguimiento, sin tener que pulsar
                // el botón.
                if (atBottom !== follow) setFollow(atBottom);
              }}
              className={cx(
                'max-h-72 overflow-auto px-4 pb-4 font-mono text-[0.6875rem] leading-relaxed',
                'whitespace-pre-wrap break-all text-[var(--text-muted)]',
              )}
            >
              {job.log}
            </pre>
          </div>
        ) : (
          // Sin salida todavía. Decirlo es mejor que dejar un hueco que parece
          // que algo no ha cargado.
          <p className="border-t border-[var(--border)] px-4 py-3 text-[0.75rem] text-[var(--text-faint)]">
            {t('updates.noOutputYet')}
          </p>
        )}
      </Card>

      {confirmCancel ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmCancel(false)}
          title={t('updates.cancel')}
          description={t('updates.confirmCancel', { ref: displayImage(job.imageRef) })}
          confirmLabel={t('updates.cancel')}
          cancelLabel={t('common.close')}
          danger
          loading={cancel.isPending}
          onConfirm={() => cancel.mutate()}
        />
      ) : null}
    </>
  );
}
