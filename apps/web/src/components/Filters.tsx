import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Input, cx } from '@/components/ui';
import { IconSearch, IconClose } from '@/components/icons';

/**
 * Buscador y filtros, compartidos por Contenedores, Imagenes y Proyectos.
 *
 * Estaban copiados en dos pantallas y hacia falta una tercera, que es cuando
 * duplicar deja de salir a cuenta: cualquier arreglo (el foco, el borrado, el
 * tamano en movil) habria que hacerlo tres veces y se olvidaria una.
 */

export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}): ReactNode {
  const { t } = useTranslation();

  return (
    <div className="relative">
      <IconSearch
        size={15}
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
      />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? t('common.search')}
        className="w-48 pl-8 sm:w-60"
        type="search"
      />
    </div>
  );
}

export interface FilterOption<T extends string> {
  key: T;
  label: string;
  /** Cuantos elementos caen en este filtro. Se oculta si es cero y no esta activo. */
  count?: number;
}

/**
 * Pastillas de filtro con su recuento.
 *
 * El numero no es decoracion: dice de un vistazo si merece la pena pulsar. Un
 * "Con actualizaciones" a cero ahorra el clic y la decepcion.
 */
export function FilterPills<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<FilterOption<T>>;
}): ReactNode {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const active = value === option.key;
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => onChange(option.key)}
            className={cx(
              'flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.75rem] font-medium',
              'transition-colors duration-[var(--dur-fast)]',
              active
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'bg-[var(--bg-inset)] text-[var(--text-muted)] hover:text-[var(--text)]',
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className={cx('tabular-nums', !active && 'text-[var(--text-faint)]')}>
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Aviso de que la lista viene filtrada desde otra pantalla.
 *
 * Sin esto, llegar a Contenedores desde una imagen y ver tres de veinte parece
 * que falten contenedores. Dice por que esta recortada y da un boton para
 * deshacerlo, que es la primera pregunta de quien llega aqui.
 */
export function FocusBanner({
  label,
  value,
  onClear,
}: {
  label: string;
  value: string;
  onClear: () => void;
}): ReactNode {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--accent-soft)] px-3 py-2 text-[0.8125rem] cu-animate-in">
      <span className="text-[var(--accent)]">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem]">{value}</span>
      <button
        type="button"
        onClick={onClear}
        className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.75rem] text-[var(--accent)] hover:bg-[var(--accent)]/10"
      >
        <IconClose size={13} />
        {t('common.clearFilter')}
      </button>
    </div>
  );
}

/**
 * Enlace a otra pantalla llevando el filtro puesto.
 *
 * Se pinta como texto y no como boton a proposito: va dentro de las lineas de
 * metadatos de cada fila, donde un boton de verdad competiria visualmente con
 * las acciones reales de la derecha.
 */
export function CrossLink({
  to,
  title,
  children,
  mono,
  onNavigate,
}: {
  to: string;
  title: string;
  children: ReactNode;
  mono?: boolean;
  /** Para cerrar el modal desde el que se navega: dejarlo abierto sobre otra
      pantalla desorienta. */
  onNavigate?: () => void;
}): ReactNode {
  return (
    <Link
      to={to}
      title={title}
      onClick={onNavigate}
      className={cx(
        'max-w-full truncate rounded-[var(--radius-sm)] px-1 -mx-1',
        'text-[var(--text-muted)] underline decoration-dotted underline-offset-2',
        'hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]',
        'transition-colors duration-[var(--dur-fast)]',
        mono && 'font-mono',
      )}
    >
      {children}
    </Link>
  );
}
