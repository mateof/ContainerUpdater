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
import { RevertDialog } from './RevertDialog';
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
  const [confirmRevert, setConfirmRevert] = useState<TrackedImage | null>(null);

  /**
   * Seleccion para actualizar varias de una vez.
   *
   * Se guardan REFERENCIAS y no objetos: la lista se recarga sola con cada
   * evento del servidor, y quedarse con los objetos dejaria una seleccion que
   * apunta a copias viejas.
   */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);

  const toggleSelected = (ref: string): void =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });

  /**
   * Que se puede seleccionar: cualquier imagen de registry.
   *
   * Antes solo se podian marcar las que YA tenian actualizacion, porque la
   * seleccion nacio para actualizar en lote. Comprobar en lote necesita lo
   * contrario: se comprueba justamente lo que todavia no se sabe si tiene
   * novedad.
   */
  const selectables = useMemo(
    () => images.filter((image) => image.source === 'registry'),
    [images],
  );

  /**
   * De lo seleccionado, que se puede actualizar de verdad.
   *
   * La propia aplicacion queda fuera porque no puede recrearse a si misma, y
   * colarla en un lote lo haria fallar entero.
   */
  const bulkCandidates = useMemo(
    () =>
      images.filter(
        (image) =>
          image.status === 'update-available' &&
          image.source === 'registry' &&
          image.ref !== selfImageRef,
      ),
    [images, selfImageRef],
  );

  // La seleccion se limpia de lo que ya no aplica (se actualizo, o dejo de
  // tener novedad), o el contador prometeria trabajos que no se van a encolar.
  /** Seleccionadas que siguen existiendo y se pueden comprobar. */
  const selectedRefs = useMemo(
    () => selectables.filter((image) => selected.has(image.ref)).map((image) => image.ref),
    [selectables, selected],
  );

  /** De esas, las que ademas se pueden actualizar ahora mismo. */
  const selectedUpdatable = useMemo(
    () => bulkCandidates.filter((image) => selected.has(image.ref)).map((image) => image.ref),
    [bulkCandidates, selected],
  );

  const bulkCheck = useMutation({
    mutationFn: (refs: string[]) => api.checkImages(refs),
    onSuccess: () => {
      notify(t('images.bulkChecked', { count: selectedRefs.length }), 'ok');
      invalidate();
    },
    onError: () => notify(t('common.error'), 'danger'),
  });

  /**
   * Encola las seleccionadas de una en una.
   *
   * En serie y no con `Promise.all`: el servidor las mete en una cola global de
   * todas formas, pero lanzarlas a la vez puede pasarse del tope de cola y
   * rechazar las ultimas sin que se sepa cuales. Asi se cuenta exactamente
   * cuantas entraron y se puede decir que fallo.
   */
  const bulkUpdate = useMutation({
    mutationFn: async (refs: string[]) => {
      let ok = 0;
      let lastError: string | null = null;
      for (const ref of refs) {
        try {
          await api.updateImage(ref, { mode: 'update' });
          ok += 1;
        } catch (error) {
          lastError = error instanceof ApiError ? error.code : String(error);
        }
      }
      return { ok, total: refs.length, lastError };
    },
    onSuccess: (result) => {
      if (result.ok === result.total) {
        notify(t('images.bulkQueued', { count: result.ok }), 'ok');
      } else {
        notify(
          t('images.bulkPartial', {
            ok: result.ok,
            total: result.total,
            reason: result.lastError ?? '',
          }),
          'info',
        );
      }
      setSelected(new Set());
      setConfirmBulk(false);
      invalidate();
    },
    onError: () => notify(t('common.error'), 'danger'),
  });

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

      <div className="flex flex-wrap items-center gap-2">
        <FilterPills value={filter} onChange={setFilter} options={options} />
        {/* Con siete imagenes pendientes, marcarlas una a una es el trabajo que
            precisamente se queria evitar. Solo aparece si hay mas de una. */}
        {bulkCandidates.length > 1 && selectedUpdatable.length !== bulkCandidates.length ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(new Set(bulkCandidates.map((image) => image.ref)))}
          >
            {t('images.selectAllUpdatable')}
          </Button>
        ) : null}
      </div>

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
              onRevert={() => setConfirmRevert(image)}
              isSelf={image.ref === selfImageRef}
              activeJob={live.activeByImage.get(image.ref)}
              // La casilla solo existe donde tiene sentido pulsarla: en algo que
              // de verdad se puede actualizar. Ponerla en todas y desactivarla
              // en la mayoria seria una columna de casillas muertas.
              selectable={image.source === 'registry'}
              selected={selected.has(image.ref)}
              onSelect={() => toggleSelected(image.ref)}
            />
          ))}
        </ul>
      )}

      {/*
        Barra de seleccion, que aparece solo cuando hay algo seleccionado. Va
        pegada abajo para que no haya que volver arriba tras marcar la ultima.
      */}
      {selectedRefs.length > 0 ? (
        <div className="sticky bottom-4 z-20 flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 shadow-[var(--shadow-lg)]">
          <span className="mr-auto text-[0.8125rem]">
            {t('images.selectedCount', { count: selectedRefs.length })}
          </span>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            {t('images.clearSelection')}
          </Button>
          <Button
            variant="secondary"
            icon={<IconRefresh size={15} />}
            loading={bulkCheck.isPending}
            onClick={() => bulkCheck.mutate(selectedRefs)}
          >
            {t('images.checkSelected', { count: selectedRefs.length })}
          </Button>
          {/* Actualizar solo aparece si algo de lo marcado tiene novedad: un
              boton que no haria nada confunde mas que ayuda. */}
          {selectedUpdatable.length > 0 ? (
            <Button
              variant="primary"
              icon={<IconDownload size={15} />}
              loading={bulkUpdate.isPending}
              onClick={() => setConfirmBulk(true)}
            >
              {t('images.updateSelected', { count: selectedUpdatable.length })}
            </Button>
          ) : null}
        </div>
      ) : null}

      {confirmBulk ? (
        <ConfirmDialog
          open
          onOpenChange={(value) => !value && setConfirmBulk(false)}
          title={t('images.updateSelected', { count: selectedUpdatable.length })}
          description={t('images.bulkConfirm', { count: selectedUpdatable.length })}
          confirmLabel={t('common.confirm')}
          cancelLabel={t('common.cancel')}
          loading={bulkUpdate.isPending}
          onConfirm={() => bulkUpdate.mutate(selectedUpdatable)}
        >
          <ul className="max-h-52 space-y-0.5 overflow-y-auto text-[0.75rem] text-[var(--text-muted)]">
            {selectedUpdatable.map((ref) => (
              <li key={ref} className="truncate font-mono">
                {displayImage(ref)}
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      ) : null}

      {detail ? (
        <ImageDetailDialog image={detail} onClose={() => setDetail(null)} onSaved={invalidate} />
      ) : null}

      {selfUpdate ? <SelfUpdateDialog onClose={() => setSelfUpdate(false)} /> : null}

      {confirmRevert ? (
        <RevertDialog
          imageRef={confirmRevert.ref}
          onClose={() => setConfirmRevert(null)}
          onDone={invalidate}
        />
      ) : null}

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
  onRevert,
  isSelf,
  activeJob,
  selectable,
  selected,
  onSelect,
}: {
  image: TrackedImage;
  checking: boolean;
  onCheck: () => void;
  onToggleAuto: (value: boolean) => void;
  onUpdate: (force: boolean) => void;
  onDetail: () => void;
  onDelete: () => void;
  onRevert: () => void;
  isSelf: boolean;
  activeJob: UpdateJob | undefined;
  selectable: boolean;
  selected: boolean;
  onSelect: () => void;
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
        {/* Fuera del boton de detalle: una casilla dentro de un boton no se
            puede pulsar sin abrir tambien la ficha. */}
        {selectable ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={onSelect}
            aria-label={t('images.select')}
            className="size-4 shrink-0 cursor-pointer accent-[var(--accent)]"
          />
        ) : null}

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
              {/*
                La version instalada, y SOLO cuando aporta algo.
                
                Con `mongo:8.2` la etiqueta ya lo dice y repetirlo seria ruido;
                con `latest` es justo el dato que faltaba, porque el nombre no
                dice nada y el digest es ilegible.
              */}
              {image.installedVersion && image.installedVersion !== image.tag ? (
                <Tooltip content={t('images.installedVersionHelp')}>
                  <span className="font-medium text-[var(--text)]">
                    {t('images.installedVersion', { version: image.installedVersion })}
                  </span>
                </Tooltip>
              ) : null}
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
            {/* Con uno solo se va directo a ese contenedor; con varios, a la
                lista filtrada, que es donde se elige. */}
            {image.inUseBy.length === 1 ? (
              <CrossLink
                to={`/containers?container=${encodeURIComponent(image.inUseBy[0]!)}`}
                title={t('images.goToContainer', { name: image.inUseBy[0] })}
              >
                {image.inUseBy[0]}
              </CrossLink>
            ) : (
              <CrossLink
                to={`/containers?image=${encodeURIComponent(image.ref)}`}
                title={t('images.goToContainers')}
              >
                {t('images.usedByCount', { count: image.inUseBy.length })}
              </CrossLink>
            )}
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
              {
                // Solo aparece si de verdad hay a donde volver. Un boton
                // apagado permanente no informa de nada.
                key: 'revert',
                label: t('images.revert'),
                disabled: !image.canRollback || !actionable || isSelf,
                hidden: !image.canRollback,
                onSelect: onRevert,
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
