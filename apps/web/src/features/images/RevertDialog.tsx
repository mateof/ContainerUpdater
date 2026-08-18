import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { api } from '@/api/client';
import { Button, Modal, useToast } from '@/components/ui';
import { displayImage, formatDateTime } from '@/lib/format';

/**
 * Confirmacion de la vuelta a la version anterior.
 *
 * El aviso sobre los datos no es un adorno legal: revertir la imagen NO revierte
 * lo que la version nueva le hizo a su base de datos. Para un proxy o un
 * frontend da igual; despues de que Immich o Paperless migren su esquema, la
 * version vieja puede no saber leerlo. Quien pulsa esto tiene que haberlo leido.
 */
export function RevertDialog({
  imageRef,
  onClose,
  onDone,
}: {
  imageRef: string;
  onClose: () => void;
  onDone: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();

  const point = useQuery({
    queryKey: ['rollback', imageRef],
    queryFn: () => api.rollbackPoint(imageRef),
  });

  const revert = useMutation({
    mutationFn: () => api.revertImage(imageRef),
    onSuccess: () => {
      notify(t('images.revertStarted'), 'ok');
      onDone();
      onClose();
    },
    onError: () => notify(t('common.error'), 'danger'),
  });

  const target = point.data?.point ?? null;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('images.revert')}
      description={displayImage(imageRef)}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            loading={revert.isPending}
            disabled={!target}
            onClick={() => revert.mutate()}
          >
            {t('images.revertConfirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[0.8125rem]">
        {point.isLoading ? (
          <p className="text-[var(--text-muted)]">{t('common.loading')}</p>
        ) : !target ? (
          <p className="text-[var(--text-muted)]">{t('images.revertNoPoint')}</p>
        ) : (
          <>
            <p>{t('images.revertExplain', { when: formatDateTime(target.appliedAt) })}</p>

            <div className="rounded-[var(--radius-sm)] bg-[var(--bg-inset)] px-3 py-2">
              <p className="text-[0.75rem] text-[var(--text-muted)]">{t('images.revertTarget')}</p>
              <p className="mt-0.5 font-mono text-[0.6875rem] break-all">{target.digests[0]}</p>
            </div>

            {/* Lo importante de este dialogo. */}
            <p className="rounded-[var(--radius-sm)] border border-[var(--warn)] px-3 py-2 text-[0.75rem]">
              {t('images.revertDataWarning')}
            </p>

            <p className="text-[0.75rem] text-[var(--text-muted)]">
              {t('images.revertIgnoreNote')}
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
