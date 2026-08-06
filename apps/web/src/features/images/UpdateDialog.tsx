import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { RecreateScope, TrackedImage } from '@cu/shared';
import { api, ApiError } from '@/api/client';
import { useLive } from '@/hooks/LiveContext';
import { Badge, Banner, Button, Modal, Select, Switch, Field } from '@/components/ui';
import { displayImage } from '@/lib/format';
import { STRATEGY_HELP, STRATEGY_LABEL, STRATEGY_TONE } from '@/lib/labels';

/**
 * Confirmacion y seguimiento de una actualizacion.
 *
 * El dialogo se queda abierto durante el trabajo y muestra el log que llega por
 * SSE: una actualizacion puede tardar minutos y cerrar el dialogo dejaria al
 * usuario sin saber si algo esta pasando.
 */
export function UpdateDialog({
  image,
  force,
  onClose,
  onDone,
}: {
  image: TrackedImage;
  force: boolean;
  onClose: () => void;
  onDone: (message: string, tone: 'ok' | 'danger' | 'info') => void;
}): ReactNode {
  const { t } = useTranslation();
  const live = useLive();
  const logRef = useRef<HTMLPreElement>(null);

  const [scope, setScope] = useState<RecreateScope>(image.policy.recreateScope);
  const [removeFirst, setRemoveFirst] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: planData, isLoading: planLoading } = useQuery({
    queryKey: ['plan', image.ref],
    queryFn: () => api.imagePlan(image.ref),
  });
  const plan = planData?.plan;

  const job = live.activeJob?.imageRef === image.ref ? live.activeJob : null;

  // El log se autodesplaza mientras corre para que la ultima linea sea visible.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.log]);

  const update = useMutation({
    mutationFn: () =>
      api.updateImage(image.ref, {
        mode: force ? 'force' : 'update',
        scope,
        removeImageFirst: force ? removeFirst : false,
        targetTag: image.candidateTag ?? undefined,
      }),
    onMutate: () => {
      setRunning(true);
      setError(null);
    },
    onSuccess: () => {
      setRunning(false);
      onDone(t('updates.statusSuccess'), 'ok');
      onClose();
    },
    onError: (caught) => {
      setRunning(false);
      if (caught instanceof ApiError) {
        // Cada codigo tiene su explicacion: un "conflicto" generico no le dice
        // al usuario si debe esperar, cambiar de sitio o rendirse.
        const messages: Record<string, string> = {
          'self-update-rejected': t('errors.selfUpdateRejected'),
          'update-in-progress': t('errors.updateInProgress'),
          'recreate-unsupported': t('projects.strategyUnsupportedHelp'),
          'rolled-back': t('updates.rolledBackNotice'),
        };
        const message = messages[caught.code] ?? t('common.error');
        setError(message);
        if (caught.code === 'rolled-back') onDone(message, 'danger');
        return;
      }
      setError(t('common.error'));
    },
  });

  const unsupported = plan?.strategy === 'unsupported';
  const isSelf = plan?.reason === 'self';

  return (
    <Modal
      open
      onOpenChange={(open) => {
        // Cerrar el dialogo a media actualizacion no la cancela, y dar esa
        // impresion seria peor que impedirlo.
        if (!open && !running) onClose();
      }}
      wide={Boolean(job)}
      title={force ? t('images.force') : t('images.update')}
      description={displayImage(image.ref)}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={running}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={force ? 'danger' : 'primary'}
            loading={running}
            disabled={unsupported || planLoading}
            onClick={() => update.mutate()}
          >
            {force ? t('images.force') : t('images.update')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {isSelf ? (
          <Banner tone="warn" title={t('containers.self')}>
            {t('errors.selfUpdateRejected')}
          </Banner>
        ) : unsupported ? (
          <Banner tone="warn" title={t('projects.strategyUnsupported')}>
            {plan?.reason ?? t('projects.strategyUnsupportedHelp')}
          </Banner>
        ) : plan ? (
          <div className="flex items-start gap-2 text-[0.8125rem]">
            <Badge tone={STRATEGY_TONE[plan.strategy]}>{t(STRATEGY_LABEL[plan.strategy])}</Badge>
            <p className="text-[var(--text-muted)] leading-snug">{t(STRATEGY_HELP[plan.strategy])}</p>
          </div>
        ) : null}

        {!unsupported ? (
          <>
            <p className="text-[0.8125rem] text-[var(--text-muted)]">
              {t(force ? 'images.confirmForce' : 'images.confirmUpdate', {
                name: plan?.containerName ?? displayImage(image.ref),
              })}
            </p>

            {image.candidateTag ? (
              <Banner tone="info" title={t('images.newVersionAvailable', { tag: image.candidateTag })} />
            ) : null}

            <Field label={t('images.recreateScope')} hint={t(`images.recreateScope${scope === 'service' ? 'Service' : 'Project'}Help`)}>
              <Select
                value={scope}
                onChange={(event) => setScope(event.target.value as RecreateScope)}
                disabled={running}
              >
                <option value="service">{t('images.recreateScopeService')}</option>
                <option value="project">{t('images.recreateScopeProject')}</option>
              </Select>
            </Field>

            {force ? (
              <div className="rounded-[var(--radius-sm)] border border-[var(--border)] px-3">
                <Switch
                  checked={removeFirst}
                  onCheckedChange={setRemoveFirst}
                  disabled={running}
                  label={t('images.removeImageOnForce')}
                  hint={t('images.removeImageOnForceWarning')}
                />
              </div>
            ) : null}

            {removeFirst ? (
              <Banner tone="danger" title={t('images.removeImageOnForce')}>
                {t('images.removeImageOnForceWarning')}
              </Banner>
            ) : null}
          </>
        ) : null}

        {error ? <Banner tone="danger" title={error} /> : null}

        {job ? (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[0.75rem] font-medium">{t('updates.viewLog')}</span>
              <Badge tone={job.status === 'running' ? 'info' : 'neutral'}>{job.status}</Badge>
            </div>
            <pre
              ref={logRef}
              className="max-h-56 overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-inset)] p-3 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap break-all"
            >
              {job.log || t('common.loading')}
            </pre>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
