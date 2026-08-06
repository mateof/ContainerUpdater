import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { api } from '@/api/client';
import { Badge, Banner, Button, Modal, Spinner } from '@/components/ui';
import { STRATEGY_HELP, STRATEGY_LABEL, STRATEGY_TONE } from '@/lib/labels';

type Phase = 'confirm' | 'starting' | 'waiting' | 'back' | 'timeout';

/** Cada cuánto se comprueba si el panel ha vuelto. */
const POLL_MS = 2000;
/** A partir de aquí se deja de esperar y se manda al usuario a mirar el log. */
const TIMEOUT_MS = 180_000;

/**
 * Auto-actualización de la propia aplicación.
 *
 * Es distinta al resto: el panel desaparece a mitad de la operación, así que no
 * hay progreso que mostrar en vivo. Lo que se hace es sondear hasta que vuelve
 * a responder, que es la única señal fiable de que ha ido bien.
 */
export function SelfUpdateDialog({ onClose }: { onClose: () => void }): ReactNode {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('confirm');

  const { data, isLoading } = useQuery({
    queryKey: ['self-update-plan'],
    queryFn: () => api.selfUpdatePlan(),
  });
  const plan = data?.plan;

  const start = useMutation({
    mutationFn: () => api.selfUpdate(),
    onMutate: () => setPhase('starting'),
    onSuccess: () => setPhase('waiting'),
    // Un fallo de red aquí no significa que haya fallado: puede que el servidor
    // se haya parado justo después de aceptar. Se pasa a esperar igualmente.
    onError: () => setPhase('waiting'),
  });

  // Sondeo hasta que el panel responde otra vez.
  useEffect(() => {
    if (phase !== 'waiting') return;

    const deadline = Date.now() + TIMEOUT_MS;
    let cancelled = false;

    const poll = async (): Promise<void> => {
      if (cancelled) return;

      if (Date.now() > deadline) {
        setPhase('timeout');
        return;
      }

      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        if (response.ok && !cancelled) {
          setPhase('back');
          // Recarga completa: el JavaScript en memoria es el de la versión
          // anterior y sus assets con hash ya no existen en el servidor nuevo.
          setTimeout(() => window.location.reload(), 1500);
          return;
        }
      } catch {
        // Esperado mientras el contenedor no existe.
      }
      setTimeout(() => void poll(), POLL_MS);
    };

    // Margen inicial: durante los primeros segundos el panel viejo todavía
    // responde y daríamos por bueno un reinicio que no ha ocurrido.
    const first = setTimeout(() => void poll(), 6000);
    return () => {
      cancelled = true;
      clearTimeout(first);
    };
  }, [phase]);

  const busy = phase === 'starting' || phase === 'waiting';

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={t('settings.selfUpdateTitle')}
      description={plan?.imageRef ?? undefined}
      footer={
        phase === 'confirm' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={start.isPending}
              disabled={isLoading || !plan?.possible}
              onClick={() => start.mutate()}
            >
              {t('settings.selfUpdateConfirm')}
            </Button>
          </>
        ) : phase === 'timeout' ? (
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t('common.retry')}
          </Button>
        ) : null
      }
    >
      {phase === 'confirm' ? (
        <div className="space-y-4">
          {isLoading ? (
            <Spinner />
          ) : !plan?.possible ? (
            <Banner tone="warn" title={t('errors.selfUpdateRejected')}>
              {plan?.reason}
            </Banner>
          ) : (
            <>
              <div className="flex items-start gap-2 text-[0.8125rem]">
                <Badge tone={STRATEGY_TONE[plan.strategy]}>{t(STRATEGY_LABEL[plan.strategy])}</Badge>
                <p className="text-[var(--text-muted)] leading-snug">
                  {t(STRATEGY_HELP[plan.strategy])}
                </p>
              </div>

              <Banner tone="warn" title={t('settings.selfUpdateWarningTitle')}>
                {t('settings.selfUpdateWarning')}
              </Banner>

              {/* Aviso específico de Compose: ahí no hay vuelta atrás. Se dice
                  antes de pulsar, no después de que falle. */}
              {plan.warning ? <Banner tone="danger" title={plan.warning} /> : null}
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          {phase === 'back' ? (
            <>
              <span className="text-2xl">✅</span>
              <p className="font-medium">{t('settings.selfUpdateDone')}</p>
            </>
          ) : phase === 'timeout' ? (
            <>
              <span className="text-2xl">⚠️</span>
              <p className="font-medium">{t('settings.selfUpdateTimeout')}</p>
              <p className="text-[0.8125rem] text-[var(--text-muted)] max-w-sm">
                {t('settings.selfUpdateTimeoutHelp')}
              </p>
            </>
          ) : (
            <>
              <Spinner className="size-6 text-[var(--accent)]" />
              <p className="font-medium">{t('settings.selfUpdateWaiting')}</p>
              <p className="text-[0.8125rem] text-[var(--text-muted)] max-w-sm">
                {t('settings.selfUpdateWaitingHelp')}
              </p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
