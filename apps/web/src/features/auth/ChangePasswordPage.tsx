import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormEvent, ReactNode } from 'react';
import { api } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { Banner, Button, Field, Input } from '@/components/ui';
import { AuthShell } from './AuthShell';

export function ChangePasswordPage({ forced }: { forced?: boolean }): ReactNode {
  const { t } = useTranslation();
  const { refresh, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (next !== repeat) {
      setError(t('auth.passwordsDoNotMatch'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      await refresh();
    } catch {
      setError(t('auth.invalidCredentials'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title={t('auth.changePasswordTitle')}>
      <form onSubmit={onSubmit} className="space-y-4">
        {forced ? (
          <Banner tone="warn" title={t('auth.changePasswordForced')} />
        ) : null}

        <Field label={t('auth.currentPassword')} htmlFor="current-password">
          <Input
            id="current-password"
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
        </Field>

        <Field label={t('auth.newPassword')} htmlFor="new-password" hint={t('password.tooShort')}>
          <Input
            id="new-password"
            type="password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
          />
        </Field>

        <Field label={t('auth.repeatPassword')} htmlFor="repeat-password" error={error}>
          <Input
            id="repeat-password"
            type="password"
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>

        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={loading} className="flex-1 justify-center">
            {t('common.save')}
          </Button>
          {forced ? (
            <Button type="button" variant="ghost" onClick={() => void logout()}>
              {t('nav.logout')}
            </Button>
          ) : null}
        </div>
      </form>
    </AuthShell>
  );
}
