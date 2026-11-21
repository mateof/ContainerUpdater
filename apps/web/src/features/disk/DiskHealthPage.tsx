import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import {
  bytesPerSecondToMbPerMinute,
  DEFAULT_HEALTHCHECK_INTERVAL_SECONDS,
  SHORT_HEALTHCHECK_SECONDS,
  type ApplyResult,
  type ContainerTuningRow,
  type HealthcheckInfo,
  type ImpactProbe,
  type LogRatesResponse,
  type MountReport,
  type StoredRule,
  type TuningRule,
} from '@cu/shared';
import { api, ApiError } from '@/api/client';
import { FilterPills } from '@/components/Filters';
import { Badge, Banner, Button, Card, EmptyState, Field, Input, Modal, Select, Skeleton, cx, useToast } from '@/components/ui';
import { IconDisk } from '@/components/icons';
import { displayImage, formatDateTime, formatEventTime } from '@/lib/format';
import { DiskTabs } from './DiskTabs';

type Translate = (key: string, options?: Record<string, unknown>) => string;
type RowFilter = 'all' | 'none' | 'short' | 'logs' | 'pending';
type HealthMode = 'keep' | 'disable' | 'set';
type LogMode = 'keep' | 'json-file' | 'local' | 'none';
type Unit = 's' | 'min';

const IMPACT_MINUTES = [3, 5, 10];
const LOG_MINUTES = 10;

function formatSeconds(seconds: number | null): string {
  const value = seconds ?? DEFAULT_HEALTHCHECK_INTERVAL_SECONDS;
  if (value < 60) return `${Math.round(value)} s`;
  if (value < 3600) {
    const minutes = Math.floor(value / 60);
    const rest = Math.round(value % 60);
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  }
  const hours = Math.floor(value / 3600);
  const minutes = Math.round((value % 3600) / 60);
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

function mbMin(bps: number): string {
  const value = bytesPerSecondToMbPerMinute(bps);
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function rotation(options: Record<string, string>): string | null {
  const size = options['max-size'];
  if (!size) return null;
  return options['max-file'] ? `${size} × ${options['max-file']}` : size;
}

function isShort(row: ContainerTuningRow): boolean {
  const effective = row.healthcheck.effective;
  return effective !== null && (effective.intervalSeconds ?? DEFAULT_HEALTHCHECK_INTERVAL_SECONDS) < SHORT_HEALTHCHECK_SECONDS;
}

function reasonText(code: string | null, t: Translate): string {
  if (!code) return '';
  const key = `diskHealth.reason_${code.replace(':', '_').replace(/-/g, '_')}`;
  const translated = t(key);
  return translated === key ? code : translated;
}

function describeRule(rule: TuningRule, t: Translate): string {
  const parts: string[] = [];
  if (rule.healthcheck?.mode === 'disable') parts.push(t('diskHealth.ruleHealthOff'));
  if (rule.healthcheck?.mode === 'set') {
    parts.push(t('diskHealth.ruleHealthEvery', { value: formatSeconds(rule.healthcheck.intervalSeconds) }));
  }
  if (rule.logging) {
    const rotated = rotation(rule.logging.options);
    parts.push(rotated ? `${rule.logging.driver} ${rotated}` : rule.logging.driver);
  }
  return parts.join(' · ');
}

export function DiskHealthPage(): ReactNode {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<RowFilter>('all');
  const [project, setProject] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<EditTarget | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['disk-health'],
    queryFn: () => api.diskHealth(),
    refetchInterval: 60_000,
  });
  const overview = data?.overview;

  const rows = overview?.containers ?? [];
  const projects = useMemo(
    () => [...new Set(rows.map((row) => row.projectName).filter((name): name is string => Boolean(name)))].sort(),
    [rows],
  );
  const counts = useMemo(
    () => ({
      all: rows.length,
      none: rows.filter((row) => row.healthcheck.effective === null).length,
      short: rows.filter(isShort).length,
      logs: rows.filter((row) => row.logging.warning !== null).length,
      pending: rows.filter((row) => row.rule && row.rule.status !== 'ok').length,
    }),
    [rows],
  );
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (filter === 'none' && row.healthcheck.effective !== null) return false;
        if (filter === 'short' && !isShort(row)) return false;
        if (filter === 'logs' && row.logging.warning === null) return false;
        if (filter === 'pending' && !(row.rule && row.rule.status !== 'ok')) return false;
        if (project && row.projectName !== project) return false;
        if (needle && !`${row.name} ${row.image}`.toLowerCase().includes(needle)) return false;
        return true;
      })
      .sort((a, b) => (b.healthcheck.probesPerMinute ?? 0) - (a.healthcheck.probesPerMinute ?? 0) || a.name.localeCompare(b.name));
  }, [rows, filter, project, search]);

  const selectedRows = rows.filter((row) => selected.has(row.id));
  const allVisibleSelected = visible.length > 0 && visible.every((row) => selected.has(row.id));
  const toggleAll = () =>
    setSelected((current) => {
      const next = new Set(current);
      for (const row of visible) {
        if (allVisibleSelected) next.delete(row.id);
        else next.add(row.id);
      }
      return next;
    });

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('disk.title')}</h1>
          <p className="text-[0.8125rem] text-[var(--text-muted)] mt-0.5 max-w-prose">{t('diskHealth.subtitle')}</p>
        </div>
        <DiskTabs />
      </div>

      {error ? <Banner tone="danger" title={t('common.error')} /> : null}

      {isLoading || !overview ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label={t('diskHealth.probesPerMinute')} value={overview.probesPerMinute.toFixed(overview.probesPerMinute >= 10 ? 0 : 1)} hint={t('diskHealth.probesHint')} />
            <Tile label={t('diskHealth.withoutHealthcheck')} value={String(counts.none)} />
            <Tile label={t('diskHealth.shortHealthcheck')} value={String(counts.short)} />
            <Tile
              label={t('diskHealth.logsWarning')}
              value={String(counts.logs)}
              hint={overview.daemonLogDriver ? t('diskHealth.daemonDriver', { driver: overview.daemonLogDriver }) : undefined}
            />
          </div>

          {overview.daemonLogDriver === 'db' ? (
            <Banner tone="info" title={t('diskHealth.dbDriverTitle')}>
              {t('diskHealth.dbDriverBody')}
            </Banner>
          ) : null}

          <Card className="p-5 space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-[0.9375rem] font-semibold">{t('diskHealth.containersTitle')}</h2>
                <p className="text-[0.75rem] text-[var(--text-muted)] mt-0.5 max-w-prose">{t('diskHealth.containersHint')}</p>
              </div>
              <Button variant="primary" disabled={selectedRows.length === 0} onClick={() => setEditing({ kind: 'containers', rows: selectedRows })}>
                {t('diskHealth.configureSelected', { count: selectedRows.length })}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <FilterPills
                value={filter}
                onChange={setFilter}
                options={[
                  { key: 'all', label: t('diskHealth.filterAll'), count: counts.all },
                  { key: 'none', label: t('diskHealth.filterNone'), count: counts.none },
                  { key: 'short', label: t('diskHealth.filterShort'), count: counts.short },
                  { key: 'logs', label: t('diskHealth.filterLogs'), count: counts.logs },
                  { key: 'pending', label: t('diskHealth.filterPending'), count: counts.pending },
                ]}
              />
              <div className="w-full sm:w-44">
                <Select value={project} onChange={(event) => setProject(event.target.value)}>
                  <option value="">{t('disk.allProjects')}</option>
                  {projects.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-full sm:w-56">
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('diskHealth.search')} />
              </div>
            </div>

            {visible.length === 0 ? (
              <EmptyState icon={<IconDisk size={24} />} title={t('diskHealth.noRows')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full md:min-w-[760px] text-[0.8125rem]">
                  <thead>
                    <tr className="text-left text-[0.6875rem] uppercase tracking-wide text-[var(--text-faint)]">
                      <th className="py-1.5 pr-2 w-8">
                        <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} aria-label={t('diskHealth.selectAll')} />
                      </th>
                      <th className="py-1.5 pr-3 font-medium">{t('diskHealth.colContainer')}</th>
                      <th className="hidden md:table-cell py-1.5 pr-3 font-medium">{t('diskHealth.colHealthcheck')}</th>
                      <th className="hidden md:table-cell py-1.5 pr-3 font-medium">{t('diskHealth.colLogging')}</th>
                      <th className="hidden md:table-cell py-1.5 pr-3 font-medium">{t('diskHealth.colRule')}</th>
                      <th className="hidden md:table-cell py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => (
                      <ContainerRow
                        key={row.id}
                        row={row}
                        checked={selected.has(row.id)}
                        onToggle={() =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (next.has(row.id)) next.delete(row.id);
                            else next.add(row.id);
                            return next;
                          })
                        }
                        onEdit={() => setEditing({ kind: 'containers', rows: [row] })}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <RulesCard rules={overview.rules} rows={rows} onEdit={setEditing} />
          <ImpactCard rows={rows} />
          <LogRatesCard />
          <MountsCard />

          {editing ? (
            <TuningDialog
              target={editing}
              rules={overview.rules}
              allRows={rows}
              onClose={() => {
                setEditing(null);
                setSelected(new Set());
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }): ReactNode {
  return (
    <Card className="p-4">
      <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--text-faint)]">{label}</p>
      <p className="text-xl font-semibold tabular-nums mt-1">{value}</p>
      {hint ? <p className="text-[0.75rem] text-[var(--text-muted)] mt-1 leading-snug">{hint}</p> : null}
    </Card>
  );
}

function healthText(info: HealthcheckInfo | null, t: Translate): string {
  return info ? t('diskHealth.every', { value: formatSeconds(info.intervalSeconds) }) : t('diskHealth.noHealthcheck');
}

function ContainerRow({
  row,
  checked,
  onToggle,
  onEdit,
}: {
  row: ContainerTuningRow;
  checked: boolean;
  onToggle: () => void;
  onEdit: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const { healthcheck, logging, rule } = row;
  const sourceTone = healthcheck.source === 'none' ? 'warn' : healthcheck.source === 'disabled' ? 'neutral' : 'info';
  const rotated = rotation(logging.options);

  const healthCell = (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={sourceTone}>{t(`diskHealth.source_${healthcheck.source}`)}</Badge>
        {healthcheck.effective ? (
          <span className={cx('tabular-nums', isShort(row) && 'text-[var(--warn)]')}>{healthText(healthcheck.effective, t)}</span>
        ) : null}
      </div>
      {healthcheck.probesPerMinute !== null ? (
        <div className="text-[0.75rem] text-[var(--text-muted)] tabular-nums">
          {t('diskHealth.probes', { value: healthcheck.probesPerMinute.toFixed(healthcheck.probesPerMinute >= 10 ? 0 : 1) })}
        </div>
      ) : null}
      {row.projectKey && healthcheck.source === 'compose' ? (
        <div className="text-[0.75rem] text-[var(--text-muted)]">
          {t('diskHealth.withoutCompose', { value: healthText(healthcheck.withoutCompose, t) })}
        </div>
      ) : null}
    </>
  );
  const loggingCell = (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <span>{logging.driver}</span>
        {rotated ? <span className="text-[var(--text-muted)] tabular-nums">{rotated}</span> : null}
        {logging.warning ? <Badge tone="warn">{t(`diskHealth.logWarning_${logging.warning.replace('-', '_')}`)}</Badge> : null}
      </div>
      {logging.fromCompose ? <div className="text-[0.75rem] text-[var(--text-faint)]">{t('diskHealth.fromCompose')}</div> : null}
    </>
  );
  const ruleCell = (
    <>
      {rule ? (
        <Badge tone={rule.status === 'ok' ? 'ok' : 'warn'} title={`${t(`diskHealth.scope_${rule.scope}`)}: ${rule.key}`}>
          {t(`diskHealth.status_${rule.status.replace('-', '_')}`)}
        </Badge>
      ) : (
        <span className="text-[var(--text-faint)]">-</span>
      )}
      {row.apply.mode === 'unsupported' ? (
        <div className="text-[0.75rem] text-[var(--text-muted)] mt-1 max-w-52">{reasonText(row.apply.reason, t)}</div>
      ) : null}
    </>
  );
  const configure = (
    <Button size="sm" variant="ghost" onClick={onEdit} disabled={row.apply.mode === 'unsupported'}>
      {t('diskHealth.configure')}
    </Button>
  );

  return (
    <tr className="border-t border-[var(--border)] align-top">
      <td className="py-2 pr-2">
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={row.name} />
      </td>
      <td className="py-2 pr-3 min-w-0">
        <div className="font-medium">{row.name}</div>
        <div className="text-[0.75rem] text-[var(--text-muted)] break-all">{displayImage(row.image)}</div>
        {row.projectName ? (
          <div className="text-[0.75rem] text-[var(--text-faint)]">
            {row.projectName} / {row.serviceName}
          </div>
        ) : null}
        <div className="md:hidden mt-2 space-y-2">
          {healthCell}
          {loggingCell}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>{ruleCell}</div>
            {configure}
          </div>
        </div>
      </td>
      <td className="hidden md:table-cell py-2 pr-3">{healthCell}</td>
      <td className="hidden md:table-cell py-2 pr-3">{loggingCell}</td>
      <td className="hidden md:table-cell py-2 pr-3">{ruleCell}</td>
      <td className="hidden md:table-cell py-2 text-right">{configure}</td>
    </tr>
  );
}

type EditTarget =
  | { kind: 'containers'; rows: ContainerTuningRow[] }
  | { kind: 'rule'; rule: StoredRule; rows: ContainerTuningRow[] };

function initialForm(rule: TuningRule | null) {
  const health = rule?.healthcheck;
  const interval = health?.mode === 'set' ? health.intervalSeconds : 300;
  const unit: Unit = interval % 60 === 0 ? 'min' : 's';
  return {
    healthMode: (health ? health.mode : 'keep') as HealthMode,
    interval: String(unit === 'min' ? interval / 60 : interval),
    unit,
    command: health?.mode === 'set' ? (health.command ?? '') : '',
    logMode: (rule?.logging ? (['json-file', 'local', 'none'].includes(rule.logging.driver) ? rule.logging.driver : 'json-file') : 'keep') as LogMode,
    maxSize: String(Number.parseInt(rule?.logging?.options['max-size'] ?? '15', 10) || 15),
    maxFile: rule?.logging?.options['max-file'] ?? '3',
  };
}

function TuningDialog({
  target,
  rules,
  allRows,
  onClose,
}: {
  target: EditTarget;
  rules: StoredRule[];
  allRows: ContainerTuningRow[];
  onClose: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();
  const single = target.kind === 'containers' && target.rows.length === 1 ? target.rows[0]! : null;
  const imageKey = target.kind === 'rule' ? (target.rule.scope === 'image' ? target.rule.key : null) : single?.imageKey ?? null;
  const [scope, setScope] = useState<'container' | 'image'>(target.kind === 'rule' ? target.rule.scope : 'container');
  const existing =
    target.kind === 'rule'
      ? target.rule
      : single
        ? (rules.find((rule) => rule.scope === 'container' && rule.key === single.name) ??
          rules.find((rule) => rule.scope === 'image' && rule.key === single.imageKey) ??
          null)
        : null;
  const [form, setForm] = useState(() => initialForm(existing));
  const [results, setResults] = useState<ApplyResult[] | null>(null);

  const affected =
    target.kind === 'containers' && scope === 'image' && imageKey
      ? allRows.filter((row) => row.imageKey === imageKey)
      : target.rows;

  const intervalSeconds = Math.round(Number(form.interval) * (form.unit === 'min' ? 60 : 1));
  const rule: TuningRule = {
    healthcheck:
      form.healthMode === 'keep'
        ? null
        : form.healthMode === 'disable'
          ? { mode: 'disable' }
          : {
              mode: 'set',
              command: form.command.trim() || null,
              intervalSeconds,
              timeoutSeconds: null,
              retries: null,
              startPeriodSeconds: null,
            },
    logging:
      form.logMode === 'keep'
        ? null
        : form.logMode === 'json-file'
          ? { driver: 'json-file', options: { 'max-size': `${form.maxSize}m`, 'max-file': form.maxFile } }
          : { driver: form.logMode, options: {} },
  };
  const invalid =
    (rule.healthcheck === null && rule.logging === null) ||
    (form.healthMode === 'set' && (!Number.isFinite(intervalSeconds) || intervalSeconds < 1)) ||
    (form.logMode === 'json-file' && (!(Number(form.maxSize) > 0) || !(Number(form.maxFile) >= 1)));
  const missingCommand =
    form.healthMode === 'set' && !form.command.trim()
      ? affected.filter((row) => row.healthcheck.effective === null && row.healthcheck.image === null)
      : [];

  const save = useMutation({
    mutationFn: async () => {
      if (target.kind === 'rule') {
        await api.saveTuningRule(target.rule.scope, target.rule.key, rule);
      } else if (scope === 'image' && imageKey) {
        await api.saveTuningRule('image', imageKey, rule);
      } else {
        await api.saveContainerRules(target.rows.map((row) => row.name), rule);
      }
      const ids = affected.filter((row) => row.apply.mode !== 'unsupported').map((row) => row.id);
      if (ids.length === 0) return [];
      return (await api.applyTuning(ids, false)).results;
    },
    onSuccess: (applied) => {
      void queryClient.invalidateQueries({ queryKey: ['disk-health'] });
      setResults(applied);
    },
    onError: () => notify(t('common.error'), 'danger'),
  });

  const pendingRunning = (results ?? []).filter(
    (result) => result.running && (result.outcome === 'pending-recreate' || result.outcome === 'pending-update'),
  );

  const recreate = useMutation({
    mutationFn: () => api.applyTuning(pendingRunning.map((result) => result.containerId), true),
    onSuccess: ({ results: applied }) => {
      void queryClient.invalidateQueries({ queryKey: ['disk-health'] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      setResults(applied);
      notify(t('updates.runsInBackground'), 'info');
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : '';
      notify(code === 'update-in-progress' ? t('errors.updateInProgress') : t('common.error'), 'danger');
    },
  });

  const title =
    target.kind === 'rule'
      ? t('diskHealth.editRule', { key: target.rule.key })
      : single
        ? t('diskHealth.configureOne', { name: single.name })
        : t('diskHealth.configureMany', { count: target.rows.length });

  return (
    <Modal
      open
      onOpenChange={(open) => (!open ? onClose() : undefined)}
      title={title}
      wide
      footer={
        results ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {pendingRunning.length > 0 ? t('diskHealth.later') : t('common.close')}
            </Button>
            {pendingRunning.length > 0 ? (
              <Button variant="primary" onClick={() => recreate.mutate()} loading={recreate.isPending}>
                {t('diskHealth.recreateNow', { count: pendingRunning.length })}
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => save.mutate()} disabled={invalid} loading={save.isPending}>
              {t('diskHealth.saveAndApply')}
            </Button>
          </>
        )
      }
    >
      {results ? (
        <div className="space-y-3">
          {results.length === 0 ? <p className="text-[0.8125rem]">{t('diskHealth.ruleSavedNoContainers')}</p> : null}
          {pendingRunning.length > 0 ? (
            <Banner tone="info" title={t('diskHealth.recreateTitle', { count: pendingRunning.length })}>
              {t('diskHealth.recreateBody')}
            </Banner>
          ) : null}
          <ul className="divide-y divide-[var(--border)] text-[0.8125rem]">
            {results.map((result) => (
              <li key={result.containerId} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                <span className="font-medium">{result.name}</span>
                <span className={cx(result.outcome === 'error' ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]')}>
                  {t(`diskHealth.outcome_${result.outcome.replace('-', '_')}`, { running: result.running })}
                  {result.message ? ` · ${reasonText(result.message, t)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-5">
          {target.kind === 'containers' && single && imageKey && scope === 'image' ? (
            <p className="text-[0.8125rem] text-[var(--text-muted)]">
              {t('diskHealth.imageScopeHint', { count: affected.length })}
            </p>
          ) : null}
          {target.kind === 'containers' && single && imageKey ? (
            <Field label={t('diskHealth.scope')}>
              <FilterPills
                value={scope}
                onChange={setScope}
                options={[
                  { key: 'container', label: t('diskHealth.scopeContainer') },
                  { key: 'image', label: t('diskHealth.scopeImage', { image: displayImage(imageKey) }) },
                ]}
              />
            </Field>
          ) : null}
          {target.kind === 'containers' && !single ? (
            <p className="text-[0.8125rem] text-[var(--text-muted)]">
              {t('diskHealth.manyHint', { names: target.rows.map((row) => row.name).join(', ') })}
            </p>
          ) : null}

          <Field label={t('diskHealth.healthcheck')} hint={t('diskHealth.healthcheckHint')}>
            <FilterPills
              value={form.healthMode}
              onChange={(healthMode) => setForm({ ...form, healthMode })}
              options={[
                { key: 'keep', label: t('diskHealth.keep') },
                { key: 'set', label: t('diskHealth.setInterval') },
                { key: 'disable', label: t('diskHealth.disable') },
              ]}
            />
          </Field>
          {form.healthMode === 'set' ? (
            <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
              <Field label={t('diskHealth.interval')}>
                <div className="flex gap-2">
                  <div className="w-24">
                    <Input
                      type="number"
                      min={1}
                      value={form.interval}
                      onChange={(event) => setForm({ ...form, interval: event.target.value })}
                    />
                  </div>
                  <div className="w-32">
                  <Select value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value as Unit })}>
                    <option value="s">{t('diskHealth.unitSeconds')}</option>
                    <option value="min">{t('diskHealth.unitMinutes')}</option>
                  </Select>
                  </div>
                </div>
              </Field>
              <Field label={t('diskHealth.command')} hint={t('diskHealth.commandHint')}>
                <Input
                  value={form.command}
                  onChange={(event) => setForm({ ...form, command: event.target.value })}
                  placeholder="curl -fsS http://localhost:8080/ || exit 1"
                />
              </Field>
            </div>
          ) : null}
          {missingCommand.length > 0 ? (
            <Banner tone="warn" title={t('diskHealth.needsCommandTitle')}>
              {t('diskHealth.needsCommandBody', { names: missingCommand.map((row) => row.name).join(', ') })}
            </Banner>
          ) : null}

          <Field label={t('diskHealth.logging')} hint={t(`diskHealth.loggingHint_${form.logMode.replace('-', '_')}`)}>
            <FilterPills
              value={form.logMode}
              onChange={(logMode) => setForm({ ...form, logMode })}
              options={[
                { key: 'keep', label: t('diskHealth.keep') },
                { key: 'json-file', label: t('diskHealth.logRotated') },
                { key: 'local', label: 'local' },
                { key: 'none', label: t('diskHealth.logNone') },
              ]}
            />
          </Field>
          {form.logMode === 'json-file' ? (
            <div className="flex flex-wrap gap-4">
              <Field label={t('diskHealth.maxSize')}>
                <div className="w-28">
                  <Input type="number" min={1} value={form.maxSize} onChange={(event) => setForm({ ...form, maxSize: event.target.value })} />
                </div>
              </Field>
              <Field label={t('diskHealth.maxFile')}>
                <div className="w-28">
                  <Input type="number" min={1} value={form.maxFile} onChange={(event) => setForm({ ...form, maxFile: event.target.value })} />
                </div>
              </Field>
            </div>
          ) : null}
          {form.logMode !== 'keep' ? <p className="text-[0.75rem] text-[var(--text-muted)]">{t('diskHealth.dbViewerNote')}</p> : null}
          <p className="text-[0.75rem] text-[var(--text-muted)] leading-snug">{t('diskHealth.applyExplain')}</p>
        </div>
      )}
    </Modal>
  );
}

function RulesCard({
  rules,
  rows,
  onEdit,
}: {
  rules: StoredRule[];
  rows: ContainerTuningRow[];
  onEdit: (target: EditTarget) => void;
}): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (rule: StoredRule) => api.deleteTuningRule(rule.scope, rule.key),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['disk-health'] }),
    onError: () => notify(t('common.error'), 'danger'),
  });
  const matching = (rule: StoredRule) => rows.filter((row) => row.rule?.scope === rule.scope && row.rule.key === rule.key);

  return (
    <Card className="p-5 space-y-3">
      <div>
        <h2 className="text-[0.9375rem] font-semibold">{t('diskHealth.rulesTitle')}</h2>
        <p className="text-[0.75rem] text-[var(--text-muted)] mt-0.5 max-w-prose">{t('diskHealth.rulesHint')}</p>
      </div>
      {rules.length === 0 ? (
        <p className="text-[0.8125rem] text-[var(--text-muted)]">{t('diskHealth.noRules')}</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] text-[0.8125rem]">
          {rules.map((rule) => {
            const targets = matching(rule);
            const behind = targets.filter((row) => row.rule?.status !== 'ok').length;
            return (
              <li key={`${rule.scope}:${rule.key}`} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">{t(`diskHealth.scope_${rule.scope}`)}</Badge>
                    <span className="font-medium break-all">{rule.scope === 'image' ? displayImage(rule.key) : rule.key}</span>
                  </div>
                  <div className="text-[0.75rem] text-[var(--text-muted)] mt-0.5">
                    {describeRule(rule, t)} · {t('diskHealth.ruleTargets', { count: targets.length, behind })}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => onEdit({ kind: 'rule', rule, rows: targets })}>
                    {behind > 0 ? t('diskHealth.applyRule', { count: behind }) : t('diskHealth.edit')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove.mutate(rule)}>
                    {t('diskHealth.deleteRule')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function ImpactCard({ rows }: { rows: ContainerTuningRow[] }): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const queryClient = useQueryClient();
  const candidates = rows.filter((row) => row.state === 'running' && !row.isSelf).sort((a, b) => a.name.localeCompare(b.name));
  const [containerId, setContainerId] = useState('');
  const [minutes, setMinutes] = useState(5);
  const [now, setNow] = useState(Date.now());

  const { data } = useQuery({
    queryKey: ['disk-impact'],
    queryFn: () => api.impactStatus(),
    refetchInterval: (query) => (query.state.data?.current ? 5000 : 60_000),
  });
  const current = data?.current ?? null;
  useEffect(() => {
    if (!current) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [current]);

  const onError = (error: unknown) => {
    const code = error instanceof ApiError ? error.code : '';
    const key = `diskHealth.impactError_${code.replace(/-/g, '_')}`;
    const text = t(key);
    notify(text === key ? t('common.error') : text, 'danger');
  };
  const start = useMutation({
    mutationFn: () => api.startImpact(containerId, minutes),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['disk-impact'] }),
    onError,
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelImpact(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['disk-impact'] }),
    onError,
  });

  return (
    <Card className="p-5 space-y-3">
      <div>
        <h2 className="text-[0.9375rem] font-semibold">{t('diskHealth.impactTitle')}</h2>
        <p className="text-[0.75rem] text-[var(--text-muted)] mt-0.5 max-w-prose">{t('diskHealth.impactHint')}</p>
      </div>
      {current ? (
        <Banner
          tone="warn"
          title={t('diskHealth.impactRunning', { name: current.containerName })}
          action={
            <Button size="sm" variant="ghost" onClick={() => cancel.mutate()} loading={cancel.isPending}>
              {t('diskHealth.impactCancel')}
            </Button>
          }
        >
          {t('diskHealth.impactLeft', { value: formatSeconds(Math.max(0, Math.round((current.endsAt - now) / 1000))) })}
        </Banner>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('diskHealth.impactContainer')}>
            <Select value={containerId} onChange={(event) => setContainerId(event.target.value)} className="w-56">
              <option value="">{t('diskHealth.impactPick')}</option>
              {candidates.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('diskHealth.impactMinutes')}>
            <Select value={String(minutes)} onChange={(event) => setMinutes(Number(event.target.value))} className="w-28">
              {IMPACT_MINUTES.map((value) => (
                <option key={value} value={value}>
                  {value} min
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" disabled={!containerId} onClick={() => start.mutate()} loading={start.isPending}>
            {t('diskHealth.impactStart')}
          </Button>
        </div>
      )}
      {(data?.recent ?? []).filter((probe) => probe.state !== 'running').length > 0 ? (
        <ul className="divide-y divide-[var(--border)] text-[0.8125rem]">
          {(data?.recent ?? [])
            .filter((probe) => probe.state !== 'running')
            .slice(0, 8)
            .map((probe) => (
              <ImpactResult key={probe.id} probe={probe} />
            ))}
        </ul>
      ) : null}
    </Card>
  );
}

function ImpactResult({ probe }: { probe: ImpactProbe }): ReactNode {
  const { t } = useTranslation();
  return (
    <li className="py-2 space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{probe.containerName}</span>
        <span className="text-[0.75rem] text-[var(--text-muted)] tabular-nums">
          {formatDateTime(probe.startedAt)} · {probe.minutes} min
        </span>
      </div>
      {probe.state === 'done' ? (
        probe.disks.map((disk) => {
          const difference = disk.baselineBps - disk.pausedBps;
          return (
            <div key={disk.disk} className="text-[0.75rem] tabular-nums">
              <span className="text-[var(--text-muted)]">{disk.disk}: </span>
              {t('diskHealth.impactLine', {
                before: mbMin(disk.baselineBps),
                during: mbMin(disk.pausedBps),
                difference: `${difference >= 0 ? '−' : '+'}${mbMin(Math.abs(difference))}`,
                noise: mbMin(disk.noiseBps),
              })}{' '}
              <Badge tone={disk.significant ? 'accent' : 'neutral'}>
                {disk.significant ? t('diskHealth.impactSignificant') : t('diskHealth.impactNoise')}
              </Badge>
            </div>
          );
        })
      ) : (
        <div className="text-[0.75rem] text-[var(--text-muted)]">
          {t(`diskHealth.impactState_${probe.state}`)}
          {probe.error ? ` · ${probe.error}` : ''}
        </div>
      )}
    </li>
  );
}

function LogRatesCard(): ReactNode {
  const { t } = useTranslation();
  const notify = useToast();
  const [result, setResult] = useState<LogRatesResponse | null>(null);
  const measure = useMutation({
    mutationFn: () => api.logRates(LOG_MINUTES),
    onSuccess: ({ logRates }) => setResult(logRates),
    onError: () => notify(t('common.error'), 'danger'),
  });

  return (
    <Card className="p-5 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[0.9375rem] font-semibold">{t('diskHealth.logRatesTitle')}</h2>
          <p className="text-[0.75rem] text-[var(--text-muted)] mt-0.5 max-w-prose">{t('diskHealth.logRatesHint', { minutes: LOG_MINUTES })}</p>
        </div>
        <Button variant="ghost" onClick={() => measure.mutate()} loading={measure.isPending}>
          {t('diskHealth.logRatesMeasure')}
        </Button>
      </div>
      {result ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-[0.8125rem]">
            <thead>
              <tr className="text-left text-[0.6875rem] uppercase tracking-wide text-[var(--text-faint)]">
                <th className="py-1.5 pr-3 font-medium">{t('diskHealth.colContainer')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('diskHealth.colDriver')}</th>
                <th className="py-1.5 pr-3 text-right font-medium">KB/min</th>
                <th className="py-1.5 text-right font-medium">{t('diskHealth.linesPerMinute')}</th>
              </tr>
            </thead>
            <tbody>
              {result.rates.map((rate) => (
                <tr key={rate.containerId} className="border-t border-[var(--border)]">
                  <td className="py-1.5 pr-3">{rate.name}</td>
                  <td className="py-1.5 pr-3 text-[var(--text-muted)]">{rate.driver}</td>
                  {rate.error ? (
                    <td colSpan={2} className="py-1.5 text-right text-[0.75rem] text-[var(--text-muted)]">
                      {t('diskHealth.logRatesUnavailable')}
                    </td>
                  ) : (
                    <>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{((rate.bytesPerMinute ?? 0) / 1000).toFixed(1)}</td>
                      <td className="py-1.5 text-right tabular-nums">{(rate.linesPerMinute ?? 0).toFixed(1)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[0.75rem] text-[var(--text-muted)] mt-2">
            {t('diskHealth.logRatesMeasured', { at: formatEventTime(result.measuredAt) })}
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function MountsCard(): ReactNode {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: ['disk-mounts'], queryFn: () => api.diskMounts(), staleTime: 300_000 });
  const mounts = data?.mounts;

  return (
    <Card className="p-5 space-y-3">
      <div>
        <h2 className="text-[0.9375rem] font-semibold">{t('diskHealth.mountsTitle')}</h2>
        <p className="text-[0.75rem] text-[var(--text-muted)] mt-0.5 max-w-prose">{t('diskHealth.mountsHint')}</p>
      </div>
      {mounts === null ? <p className="text-[0.8125rem] text-[var(--text-muted)]">{t('diskHealth.mountsUnavailable')}</p> : null}
      {mounts && mounts.length > 0 ? (
        <ul className="divide-y divide-[var(--border)] text-[0.8125rem]">
          {mounts.map((mount) => (
            <MountItem key={`${mount.source}|${mount.mountPoint}`} mount={mount} />
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function MountItem({ mount }: { mount: MountReport }): ReactNode {
  const { t } = useTranslation();
  const commit = mount.commitSeconds ?? mount.defaultCommitSeconds;
  return (
    <li className="py-2 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{mount.mountPoint}</span>
        <span className="text-[0.75rem] text-[var(--text-muted)] break-all">
          {mount.fsType} · {mount.source}
        </span>
        <Badge tone={mount.atime === 'noatime' ? 'ok' : 'warn'}>{mount.atime}</Badge>
        {commit !== null ? (
          <Badge tone="neutral">{t('diskHealth.commit', { value: commit, fallback: mount.commitSeconds === null ? t('diskHealth.byDefault') : '' })}</Badge>
        ) : null}
        {mount.flags.map((flag) => (
          <Badge key={flag} tone={flag === 'autodefrag' ? 'warn' : 'neutral'}>
            {flag}
          </Badge>
        ))}
      </div>
      {mount.advice.map((advice) => (
        <p key={advice} className="text-[0.75rem] text-[var(--text-muted)] leading-snug">
          {t(`diskHealth.advice_${advice}`, { value: commit })}
        </p>
      ))}
    </li>
  );
}
