import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { ComposeProject, LaunchOptions } from '@cu/shared';
import { validateEnv } from '@cu/shared';
import { api } from '@/api/client';
import { Badge, Button, Input, Modal, Skeleton, Switch, cx } from '@/components/ui';
import { IconPlus, IconTrash } from '@/components/icons';

/**
 * Opciones de un arranque concreto.
 *
 * Todo lo de aqui vale SOLO para esta ejecucion y no se guarda. Es deliberado:
 * un perfil activado hoy no debe reaparecer solo en la proxima actualizacion
 * automatica, porque entonces lo que corre deja de corresponderse con el fichero
 * del proyecto y no hay forma de saber por que hay un servicio de mas.
 */
export function LaunchDialog({
  project,
  action,
  onClose,
  onConfirm,
  loading,
}: {
  project: ComposeProject;
  action: 'up' | 'update';
  onClose: () => void;
  onConfirm: (launch: LaunchOptions) => void;
  loading?: boolean;
}): ReactNode {
  const { t } = useTranslation();

  // Se pregunta al abrir y no al pintar la lista: cuesta arrancar Compose.
  const profiles = useQuery({
    queryKey: ['project-profiles', project.key],
    queryFn: () => api.projectProfiles(project.key),
  });

  const [elegidos, setElegidos] = useState<Set<string>>(() => new Set());
  const [flags, setFlags] = useState({
    build: false,
    removeOrphans: false,
    wait: false,
    forceRecreate: false,
    noPull: false,
  });
  const [vars, setVars] = useState<Array<{ key: string; value: string }>>([]);

  const disponibles = profiles.data?.profiles ?? [];

  // Se valida mientras se escribe: enterarse de que una variable se descarto
  // DESPUES de arrancar es la peor forma de saberlo.
  const { issues } = validateEnv(
    Object.fromEntries(vars.filter((v) => v.key.trim()).map((v) => [v.key.trim(), v.value])),
  );

  const lanzar = (): void => {
    const env: Record<string, string> = {};
    for (const { key, value } of vars) {
      const nombre = key.trim();
      if (nombre) env[nombre] = value;
    }
    onConfirm({
      profiles: [...elegidos],
      env: Object.keys(env).length > 0 ? env : undefined,
      ...flags,
    });
  };

  return (
    <Modal
      open
      onOpenChange={(abierto) => !abierto && onClose()}
      wide
      title={t(action === 'update' ? 'projects.updateProject' : 'projects.up')}
      description={project.name}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={loading} onClick={lanzar}>
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Perfiles: solo si el proyecto define alguno. */}
        {profiles.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : disponibles.length > 0 ? (
          <div>
            <p className="text-[0.8125rem] font-medium">{t('launch.profiles')}</p>
            <p className="mb-2 text-[0.75rem] text-[var(--text-muted)]">{t('launch.profilesHelp')}</p>
            <div className="flex flex-wrap gap-1.5">
              {disponibles.map((perfil) => {
                const activo = elegidos.has(perfil);
                return (
                  <button
                    key={perfil}
                    type="button"
                    onClick={() =>
                      setElegidos((actuales) => {
                        const siguiente = new Set(actuales);
                        if (siguiente.has(perfil)) siguiente.delete(perfil);
                        else siguiente.add(perfil);
                        return siguiente;
                      })
                    }
                    className={cx(
                      'rounded-[var(--radius-pill)] border px-2.5 py-1 text-[0.8125rem]',
                      activo
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text)]'
                        : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    {perfil}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* Variables de esta ejecucion. */}
        <div>
          <p className="text-[0.8125rem] font-medium">{t('launch.env')}</p>
          <p className="mb-2 text-[0.75rem] text-[var(--text-muted)]">{t('launch.envHelp')}</p>

          {vars.length > 0 ? (
            <ul className="mb-2 space-y-1.5">
              {vars.map((entrada, indice) => (
                <li key={indice} className="flex items-center gap-1.5">
                  <Input
                    value={entrada.key}
                    placeholder="TAG"
                    className="max-w-[180px] font-mono"
                    onChange={(event) =>
                      setVars((actuales) =>
                        actuales.map((v, i) => (i === indice ? { ...v, key: event.target.value } : v)),
                      )
                    }
                  />
                  <span className="text-[var(--text-muted)]">=</span>
                  <Input
                    value={entrada.value}
                    placeholder="v2.1.0"
                    className="font-mono"
                    onChange={(event) =>
                      setVars((actuales) =>
                        actuales.map((v, i) => (i === indice ? { ...v, value: event.target.value } : v)),
                      )
                    }
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('common.delete')}
                    onClick={() => setVars((actuales) => actuales.filter((_, i) => i !== indice))}
                  >
                    <IconTrash size={15} />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}

          <Button
            size="sm"
            variant="ghost"
            icon={<IconPlus size={14} />}
            onClick={() => setVars((actuales) => [...actuales, { key: '', value: '' }])}
          >
            {t('launch.addVar')}
          </Button>

          {issues.length > 0 ? (
            <p className="mt-2 rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-[0.75rem] text-[var(--danger)]">
              {t(
                issues[0]!.reason === 'reserved' ? 'launch.envReserved' : 'launch.envInvalid',
                { keys: issues.map((i) => i.key).join(', ') },
              )}
            </p>
          ) : null}
        </div>

        {/* Interruptores. */}
        <div className="space-y-1 border-t border-[var(--border)] pt-3">
          <Switch
            checked={flags.build}
            onCheckedChange={(v) => setFlags((f) => ({ ...f, build: v }))}
            label={t('launch.build')}
            hint={t('launch.buildHelp')}
          />
          <Switch
            checked={flags.removeOrphans}
            onCheckedChange={(v) => setFlags((f) => ({ ...f, removeOrphans: v }))}
            label={t('launch.removeOrphans')}
            hint={t('launch.removeOrphansHelp')}
          />
          <Switch
            checked={flags.wait}
            onCheckedChange={(v) => setFlags((f) => ({ ...f, wait: v }))}
            label={t('launch.wait')}
            hint={t('launch.waitHelp')}
          />
          <Switch
            checked={flags.forceRecreate}
            onCheckedChange={(v) => setFlags((f) => ({ ...f, forceRecreate: v }))}
            label={t('launch.forceRecreate')}
            hint={t('launch.forceRecreateHelp')}
          />
          <Switch
            checked={flags.noPull}
            onCheckedChange={(v) => setFlags((f) => ({ ...f, noPull: v }))}
            label={t('launch.noPull')}
            hint={t('launch.noPullHelp')}
          />
        </div>

        <p className="text-[0.75rem] text-[var(--text-muted)]">
          {t('launch.onlyThisRun')}
          {elegidos.size > 0 || vars.length > 0 ? (
            <span className="ml-1">
              <Badge tone="accent">{t('launch.notSaved')}</Badge>
            </span>
          ) : null}
        </p>
      </div>
    </Modal>
  );
}
