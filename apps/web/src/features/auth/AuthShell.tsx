import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { Button, Menu, useTheme } from '@/components/ui';
import { IconMoon, IconSun } from '@/components/icons';
import { MadeBy } from '@/components/MadeBy';
import { currentLocale, setLocale } from '@/i18n';
import { useState } from 'react';

/**
 * Marco de las pantallas sin sesion.
 *
 * El selector de idioma y tema esta disponible ya en el login: es la primera
 * pantalla que ve alguien y no deberia tener que entrar para poder leerla en su
 * idioma.
 */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}): ReactNode {
  const { t } = useTranslation();
  const [theme, setTheme] = useTheme();
  const [, forceRender] = useState(0);

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden px-4">
      {/* Fondo decorativo. Es estatico: una animacion de fondo permanente
          consume GPU sin parar y aqui no aporta nada. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.55]"
        style={{
          background:
            'radial-gradient(60rem 40rem at 15% -10%, color-mix(in oklab, var(--accent) 22%, transparent), transparent 60%),' +
            'radial-gradient(50rem 36rem at 100% 110%, color-mix(in oklab, var(--info) 18%, transparent), transparent 60%)',
        }}
      />

      <div className="absolute right-4 top-4 flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('nav.theme')}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
        </Button>
        <Menu
          trigger={
            <Button size="icon" variant="ghost" aria-label={t('nav.language')}>
              <span className="text-[0.6875rem] font-bold">{currentLocale().toUpperCase()}</span>
            </Button>
          }
          items={[
            {
              key: 'es',
              label: 'Espanol',
              onSelect: () => {
                setLocale('es');
                forceRender((n) => n + 1);
              },
            },
            {
              key: 'en',
              label: 'English',
              onSelect: () => {
                setLocale('en');
                forceRender((n) => n + 1);
              },
            },
          ]}
        />
      </div>

      <div className="relative w-full max-w-[380px] cu-animate-in">
        <div className="mb-6 flex flex-col items-center text-center">
          <div
            className="mb-4 grid size-12 place-items-center rounded-[14px] text-white shadow-[var(--shadow)]"
            style={{
              background:
                'linear-gradient(135deg, var(--accent), color-mix(in oklab, var(--accent) 55%, var(--info)))',
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M21 8 12 3 3 8v8l9 5 9-5z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <path d="m3 8 9 5 9-5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? (
            <p className="mt-1 text-[0.8125rem] text-[var(--text-muted)]">{subtitle}</p>
          ) : null}
        </div>

        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow-lg)]">
          {children}
        </div>

        <MadeBy className="mt-5" />
      </div>
    </div>
  );
}
