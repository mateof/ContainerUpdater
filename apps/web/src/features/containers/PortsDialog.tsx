import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { buildPortLink, buildPortsTable, portsToCsv, type PortRow } from '@cu/shared';
import { api } from '@/api/client';
import { Badge, Button, Input, Modal, Tooltip, cx, useToast } from '@/components/ui';
import { IconDownload, IconExternal, IconSearch } from '@/components/icons';
import { CrossLink } from '@/components/Filters';

/**
 * Resumen de los puertos publicados de la maquina.
 *
 * Responde a una pregunta concreta que uno se hace cada vez que va a levantar
 * algo nuevo: que puertos tengo pillados y quien los tiene. Estaba la
 * informacion, repartida por veinticuatro tarjetas de contenedor, que es como
 * no tenerla.
 *
 * Todo sale de los contenedores que ya estan cargados, asi que no hay peticion
 * nueva ni endpoint nuevo: es la misma lista mirada por el otro lado.
 */
export function PortsDialog({ onClose }: { onClose: () => void }): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const [filtro, setFiltro] = useState('');

  const { data } = useQuery({ queryKey: ['containers'], queryFn: () => api.containers() });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.settings() });
  const configuredHost = settings.data?.settings.serviceHost ?? '';

  const resumen = useMemo(
    () => buildPortsTable(data?.containers ?? []),
    [data?.containers],
  );

  const filas = useMemo(() => {
    const aguja = filtro.trim().toLowerCase();
    if (!aguja) return resumen.rows;
    return resumen.rows.filter(
      (row) =>
        String(row.publicPort).includes(aguja) ||
        row.containerName.toLowerCase().includes(aguja) ||
        (row.projectName ?? '').toLowerCase().includes(aguja) ||
        row.image.toLowerCase().includes(aguja),
    );
  }, [resumen.rows, filtro]);

  /**
   * Descarga el CSV.
   *
   * Se construye en el navegador con un blob en vez de pedirselo al servidor:
   * el dato ya esta aqui, y asi no hay endpoint nuevo que autenticar ni una
   * segunda forma de generar la misma tabla que pueda discrepar de la que se ve.
   */
  const exportar = (): void => {
    const csv = portsToCsv(filas);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = `puertos-${new Date().toISOString().slice(0, 10)}.csv`;
    enlace.click();
    URL.revokeObjectURL(url);
    notify(t('ports.exported', { count: filas.length }), 'ok');
  };

  const viewerHost = typeof window === 'undefined' ? '' : window.location.hostname;

  return (
    <Modal
      open
      onOpenChange={(abierto) => !abierto && onClose()}
      wider
      title={t('ports.title')}
      description={t('ports.subtitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button variant="primary" icon={<IconDownload size={15} />} onClick={exportar}>
            {t('ports.export')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Resumen valor={resumen.occupiedNow} etiqueta={t('ports.occupiedNow')} tono="ok" />
          {resumen.reserved > 0 ? (
            <Tooltip content={t('ports.reservedHelp')}>
              <span>
                <Resumen valor={resumen.reserved} etiqueta={t('ports.reserved')} tono="neutral" />
              </span>
            </Tooltip>
          ) : null}
          {resumen.conflicts > 0 ? (
            <Tooltip content={t('ports.conflictsHelp')}>
              <span>
                <Resumen valor={resumen.conflicts} etiqueta={t('ports.conflicts')} tono="warn" />
              </span>
            </Tooltip>
          ) : null}

          <div className="ml-auto flex min-w-[180px] items-center gap-1.5">
            <IconSearch size={14} />
            <Input
              value={filtro}
              onChange={(event) => setFiltro(event.target.value)}
              placeholder={t('ports.filter')}
            />
          </div>
        </div>

        {filas.length === 0 ? (
          <p className="py-8 text-center text-[0.8125rem] text-[var(--text-muted)]">
            {resumen.rows.length === 0 ? t('ports.none') : t('common.empty')}
          </p>
        ) : (
          // La tabla desborda en horizontal dentro de su propio contenedor, no
          // en la pagina: en movil se arrastra sin mover el resto.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-[0.8125rem]">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[0.6875rem] uppercase tracking-wide text-[var(--text-muted)]">
                  <th className="py-1.5 pr-3 font-medium">{t('ports.port')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('ports.binding')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('ports.container')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('projects.name')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('images.reference')}</th>
                  <th className="py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {filas.map((row) => (
                  <Fila
                    key={`${row.containerId}-${row.publicPort}-${row.binding}-${row.type}`}
                    row={row}
                    viewerHost={viewerHost}
                    configuredHost={configuredHost}
                    onNavigate={onClose}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Resumen({
  valor,
  etiqueta,
  tono,
}: {
  valor: number;
  etiqueta: string;
  tono: 'ok' | 'warn' | 'neutral';
}): ReactNode {
  return (
    <div className="rounded-[var(--radius-sm)] bg-[var(--bg-inset)] px-3 py-1.5">
      <span
        className={cx(
          'text-[1.05rem] font-semibold',
          tono === 'ok' && 'text-[var(--ok)]',
          tono === 'warn' && 'text-[var(--warn)]',
        )}
      >
        {valor}
      </span>
      <span className="ml-1.5 text-[0.75rem] text-[var(--text-muted)]">{etiqueta}</span>
    </div>
  );
}

function Fila({
  row,
  viewerHost,
  configuredHost,
  onNavigate,
}: {
  row: PortRow;
  viewerHost: string;
  configuredHost: string;
  onNavigate: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const link = buildPortLink(
    { ip: row.binding === '*' ? '0.0.0.0' : row.binding, privatePort: row.privatePort, publicPort: row.publicPort, type: row.type },
    { viewerHost, configuredHost },
  );

  return (
    <tr className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-hover)]">
      <td className="py-1.5 pr-3">
        <span className="font-mono font-medium">{row.publicPort}</span>
        <span className="ml-1 text-[0.6875rem] text-[var(--text-muted)]">
          {row.type} → {row.privatePort}
        </span>
        {row.conflict ? (
          <Tooltip content={t('ports.conflictsHelp')}>
            <span className="ml-1.5">
              <Badge tone="warn">{t('ports.conflict')}</Badge>
            </span>
          </Tooltip>
        ) : null}
      </td>
      <td className="py-1.5 pr-3 font-mono text-[0.75rem] text-[var(--text-muted)]">{row.binding}</td>
      <td className="py-1.5 pr-3">
        <CrossLink
          to={`/containers?container=${encodeURIComponent(row.containerName)}`}
          title={t('images.goToContainer', { name: row.containerName })}
          onNavigate={onNavigate}
        >
          {row.containerName}
        </CrossLink>
        {!row.running ? (
          <Tooltip content={t('ports.stoppedHelp')}>
            <span className="ml-1.5">
              <Badge>{t('containers.stopped')}</Badge>
            </span>
          </Tooltip>
        ) : null}
      </td>
      <td className="py-1.5 pr-3 text-[var(--text-muted)]">
        {row.projectKey && row.projectName ? (
          <CrossLink
            to={`/projects?key=${encodeURIComponent(row.projectKey)}`}
            title={t('containers.goToProject')}
            onNavigate={onNavigate}
          >
            {row.projectName}
          </CrossLink>
        ) : (
          '-'
        )}
      </td>
      <td className="max-w-[220px] truncate py-1.5 pr-3 font-mono text-[0.6875rem] text-[var(--text-muted)]">
        {row.image}
      </td>
      <td className="py-1.5 text-right">
        {link.url && row.running ? (
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[0.75rem] text-[var(--accent)] hover:underline"
          >
            {t('ports.open')}
            <IconExternal size={11} />
          </a>
        ) : null}
      </td>
    </tr>
  );
}
