import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormEvent, ReactNode } from 'react';
import { api } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { Button, Field, Input } from '@/components/ui';
import { currentLocale } from '@/i18n';
import { AuthShell } from './AuthShell';

/** Alta del primer administrador. Solo aparece cuando no hay ningun usuario. */
export function SetupPage(): ReactNode {
  const { t } = useTranslation();
  const { refresh, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (password !== repeat) {
      setError(t('auth.passwordsDoNotMatch'));
      return;
    }
    if (password.length < 12) {
      setError(t('password.tooShort'));
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await api.setup({ username, password, locale: currentLocale() });
      // Se entra directamente: obligar a escribir las credenciales otra vez
      // justo despues de crearlas no aporta nada.
      await login(username, password);
      await refresh();
    } catch {
      setError(t('common.error'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title={t('auth.setupTitle')} subtitle={t('auth.setupSubtitle')}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={t('auth.username')} htmlFor="setup-username">
          <Input
            id="setup-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            minLength={3}
            autoFocus
            required
          />
        </Field>

        <Field label={t('auth.password')} htmlFor="setup-password" hint={t('password.tooShort')}>
          <Input
            id="setup-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
          />
        </Field>

        <Field label={t('auth.repeatPassword')} htmlFor="setup-repeat" error={error}>
          <Input
            id="setup-repeat"
            type="password"
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>

        <Button type="submit" variant="primary" loading={loading} className="w-full justify-center">
          {t('common.save')}
        </Button>
      </form>
    </AuthShell>
  );
}
