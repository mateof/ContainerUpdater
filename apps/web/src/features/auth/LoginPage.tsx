import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FormEvent, ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { Button, Field, Input } from '@/components/ui';
import { AuthShell } from './AuthShell';

export function LoginPage(): ReactNode {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(username, password);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        const payload = caught.payload as { retryAfterMinutes?: number } | undefined;
        setError(t('auth.tooManyAttempts', { minutes: payload?.retryAfterMinutes ?? 15 }));
      } else {
        // Mensaje identico para usuario inexistente y contrasena incorrecta: lo
        // contrario permitiria averiguar que usuarios existen.
        setError(t('auth.invalidCredentials'));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title={t('auth.title')} subtitle={t('auth.subtitle')}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={t('auth.username')} htmlFor="username">
          <Input
            id="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </Field>

        <Field label={t('auth.password')} htmlFor="password" error={error}>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>

        <Button type="submit" variant="primary" loading={loading} className="w-full justify-center">
          {t('auth.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
