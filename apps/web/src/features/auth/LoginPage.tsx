import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { startAuthentication } from '@simplewebauthn/browser';
import type { FormEvent, ReactNode } from 'react';
import type { PasskeySupport } from '@cu/shared';
import { api, ApiError } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { Button, Field, Input } from '@/components/ui';
import { IconKey } from '@/components/icons';
import { AuthShell } from './AuthShell';

export function LoginPage(): ReactNode {
  const { t } = useTranslation();
  const { login, setUser } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);

  /**
   * Si ofrecer el boton de passkey.
   *
   * Hacen falta las tres: que el navegador tenga la API, que el origen la
   * admita (HTTPS con nombre de dominio) y que haya alguna llave registrada.
   * Un boton que no puede funcionar es peor que no tenerlo.
   */
  const [support, setSupport] = useState<PasskeySupport | null>(null);
  useEffect(() => {
    void api
      .passkeySupport()
      .then(setSupport)
      .catch(() => setSupport(null));
  }, []);

  const canUsePasskey =
    support?.available === true &&
    support.anyRegistered &&
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof window.PublicKeyCredential !== 'undefined';

  async function onPasskey(): Promise<void> {
    setPasskeyLoading(true);
    setError(null);
    try {
      const options = await api.passkeyLoginOptions();
      const response = await startAuthentication({ optionsJSON: options as never });
      const result = await api.passkeyLoginVerify(response);
      setUser(result.user);
    } catch (caught) {
      // Cerrar el dialogo del navegador no es un fallo que merezca mensaje.
      if (caught instanceof Error && caught.name === 'NotAllowedError') return;
      setError(t('passkeys.loginFailed'));
    } finally {
      setPasskeyLoading(false);
    }
  }

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

        {canUsePasskey ? (
          <>
            <div className="flex items-center gap-3 text-[0.75rem] text-[var(--text-faint)]">
              <span className="h-px flex-1 bg-[var(--border)]" />
              {t('passkeys.or')}
              <span className="h-px flex-1 bg-[var(--border)]" />
            </div>
            {/* type="button" es imprescindible: dentro de un form, el defecto es
                submit y pulsarlo enviaria la contrasena vacia. */}
            <Button
              type="button"
              variant="secondary"
              icon={<IconKey size={16} />}
              loading={passkeyLoading}
              className="w-full justify-center"
              onClick={() => void onPasskey()}
            >
              {t('passkeys.login')}
            </Button>
          </>
        ) : null}
      </form>
    </AuthShell>
  );
}
