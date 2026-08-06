import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { UpdateJob } from '@cu/shared';
import { Button, Spinner, Tooltip } from './ui';

/**
 * Indicador de que un elemento se esta actualizando ahora mismo.
 *
 * Sustituye al boton de actualizar mientras el trabajo esta vivo: dejarlo
 * visible invitaria a pulsarlo otra vez y encolar una segunda actualizacion de
 * lo mismo.
 *
 * Al pulsarlo lleva a Actualizaciones apuntando a ESTE trabajo, que es lo que
 * el usuario quiere ver cuando hace clic en un indicador concreto y no una
 * lista donde tenga que buscarlo.
 */
export function JobIndicator({
  job,
  size = 'sm',
}: {
  job: UpdateJob;
  size?: 'sm' | 'icon';
}): ReactNode {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const running = job.status === 'running';
  const label = running ? t('updates.inProgress') : t('updates.waiting');

  return (
    <Tooltip content={`${label}. ${t('updates.viewLog')}`}>
      <Button
        size={size}
        variant="subtle"
        onClick={() => navigate(`/updates?job=${job.id}`)}
        aria-label={label}
        className={running ? 'cu-update-glow' : undefined}
      >
        {running ? (
          <Spinner className="size-3.5 text-[var(--accent)]" />
        ) : (
          // En cola: un reloj estatico distingue de un vistazo "esperando turno"
          // de "trabajando", sin tener que leer el texto.
          <span className="grid size-3.5 place-items-center text-[var(--text-muted)]" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" strokeLinecap="round" />
            </svg>
          </span>
        )}
        {size === 'sm' ? <span className="hidden sm:inline">{label}</span> : null}
      </Button>
    </Tooltip>
  );
}
