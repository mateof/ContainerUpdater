import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { locales, localeNames } from '@cu/shared';
import type { AppSettings, Locale } from '@cu/shared';
import { api } from '@/api/client';
import {
  Badge,
  Banner,
  Button,
  Card,
  Field,
  Input,
  SectionTitle,
  Select,
  cx,
  Skeleton,
  Switch,
  useToast,
} from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { IconGithub, IconStar } from '@/components/icons';
import { MadeBy, REPO_URL } from '@/components/MadeBy';
import { RegistriesSection } from './RegistriesSection';
import { RuntimeSection } from './RuntimeSection';
import { PasskeysSection } from './PasskeysSection';
import { TotpSection } from './TotpSection';
import { TelegramSection } from './TelegramSection';
import { StorageSection } from './StorageSection';
import { BackupSection } from './BackupSection';

/** Horas del dia para los selectores de la ventana de mantenimiento. */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function SettingsPage(): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ['settings'], queryFn: () => api.settings() });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: () => api.status() });

  const [draft, setDraft] = useState<AppSettings | null>(null);

  // El borrador se inicializa una vez cuando llegan los datos. Sincronizarlo en
  // cada render pisaria lo que el usuario esta escribiendo.
  useEffect(() => {
    if (data?.settings && !draft) setDraft(data.settings);
  }, [data?.settings, draft]);

  const save = useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api.saveSettings(patch),
    onSuccess: (result) => {
      notify(t('common.save'), 'ok');
      setDraft(result.settings);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['status'] });
    },
    onError: () => notify(t('common.error'), 'danger'),
  });

  if (isLoading || !draft) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const patch = (changes: Partial<AppSettings>) => setDraft({ ...draft, ...changes });

  /**
   * Si hay algo pendiente de guardar EN ESTA PARTE de la pantalla.
   *
   * Hace falta porque el boton de guardar no manda sobre toda la pagina, y eso
   * confundia: las secciones de abajo (registries, Telegram, segundo factor,
   * almacenamiento, copia) aplican sus cambios al momento, cada una con su
   * propia peticion. Un boton siempre visible y flotando por encima de todas
   * ellas daba a entender que tambien las gobernaba, o peor, que lo que acababas
   * de hacer alli seguia sin guardar.
   *
   * Se recorren las claves del propio objeto en vez de enumerarlas a mano: asi
   * un ajuste nuevo entra en la comparacion solo, sin que nadie se acuerde de
   * anadirlo aqui. Todos los valores son primitivos, asi que `!==` basta.
   */
  const saved = data?.settings ?? null;
  const dirty =
    saved !== null &&
    (Object.keys(draft) as Array<keyof AppSettings>).some((key) => draft[key] !== saved[key]);

  /**
   * Aviso del navegador al cerrar o recargar con cambios sin guardar.
   *
   * Un interruptor que se mueve parece que ya ha hecho algo, asi que es facil
   * darlo por hecho y salir. Se pierde en silencio y el ajuste simplemente
   * nunca existio, que es peor que un error: no hay nada que mirar. El texto lo
   * pone el navegador, no se puede personalizar.
   */
  useEffect(() => {
    if (!dirty) return;
    const avisar = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Sigue haciendo falta en algunos navegadores pese a estar en desuso.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', avisar);
    return () => window.removeEventListener('beforeunload', avisar);
  }, [dirty]);

  return (
    <div className="space-y-5 max-w-3xl">
      <h1 className="text-xl font-semibold tracking-tight">{t('settings.title')}</h1>

      {status && !status.keyringHealthy ? (
        <Banner tone="warn" title={t('errors.keyringLocked')}>
          {t('settings.keyringDegraded')}
        </Banner>
      ) : null}

      {/* Programacion */}
      <Card className="p-5">
        <SectionTitle title={t('settings.schedule')} />
        <div className="space-y-4">
          <Field label={t('settings.checkCron')} hint={t('settings.checkCronHelp')} htmlFor="cron">
            <Input
              id="cron"
              value={draft.checkCron}
              onChange={(event) => patch({ checkCron: event.target.value })}
              className="font-mono"
            />
          </Field>

          {status?.nextCheckAt ? (
            <p className="text-[0.75rem] text-[var(--text-muted)]">
              {t('dashboard.nextCheck')}: {formatDateTime(status.nextCheckAt)}
            </p>
          ) : null}

          <Switch
            checked={draft.autoUpdateEnabled}
            onCheckedChange={(value) => patch({ autoUpdateEnabled: value })}
            label={t('settings.autoUpdateEnabled')}
            hint={t('settings.autoUpdateEnabledHelp')}
          />

          {/*
            Cuarentena y ventana solo se muestran con el auto-update encendido:
            con el apagado no retienen nada y serian dos ajustes que prometen
            algo que no hacen.
          */}
          {draft.autoUpdateEnabled ? (
            <>
              <Field
                label={t('settings.defaultMinAge')}
                hint={t('settings.defaultMinAgeHelp')}
                htmlFor="min-age"
              >
                <Select
                  id="min-age"
                  value={String(draft.defaultMinAgeHours)}
                  onChange={(event) => patch({ defaultMinAgeHours: Number(event.target.value) })}
                  className="w-56"
                >
                  <option value="0">{t('images.minAgeNone')}</option>
                  <option value="24">{t('images.minAgeHours', { count: 24 })}</option>
                  <option value="72">{t('images.minAgeHours', { count: 72 })}</option>
                  <option value="168">{t('images.minAgeDays', { count: 7 })}</option>
                  <option value="336">{t('images.minAgeDays', { count: 14 })}</option>
                </Select>
              </Field>

              <Switch
                checked={draft.maintenanceWindowEnabled}
                onCheckedChange={(value) => patch({ maintenanceWindowEnabled: value })}
                label={t('settings.maintenanceWindow')}
                hint={t('settings.maintenanceWindowHelp')}
              />

              {draft.maintenanceWindowEnabled ? (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label={t('settings.maintenanceStart')} htmlFor="win-start">
                    <Select
                      id="win-start"
                      value={String(draft.maintenanceStartHour)}
                      onChange={(event) =>
                        patch({ maintenanceStartHour: Number(event.target.value) })
                      }
                      className="w-24"
                    >
                      {HOURS.map((hour) => (
                        <option key={hour} value={hour}>
                          {String(hour).padStart(2, '0')}:00
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('settings.maintenanceEnd')} htmlFor="win-end">
                    <Select
                      id="win-end"
                      value={String(draft.maintenanceEndHour)}
                      onChange={(event) => patch({ maintenanceEndHour: Number(event.target.value) })}
                      className="w-24"
                    >
                      {HOURS.map((hour) => (
                        <option key={hour} value={hour}>
                          {String(hour).padStart(2, '0')}:00
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              ) : null}
            </>
          ) : null}

          <Field
            label={t('settings.registryConcurrency')}
            hint={t('settings.registryConcurrencyHelp')}
            htmlFor="concurrency"
          >
            <Input
              id="concurrency"
              type="number"
              min={1}
              max={10}
              value={draft.registryConcurrency}
              onChange={(event) => patch({ registryConcurrency: Number(event.target.value) })}
              className="w-24"
            />
          </Field>
        </div>
      </Card>

      {/* Avisos */}
      <Card className="p-5">
        <SectionTitle title={t('settings.notifications')} />
        <div className="divide-y divide-[var(--border)]">
          <Switch
            checked={draft.notifyOnUpdateAvailable}
            onCheckedChange={(value) => patch({ notifyOnUpdateAvailable: value })}
            label={t('settings.notifyOnUpdateAvailable')}
          />
          <Switch
            checked={draft.notifyOnUpdateApplied}
            onCheckedChange={(value) => patch({ notifyOnUpdateApplied: value })}
            label={t('settings.notifyOnUpdateApplied')}
          />
          <Switch
            checked={draft.notifyOnContainerDown}
            onCheckedChange={(value) => patch({ notifyOnContainerDown: value })}
            label={t('settings.notifyOnContainerDown')}
            hint={t('settings.notifyOnContainerDownHelp')}
          />
          <Switch
            checked={draft.notifyOnContainerRecovered}
            onCheckedChange={(value) => patch({ notifyOnContainerRecovered: value })}
            label={t('settings.notifyOnContainerRecovered')}
          />
          <Switch
            checked={draft.notifyOnFailure}
            onCheckedChange={(value) => patch({ notifyOnFailure: value })}
            label={t('settings.notifyOnFailure')}
          />
        </div>
      </Card>

      {/* Metricas */}
      <Card className="p-5">
        <SectionTitle title={t('settings.metrics')} />
        <div className="space-y-4">
          <Field label={t('settings.metricsInterval')} htmlFor="interval">
            <Input
              id="interval"
              type="number"
              min={2}
              max={60}
              value={draft.metricsIntervalSeconds}
              onChange={(event) => patch({ metricsIntervalSeconds: Number(event.target.value) })}
              className="w-24"
            />
          </Field>

          <Switch
            checked={draft.metricsHistoryEnabled}
            onCheckedChange={(value) => patch({ metricsHistoryEnabled: value })}
            label={t('settings.metricsHistoryEnabled')}
            hint={t('settings.metricsHistoryHelp')}
          />

          <Field label={t('settings.historyRetention')} htmlFor="retention">
            <Input
              id="retention"
              type="number"
              min={1}
              max={365}
              value={draft.historyRetentionDays}
              onChange={(event) => patch({ historyRetentionDays: Number(event.target.value) })}
              className="w-24"
            />
          </Field>

          <Field label={t('nav.language')} htmlFor="locale">
            <Select
              id="locale"
              value={draft.defaultLocale}
              onChange={(event) => patch({ defaultLocale: event.target.value as Locale })}
              className="w-44"
            >
              {/* Recorriendo `locales`: un idioma nuevo aparece aqui solo. */}
              {locales.map((locale) => (
                <option key={locale} value={locale}>
                  {localeNames[locale]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      {/*
        Solo aparece cuando hay cambios sin guardar, y por eso lleva tambien un
        boton para descartarlos: sin el, una vez aparecida la barra no habria
        forma de quitarla salvo guardando o recargando la pagina.
      */}
      {dirty ? (
        <div className="sticky bottom-4 z-20 flex flex-wrap items-center justify-end gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 shadow-[var(--shadow-lg)]">
          <span className="mr-auto text-[0.8125rem] text-[var(--text-muted)]">
            {t('settings.unsaved')}
          </span>
          <Button variant="ghost" onClick={() => setDraft(saved)} disabled={save.isPending}>
            {t('settings.discardChanges')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(draft)}>
            {t('common.save')}
          </Button>
        </div>
      ) : null}

      {/*
        Frontera explicita entre las dos mitades de la pantalla.
        
        Arriba, ajustes que viajan juntos en una sola peticion y necesitan el
        boton. Abajo, cosas que se aplican al momento porque cada una es una
        operacion con su propio efecto: dar de alta una passkey, vincular un
        chat, borrar un volumen. Sin decirlo, la unica forma de averiguar de que
        lado esta cada campo es probar y ver si el boton se enciende.
      */}
      <div className="flex items-center gap-3 pt-1" role="separator">
        <span className="h-px flex-1 bg-[var(--border)]" />
        <span className="text-[0.6875rem] text-[var(--text-muted)]">
          {t('settings.savedOnChange')}
        </span>
        <span className="h-px flex-1 bg-[var(--border)]" />
      </div>

      <TotpSection />

      <PasskeysSection />

      <RuntimeSection />
      <RegistriesSection />
      <TelegramSection />
      <StorageSection />
      <BackupSection />

      {/* Sistema */}
      <Card className="p-5">
        <SectionTitle title={t('settings.system')} />
        <dl className="space-y-2 text-[0.8125rem]">
          <Row label={t('settings.version')}>{status?.version ?? '-'}</Row>
          <Row label={t('settings.dockerVersion')}>
            {status?.dockerConnected ? (
              <span className="flex items-center gap-2">
                <Badge tone="ok">{status.dockerFlavor}</Badge>
                API {status.dockerApiVersion}
              </span>
            ) : (
              <Badge tone="danger">{t('errors.dockerUnavailable')}</Badge>
            )}
          </Row>
          <Row label={t('dashboard.lastCheck')}>{formatDateTime(status?.lastCheckAt)}</Row>
        </dl>
      </Card>

      {/* Acerca de. Va al final a proposito: es lo ultimo que se mira, no lo
          que estorba mientras se configura algo. */}
      <Card className="p-5">
        <SectionTitle title={t('settings.about')} description={t('settings.aboutDescription')} />

        <div className="flex flex-wrap gap-2">
          {/* rel="noreferrer noopener" en todos: sin noopener la pagina abierta
              puede manipular la nuestra por window.opener. */}
          <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
            <Button variant="secondary" icon={<IconGithub size={16} />}>
              {t('settings.viewOnGithub')}
            </Button>
          </a>

          <a href={`${REPO_URL}/issues/new`} target="_blank" rel="noreferrer noopener">
            <Button variant="ghost">{t('settings.reportIssue')}</Button>
          </a>
        </div>

        <a
          href={`${REPO_URL}/stargazers`}
          target="_blank"
          rel="noreferrer noopener"
          className={cx(
            'mt-4 flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2.5',
            'bg-[var(--warn-soft)] text-[var(--warn)]',
            'transition-transform duration-[var(--dur-fast)] hover:-translate-y-0.5',
          )}
        >
          <IconStar size={17} />
          <span className="text-[0.8125rem]">{t('settings.starPrompt')}</span>
        </a>

        <MadeBy className="mt-5" />
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] pb-2 last:border-0">
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
