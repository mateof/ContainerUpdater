import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { UpdateJob } from '@cu/shared';
import { Badge, Button, Card, Spinner, cx } from '@/components/ui';
import { displayImage, formatDuration } from '@/lib/format';
import { JOB_STATUS_LABEL, JOB_STATUS_TONE } from '@/lib/labels';

/**
 * Trabajo en curso con su salida en vivo.
 *
 * La salida llega por SSE línea a línea. El contenedor hace autoscroll salvo
 * que el usuario suba a leer algo: arrancarle la vista al final cada vez que
 * llega una línea haría imposible revisar un error mientras el trabajo sigue.
 */
export function ActiveJobCard({ job }: { job: UpdateJob }): ReactNode {
  const { t } = useTranslation();
  const preRef = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const [elapsed, setElapsed] = useState(0);

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

  return (
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

        {running ? (
          <Button
            size="sm"
            variant={follow ? 'subtle' : 'ghost'}
            onClick={() => setFollow((value) => !value)}
          >
            {t('updates.followOutput')}
          </Button>
        ) : null}
      </div>

      {job.log ? (
        <div className="border-t border-[var(--border)]">
          <div className="flex items-center justify-between px-4 pt-2.5 pb-1">
            <span className="text-[0.6875rem] font-medium text-[var(--text-muted)]">
              {t('updates.liveOutput')}
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
      ) : null}
    </Card>
  );
}
