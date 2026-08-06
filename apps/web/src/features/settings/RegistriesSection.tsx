import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { RegistryConfig } from '@cu/shared';
import { api, ApiError } from '@/api/client';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  SectionTitle,
  Select,
  useToast,
} from '@/components/ui';
import { IconLock } from '@/components/icons';

const STATUS_TONE = {
  ok: 'ok',
  'needs-reauth': 'warn',
  error: 'danger',
  untested: 'neutral',
} as const;

const STATUS_LABEL = {
  ok: 'settings.registryStatusOk',
  'needs-reauth': 'settings.registryStatusNeedsReauth',
  error: 'settings.registryStatusError',
  untested: 'settings.registryStatusUntested',
} as const;

export function RegistriesSection(): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<RegistryConfig | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RegistryConfig | null>(null);
  const [forgetting, setForgetting] = useState(false);

  const { data } = useQuery({ queryKey: ['registries'], queryFn: () => api.registries() });
  const registries = data?.registries ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['registries'] });

  const test = useMutation({
    mutationFn: (id: number) => api.testRegistry(id),
    onSuccess: (result) => {
      notify(`${t('settings.registryTestOk')} (${result.testedWith})`, 'ok');
      void invalidate();
    },
    onError: (error) => {
      const payload = error instanceof ApiError ? (error.payload as { message?: string }) : undefined;
      notify(t('settings.registryTestFailed', { error: payload?.message ?? '' }), 'danger');
      void invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteRegistry(id),
    onSuccess: () => {
      void invalidate();
      setDeleting(null);
    },
  });

  const forget = useMutation({
    mutationFn: () => api.forgetSecrets(),
    onSuccess: () => {
      void invalidate();
      setForgetting(false);
    },
  });

  return (
    <Card className="p-5">
      <SectionTitle
        title={t('settings.registries')}
        description={t('settings.registriesHelp')}
        action={
          <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
            {t('common.add')}
          </Button>
        }
      />

      {data && !data.keyringHealthy ? (
        <Banner
          tone="warn"
          title={t('errors.keyringLocked')}
          action={
            <Button size="sm" variant="ghost" onClick={() => setForgetting(true)}>
              {t('settings.keyringDegradedAction')}
            </Button>
          }
        >
          {t('settings.keyringDegraded')}
        </Banner>
      ) : null}

      {registries.length === 0 ? (
        <p className="py-4 text-center text-[0.8125rem] text-[var(--text-muted)]">
          {t('common.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {registries.map((registry) => (
            <li key={registry.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[0.8125rem] font-medium">{registry.name}</span>
                  <Badge tone={STATUS_TONE[registry.status]}>
                    {t(STATUS_LABEL[registry.status])}
                  </Badge>
                  {registry.hasSecret ? <IconLock size={13} className="text-[var(--text-faint)]" /> : null}
                </div>
                <p className="truncate font-mono text-[0.6875rem] text-[var(--text-muted)]">
                  {registry.host}
                  {registry.username ? ` · ${registry.username}` : ''}
                </p>
                {registry.rateLimitRemaining !== null && registry.rateLimitTotal !== null ? (
                  <p className="text-[0.6875rem] text-[var(--text-faint)]">
                    {t('settings.rateLimit', {
                      remaining: registry.rateLimitRemaining,
                      total: registry.rateLimitTotal,
                    })}
                  </p>
                ) : null}
              </div>

              <div className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  loading={test.isPending && test.variables === registry.id}
                  onClick={() => test.mutate(registry.id)}
                >
                  {t('settings.registryTest')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(registry)}>
                  {t('common.edit')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(registry)}>
                  {t('common.delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <RegistryDialog
          registry={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void invalidate();
            setEditing(null);
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          title={t('common.delete')}
          description={deleting.host}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
        />
      ) : null}

      {forgetting ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setForgetting(false)}
          title={t('settings.keyringDegradedAction')}
          description={t('settings.keyringConfirmForget')}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          loading={forget.isPending}
          onConfirm={() => forget.mutate()}
        />
      ) : null}
    </Card>
  );
}

function RegistryDialog({
  registry,
  onClose,
  onSaved,
}: {
  registry: RegistryConfig | null;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();

  const [name, setName] = useState(registry?.name ?? '');
  const [host, setHost] = useState(registry?.host ?? '');
  const [authType, setAuthType] = useState(registry?.authType ?? 'basic');
  const [username, setUsername] = useState(registry?.username ?? '');
  const [secret, setSecret] = useState('');

  const save = useMutation({
    // Se descarta el valor de retorno: alta y edicion devuelven formas
    // distintas y aqui solo importa que haya ido bien.
    mutationFn: async (): Promise<void> => {
      if (registry) {
        await api.updateRegistry(registry.id, {
          name,
          authType,
          username,
          secret: secret || undefined,
        });
      } else {
        await api.createRegistry({ name, host, authType, username, secret: secret || undefined });
      }
    },
    onSuccess: onSaved,
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : '';
      notify(code === 'already-exists' ? t('errors.conflict') : t('common.error'), 'danger');
    },
  });

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={registry ? t('common.edit') : t('common.add')}
      description={t('settings.registriesHelp')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('settings.registryName')} htmlFor="reg-name">
          <Input id="reg-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        <Field label={t('settings.registryHost')} htmlFor="reg-host">
          <Input
            id="reg-host"
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="ghcr.io"
            className="font-mono"
            // El host es la clave del registry: cambiarlo seria crear otro
            // distinto y dejaria el secreto cifrado apuntando al equivocado.
            disabled={Boolean(registry)}
          />
        </Field>

        <Field label={t('settings.registryAuthType')} htmlFor="reg-auth">
          <Select
            id="reg-auth"
            value={authType}
            onChange={(event) => setAuthType(event.target.value as typeof authType)}
          >
            <option value="anonymous">{t('settings.registryAuthAnonymous')}</option>
            <option value="basic">{t('settings.registryAuthBasic')}</option>
            <option value="token">{t('settings.registryAuthToken')}</option>
          </Select>
        </Field>

        {authType !== 'anonymous' ? (
          <>
            <Field label={t('settings.registryUsername')} htmlFor="reg-user">
              <Input
                id="reg-user"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="off"
              />
            </Field>

            <Field
              label={t('settings.registrySecret')}
              hint={registry?.hasSecret ? t('settings.registrySecretKeep') : undefined}
              htmlFor="reg-secret"
            >
              <Input
                id="reg-secret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="new-password"
                placeholder={registry?.hasSecret ? '••••••••' : ''}
              />
            </Field>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
