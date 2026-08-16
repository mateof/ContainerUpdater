import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { startRegistration } from '@simplewebauthn/browser';
import type { ReactNode } from 'react';
import { api, ApiError } from '@/api/client';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Input,
  Modal,
  SectionTitle,
  Skeleton,
  useToast,
} from '@/components/ui';
import { IconPlus, IconKey } from '@/components/icons';
import { formatRelative } from '@/lib/format';
import type { PasskeySummary } from '@cu/shared';

/**
 * Gestion de passkeys.
 *
 * Se muestra siempre, tambien cuando el origen no las admite, porque el motivo
 * es informacion util: quien lea "hace falta HTTPS con un nombre de dominio"
 * sabe que tiene que montar. Ocultar la seccion dejaria la funcionalidad
 * invisible sin explicar nada.
 */
export function PasskeysSection(): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();

  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<PasskeySummary | null>(null);

  const support = useQuery({ queryKey: ['passkey-support'], queryFn: () => api.passkeySupport() });
  const list = useQuery({ queryKey: ['passkeys'], queryFn: () => api.passkeys() });

  const register = useMutation({
    mutationFn: async (label: string) => {
      const options = await api.passkeyRegisterOptions();
      // El navegador habla con el autenticador (Bitwarden, el llavero, una
      // llave fisica). Aqui solo se traslada su respuesta al servidor.
      const response = await startRegistration({ optionsJSON: options as never });
      return api.passkeyRegisterVerify(label, response);
    },
    onSuccess: () => {
      notify(t('passkeys.registered'), 'ok');
      setNaming(false);
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['passkeys'] });
      void queryClient.invalidateQueries({ queryKey: ['passkey-support'] });
    },
    onError: (error) => {
      // Cancelar el dialogo del navegador no es un error que merezca aviso
      // rojo: es lo que pasa cuando alguien cambia de idea.
      if (error instanceof Error && error.name === 'NotAllowedError') {
        setNaming(false);
        return;
      }
      const code = error instanceof ApiError ? error.code : '';
      notify(
        code === 'already-registered' ? t('passkeys.alreadyRegistered') : t('passkeys.registerFailed'),
        'danger',
      );
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deletePasskey(id),
    onSuccess: () => {
      notify(t('passkeys.removed'), 'ok');
      setConfirmDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['passkeys'] });
      void queryClient.invalidateQueries({ queryKey: ['passkey-support'] });
    },
    onError: () => notify(t('common.error'), 'danger'),
  });

  const passkeys = list.data?.passkeys ?? [];
  const available = support.data?.available ?? false;

  return (
    <Card className="p-5">
      <SectionTitle
        title={t('passkeys.title')}
        description={t('passkeys.help')}
        action={
          <Button
            variant="secondary"
            icon={<IconPlus size={15} />}
            disabled={!available}
            onClick={() => setNaming(true)}
          >
            {t('passkeys.add')}
          </Button>
        }
      />

      {support.data && !available ? (
        <Banner tone="info" title={t('passkeys.unavailable')}>
          <p>
            {support.data.reason === 'ip-address'
              ? t('passkeys.unavailableIp', { origin: support.data.origin })
              : t('passkeys.unavailableInsecure', { origin: support.data.origin })}
          </p>
          <p className="mt-1">{t('passkeys.unavailableFix')}</p>
        </Banner>
      ) : null}

      {list.isLoading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : passkeys.length === 0 ? (
        <p className="mt-3 text-[0.8125rem] text-[var(--text-muted)]">{t('passkeys.none')}</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {passkeys.map((passkey) => (
            <li
              key={passkey.id}
              className="flex items-center gap-3 rounded-[var(--radius-sm)] bg-[var(--bg-inset)] px-3 py-2"
            >
              <IconKey size={15} className="shrink-0 text-[var(--text-muted)]" />
              <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{passkey.name}</span>
              <span className="shrink-0 text-[0.6875rem] text-[var(--text-muted)]">
                {passkey.lastUsedAt
                  ? t('passkeys.lastUsed', { when: formatRelative(passkey.lastUsedAt) })
                  : t('passkeys.neverUsed')}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(passkey)}>
                {t('common.delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* La contrasena nunca se retira. Un passkey depende del autenticador, y
          perderlo sin otra via de entrada dejaria el panel del NAS inaccesible. */}
      <div className="mt-3">
        <Banner tone="info" title={t('passkeys.passwordStays')}>
          {t('passkeys.passwordStaysHelp')}
        </Banner>
      </div>

      {naming ? (
        <Modal
          open
          onOpenChange={(open) => !open && setNaming(false)}
          title={t('passkeys.add')}
          description={t('passkeys.nameHelp')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setNaming(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={!name.trim()}
                loading={register.isPending}
                onClick={() => register.mutate(name.trim())}
              >
                {t('passkeys.create')}
              </Button>
            </>
          }
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('passkeys.namePlaceholder')}
            autoFocus
          />
        </Modal>
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmDelete(null)}
          title={t('common.delete')}
          description={t('passkeys.confirmRemove', { name: confirmDelete.name })}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          loading={remove.isPending}
          onConfirm={() => remove.mutate(confirmDelete.id)}
        />
      ) : null}
    </Card>
  );
}
