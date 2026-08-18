import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { UnusedVolume } from '@cu/shared';
import { api } from '@/api/client';
import { Badge, Button, Card, Modal, SectionTitle, Skeleton, useToast } from '@/components/ui';
import { formatBytes, formatRelative } from '@/lib/format';
import { IconDatabase, IconTrash } from '@/components/icons';

/**
 * Espacio en disco.
 *
 * La diferencia de trato con las imagenes es deliberada y se nota en la
 * interfaz: las imagenes tienen borrado en la propia lista, y aqui cada volumen
 * exige abrir un dialogo que dice lo que se pierde. Una imagen borrada se vuelve
 * a descargar; un volumen borrado son datos que no vuelven, y "no lo usa nadie"
 * puede significar simplemente que lo paraste en marzo.
 *
 * Por el mismo motivo no hay ningun boton de "limpiar todos los volumenes".
 */
export function StorageSection(): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<UnusedVolume | null>(null);
  const [open, setOpen] = useState(false);

  const storage = useQuery({
    queryKey: ['storage'],
    queryFn: () => api.storage(),
    // Solo se pide al desplegar la seccion: el daemon recorre el disco para
    // calcularlo y puede tardar segundos.
    enabled: open,
  });

  const removeVolume = useMutation({
    mutationFn: (name: string) => api.deleteVolume(name),
    onSuccess: () => {
      notify(t('storage.volumeDeleted'), 'ok');
      setConfirm(null);
      void queryClient.invalidateQueries({ queryKey: ['storage'] });
    },
    onError: () => notify(t('common.error'), 'danger'),
  });

  const prune = useMutation({
    mutationFn: () => api.pruneBuildCache(),
    onSuccess: (result) => {
      notify(t('storage.cachePruned', { size: formatBytes(result.freed) }), 'ok');
      void queryClient.invalidateQueries({ queryKey: ['storage'] });
    },
    onError: () => notify(t('common.error'), 'danger'),
  });

  const usage = storage.data?.usage;

  return (
    <Card className="p-5">
      <SectionTitle
        title={t('storage.title')}
        action={
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
            {open ? t('common.close') : t('storage.analyze')}
          </Button>
        }
      />

      {!open ? (
        <p className="text-[0.8125rem] text-[var(--text-muted)]">{t('storage.help')}</p>
      ) : storage.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-52" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : !usage ? (
        <p className="text-[0.8125rem] text-[var(--text-muted)]">{t('common.error')}</p>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <UsageRow
              label={t('nav.images')}
              total={usage.images.total}
              reclaimable={usage.images.reclaimable}
              count={usage.images.count}
            />
            <UsageRow
              label={t('nav.containers')}
              total={usage.containers.total}
              reclaimable={null}
              count={usage.containers.count}
            />
            <UsageRow
              label={t('storage.volumes')}
              total={usage.volumes.total}
              reclaimable={usage.volumes.reclaimable}
              count={usage.volumes.count}
            />
            <UsageRow
              label={t('storage.buildCache')}
              total={usage.buildCache.total}
              reclaimable={usage.buildCache.reclaimable}
              count={usage.buildCache.count}
            />
          </div>

          {usage.partial ? (
            <p className="text-[0.75rem] text-[var(--text-muted)]">{t('storage.partial')}</p>
          ) : null}

          {usage.buildCache.reclaimable > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              loading={prune.isPending}
              onClick={() => prune.mutate()}
            >
              {t('storage.pruneCache', { size: formatBytes(usage.buildCache.reclaimable) })}
            </Button>
          ) : null}

          <div>
            <p className="mb-2 text-[0.8125rem] font-medium">{t('storage.unusedVolumes')}</p>
            {usage.unusedVolumes.length === 0 ? (
              <p className="text-[0.8125rem] text-[var(--text-muted)]">{t('storage.noUnused')}</p>
            ) : (
              <>
                <p className="mb-2 text-[0.75rem] text-[var(--text-muted)]">
                  {t('storage.unusedWarning')}
                </p>
                <ul className="space-y-1.5">
                  {usage.unusedVolumes.map((volume) => (
                    <li
                      key={volume.name}
                      className="flex min-w-0 items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--bg-inset)] px-3 py-2"
                    >
                      <IconDatabase size={14} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[0.75rem]">{volume.name}</p>
                        <p className="text-[0.6875rem] text-[var(--text-muted)]">
                          {volume.sizeBytes === null
                            ? t('storage.sizeUnknown')
                            : formatBytes(volume.sizeBytes)}
                          {volume.createdAt ? ` · ${formatRelative(volume.createdAt)}` : ''}
                        </p>
                      </div>
                      {volume.projectName ? (
                        <Badge tone="neutral">{volume.projectName}</Badge>
                      ) : null}
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t('common.delete')}
                        onClick={() => setConfirm(volume)}
                      >
                        <IconTrash size={15} />
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}

      {confirm ? (
        <Modal
          open
          onOpenChange={(value) => !value && setConfirm(null)}
          title={t('storage.deleteVolume')}
          description={confirm.name}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                loading={removeVolume.isPending}
                onClick={() => removeVolume.mutate(confirm.name)}
              >
                {t('common.delete')}
              </Button>
            </>
          }
        >
          <div className="space-y-2 text-[0.8125rem]">
            <p>{t('storage.deleteVolumeWarning')}</p>
            {confirm.projectName ? (
              <p className="text-[var(--text-muted)]">
                {t('storage.volumeFromProject', { project: confirm.projectName })}
              </p>
            ) : null}
            <p className="rounded-[var(--radius-sm)] border border-[var(--danger)] px-3 py-2 text-[0.75rem]">
              {t('storage.deleteVolumeIrreversible')}
            </p>
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}

function UsageRow({
  label,
  total,
  reclaimable,
  count,
}: {
  label: string;
  total: number;
  /** null cuando el concepto no aplica, que no es lo mismo que cero. */
  reclaimable: number | null;
  count: number;
}): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 rounded-[var(--radius-sm)] bg-[var(--bg-inset)] px-3 py-2">
      <p className="text-[0.75rem] text-[var(--text-muted)]">
        {label} ({count})
      </p>
      <p className="font-medium">{formatBytes(total)}</p>
      {reclaimable !== null && reclaimable > 0 ? (
        <p className="text-[0.6875rem] text-[var(--text-muted)]">
          {t('storage.reclaimable', { size: formatBytes(reclaimable) })}
        </p>
      ) : null}
    </div>
  );
}
