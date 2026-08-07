import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { TrackedImage, UpdateJob } from '@cu/shared';
import { api, ApiError } from '@/api/client';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Menu,
  Skeleton,
  Tooltip,
  cx,
  useToast,
} from '@/components/ui';
import { IconCheck, IconDownload, IconImage, IconMore, IconRefresh } from '@/components/icons';
import { CrossLink, FilterPills, FocusBanner, SearchBox } from '@/components/Filters';
import { displayImage, formatBytes, formatRelative, shortDigest } from '@/lib/format';
import { IMAGE_USAGE_LABEL, IMAGE_USAGE_TONE, UPDATE_STATUS_LABEL, UPDATE_STATUS_TONE } from '@/lib/labels';
import { ImageDetailDialog } from './ImageDetailDialog';
import { UpdateDialog } from './UpdateDialog';
import { SelfUpdateDialog } from './SelfUpdateDialog';
import { JobIndicator } from '@/components/JobIndicator';
import { useLive } from '@/hooks/LiveContext';

type Filter = 'all' | 'updates' | 'auto' | 'unknown' | 'stopped' | 'orphan';

export function ImagesPage(): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();
  const live = useLive();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [detail, setDetail] = useState<TrackedImage | null>(null);
  const [updateTarget, setUpdateTarget] = useState<{ image: TrackedImage; force: boolean } | null>(
    null,
  );
  const [selfUpdate, setSelfUpdate] = useState(false);

  const { data: statusData } = useQuery({ queryKey: ['status'], queryFn: () => api.status() });
  const { data: containersData } = useQuery({
    queryKey: ['containers'],
    queryFn: () => api.containers(),
  });

  const { data, isLoading } = useQuery({ queryKey: ['images'], queryFn: () => api.images() });
  const images = data?.images ?? [];

  /**
   * Referencia de la imagen con la que corre la propia aplicacion. Actualizarla
   * no es un update normal: hace falta el ayudante que sobrevive al reinicio,
   * asi que se enruta a un dialogo distinto.
   */
  const selfImageRef = useMemo(() => {
    const selfId = statusData?.selfContainerId;
    if (!selfId) return null;
    const own = containersData?.containers.find((container) => container.id === selfId);
    if (!own) return null;
    return images.find((image) => image.inUseBy.includes(own.name))?.ref ?? null;
  }, [statusData?.selfContainerId, containersData?.containers, images]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['images'] });
    void queryClient.invalidateQueries({ queryKey: ['status'] });
  };

  const checkOne = useMutation({
    mutationFn: (ref: string) => api.checkImage(ref),
    onSuccess: invalidate,
    onError: () => notify(t('common.error'), 'danger'),
  });

  const toggleAuto = useMutation({
    mutationFn: ({ ref, value }: { ref: string; value: boolean }) =>
      api.savePolicy(ref, { autoUpdate: value }),
    // Actualizacion optimista: el interruptor responde al instante y se
    // revierte solo si el servidor rechaza el cambio.
    onMutate: async ({ ref, value }) => {
      await queryClient.cancelQueries({ queryKey: ['images'] });
      const previous = queryClient.getQueryData<{ images: TrackedImage[] }>(['images']);
      queryClient.setQueryData<{ images: TrackedImage[] }>(['images'], (current) =>
        current
          ? {
              images: current.images.map((image) =>
                image.ref === ref
                  ? { ...image, policy: { ...image.policy, autoUpdate: value } }
                  : image,
              ),
            }
          : current,
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['images'], context.previous);
      notify(t('common.error'), 'danger');
    },
    onSuccess: (_data, variables) => {
      notify(
        t(variables.value ? 'images.autoUpdateOn' : 'images.autoUpdateOff', {
          ref: displayImage(variables.ref),
        }),
        'ok',
      );
    },
    onSettled: invalidate,
  });

  /**
   * Foco desde otra pantalla: se llega pulsando la imagen de un contenedor.
   *
   * Se filtra por referencia exacta en vez de resaltar la fila: con veinte
   * imagenes, resaltar una obliga a buscarla igualmente.
   */
  const [confirmDelete, setConfirmDelete] = useState<TrackedImage | null>(null);

  const remove = useMutation({
    mutationFn: ({ ref, force }: { ref: string; force: boolean }) => api.deleteImage(ref, force),
    onSuccess: () => {
      notify(t('images.deleted'), 'ok');
      setConfirmDelete(null);
      invalidate();
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : '';
      const messages: Record<string, string> = {
        'image-in-use': t('images.deleteInUse'),
        'needs-force': t('images.deleteNeedsForce'),
      };
      notify(messages[code] ?? t('common.error'), 'danger');
    },
  });

  const [params, setParams] = useSearchParams();
  const focusRef = params.get('ref');
  const clearFocus = (): void => setParams({}, { replace: true });

  const focused = useMemo(
    () => (focusRef ? images.filter((image) => image.ref === focusRef) : images),
    [images, focusRef],
  );

  const matches = (image: TrackedImage, which: Filter): boolean => {
    switch (which) {
      case 'updates':
        return image.status === 'update-available';
      case 'auto':
        return image.policy.autoUpdate;
      case 'unknown':
        return image.status === 'unknown' || image.status === 'error';
      case 'stopped':
        return image.usage === 'stopped';
      case 'orphan':
        return image.usage === 'orphan';
      default:
        return true;
    }
  };

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return focused.filter((image) => {
      if (
        needle &&
        !image.ref.toLowerCase().includes(needle) &&
        !image.inUseBy.some((name) => name.toLowerCase().includes(needle))
      ) {
        return false;
      }
      return matches(image, filter);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, search, filter]);

  const options = useMemo(
    () =>
      (
        [
          ['all', 'images.filterAll'],
          ['updates', 'images.filterUpdates'],
          ['auto', 'images.filterAuto'],
          ['unknown', 'images.filterUnknown'],
          ['stopped', 'images.filterStopped'],
          ['orphan', 'images.filterOrphan'],
        ] as const
      ).map(([key, label]) => ({
        key,
        label: t(label),
        count: focused.filter((image) => matches(image, key)).length,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focused, t],
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t('images.title')}</h1>
        <SearchBox value={search} onChange={setSearch} placeholder={t('images.searchHint')} />
      </header>

      {focusRef ? (
        <FocusBanner label={t('images.focusRef')} value={focusRef} onClear={clearFocus} />
      ) : null}

      <FilterPills value={filter} onChange={setFilter} options={options} />

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((index) => (
            <Skeleton key={index} className="h-[68px] w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconImage size={30} />}
            title={t('common.empty')}
            description={images.length === 0 ? t('projects.yamlNotAccessible') : undefined}
          />
        </Card>
      ) : (
        <ul className="space-y-2">
          {filtered.map((image) => (
            <ImageRow
              key={image.ref}
              image={image}
              checking={checkOne.isPending && checkOne.variables === image.ref}
              onCheck={() => checkOne.mutate(image.ref)}
              onToggleAuto={(value) => toggleAuto.mutate({ ref: image.ref, value })}
              onUpdate={(force) => {
                // La imagen propia va por otro camino: no se puede recrear a si
                // misma, hace falta el ayudante externo.
                if (image.ref === selfImageRef) setSelfUpdate(true);
                else setUpdateTarget({ image, force });
              }}
              onDetail={() => setDetail(image)}
              onDelete={() => setConfirmDelete(image)}
              isSelf={image.ref === selfImageRef}
              activeJob={live.activeByImage.get(image.ref)}
            />
          ))}
        </ul>
      )}

      {detail ? (
        <ImageDetailDialog image={detail} onClose={() => setDetail(null)} onSaved={invalidate} />
      ) : null}

      {selfUpdate ? <SelfUpdateDialog onClose={() => setSelfUpdate(false)} /> : null}

      {/* Borrar una imagen con contenedores parados los deja sin poder
          arrancar. Se nombran uno a uno antes de confirmar: decir "se borrara
          la imagen" y callarse eso seria una trampa. */}
      {confirmDelete ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmDelete(null)}
          title={t('images.delete')}
          description={
            confirmDelete.usage === 'orphan'
              ? t('images.confirmDeleteOrphan', { ref: displayImage(confirmDelete.ref) })
              : t('images.confirmDeleteStopped', {
                  ref: displayImage(confirmDelete.ref),
                  names: confirmDelete.inUseBy.join(', '),
                })
          }
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          loading={remove.isPending}
          onConfirm={() =>
            remove.mutate({
              ref: confirmDelete.ref,
              // Solo se fuerza cuando hay contenedores parados de por medio,
              // que es exactamente el caso que el usuario acaba de confirmar.
              force: confirmDelete.usage === 'stopped',
            })
          }
        />
      ) : null}

      {updateTarget ? (
        <UpdateDialog
          image={updateTarget.image}
          force={updateTarget.force}
          onClose={() => setUpdateTarget(null)}
          onDone={(message, tone) => {
            notify(message, tone);
            invalidate();
          }}
        />
      ) : null}
    </div>
  );
}

function ImageRow({
  image,
  checking,
  onCheck,
  onToggleAuto,
  onUpdate,
  onDetail,
  onDelete,
  isSelf,
  activeJob,
}: {
  image: TrackedImage;
  checking: boolean;
  onCheck: () => void;
  onToggleAuto: (value: boolean) => void;
  onUpdate: (force: boolean) => void;
  onDetail: () => void;
  onDelete: () => void;
  isSelf: boolean;
  activeJob: UpdateJob | undefined;
}): ReactNode {
  const { t } = useTranslation();
  const hasUpdate = image.status === 'update-available';
  const actionable = image.source === 'registry';

  return (
    <li className="cu-list-row">
      <Card
        className={cx(
          'flex items-center gap-3 p-3 transition-colors duration-[var(--dur-fast)]',
          'hover:border-[var(--border-strong)]',
        )}
        glow={hasUpdate}
      >
        <button
          type="button"
          onClick={onDetail}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-mono text-[0.8125rem] font-medium">
                {displayImage(image.ref)}
              </span>
              <Badge tone={UPDATE_STATUS_TONE[image.status]}>
                {t(UPDATE_STATUS_LABEL[image.status])}
              </Badge>
              {image.policy.autoUpdate ? (
                <Tooltip content={t('images.autoUpdate')}>
                  <Badge tone="info">auto</Badge>
                </Tooltip>
              ) : null}
              {/* Solo cuando NO esta en marcha: que una imagen se este usando
                  es lo normal, y etiquetarlo en cada fila seria ruido. Lo que
                  interesa senalar es lo que se puede limpiar. */}
              {image.usage !== 'running' ? (
                <Tooltip
                  content={
                    image.usage === 'orphan'
                      ? t('images.usageOrphanHelp')
                      : t('images.usageStoppedHelp', { names: image.inUseBy.join(', ') })
                  }
                >
                  <Badge tone={IMAGE_USAGE_TONE[image.usage]}>
                    {t(IMAGE_USAGE_LABEL[image.usage])}
                  </Badge>
                </Tooltip>
              ) : null}
              {image.candidateTag ? (
                <Badge tone="accent">{`→ ${image.candidateTag}`}</Badge>
              ) : null}
              {isSelf ? (
                <Tooltip content={t('settings.selfUpdateWarning')}>
                  <Badge tone="info">{t('containers.self')}</Badge>
                </Tooltip>
              ) : null}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.6875rem] text-[var(--text-muted)]">
              {image.sizeBytes ? <span>{formatBytes(image.sizeBytes)}</span> : null}
              {image.localDigests[0] ? (
                <span className="font-mono">{shortDigest(image.localDigests[0], 10)}</span>
              ) : null}
              <span>
                {t('images.lastChecked')}: {formatRelative(image.lastCheckedAt)}
              </span>
            </div>

            {image.lastError ? (
              <p className="mt-1 text-[0.6875rem] text-[var(--danger)] line-clamp-2">
                {image.lastError}
              </p>
            ) : null}

            {image.source === 'local-build' ? (
              <p className="mt-1 text-[0.6875rem] text-[var(--text-faint)]">
                {t('images.sourceLocalBuildHelp')}
              </p>
            ) : null}
          </div>
        </button>

        {/* Quien usa esta imagen, y un salto directo a esos contenedores.
            Fuera del boton de detalle porque un enlace no puede ir dentro. */}
        {image.inUseBy.length > 0 ? (
          <div className="hidden max-w-[26%] shrink-0 text-right text-[0.6875rem] md:block">
            <CrossLink
              to={`/containers?image=${encodeURIComponent(image.ref)}`}
              title={t('images.goToContainers')}
            >
              {image.inUseBy.length === 1
                ? image.inUseBy[0]
                : t('images.usedByCount', { count: image.inUseBy.length })}
            </CrossLink>
          </div>
        ) : null}

        <div className="flex shrink-0 items-center gap-1">
          {/* Mientras hay un trabajo vivo se sustituye el boton por el
              indicador: dejarlo visible invitaria a encolar la misma
              actualizacion dos veces. */}
          {activeJob ? (
            <JobIndicator job={activeJob} />
          ) : hasUpdate ? (
            <Button
              size="sm"
              variant="primary"
              icon={<IconDownload size={15} />}
              onClick={() => onUpdate(false)}
            >
              <span className="hidden sm:inline">{t('images.update')}</span>
            </Button>
          ) : null}

          <Tooltip content={t('images.check')}>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t('images.check')}
              loading={checking}
              disabled={!actionable || Boolean(activeJob)}
              onClick={onCheck}
            >
              <IconRefresh size={16} />
            </Button>
          </Tooltip>

          <Menu
            trigger={
              <Button size="icon" variant="ghost" aria-label={t('common.showMore')}>
                <IconMore size={16} />
              </Button>
            }
            items={[
              {
                key: 'detail',
                label: t('images.policy'),
                onSelect: onDetail,
              },
              {
                key: 'auto',
                // Se enuncia la ACCION, no el estado. "Auto-actualizar: Si"
                // se leia como "esta activada" cuando en realidad significaba
                // "pulsa para activarla", justo lo contrario.
                label: image.policy.autoUpdate
                  ? t('images.autoUpdateDisable')
                  : t('images.autoUpdateEnable'),
                disabled: !actionable,
                onSelect: () => onToggleAuto(!image.policy.autoUpdate),
              },
              { type: 'separator', key: 'sep' },
              {
                key: 'force',
                label: t('images.force'),
                danger: true,
                disabled: !actionable,
                onSelect: () => onUpdate(true),
              },
              {
                key: 'delete',
                label: t('images.delete'),
                danger: true,
                // Con algo en marcha el daemon se niega, asi que ni se ofrece.
                disabled: image.usage === 'running' || isSelf,
                onSelect: onDelete,
              },
            ]}
          />
        </div>
      </Card>
    </li>
  );
}

export { ApiError };
