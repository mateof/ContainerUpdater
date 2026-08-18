import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CrossLink } from '@/components/Filters';
import type { ReactNode } from 'react';
import type {
  ReleaseInfo,
  SemverChannel,
  TrackMode,
  TrackedImage,
  UpdateHold,
} from '@cu/shared';
import { api } from '@/api/client';
import { Badge, Button, Field, Modal, Select, Switch, useToast } from '@/components/ui';
import { IconExternal } from '@/components/icons';
import { displayImage, formatBytes, formatDateTime, formatRelative } from '@/lib/format';
import { UPDATE_STATUS_LABEL, UPDATE_STATUS_TONE } from '@/lib/labels';

/** Detalle y politica de una imagen. */
export function ImageDetailDialog({
  image,
  onClose,
  onSaved,
}: {
  image: TrackedImage;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();

  const [policy, setPolicy] = useState(image.policy);
  const readOnly = image.source !== 'registry';

  // Para poder decir cuanta cuarentena se hereda cuando la imagen no tiene la
  // suya. Misma clave que la pantalla de Ajustes, asi que se reutiliza la cache
  // en vez de pedirlo otra vez.
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.settings() });
  const defaultMinAgeHours = settings.data?.settings.defaultMinAgeHours ?? 24;

  const save = useMutation({
    mutationFn: () =>
      api.savePolicy(image.ref, {
        autoUpdate: policy.autoUpdate,
        trackMode: policy.trackMode,
        semverChannel: policy.semverChannel,
        notify: policy.notify,
        recreateScope: policy.recreateScope,
        cleanupOldImage: policy.cleanupOldImage,
        removeImageOnForce: policy.removeImageOnForce,
        ignoredDigest: policy.ignoredDigest,
        minAgeHours: policy.minAgeHours,
      }),
    onSuccess: () => {
      notify(t('common.copied'), 'ok');
      onSaved();
      onClose();
    },
    onError: () => notify(t('common.error'), 'danger'),
  });

  const trackHelp: Record<TrackMode, string> = {
    digest: 'images.trackModeDigestHelp',
    semver: 'images.trackModeSemverHelp',
    both: 'images.trackModeBothHelp',
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      wide
      title={displayImage(image.ref)}
      description={t('images.policy')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={readOnly} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 text-[0.8125rem]">
          <Detail label={t('images.status')}>
            <Badge tone={UPDATE_STATUS_TONE[image.status]}>
              {t(UPDATE_STATUS_LABEL[image.status])}
            </Badge>
          </Detail>
          <Detail label={t('images.tag')}>
            <span className="font-mono">{image.tag}</span>
          </Detail>
          <Detail label={t('images.size')}>{formatBytes(image.sizeBytes)}</Detail>
          <Detail label={t('images.created')}>{formatDateTime(image.imageCreatedAt)}</Detail>
          <Detail label={t('images.lastChecked')}>{formatRelative(image.lastCheckedAt)}</Detail>
          <Detail label={t('images.usedBy')}>
            {image.inUseBy.length > 0 ? (
              // Cada nombre lleva a SU contenedor, no a la lista filtrada: al
              // mirar quien usa una imagen, lo siguiente es abrir uno concreto.
              <span className="flex flex-wrap justify-end gap-x-2 gap-y-0.5">
                {image.inUseBy.map((name) => (
                  <CrossLink
                    key={name}
                    to={`/containers?container=${encodeURIComponent(name)}`}
                    title={t('images.goToContainer', { name })}
                    onNavigate={onClose}
                  >
                    {name}
                  </CrossLink>
                ))}
              </span>
            ) : (
              t('common.none')
            )}
          </Detail>
        </div>

        {image.release && image.status === 'update-available' ? (
          <ReleasePanel release={image.release} hold={image.hold} />
        ) : null}

        {image.localDigests.length > 0 ? (
          <div>
            <p className="text-[0.75rem] font-medium mb-1">{t('images.digest')}</p>
            <ul className="space-y-0.5">
              {image.localDigests.map((digest) => (
                <li key={digest} className="font-mono text-[0.6875rem] text-[var(--text-muted)] break-all">
                  {digest}
                </li>
              ))}
            </ul>
            {image.remoteDigest && !image.localDigests.includes(image.remoteDigest) ? (
              <p className="mt-1.5 font-mono text-[0.6875rem] text-[var(--accent)] break-all">
                remoto: {image.remoteDigest}
              </p>
            ) : null}
          </div>
        ) : null}

        {readOnly ? (
          <p className="rounded-[var(--radius-sm)] bg-[var(--bg-inset)] px-3 py-2 text-[0.75rem] text-[var(--text-muted)]">
            {image.source === 'local-build'
              ? t('images.sourceLocalBuildHelp')
              : t('images.sourcePinnedHelp')}
          </p>
        ) : (
          <div className="space-y-4 border-t border-[var(--border)] pt-4">
            <Switch
              checked={policy.autoUpdate}
              onCheckedChange={(value) => setPolicy({ ...policy, autoUpdate: value })}
              label={t('images.autoUpdate')}
              hint={t('settings.autoUpdateEnabledHelp')}
            />

            <Field label={t('images.trackMode')} hint={t(trackHelp[policy.trackMode])}>
              <Select
                value={policy.trackMode}
                onChange={(event) =>
                  setPolicy({ ...policy, trackMode: event.target.value as TrackMode })
                }
              >
                <option value="digest">{t('images.trackModeDigest')}</option>
                <option value="semver">{t('images.trackModeSemver')}</option>
                <option value="both">{t('images.trackModeBoth')}</option>
              </Select>
            </Field>

            {policy.trackMode !== 'digest' ? (
              <Field label={t('images.semverChannel')}>
                <Select
                  value={policy.semverChannel}
                  onChange={(event) =>
                    setPolicy({ ...policy, semverChannel: event.target.value as SemverChannel })
                  }
                >
                  <option value="patch">{t('images.semverChannelPatch')}</option>
                  <option value="minor">{t('images.semverChannelMinor')}</option>
                  <option value="major">{t('images.semverChannelMajor')}</option>
                </Select>
              </Field>
            ) : null}

            {/*
              La cuarentena solo se ofrece si la imagen se actualiza sola: en
              las manuales no retiene nada y seria un campo que promete algo que
              no hace.
            */}
            {policy.autoUpdate ? (
              <Field
                label={t('images.minAge')}
                hint={
                  policy.minAgeHours === null
                    ? t('images.minAgeInheritHelp', { hours: defaultMinAgeHours })
                    : t('images.minAgeHelp')
                }
              >
                <Select
                  value={policy.minAgeHours === null ? 'inherit' : String(policy.minAgeHours)}
                  onChange={(event) =>
                    setPolicy({
                      ...policy,
                      minAgeHours:
                        event.target.value === 'inherit' ? null : Number(event.target.value),
                    })
                  }
                >
                  <option value="inherit">{t('images.minAgeInherit')}</option>
                  <option value="0">{t('images.minAgeNone')}</option>
                  <option value="24">{t('images.minAgeHours', { count: 24 })}</option>
                  <option value="72">{t('images.minAgeHours', { count: 72 })}</option>
                  <option value="168">{t('images.minAgeDays', { count: 7 })}</option>
                  <option value="336">{t('images.minAgeDays', { count: 14 })}</option>
                </Select>
              </Field>
            ) : null}

            <Switch
              checked={policy.notify}
              onCheckedChange={(value) => setPolicy({ ...policy, notify: value })}
              label={t('settings.notifyOnUpdateAvailable')}
            />

            <Switch
              checked={policy.cleanupOldImage}
              onCheckedChange={(value) => setPolicy({ ...policy, cleanupOldImage: value })}
              label={t('images.cleanupOldImage')}
            />

            {policy.ignoredDigest ? (
              <div className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] bg-[var(--bg-inset)] px-3 py-2">
                <p className="text-[0.75rem] text-[var(--text-muted)]">
                  {t('images.ignoredVersion')}
                </p>
                <Button size="sm" variant="ghost" onClick={() => setPolicy({ ...policy, ignoredDigest: null })}>
                  {t('images.unignore')}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * Que trae la version publicada y por que no ha entrado todavia.
 *
 * Las dos cosas van juntas a proposito: aparecen en el mismo momento (cuando
 * hay novedad) y responden a la misma pregunta del usuario, que es "y esto que
 * es y que hago con ello".
 */
function ReleasePanel({
  release,
  hold,
}: {
  release: ReleaseInfo;
  hold: UpdateHold | null;
}): ReactNode {
  const { t } = useTranslation();
  const link = release.compareUrl ?? release.releasesUrl;

  return (
    <div className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-inset)] px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.75rem] font-medium">{t('images.newVersion')}</p>
        {release.remoteVersion ? (
          <Badge tone="accent">{release.remoteVersion}</Badge>
        ) : null}
      </div>

      {release.publishedAt !== null ? (
        <p className="text-[0.75rem] text-[var(--text-muted)]">
          {t('images.publishedAt', { when: formatRelative(release.publishedAt) })}
        </p>
      ) : (
        // Se dice que no se sabe en vez de callarlo: es lo que explica por que
        // la cuarentena no ha retenido esta imagen.
        <p className="text-[0.75rem] text-[var(--text-muted)]">{t('images.publishedUnknown')}</p>
      )}

      {hold ? (
        <p className="text-[0.75rem] text-[var(--warn)]">
          {hold.reason === 'quarantine'
            ? t('images.heldQuarantine', {
                when: hold.until ? formatDateTime(hold.until) : '',
              })
            : t('images.heldWindow', {
                when: hold.until ? formatDateTime(hold.until) : '',
              })}
        </p>
      ) : null}

      {link ? (
        <a
          href={link}
          target="_blank"
          // noreferrer ademas de noopener: la URL sale de una etiqueta que
          // controla quien publica la imagen, no nosotros.
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[0.75rem] text-[var(--accent)] hover:underline"
        >
          {release.compareUrl ? t('images.whatChanged') : t('images.viewReleases')}
          <IconExternal size={12} />
        </a>
      ) : null}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] py-1.5 sm:border-0">
      <span className="shrink-0 text-[var(--text-muted)]">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}
