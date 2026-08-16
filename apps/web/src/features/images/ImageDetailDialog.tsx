import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CrossLink } from '@/components/Filters';
import type { ReactNode } from 'react';
import type { SemverChannel, TrackMode, TrackedImage } from '@cu/shared';
import { api } from '@/api/client';
import { Badge, Button, Field, Modal, Select, Switch, useToast } from '@/components/ui';
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

function Detail({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] py-1.5 sm:border-0">
      <span className="shrink-0 text-[var(--text-muted)]">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}
