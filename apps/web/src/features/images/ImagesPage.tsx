import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { TrackedImage, UpdateJob } from '@cu/shared';
import { api, ApiError } from '@/api/client';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Menu,
  Skeleton,
  Tooltip,
  cx,
  useToast,
} from '@/components/ui';
import { IconDownload, IconImage, IconMore, IconRefresh, IconSearch } from '@/components/icons';
import { displayImage, formatBytes, formatRelative, shortDigest } from '@/lib/format';
import { UPDATE_STATUS_LABEL, UPDATE_STATUS_TONE } from '@/lib/labels';
import { ImageDetailDialog } from './ImageDetailDialog';
import { UpdateDialog } from './UpdateDialog';
import { SelfUpdateDialog } from './SelfUpdateDialog';
import { JobIndicator } from '@/components/JobIndicator';
import { useLive } from '@/hooks/LiveContext';

type Filter = 'all' | 'updates' | 'auto' | 'unknown';

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

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return images.filter((image) => {
      if (needle && !image.ref.toLowerCase().includes(needle)) return false;
      if (filter === 'updates') return image.status === 'update-available';
      if (filter === 'auto') return image.policy.autoUpdate;
      if (filter === 'unknown') return image.status === 'unknown' || image.status === 'error';
      return true;
    });
  }, [images, search, filter]);

  const counts = useMemo(
    () => ({
      all: images.length,
      updates: images.filter((image) => image.status === 'update-available').length,
      auto: images.filter((image) => image.policy.autoUpdate).length,
      unknown: images.filter((image) => image.status === 'unknown' || image.status === 'error')
        .length,
    }),
    [images],
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t('images.title')}</h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <IconSearch
              size={15}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('common.search')}
              className="pl-8 w-48 sm:w-60"
              type="search"
            />
          </div>
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ['all', 'images.filterAll'],
            ['updates', 'images.filterUpdates'],
            ['auto', 'images.filterAuto'],
            ['unknown', 'images.filterUnknown'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={cx(
              'rounded-full px-3 py-1 text-[0.75rem] font-medium transition-colors duration-[var(--dur-fast)]',
              filter === key
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'bg-[var(--bg-inset)] text-[var(--text-muted)] hover:text-[var(--text)]',
            )}
          >
            {t(label)}
            <span className="ml-1.5 tabular-nums opacity-60">{counts[key]}</span>
          </button>
        ))}
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
  isSelf,
  activeJob,
}: {
  image: TrackedImage;
  checking: boolean;
  onCheck: () => void;
  onToggleAuto: (value: boolean) => void;
  onUpdate: (force: boolean) => void;
  onDetail: () => void;
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
              {image.inUseBy.length > 0 ? (
                <span className="truncate">
                  {t('images.usedBy')}: {image.inUseBy.join(', ')}
                </span>
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
                label: image.policy.autoUpdate
                  ? `${t('images.autoUpdate')}: ${t('common.no')}`
                  : `${t('images.autoUpdate')}: ${t('common.yes')}`,
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
            ]}
          />
        </div>
      </Card>
    </li>
  );
}

export { ApiError };
