import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { ComposeProject, ProjectAction, ServiceAction } from '@cu/shared';
import { api, ApiError } from '@/api/client';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Menu,
  Skeleton,
  StatusDot,
  Tooltip,
  useToast,
} from '@/components/ui';
import { IconDownload, IconMore, IconPlus, IconProject, IconRefresh, IconRestart } from '@/components/icons';
import { ProjectEditor } from './ProjectEditor';
import { displayImage } from '@/lib/format';
import { JobIndicator } from '@/components/JobIndicator';
import { useLive } from '@/hooks/LiveContext';
import { CONTAINER_STATE_LABEL, STRATEGY_HELP, STRATEGY_LABEL, STRATEGY_TONE } from '@/lib/labels';

/** Etiquetas de las acciones de servicio, declaradas una vez. */
const ACTION_LABEL: Record<ServiceAction, string> = {
  recreate: 'projects.actionRecreate',
  restart: 'containers.restart',
  stop: 'containers.stop',
  start: 'containers.start',
  pull: 'projects.actionPull',
};

const PROJECT_ACTION_LABEL: Record<ProjectAction, string> = {
  up: 'projects.up',
  restart: 'projects.restart',
  down: 'projects.down',
};

const PROJECT_ACTION_CONFIRM: Record<ProjectAction, string> = {
  up: 'projects.confirmUp',
  restart: 'projects.confirmRestart',
  down: 'projects.confirmDown',
};

const ACTION_CONFIRM: Record<ServiceAction, string> = {
  recreate: 'projects.confirmRecreate',
  restart: 'projects.confirmRestartService',
  stop: 'projects.confirmStopService',
  start: 'projects.confirmStartService',
  pull: 'projects.confirmPull',
};

export function ProjectsPage(): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();
  const live = useLive();
  const [confirm, setConfirm] = useState<{ project: ComposeProject; action: ProjectAction } | null>(
    null,
  );
  const [confirmAction, setConfirmAction] = useState<{
    project: ComposeProject;
    service: string;
    action: ServiceAction;
  } | null>(null);
  /** `undefined` en `name` significa crear; una cadena, editar ese proyecto. */
  const [editor, setEditor] = useState<{ name?: string } | null>(null);

  const dir = useQuery({ queryKey: ['projects-dir'], queryFn: () => api.projectsDir() });

  const serviceAction = useMutation({
    mutationFn: ({
      projectKey,
      service,
      action,
    }: {
      projectKey: string;
      service: string;
      action: ServiceAction;
    }) => api.serviceAction(projectKey, service, action),
    onSuccess: () => {
      // Corre en segundo plano: se avisa y el progreso se sigue desde
      // Actualizaciones, igual que el resto de operaciones.
      notify(t('updates.runsInBackground'), 'info');
      setConfirmAction(null);
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : '';
      const messages: Record<string, string> = {
        'update-in-progress': t('errors.updateInProgress'),
        'self-update-rejected': t('errors.selfUpdateRejected'),
      };
      notify(messages[code] ?? t('common.error'), 'danger');
      setConfirmAction(null);
    },
  });

  const { data, isLoading } = useQuery({ queryKey: ['projects'], queryFn: () => api.projects() });
  const projects = data?.projects ?? [];

  const apply = useMutation({
    mutationFn: ({ key, action }: { key: string; action: ProjectAction }) =>
      api.projectAction(key, action),
    onSuccess: () => {
      // Igual que el resto: se encola y el progreso se sigue en Actualizaciones.
      notify(t('updates.runsInBackground'), 'info');
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['containers'] });
      setConfirm(null);
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : '';
      const message =
        code === 'update-in-progress'
          ? t('errors.updateInProgress')
          : code === 'self-update-rejected'
            ? t('errors.selfUpdateRejected')
            : t('common.error');
      notify(message, 'danger');
      setConfirm(null);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t('projects.title')}</h1>
        <Tooltip content={dir.data?.writable ? t('projects.newProjectHelp') : (dir.data?.reason ?? '')}>
          <span>
            <Button
              variant="primary"
              icon={<IconPlus size={16} />}
              disabled={!dir.data?.writable}
              onClick={() => setEditor({})}
            >
              {t('projects.newProject')}
            </Button>
          </span>
        </Tooltip>
      </div>

      {/* Sin carpeta escribible no se puede crear nada, y el motivo casi siempre
          es el montaje en solo lectura. Decirlo aqui evita que el boton
          desactivado parezca un fallo. */}
      {dir.data && !dir.data.writable ? (
        <Banner tone="info" title={t('projects.cannotCreate')}>
          {dir.data.reason}
        </Banner>
      ) : null}

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-32 w-full" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconProject size={30} />}
            title={t('common.empty')}
            description={t('projects.yamlNotAccessible')}
          />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {projects.map((project) => (
            <Card key={project.key} className="p-4" glow={project.updatesAvailable > 0}>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate font-semibold text-[0.9375rem]">{project.name}</h2>
                    <Tooltip content={t(STRATEGY_HELP[project.strategy])}>
                      <Badge tone={STRATEGY_TONE[project.strategy]}>
                        {t(STRATEGY_LABEL[project.strategy])}
                      </Badge>
                    </Tooltip>
                    {project.updatesAvailable > 0 ? (
                      <Badge tone="accent">
                        {project.updatesAvailable} {t('nav.updates').toLowerCase()}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[0.6875rem] text-[var(--text-muted)]">
                    {project.workingDir}
                  </p>
                </div>

                <div className="flex shrink-0 gap-1">
                  <Tooltip content={t('projects.restart')}>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t('projects.restart')}
                      disabled={!project.yamlAccessible}
                      onClick={() => setConfirm({ project, action: 'restart' })}
                    >
                      <IconRestart size={16} />
                    </Button>
                  </Tooltip>
                  <Tooltip content={t('projects.up')}>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t('projects.up')}
                      disabled={!project.yamlAccessible}
                      onClick={() => setConfirm({ project, action: 'up' })}
                    >
                      <IconRefresh size={16} />
                    </Button>
                  </Tooltip>
                  <Menu
                    trigger={
                      <Button size="icon" variant="ghost" aria-label={t('projects.projectActions')}>
                        <IconMore size={16} />
                      </Button>
                    }
                    items={[
                      {
                        key: 'edit',
                        label: t('projects.editFilesShort'),
                        // Solo lo creado aqui: sobrescribir el YAML de un stack
                        // que hizo otro es la clase de sorpresa que no se quiere.
                        disabled: !project.managed,
                        onSelect: () => setEditor({ name: project.name }),
                      },
                      { type: 'separator', key: 'sep' },
                      {
                        key: 'down',
                        label: t('projects.down'),
                        danger: true,
                        disabled: !project.yamlAccessible,
                        onSelect: () => setConfirm({ project, action: 'down' }),
                      },
                    ]}
                  />
                </div>
              </div>

              {!project.yamlAccessible ? (
                <Banner tone="warn" title={t('projects.strategyRecreate')}>
                  {t('projects.yamlNotAccessible')}
                </Banner>
              ) : null}

              <ul className="mt-3 space-y-1">
                {project.containers.map((container) => {
                  const running = container.state === 'running';
                  const activeJob = live.activeByContainer.get(container.id);
                  const service = container.serviceName;

                  return (
                    <li
                      key={container.id}
                      className="flex items-center gap-2.5 rounded-[var(--radius-sm)] py-1 pr-1 text-[0.8125rem] hover:bg-[var(--bg-hover)]"
                    >
                      <StatusDot state={running ? 'running' : 'stopped'} />
                      <span className="min-w-0 flex-1 truncate">{service || container.name}</span>
                      <span className="hidden truncate font-mono text-[0.6875rem] text-[var(--text-muted)] lg:block lg:max-w-[38%]">
                        {displayImage(container.image)}
                      </span>

                      {activeJob ? (
                        <JobIndicator job={activeJob} size="icon" />
                      ) : (
                        <>
                          <span className="shrink-0 text-[0.6875rem] text-[var(--text-muted)]">
                            {t(CONTAINER_STATE_LABEL[container.state])}
                          </span>

                          {/* Acciones por servicio: lo que si no habria que
                              hacer por SSH. Solo si el YAML es accesible y el
                              contenedor declara su servicio. */}
                          {project.yamlAccessible && service && !container.isSelf ? (
                            <Menu
                              trigger={
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  aria-label={t('projects.serviceActions')}
                                >
                                  <IconMore size={15} />
                                </Button>
                              }
                              items={[
                                {
                                  key: 'recreate',
                                  label: t('projects.actionRecreate'),
                                  icon: <IconRestart size={14} />,
                                  onSelect: () =>
                                    setConfirmAction({ project, service, action: 'recreate' }),
                                },
                                {
                                  key: 'restart',
                                  label: t('containers.restart'),
                                  onSelect: () =>
                                    setConfirmAction({ project, service, action: 'restart' }),
                                },
                                {
                                  key: running ? 'stop' : 'start',
                                  label: running ? t('containers.stop') : t('containers.start'),
                                  danger: running,
                                  onSelect: () =>
                                    setConfirmAction({
                                      project,
                                      service,
                                      action: running ? 'stop' : 'start',
                                    }),
                                },
                                { type: 'separator', key: 'sep' },
                                {
                                  key: 'pull',
                                  label: t('projects.actionPull'),
                                  icon: <IconDownload size={14} />,
                                  onSelect: () =>
                                    setConfirmAction({ project, service, action: 'pull' }),
                                },
                              ]}
                            />
                          ) : null}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
      )}

      {confirm ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirm(null)}
          title={t(PROJECT_ACTION_LABEL[confirm.action])}
          description={t(PROJECT_ACTION_CONFIRM[confirm.action], { name: confirm.project.name })}
          confirmLabel={t('common.confirm')}
          cancelLabel={t('common.cancel')}
          // Bajar el stack corta el servicio; levantar y reiniciar no tanto.
          danger={confirm.action === 'down'}
          loading={apply.isPending}
          onConfirm={() => apply.mutate({ key: confirm.project.key, action: confirm.action })}
        />
      ) : null}

      {editor ? <ProjectEditor name={editor.name} onClose={() => setEditor(null)} /> : null}

      {confirmAction ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmAction(null)}
          title={t(ACTION_LABEL[confirmAction.action])}
          description={t(ACTION_CONFIRM[confirmAction.action], {
            service: confirmAction.service,
          })}
          confirmLabel={t('common.confirm')}
          cancelLabel={t('common.cancel')}
          // Parar y recrear cortan el servicio; descargar y arrancar no.
          danger={confirmAction.action === 'stop' || confirmAction.action === 'recreate'}
          loading={serviceAction.isPending}
          onConfirm={() =>
            serviceAction.mutate({
              projectKey: confirmAction.project.key,
              service: confirmAction.service,
              action: confirmAction.action,
            })
          }
        />
      ) : null}
    </div>
  );
}
