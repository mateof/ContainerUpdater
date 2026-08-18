/**
 * Primitivos de interfaz.
 *
 * Los que son dificiles de hacer accesibles de verdad (dialogo modal, menu,
 * interruptor, tooltip) se apoyan en Radix, que ya resuelve foco atrapado,
 * roles ARIA y navegacion por teclado. El resto son componentes propios
 * finos: no merece la pena una dependencia para un boton.
 */
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  MouseEvent,
  ReactNode,
  SelectHTMLAttributes,
  TouchEvent,
} from 'react';

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'icon';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] shadow-[var(--shadow-sm)]',
  secondary:
    'bg-[var(--bg-elevated)] text-[var(--text)] border border-[var(--border)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)]',
  ghost: 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]',
  danger: 'bg-[var(--danger)] text-white hover:brightness-110 shadow-[var(--shadow-sm)]',
  subtle: 'bg-[var(--bg-inset)] text-[var(--text)] hover:bg-[var(--bg-hover)]',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[0.8125rem] gap-1.5',
  md: 'h-9.5 px-4 gap-2',
  icon: 'h-9 w-9 justify-center',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      // `active:scale` en vez de mover el borde: transform va al compositor y
      // no fuerza layout.
      className={cx(
        'inline-flex items-center rounded-[var(--radius-sm)] font-medium select-none',
        'transition-[background-color,border-color,color,transform,opacity] duration-[var(--dur-fast)]',
        'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }): ReactNode {
  return (
    <svg
      className={cx('cu-spin shrink-0', className)}
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Superficies
// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
  glow,
}: {
  children: ReactNode;
  className?: string;
  glow?: boolean;
}): ReactNode {
  return (
    <div
      className={cx(
        'rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-elevated)]',
        'shadow-[var(--shadow-sm)]',
        /*
         * `min-w-0` es lo que impide que la tarjeta se salga de la pantalla.
         *
         * Un elemento de grid o de flex tiene `min-width: auto`, que significa
         * "no encojas por debajo de tu contenido". Basta con que dentro haya
         * algo que no parta (una ruta larga con `truncate`, que implica
         * `white-space: nowrap`) para que la tarjeta crezca hasta el ancho de
         * ese texto. Medido a 375px: las tarjetas de Proyectos llegaban a 659px.
         *
         * El `truncate` del texto no bastaba, porque el que se negaba a encoger
         * era el contenedor, no el texto.
         *
         * Fuera de un grid o un flex esta regla no hace nada, asi que ponerla en
         * la base de Card es seguro y arregla el problema alli donde aparezca.
         */
        'min-w-0',
        glow && 'cu-update-glow',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="flex items-start justify-between gap-4 mb-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="text-[0.8125rem] text-[var(--text-muted)] mt-0.5 max-w-prose">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--bg-inset)] text-[var(--text-muted)] border-[var(--border)]',
  ok: 'bg-[var(--ok-soft)] text-[var(--ok)] border-transparent',
  warn: 'bg-[var(--warn-soft)] text-[var(--warn)] border-transparent',
  danger: 'bg-[var(--danger-soft)] text-[var(--danger)] border-transparent',
  info: 'bg-[var(--info-soft)] text-[var(--info)] border-transparent',
  accent: 'bg-[var(--accent-soft)] text-[var(--accent)] border-transparent',
};

export function Badge({
  children,
  tone = 'neutral',
  dot,
  className,
  title,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
  title?: string;
}): ReactNode {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5',
        'text-[0.6875rem] font-medium whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

/** Punto de estado con anillo animado solo cuando algo esta vivo. */
export function StatusDot({ state }: { state: 'running' | 'stopped' | 'warn' }): ReactNode {
  const color =
    state === 'running' ? 'var(--ok)' : state === 'warn' ? 'var(--warn)' : 'var(--text-faint)';
  return (
    <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
      {state === 'running' ? (
        <span
          className="absolute inset-0 rounded-full"
          style={{ background: color, animation: 'cu-pulse-ring 2.5s ease-out infinite' }}
        />
      ) : null}
      <span className="relative size-2.5 rounded-full" style={{ background: color }} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Formularios
// ---------------------------------------------------------------------------

const FIELD_BASE =
  'w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-inset)] ' +
  'px-3 h-9.5 text-[var(--text)] placeholder:text-[var(--text-faint)] ' +
  'transition-colors duration-[var(--dur-fast)] ' +
  'hover:border-[var(--border-strong)] focus:border-[var(--accent)] focus:outline-none ' +
  'disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx(FIELD_BASE, className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cx(FIELD_BASE, 'cursor-pointer pr-8', className)} {...rest}>
        {children}
      </select>
    );
  },
);

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[0.8125rem] font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[0.75rem] text-[var(--danger)]">{error}</p>
      ) : hint ? (
        <p className="text-[0.75rem] text-[var(--text-muted)] leading-snug">{hint}</p>
      ) : null}
    </div>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}): ReactNode {
  return (
    <label
      className={cx(
        'flex items-start justify-between gap-4 py-2 cursor-pointer',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span className="min-w-0">
        <span className="block text-[0.8125rem] font-medium">{label}</span>
        {hint ? (
          <span className="block text-[0.75rem] text-[var(--text-muted)] leading-snug mt-0.5">
            {hint}
          </span>
        ) : null}
      </span>
      <SwitchPrimitive.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className={cx(
          'relative h-[22px] w-[38px] shrink-0 rounded-full mt-0.5',
          'transition-colors duration-[var(--dur-fast)]',
          'data-[state=checked]:bg-[var(--accent)] data-[state=unchecked]:bg-[var(--border-strong)]',
        )}
      >
        <SwitchPrimitive.Thumb
          className={cx(
            'block size-[18px] rounded-full bg-white shadow-[var(--shadow-sm)]',
            'translate-x-0.5 transition-transform duration-[var(--dur-fast)] will-change-transform',
            'data-[state=checked]:translate-x-[18px]',
          )}
        />
      </SwitchPrimitive.Root>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Modal y confirmacion
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
  resizable,
  storageKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Permite arrastrar la esquina para agrandarlo. Util con registros largos. */
  resizable?: boolean;
  /** Recuerda el tamano elegido entre aperturas. */
  storageKey?: string;
}): ReactNode {
  const [size, setSize] = useResizableSize(storageKey, resizable);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 cu-animate-in" />
        <Dialog.Content
          style={
            resizable && size
              ? { width: `${size.width}px`, height: `${size.height}px`, maxWidth: 'none', maxHeight: 'none' }
              : undefined
          }
          className={cx(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 cu-scale-in',
            'w-[calc(100vw-2rem)] max-h-[85vh] overflow-hidden flex flex-col',
            'rounded-[var(--radius)] border border-[var(--border)] shadow-[var(--shadow-lg)]',
            // Uno de los dos unicos sitios con backdrop-filter.
            'cu-glass',
            wide ? 'max-w-3xl' : 'max-w-lg',
          )}
        >
          {resizable ? <ResizeHandle onResize={setSize} /> : null}
          <div className="px-5 pt-5 pb-3">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            {description ? (
              <Dialog.Description className="text-[0.8125rem] text-[var(--text-muted)] mt-1">
                {description}
              </Dialog.Description>
            ) : null}
          </div>
          {children ? <div className="px-5 pb-4 overflow-y-auto flex-1">{children}</div> : null}
          {footer ? (
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--border)] bg-[var(--bg-inset)]/50">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface Size {
  width: number;
  height: number;
}

/**
 * Tamano del modal, recordado entre aperturas.
 *
 * Quien agranda el modal de registros lo hace porque su pantalla da para mas;
 * volver al tamano por defecto cada vez obligaria a repetir el gesto en cada
 * contenedor que abra.
 */
function useResizableSize(
  storageKey: string | undefined,
  enabled: boolean | undefined,
): [Size | null, (size: Size) => void] {
  const [size, setSizeState] = useState<Size | null>(() => {
    if (!enabled || !storageKey) return null;
    try {
      const stored = localStorage.getItem(`cu-modal-${storageKey}`);
      if (!stored) return null;
      const parsed = JSON.parse(stored) as Size;
      // Un tamano guardado en un monitor grande no puede desbordar una pantalla
      // pequena: se acota a lo que quepa ahora.
      return {
        width: Math.min(parsed.width, window.innerWidth - 32),
        height: Math.min(parsed.height, window.innerHeight - 32),
      };
    } catch {
      return null;
    }
  });

  const setSize = useCallback(
    (next: Size) => {
      setSizeState(next);
      if (!storageKey) return;
      try {
        localStorage.setItem(`cu-modal-${storageKey}`, JSON.stringify(next));
      } catch {
        // Sin persistencia el tamano dura lo que la sesion.
      }
    },
    [storageKey],
  );

  return [size, setSize];
}

/**
 * Tirador de redimension en la esquina inferior derecha.
 *
 * Se escucha en `window` y no en el propio tirador: si el puntero se adelanta
 * al arrastrar, sale del elemento y el gesto se cortaria a medias.
 */
function ResizeHandle({ onResize }: { onResize: (size: Size) => void }): ReactNode {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Redimensionar"
      onPointerDown={(event) => {
        event.preventDefault();
        const content = event.currentTarget.parentElement;
        if (!content) return;

        const startX = event.clientX;
        const startY = event.clientY;
        const rect = content.getBoundingClientRect();

        const onMove = (move: PointerEvent): void => {
          // Se multiplica por 2 porque el modal esta centrado: crece por los
          // dos lados a la vez, asi que el borde solo avanza la mitad de lo que
          // se arrastra.
          onResize({
            width: Math.max(360, Math.min(rect.width + (move.clientX - startX) * 2, window.innerWidth - 32)),
            height: Math.max(240, Math.min(rect.height + (move.clientY - startY) * 2, window.innerHeight - 32)),
          });
        };

        const onUp = (): void => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          document.body.style.userSelect = '';
        };

        // Sin esto, arrastrar selecciona el texto del modal.
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      }}
      className={cx(
        'absolute bottom-0 right-0 z-10 size-5 cursor-nwse-resize',
        'text-[var(--text-faint)] hover:text-[var(--text-muted)]',
      )}
    >
      <svg viewBox="0 0 16 16" className="size-full p-1" aria-hidden="true">
        <path d="M14 6 6 14M14 11l-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger,
  loading,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}): ReactNode {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Tooltip y menu
// ---------------------------------------------------------------------------

export function TooltipProvider({ children }: { children: ReactNode }): ReactNode {
  return (
    <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={200}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

/**
 * Etiqueta al pasar el raton y al MANTENER PULSADO en tactil.
 *
 * Radix abre el tooltip con el raton y con el foco de teclado, pero en una
 * pantalla tactil no hay ninguno de los dos: quien usa el movil ve iconos sin
 * ninguna forma de averiguar que hacen. Eso pesa mas de lo normal aqui, donde
 * varias acciones se distinguen solo por el dibujo.
 *
 * Se replica lo que hace una aplicacion nativa: mantener pulsado medio segundo
 * ensena la etiqueta. Detalles que hacen que no estorbe:
 *
 * - Si el dedo se mueve mas de 10 pixeles, se cancela: estaba desplazando la
 *   lista, no consultando el boton.
 * - Al soltar se cierra, y ademas se cancela el clic de esa pulsacion. Si no,
 *   consultar que hace un boton lo ejecutaria, que es lo contrario de lo que
 *   busca quien lo mantiene pulsado.
 */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const longPressed = useRef(false);

  const clear = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };

  const touchHandlers = {
    onTouchStart: (event: TouchEvent<HTMLElement>) => {
      const touch = event.touches[0];
      if (!touch) return;
      longPressed.current = false;
      start.current = { x: touch.clientX, y: touch.clientY };
      timer.current = setTimeout(() => {
        longPressed.current = true;
        setOpen(true);
      }, 500);
    },
    onTouchMove: (event: TouchEvent<HTMLElement>) => {
      const touch = event.touches[0];
      if (!touch || !start.current) return;
      const moved =
        Math.abs(touch.clientX - start.current.x) + Math.abs(touch.clientY - start.current.y);
      // Se esta desplazando la pantalla, no consultando el boton.
      if (moved > 10) clear();
    },
    onTouchEnd: () => {
      clear();
      if (longPressed.current) setOpen(false);
    },
    onTouchCancel: () => {
      clear();
      setOpen(false);
    },
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      // Consultar la etiqueta no puede disparar la accion.
      if (!longPressed.current) return;
      longPressed.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  if (!content) return <>{children}</>;
  return (
    <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
      <TooltipPrimitive.Trigger asChild {...touchHandlers}>
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          collisionPadding={8}
          // Sin esto, al mantener pulsado el navegador movil roba el evento para
          // su propio menu de seleccion y la etiqueta parpadea.
          onPointerDownOutside={(event) => event.preventDefault()}
          className={cx(
            'z-50 max-w-xs rounded-[var(--radius-sm)] px-2.5 py-1.5 cu-scale-in',
            'bg-[var(--bg-elevated)] border border-[var(--border)] shadow-[var(--shadow)]',
            'text-[0.75rem] leading-snug text-[var(--text)]',
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function Menu({
  trigger,
  items,
}: {
  trigger: ReactNode;
  items: Array<
    | { type: 'separator'; key: string }
    | {
        type?: 'item';
        key: string;
        label: string;
        icon?: ReactNode;
        danger?: boolean;
        disabled?: boolean;
        /**
         * Quita la entrada del menu en vez de apagarla.
         *
         * `disabled` y `hidden` responden a preguntas distintas: apagada dice
         * "esto existe pero ahora no se puede", oculta dice "esto no aplica
         * aqui". Volver a una version anterior cuando nunca ha habido una
         * actualizacion es el segundo caso, y un boton apagado eterno solo
         * genera la duda de que hay que hacer para encenderlo.
         */
        hidden?: boolean;
        onSelect: () => void;
      }
  >;
}): ReactNode {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className={cx(
            'z-50 min-w-[190px] rounded-[var(--radius-sm)] p-1 cu-scale-in',
            'bg-[var(--bg-elevated)] border border-[var(--border)] shadow-[var(--shadow-lg)]',
          )}
        >
          {items
            .filter((item) => item.type === 'separator' || !item.hidden)
            .map((item) =>
            item.type === 'separator' ? (
              <DropdownMenu.Separator key={item.key} className="my-1 h-px bg-[var(--border)]" />
            ) : (
              <DropdownMenu.Item
                key={item.key}
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={cx(
                  'flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 cursor-pointer',
                  'text-[0.8125rem] outline-none select-none',
                  'data-[highlighted]:bg-[var(--bg-hover)]',
                  'data-[disabled]:opacity-40 data-[disabled]:pointer-events-none',
                  item.danger && 'text-[var(--danger)]',
                )}
              >
                {item.icon}
                {item.label}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

export function Skeleton({ className }: { className?: string }): ReactNode {
  return <div className={cx('cu-skeleton', className)} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center py-14 px-6 text-center cu-animate-in">
      {icon ? <div className="mb-3 text-[var(--text-faint)]">{icon}</div> : null}
      <p className="font-medium">{title}</p>
      {description ? (
        <p className="text-[0.8125rem] text-[var(--text-muted)] mt-1 max-w-sm">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Banner({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'danger';
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}): ReactNode {
  const styles = {
    info: 'bg-[var(--info-soft)] text-[var(--info)]',
    warn: 'bg-[var(--warn-soft)] text-[var(--warn)]',
    danger: 'bg-[var(--danger-soft)] text-[var(--danger)]',
  }[tone];

  return (
    <div
      role="status"
      className={cx(
        'flex items-start gap-3 rounded-[var(--radius)] px-4 py-3 cu-animate-in',
        styles,
      )}
    >
      <div className="flex-1 min-w-0">
        <p className="text-[0.8125rem] font-semibold">{title}</p>
        {children ? (
          <div className="text-[0.8125rem] opacity-90 mt-0.5 leading-snug">{children}</div>
        ) : null}
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Avisos efimeros
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'danger' | 'info';
}

const ToastContext = createContext<{
  notify: (message: string, tone?: Toast['tone']) => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 5000);
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
        role="region"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cx(
              'cu-animate-in pointer-events-auto max-w-sm rounded-[var(--radius-sm)] px-4 py-2.5',
              'border shadow-[var(--shadow-lg)] text-[0.8125rem] cu-glass',
              toast.tone === 'ok' && 'border-[var(--ok)] text-[var(--ok)]',
              toast.tone === 'danger' && 'border-[var(--danger)] text-[var(--danger)]',
              toast.tone === 'info' && 'border-[var(--border)] text-[var(--text)]',
            )}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (message: string, tone?: Toast['tone']) => void {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast debe usarse dentro de ToastProvider');
  return context.notify;
}

// ---------------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------------

export type Theme = 'light' | 'dark' | 'system';

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem('cu-theme');
      return stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch {
      return 'system';
    }
  });

  const apply = useCallback((next: Theme) => {
    const dark =
      next === 'dark' ||
      (next === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    // Cambiar un atributo del html es todo lo que hace falta: los tokens son
    // custom properties, asi que React no vuelve a renderizar nada.
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, []);

  useEffect(() => {
    apply(theme);
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => apply('system');
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [theme, apply]);

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeState(next);
      try {
        if (next === 'system') localStorage.removeItem('cu-theme');
        else localStorage.setItem('cu-theme', next);
      } catch {
        // Sin persistencia el tema dura la sesion.
      }
      apply(next);
    },
    [apply],
  );

  return [theme, setTheme];
}
