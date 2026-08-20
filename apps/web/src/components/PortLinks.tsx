import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { buildPortLink, type PortSpec } from '@cu/shared';
import { api } from '@/api/client';
import { Tooltip } from './ui';
import { IconExternal } from './icons';

/**
 * Puertos publicados de un contenedor, como enlaces cuando se puede.
 *
 * El host sale del navegador (`window.location.hostname`) y no de ningun sitio
 * del servidor. Es la respuesta que acierta sola: si estas viendo el panel en
 * `192.168.0.22:8210`, los contenedores corren en esa misma maquina, porque la
 * aplicacion gestiona su daemon local. Cuando eso no vale (un dominio detras de
 * un proxy inverso que no publica los puertos de los contenedores) se rellena a
 * mano en Ajustes.
 *
 * Los que no se pueden abrir NO se convierten en enlaces rotos: se enseñan
 * igual, apagados, y el tooltip dice por que.
 */
export function PortLinks({ ports }: { ports: PortSpec[] }): ReactNode {
  const { t } = useTranslation();
  // Misma clave que Ajustes: reutiliza la cache en vez de pedirlo otra vez.
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.settings() });
  const configuredHost = settings.data?.settings.serviceHost ?? '';

  if (ports.length === 0) return null;

  const viewerHost = typeof window === 'undefined' ? '' : window.location.hostname;

  const motivos: Record<string, string> = {
    'not-published': 'containers.portNotPublished',
    'not-browsable': 'containers.portNotBrowsable',
    loopback: 'containers.portLoopback',
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ports.map((port, index) => {
        const link = buildPortLink(port, { configuredHost, viewerHost });
        const clave = `${port.privatePort}-${port.publicPort ?? 'x'}-${index}`;

        if (!link.url) {
          return (
            <Tooltip key={clave} content={t(motivos[link.reason ?? 'not-published']!)}>
              <span className="rounded-[5px] border border-[var(--border)] px-1.5 py-0.5 font-mono text-[0.6875rem] text-[var(--text-muted)]">
                {link.label}
              </span>
            </Tooltip>
          );
        }

        return (
          <Tooltip key={clave} content={t('containers.openService', { url: link.url })}>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              // Para que pulsar el enlace no abra ademas la ficha del
              // contenedor, que es lo que hace el clic en la fila.
              onClick={(event) => event.stopPropagation()}
              className="inline-flex items-center gap-1 rounded-[5px] border border-[var(--border)] px-1.5 py-0.5 font-mono text-[0.6875rem] text-[var(--accent)] hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]"
            >
              {link.label}
              <IconExternal size={10} />
            </a>
          </Tooltip>
        );
      })}
    </div>
  );
}
