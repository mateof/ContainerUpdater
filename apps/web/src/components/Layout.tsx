import { useQuery } from '@tanstack/react-query';
import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { locales, localeNames } from '@cu/shared';
import { api } from '@/api/client';
import { LocaleFlag } from '@/components/flags';
import { useAuth } from '@/hooks/useAuth';
import { useEvents } from '@/hooks/useEvents';
import { LiveContext } from '@/hooks/LiveContext';
import { setLocale, currentLocale } from '@/i18n';
import { Badge, Button, Menu, Spinner, Tooltip, cx, useTheme } from './ui';
import { MadeBy, REPO_URL } from './MadeBy';
import { HelpDialog } from '@/features/help/HelpDialog';
import {
  IconContainer,
  IconDashboard,
  IconImage,
  IconLogout,
  IconMoon,
  IconMore,
  IconProject,
  IconSettings,
  IconSun,
  IconUpdates,
  IconGithub,
  IconStar,
  IconHelp,
} from './icons';

interface NavEntry {
  to: string;
  key: string;
  Icon: (props: { size?: number }) => ReactNode;
  /** Solo la raiz necesita coincidencia exacta; el resto son prefijos. */
  end: boolean;
}

const NAV: NavEntry[] = [
  { to: '/', key: 'nav.dashboard', Icon: IconDashboard, end: true },
  { to: '/containers', key: 'nav.containers', Icon: IconContainer, end: false },
  { to: '/images', key: 'nav.images', Icon: IconImage, end: false },
  { to: '/projects', key: 'nav.projects', Icon: IconProject, end: false },
  { to: '/updates', key: 'nav.updates', Icon: IconUpdates, end: false },
  { to: '/settings', key: 'nav.settings', Icon: IconSettings, end: false },
];

export function Layout({ children }: { children: ReactNode }): ReactNode {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const location = useLocation();
  const [theme, setTheme] = useTheme();
  const [, forceRender] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);

  const live = useEvents(true);

  const { data: status } = useQuery({
    queryKey: ['status'],
    queryFn: () => api.status(),
    // Fallback por si el SSE se corta tras el proxy inverso: 30 segundos no
    // cargan nada y garantizan que la cabecera no se quede congelada.
    refetchInterval: 30_000,
  });

  const updates = status?.updatesAvailable ?? 0;

  return (
    <LiveContext.Provider value={live}>
      <div className="flex h-full">
        {/* Barra lateral. En movil se convierte en barra inferior. */}
        <aside
          className={cx(
            'hidden md:flex w-[216px] shrink-0 flex-col gap-1 p-3',
            'border-r border-[var(--border)] bg-[var(--bg-elevated)]',
          )}
        >
          <div className="flex items-center gap-2.5 px-2 py-3 mb-2">
            <Logo />
            <div className="min-w-0">
              <p className="font-semibold text-sm leading-tight truncate">ContainerUpdater</p>
              <p className="text-[0.6875rem] text-[var(--text-faint)] leading-tight">
                v{status?.version ?? '...'}
              </p>
            </div>
          </div>

          <nav className="flex flex-col gap-0.5">
            {NAV.map(({ to, key, Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cx(
                    'group relative flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2',
                    'text-[0.8125rem] font-medium transition-colors duration-[var(--dur-fast)]',
                    isActive
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]',
                  )
                }
              >
                <Icon size={17} />
                <span className="flex-1">{t(key)}</span>
                {to === '/images' && updates > 0 ? (
                  <Badge tone="accent" className="px-1.5 py-0 tabular-nums">
                    {updates}
                  </Badge>
                ) : null}
                {/* Aviso de que hay una actualizacion corriendo en segundo
                    plano, para que se vea desde cualquier pantalla. */}
                {to === '/updates' && live.activeJob ? (
                  <Spinner className="size-3.5 text-[var(--accent)]" />
                ) : null}
              </NavLink>
            ))}
          </nav>

          <div className="mt-auto space-y-2 pt-3">
            {/* La ayuda vive en un modal y no en una ruta: se consulta mientras
                se esta haciendo algo, y cambiar de pantalla obligaria a
                recuperar el sitio al volver. */}
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className={cx(
                'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5',
                'text-[0.75rem] text-[var(--text-muted)]',
                'transition-colors duration-[var(--dur-fast)]',
                'hover:bg-[var(--bg-hover)] hover:text-[var(--text)]',
              )}
            >
              <IconHelp size={15} />
              <span className="flex-1 text-left">{t('help.open')}</span>
            </button>

            {/* Enlace al repositorio. Discreto y al fondo: esta ahi para quien
                lo busque, sin robar atencion al panel. */}
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              className={cx(
                'flex items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5',
                'text-[0.75rem] text-[var(--text-muted)]',
                'transition-colors duration-[var(--dur-fast)]',
                'hover:bg-[var(--bg-hover)] hover:text-[var(--text)]',
              )}
            >
              <IconGithub size={15} />
              <span className="flex-1">GitHub</span>
              <IconStar size={13} className="text-[var(--warn)]" />
            </a>

            <ConnectionIndicator connected={live.connected} dockerOk={status?.dockerConnected} />
            <div className="flex items-center gap-1 px-1">
              <Tooltip content={t('nav.theme')}>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('nav.theme')}
                  onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                >
                  {theme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
                </Button>
              </Tooltip>

              {/* Se recorre `locales` en vez de enumerarlos: anadir un idioma es
                  anadirlo al catalogo, sin tocar esta pantalla. Antes estaban a
                  mano y el tercero habria pasado desapercibido aqui. */}
              <Menu
                trigger={
                  <Button size="icon" variant="ghost" aria-label={t('nav.language')}>
                    <LocaleFlag locale={currentLocale()} />
                  </Button>
                }
                items={locales.map((locale) => ({
                  key: locale,
                  // El nombre va en su propio idioma: quien busca el suyo lo
                  // reconoce como el lo escribe.
                  label: localeNames[locale],
                  icon: <LocaleFlag locale={locale} />,
                  onSelect: () => {
                    setLocale(locale);
                    void api.updateProfile(locale);
                    forceRender((n) => n + 1);
                  },
                }))}
              />

              <Menu
                trigger={
                  <Button
                    size="sm"
                    variant="ghost"
                    className="flex-1 justify-between min-w-0"
                    aria-label={user?.username}
                  >
                    <span className="truncate">{user?.username}</span>
                    <IconMore size={15} />
                  </Button>
                }
                items={[
                  {
                    key: 'logout',
                    label: t('nav.logout'),
                    icon: <IconLogout size={15} />,
                    danger: true,
                    onSelect: () => void logout(),
                  },
                ]}
              />
            </div>

            <MadeBy className="pb-1" />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/*
            Cabecera solo en movil.
            
            Todo lo que no es navegar (idioma, tema, ayuda, cerrar sesion) vivia
            unicamente en la barra lateral, que es `hidden md:flex`. En un movil
            no habia forma de llegar a ello: el idioma se podia cambiar desde el
            escritorio y desde el telefono no se veia por ningun sitio.
          */}
          <header className="md:hidden sticky top-0 z-30 flex items-center gap-2 border-b border-[var(--border)] px-4 py-2 cu-glass">
            <Logo />
            <span className="flex-1 truncate text-[0.875rem] font-semibold">
              {t('common.appName')}
            </span>

            <Tooltip content={t('help.open')}>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('help.open')}
                onClick={() => setHelpOpen(true)}
              >
                <IconHelp size={17} />
              </Button>
            </Tooltip>

            <Menu
              trigger={
                <Button size="icon" variant="ghost" aria-label={t('nav.language')}>
                  <LocaleFlag locale={currentLocale()} />
                </Button>
              }
              items={locales.map((locale) => ({
                key: locale,
                label: localeNames[locale],
                icon: <LocaleFlag locale={locale} />,
                onSelect: () => {
                  setLocale(locale);
                  void api.updateProfile(locale);
                  forceRender((n) => n + 1);
                },
              }))}
            />

            <Menu
              trigger={
                <Button size="icon" variant="ghost" aria-label={t('common.showMore')}>
                  <IconMore size={17} />
                </Button>
              }
              items={[
                {
                  key: 'theme',
                  label: theme === 'dark' ? t('nav.themeLight') : t('nav.themeDark'),
                  icon: theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />,
                  onSelect: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
                },
                {
                  key: 'github',
                  label: 'GitHub',
                  icon: <IconGithub size={15} />,
                  onSelect: () => window.open(REPO_URL, '_blank', 'noreferrer,noopener'),
                },
                { type: 'separator', key: 'sep' },
                {
                  key: 'logout',
                  label: t('nav.logout'),
                  icon: <IconLogout size={15} />,
                  danger: true,
                  onSelect: () => void logout(),
                },
              ]}
            />
          </header>

          <main
            key={location.pathname}
            className="flex-1 overflow-y-auto px-4 py-5 md:px-7 md:py-6 cu-animate-in pb-20 md:pb-6"
          >
            <div className="mx-auto w-full max-w-[1400px]">{children}</div>
          </main>

          {/* Navegacion inferior en movil. */}
          <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 flex border-t border-[var(--border)] cu-glass">
            {NAV.map(({ to, key, Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cx(
                    'relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[0.625rem]',
                    isActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]',
                  )
                }
              >
                <Icon size={19} />
                <span className="truncate max-w-full px-0.5">{t(key)}</span>
                {(to === '/images' && updates > 0) ||
                (to === '/updates' && live.activeJob) ? (
                  <span className="absolute top-1 right-[22%] size-1.5 rounded-full bg-[var(--accent)]" />
                ) : null}
              </NavLink>
            ))}
          </nav>
        </div>
      </div>
      {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} /> : null}
    </LiveContext.Provider>
  );
}

function Logo(): ReactNode {
  return (
    <div
      className="grid size-8 shrink-0 place-items-center rounded-[9px] text-white"
      style={{
        background: 'linear-gradient(135deg, var(--accent), color-mix(in oklab, var(--accent) 60%, var(--info)))',
      }}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M21 8 12 3 3 8v8l9 5 9-5z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
        <path d="m3 8 9 5 9-5" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function ConnectionIndicator({
  connected,
  dockerOk,
}: {
  connected: boolean;
  dockerOk: boolean | undefined;
}): ReactNode {
  const { t } = useTranslation();

  if (dockerOk === false) {
    return (
      <div className="px-2">
        <Badge tone="danger" dot>
          {t('errors.dockerUnavailable')}
        </Badge>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 px-2.5 text-[0.6875rem] text-[var(--text-faint)]">
      <span
        className={cx('size-1.5 rounded-full', connected ? 'bg-[var(--ok)]' : 'bg-[var(--warn)]')}
      />
      {connected ? 'en vivo' : 'reconectando'}
    </div>
  );
}
