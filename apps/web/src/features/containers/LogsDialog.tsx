import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { ContainerSummary } from '@cu/shared';
import { api } from '@/api/client';
import { Button, Modal, Select, Spinner } from '@/components/ui';

export function LogsDialog({
  container,
  onClose,
}: {
  container: ContainerSummary;
  onClose: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const [tail, setTail] = useState(200);
  const [follow, setFollow] = useState(true);
  const preRef = useRef<HTMLPreElement>(null);

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['logs', container.id, tail],
    queryFn: () => api.containerLogs(container.id, tail),
    // Sondeo mientras el dialogo esta abierto y el usuario quiere seguir el
    // log. No se usa SSE aqui: son datos puntuales de un solo contenedor y
    // abrir un flujo dedicado por cada mirada al log no compensa.
    refetchInterval: follow ? 3000 : false,
  });

  useEffect(() => {
    if (follow && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [data?.logs, follow]);

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      wide
      title={t('containers.logsTitle', { name: container.name })}
      footer={
        <>
          <Select
            value={String(tail)}
            onChange={(event) => setTail(Number(event.target.value))}
            className="w-28 mr-auto"
          >
            <option value="100">100</option>
            <option value="200">200</option>
            <option value="500">500</option>
            <option value="1000">1000</option>
          </Select>
          <Button variant="ghost" onClick={() => setFollow((value) => !value)}>
            {follow ? '⏸' : '▶'}
          </Button>
          <Button variant="secondary" loading={isFetching} onClick={() => void refetch()}>
            {t('common.refresh')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      {isFetching && !data ? (
        <div className="flex justify-center py-10">
          <Spinner className="size-5" />
        </div>
      ) : (
        <pre
          ref={preRef}
          onScroll={(event) => {
            // Si el usuario sube a leer algo, se desactiva el seguimiento
            // automatico para no arrancarle la vista al final cada 3 segundos.
            const element = event.currentTarget;
            const atBottom =
              element.scrollHeight - element.scrollTop - element.clientHeight < 40;
            if (!atBottom && follow) setFollow(false);
          }}
          className="max-h-[55vh] overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-inset)] p-3 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap break-all"
        >
          {data?.logs?.trim() || t('containers.logsEmpty')}
        </pre>
      )}
    </Modal>
  );
}
