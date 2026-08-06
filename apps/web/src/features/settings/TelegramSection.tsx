import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { TelegramUser } from '@cu/shared';
import { api } from '@/api/client';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Modal,
  SectionTitle,
  useToast,
} from '@/components/ui';
import { IconTelegram } from '@/components/icons';
import { formatRelative } from '@/lib/format';

export function TelegramSection(): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();

  const [link, setLink] = useState<{ code: string; deepLink: string | null; expiresAt: number } | null>(
    null,
  );
  const [revoking, setRevoking] = useState<TelegramUser | null>(null);

  const { data } = useQuery({ queryKey: ['telegram'], queryFn: () => api.telegram() });

  const createCode = useMutation({
    mutationFn: () => api.telegramLinkCode(),
    onSuccess: (result) => setLink(result),
    onError: () => notify(t('common.error'), 'danger'),
  });

  const revoke = useMutation({
    mutationFn: (id: number) => api.revokeTelegramUser(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['telegram'] });
      setRevoking(null);
    },
  });

  return (
    <Card className="p-5">
      <SectionTitle
        title={t('settings.telegram')}
        action={
          data?.configured ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<IconTelegram size={15} />}
              loading={createCode.isPending}
              onClick={() => createCode.mutate()}
            >
              {t('settings.telegramLink')}
            </Button>
          ) : null
        }
      />

      {!data?.configured ? (
        <Banner tone="info" title={t('settings.telegram')}>
          {t('settings.telegramNotConfigured')}
        </Banner>
      ) : data.running ? (
        <Banner tone="info" title={t('settings.telegramRunning', { username: data.botUsername ?? '?' })} />
      ) : (
        <Banner tone="danger" title={t('settings.telegramStopped', { error: data.error ?? '' })} />
      )}

      <div className="mt-4">
        {(data?.users.length ?? 0) === 0 ? (
          <p className="text-[0.8125rem] text-[var(--text-muted)]">{t('settings.telegramNoUsers')}</p>
        ) : (
          <>
            <p className="mb-2 text-[0.75rem] font-medium text-[var(--text-muted)]">
              {t('settings.telegramLinkedUsers')}
            </p>
            <ul className="divide-y divide-[var(--border)]">
              {data?.users.map((user) => (
                <li key={user.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[0.8125rem] font-medium">
                        {user.firstName ?? user.username ?? `chat ${user.chatId}`}
                      </span>
                      <Badge tone={user.active ? 'ok' : 'neutral'}>{user.role}</Badge>
                    </div>
                    <p className="text-[0.6875rem] text-[var(--text-muted)]">
                      {user.username ? `@${user.username} · ` : ''}
                      {formatRelative(user.lastSeenAt ?? user.linkedAt)}
                    </p>
                  </div>
                  {user.active ? (
                    <Button size="sm" variant="ghost" onClick={() => setRevoking(user)}>
                      {t('settings.telegramRevoke')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {link ? (
        <Modal
          open
          onOpenChange={(open) => !open && setLink(null)}
          title={t('settings.telegramLink')}
          description={t('settings.telegramLinkHelp')}
          footer={
            <Button
              variant="primary"
              onClick={() => {
                setLink(null);
                void queryClient.invalidateQueries({ queryKey: ['telegram'] });
              }}
            >
              {t('common.close')}
            </Button>
          }
        >
          <div className="flex flex-col items-center gap-4">
            <p className="rounded-[var(--radius-sm)] bg-[var(--bg-inset)] px-4 py-2 font-mono text-lg tracking-[0.2em]">
              {link.code}
            </p>

            {link.deepLink ? (
              <Button
                variant="primary"
                icon={<IconTelegram size={15} />}
                onClick={() => window.open(link.deepLink ?? '', '_blank', 'noopener,noreferrer')}
              >
                {t('settings.telegramLink')}
              </Button>
            ) : null}

            <p className="text-[0.75rem] text-[var(--text-muted)]">
              {t('units.inTime', { value: formatRelative(link.expiresAt) })}
            </p>
          </div>
        </Modal>
      ) : null}

      {revoking ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRevoking(null)}
          title={t('settings.telegramRevoke')}
          description={t('settings.telegramConfirmRevoke', {
            name: revoking.firstName ?? revoking.username ?? String(revoking.chatId),
          })}
          confirmLabel={t('common.confirm')}
          cancelLabel={t('common.cancel')}
          danger
          loading={revoke.isPending}
          onConfirm={() => revoke.mutate(revoking.id)}
        />
      ) : null}
    </Card>
  );
}

