import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { api, ApiError } from '@/api/client';
import {
  Badge,
  Banner,
  Button,
  Card,
  Input,
  Modal,
  SectionTitle,
  Skeleton,
  useToast,
} from '@/components/ui';
import { IconKey } from '@/components/icons';

/**
 * Segundo factor con codigo temporal.
 *
 * El alta tiene tres pasos y ninguno se puede saltar: ensenar el QR, confirmar
 * con un codigo (asi nadie se queda fuera por no haber llegado a escanear) y
 * guardar los codigos de recuperacion, que se muestran una sola vez.
 */
export function TotpSection(): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();

  const [enrolling, setEnrolling] = useState(false);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [asking, setAsking] = useState<'disable' | 'regenerate' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = useQuery({ queryKey: ['totp'], queryFn: () => api.totpStatus() });
  const enrollment = useQuery({
    queryKey: ['totp-enrollment'],
    queryFn: () => api.totpStart(),
    // Solo se pide al abrir el alta: genera un secreto nuevo cada vez.
    enabled: enrolling,
    staleTime: Infinity,
    gcTime: 0,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['totp'] });
  };

  const confirm = useMutation({
    mutationFn: (value: string) => api.totpConfirm(value),
    onSuccess: (result) => {
      setEnrolling(false);
      setCode('');
      setRecoveryCodes(result.recoveryCodes);
      refresh();
    },
    onError: () => setError(t('totp.invalidCode')),
  });

  const disable = useMutation({
    mutationFn: (value: string) => api.totpDisable(value),
    onSuccess: () => {
      notify(t('totp.disabled'), 'ok');
      setAsking(null);
      setPassword('');
      refresh();
    },
    onError: (caught) => {
      setError(
        caught instanceof ApiError && caught.code === 'invalid-password'
          ? t('totp.wrongPassword')
          : t('common.error'),
      );
    },
  });

  const regenerate = useMutation({
    mutationFn: (value: string) => api.totpRegenerate(value),
    onSuccess: (result) => {
      setAsking(null);
      setPassword('');
      setRecoveryCodes(result.recoveryCodes);
      refresh();
    },
    onError: (caught) => {
      setError(
        caught instanceof ApiError && caught.code === 'invalid-password'
          ? t('totp.wrongPassword')
          : t('common.error'),
      );
    },
  });

  const enabled = status.data?.enabled ?? false;
  const left = status.data?.recoveryCodesLeft ?? 0;

  return (
    <Card className="p-5">
      <SectionTitle
        title={t('totp.title')}
        description={t('totp.help')}
        action={
          status.isLoading ? null : enabled ? (
            <Button variant="ghost" onClick={() => { setAsking('disable'); setError(null); }}>
              {t('totp.disable')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              icon={<IconKey size={15} />}
              onClick={() => { setEnrolling(true); setError(null); }}
            >
              {t('totp.enable')}
            </Button>
          )
        }
      />

      {status.isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : enabled ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
            <Badge tone="ok">{t('totp.active')}</Badge>
            <span className="text-[var(--text-muted)]">
              {t('totp.recoveryLeft', { count: left })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setAsking('regenerate'); setError(null); }}
            >
              {t('totp.regenerate')}
            </Button>
          </div>

          {/* Quedarse sin codigos de recuperacion sin enterarse es quedarse sin
              llaves de repuesto a ciegas. */}
          {left <= 3 ? (
            <Banner tone={left === 0 ? 'danger' : 'warn'} title={t('totp.fewCodes')}>
              {t('totp.fewCodesHelp')}
            </Banner>
          ) : null}
        </div>
      ) : (
        <p className="text-[0.8125rem] text-[var(--text-muted)]">{t('totp.inactive')}</p>
      )}

      {/* -- Alta ------------------------------------------------------------ */}
      {enrolling ? (
        <Modal
          open
          onOpenChange={(open) => !open && setEnrolling(false)}
          title={t('totp.enable')}
          description={t('totp.scanHelp')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEnrolling(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={code.trim().length < 6}
                loading={confirm.isPending}
                onClick={() => { setError(null); confirm.mutate(code.trim()); }}
              >
                {t('totp.confirm')}
              </Button>
            </>
          }
        >
          {enrollment.isLoading || !enrollment.data ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="space-y-4">
              {/*
                Tres formas de pasar el secreto a la aplicacion, y las tres hacen
                falta porque ninguna sirve siempre:

                - El enlace `otpauth://`, que es la unica que funciona cuando se
                  esta mirando el panel DESDE el movil: ahi el QR es inservible,
                  porque no se puede escanear la pantalla del propio telefono.
                - El QR, para cuando el panel se ve en el ordenador.
                - La clave a mano, para cuando el enlace no abre nada (un
                  escritorio sin ninguna aplicacion OTP registrada) o se prefiere
                  teclearla.

                Va primero el enlace porque es el caso que antes no tenia salida.
              */}
              <div>
                {/*
                  Un ancla normal, no un boton: el sistema resuelve el esquema
                  `otpauth://` y ofrece las aplicaciones instaladas que lo
                  declaran. Android muestra la lista para elegir; iOS abre la que
                  tenga registrada.

                  La URI lleva el secreto, igual que el QR y que la clave de
                  abajo. No anade exposicion: es el mismo dato, en la misma
                  pantalla y bajo la misma sesion.
                */}
                <a href={enrollment.data.uri} className="block">
                  <Button variant="primary" className="w-full justify-center">
                    {t('totp.openInApp')}
                  </Button>
                </a>
                <p className="mt-1 text-center text-[0.75rem] text-[var(--text-muted)]">
                  {t('totp.openInAppHelp')}
                </p>
              </div>

              <div className="flex items-center gap-3 text-[0.75rem] text-[var(--text-faint)]">
                <span className="h-px flex-1 bg-[var(--border)]" />
                {t('totp.orScan')}
                <span className="h-px flex-1 bg-[var(--border)]" />
              </div>

              {/* El QR llega ya renderizado como SVG desde el servidor: asi no
                  entra un generador de codigos QR en el bundle por una pantalla
                  que se usa una vez. */}
              <div
                className="mx-auto w-52 rounded-[var(--radius-sm)] bg-white p-2"
                // El SVG lo genera el servidor a partir de una URI que el propio
                // servidor construye, no de nada que escriba el usuario.
                dangerouslySetInnerHTML={{ __html: enrollment.data.qr }}
              />

              <div>
                <p className="mb-1 text-[0.75rem] text-[var(--text-muted)]">
                  {t('totp.manualEntry')}
                </p>
                <code className="block break-all rounded-[var(--radius-sm)] bg-[var(--bg-inset)] p-2 font-mono text-[0.75rem]">
                  {enrollment.data.secret}
                </code>
              </div>

              <Input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder={t('totp.codePlaceholder')}
                autoComplete="one-time-code"
                autoFocus
              />
              {error ? <p className="text-[0.75rem] text-[var(--danger)]">{error}</p> : null}
            </div>
          )}
        </Modal>
      ) : null}

      {/* -- Codigos de recuperacion, una sola vez ---------------------------- */}
      {recoveryCodes ? (
        <Modal
          open
          onOpenChange={(open) => !open && setRecoveryCodes(null)}
          title={t('totp.recoveryTitle')}
          description={t('totp.recoveryHelp')}
          footer={
            <Button variant="primary" onClick={() => setRecoveryCodes(null)}>
              {t('totp.recoverySaved')}
            </Button>
          }
        >
          <div className="space-y-3">
            <Banner tone="warn" title={t('totp.recoveryOnce')}>
              {t('totp.recoveryOnceHelp')}
            </Banner>
            <ul className="grid grid-cols-2 gap-1.5">
              {recoveryCodes.map((recovery) => (
                <li
                  key={recovery}
                  className="rounded-[var(--radius-sm)] bg-[var(--bg-inset)] px-2 py-1.5 text-center font-mono text-[0.8125rem]"
                >
                  {recovery}
                </li>
              ))}
            </ul>
            <Button
              variant="secondary"
              className="w-full justify-center"
              onClick={() => {
                void navigator.clipboard.writeText(recoveryCodes.join('\n'));
                notify(t('common.copied'), 'ok');
              }}
            >
              {t('common.copy')}
            </Button>
          </div>
        </Modal>
      ) : null}

      {/* -- Contrasena para desactivar o regenerar --------------------------- */}
      {asking ? (
        <Modal
          open
          onOpenChange={(open) => !open && setAsking(null)}
          title={asking === 'disable' ? t('totp.disable') : t('totp.regenerate')}
          description={t('totp.passwordNeeded')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAsking(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant={asking === 'disable' ? 'danger' : 'primary'}
                disabled={!password}
                loading={disable.isPending || regenerate.isPending}
                onClick={() => {
                  setError(null);
                  if (asking === 'disable') disable.mutate(password);
                  else regenerate.mutate(password);
                }}
              >
                {t('common.confirm')}
              </Button>
            </>
          }
        >
          <div className="space-y-2">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
            />
            {error ? <p className="text-[0.75rem] text-[var(--danger)]">{error}</p> : null}
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}
