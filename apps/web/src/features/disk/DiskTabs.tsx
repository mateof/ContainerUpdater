import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { cx } from '@/components/ui';

export function DiskTabs(): ReactNode {
  const { t } = useTranslation();
  const tabs = [
    { to: '/disk', label: t('disk.tabWrites'), end: true },
    { to: '/disk/health', label: t('disk.tabHealth'), end: false },
  ];
  return (
    <nav className="flex gap-1.5" aria-label={t('nav.disk')}>
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            cx(
              'rounded-full px-3 py-1 text-[0.8125rem] font-medium transition-colors duration-[var(--dur-fast)]',
              isActive
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'bg-[var(--bg-inset)] text-[var(--text-muted)] hover:text-[var(--text)]',
            )
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
