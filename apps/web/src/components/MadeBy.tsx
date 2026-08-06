import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { IconHeart } from './icons';
import { cx } from './ui';

/** Repositorio del proyecto. En un solo sitio para no repetirlo por la interfaz. */
export const REPO_URL = 'https://github.com/mateof/ContainerUpdater';

/**
 * Credito del autor.
 *
 * El corazon es un SVG y no el emoji: el emoji lo dibuja cada sistema a su
 * manera (y en algunos sale con su propio color, que choca con el tema),
 * mientras que el SVG hereda el color y encaja con el resto de iconos.
 *
 * El texto va partido en dos claves de traduccion en vez de una con el corazon
 * incrustado, para que cada idioma pueda colocarlo donde le corresponda.
 */
export function MadeBy({ className }: { className?: string }): ReactNode {
  const { t } = useTranslation();

  return (
    <p
      className={cx(
        'flex items-center justify-center gap-1 text-[0.6875rem] text-[var(--text-faint)]',
        className,
      )}
    >
      <span>{t('settings.madeWith')}</span>
      <IconHeart
        size={12}
        className="text-[var(--danger)]"
        // El corazon es decorativo: quien use lector de pantalla oye
        // "Hecho con por Mateo", que se entiende igual y evita leer un icono.
        aria-hidden="true"
      />
      <span>{t('settings.madeBy')}</span>
    </p>
  );
}
