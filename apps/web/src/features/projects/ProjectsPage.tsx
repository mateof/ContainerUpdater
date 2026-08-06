import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { ComposeProject } from '@cu/shared';
import { api, ApiError } from '@/api/client';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Skeleton,
  StatusDot,
  Tooltip,
  useToast,
} from '@/components/ui';
import { IconProject, IconRefresh, IconRestart } from '@/components/icons';
import { displayImage } from '@/lib/format';
import { CONTAINER_STATE_LABEL, STRATEGY_HELP, STRATEGY_LABEL, STRATEGY_TONE } from '@/lib/labels';

export function ProjectsPage(): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<{ project: ComposeProject; restartOnly: boolean } | null>(
    null,
  );

  const { data, isLoading } = useQuery({ queryKey: ['projects'], queryFn: () => api.projects() });
  const projects = data?.projects ?? [];

  const apply = useMutation({
    mutationFn: ({ key, restartOnly }: { key: string; restartOnly: boolean }) =>
      api.applyProject(key, restartOnly),
    onSuccess: () => {
      notify(t('updates.statusSuccess'), 'ok');
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
      <h1 className="text-xl font-semibold tracking-tight">{t('projects.title')}</h1>

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
                      onClick={() => setConfirm({ project, restartOnly: true })}
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
                      onClick={() => setConfirm({ project, restartOnly: false })}
                    >
                      <IconRefresh size={16} />
                    </Button>
                  </Tooltip>
                </div>
              </div>

              {!project.yamlAccessible ? (
                <Banner tone="warn" title={t('projects.strategyRecreate')}>
                  {t('projects.yamlNotAccessible')}
                </Banner>
              ) : null}

              <ul className="mt-3 space-y-1.5">
                {project.containers.map((container) => (
                  <li key={container.id} className="flex items-center gap-2.5 text-[0.8125rem]">
                    <StatusDot state={container.state === 'running' ? 'running' : 'stopped'} />
                    <span className="min-w-0 flex-1 truncate">
                      {container.serviceName || container.name}
                    </span>
                    <span className="hidden truncate font-mono text-[0.6875rem] text-[var(--text-muted)] sm:block sm:max-w-[45%]">
                      {displayImage(container.image)}
                    </span>
                    <span className="shrink-0 text-[0.6875rem] text-[var(--text-muted)]">
                      {t(CONTAINER_STATE_LABEL[container.state])}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}

      {confirm ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirm(null)}
          title={confirm.restartOnly ? t('projects.restart') : t('projects.up')}
          description={t('projects.confirmRestart', { name: confirm.project.name })}
          confirmLabel={t('common.confirm')}
          cancelLabel={t('common.cancel')}
          danger
          loading={apply.isPending}
          onConfirm={() =>
            apply.mutate({ key: confirm.project.key, restartOnly: confirm.restartOnly })
          }
        />
      ) : null}
    </div>
  );
}
