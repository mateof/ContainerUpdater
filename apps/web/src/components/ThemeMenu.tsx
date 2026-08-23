import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { Button, Menu, THEMES, useTheme, type Theme } from './ui';
import { IconMoon, IconSun } from './icons';

/**
 * Selector de tema.
 *
 * Antes era un interruptor entre claro y oscuro. Con seis temas hace falta una
 * lista, y la lista **se recorre desde `THEMES`**: anadir un tema es escribir su
 * bloque de CSS y su entrada ahi, sin tocar esta pantalla. Es la misma leccion
 * que dejo el galego, cuando el idioma estaba en el catalogo pero la lista de la
 * interfaz se habia escrito a mano y se quedo con dos.
 *
 * Cada entrada lleva una muestra de sus colores REALES, tomados de sus propias
 * variables. Con temas que cambian de forma y no solo de color, un nombre suelto
 * ("Trazo") no dice nada; el punto de color al menos adelanta el ambiente.
 */
export function ThemeMenu({ trigger }: { trigger?: ReactNode }): ReactNode {
  const { t } = useTranslation();
  const [theme, setTheme] = useTheme();

  const opciones: Array<{ id: Theme; label: string }> = [
    { id: 'system', label: t('nav.themeSystem') },
    ...THEMES.map((entry) => ({ id: entry.id as Theme, label: t(`nav.theme_${entry.id}`) })),
  ];

  return (
    <Menu
      trigger={
        trigger ?? (
          <Button size="icon" variant="ghost" aria-label={t('nav.theme')}>
            {theme === 'light' || theme === 'papel' || theme === 'trazo' ? (
              <IconSun size={16} />
            ) : (
              <IconMoon size={16} />
            )}
          </Button>
        )
      }
      items={opciones.map((opcion) => ({
        key: opcion.id,
        label: opcion.id === theme ? `${opcion.label} ✓` : opcion.label,
        icon: <ThemeSwatch id={opcion.id} />,
        onSelect: () => setTheme(opcion.id),
      }))}
    />
  );
}

/**
 * Muestra de un tema: su fondo, su borde y su acento.
 *
 * Se pinta dentro de un elemento con `data-theme` propio, asi que los colores
 * salen de las variables del tema en cuestion y no hay que repetirlos aqui. Si
 * alguien retoca una paleta, la muestra cambia sola.
 */
function ThemeSwatch({ id }: { id: Theme }): ReactNode {
  if (id === 'system') {
    return (
      <span
        aria-hidden="true"
        className="size-3.5 shrink-0 rounded-full border border-[var(--border-strong)]"
        style={{ background: 'linear-gradient(135deg, #111 50%, #eee 50%)' }}
      />
    );
  }
  return (
    <span data-theme={id} aria-hidden="true" className="shrink-0">
      <span
        className="grid size-3.5 place-items-center rounded-full"
        style={{ background: 'var(--bg)', border: '1px solid var(--border-strong)' }}
      >
        <span className="size-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
      </span>
    </span>
  );
}
