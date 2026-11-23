import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  bytesPerSecondToMbPerMinute,
  DISK_IO_RANGES,
  type ContainerEvent,
  type ContainerEventKind,
  type DiskIoOp,
  type DiskIoRange,
  type DiskIoSeriesResponse,
  type DiskIoView,
  type DiskSummary,
  type SwapStatus,
} from '@cu/shared';
import { api } from '@/api/client';
import { Chart, type ChartMarker, type MarkerShape, type Series } from '@/components/Chart';
import { FilterPills } from '@/components/Filters';
import { Badge, Banner, Button, Card, EmptyState, Select, Skeleton, cx } from '@/components/ui';
import { IconAlert, IconDisk } from '@/components/icons';
import { DiskTabs } from './DiskTabs';
import { formatBytes, formatDateTime, formatDuration, formatEventTime } from '@/lib/format';

const CATEGORICAL = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'];
const OTHERS_COLOR = 'var(--series-other)';
const UNATTRIBUTED_COLOR = 'var(--series-unattributed)';
const REFRESH_MS = 60_000;
const EVENTS_PREVIEW = 8;
const CURSOR_EVENTS = 3;

const SHAPE: Record<ContainerEventKind, MarkerShape> = { start: 'up', unpause: 'up', stop: 'down', pause: 'down', pull: 'square' };

function useDataTheme(): string {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? '');
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme ?? ''));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function useStableColors(): (key: string) => string {
  const slots = useRef(new Map<string, number>());
  return (key: string) => {
    let slot = slots.current.get(key);
    if (slot === undefined) {
      const used = new Set(slots.current.values());
      slot = CATEGORICAL.findIndex((_, index) => !used.has(index));
      if (slot === -1) slot = slots.current.size % CATEGORICAL.length;
      slots.current.set(key, slot);
    }
    return `var(${CATEGORICAL[slot]})`;
  };
}

function mbMin(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '-';
  const value = bytesPerSecondToMbPerMinute(bps);
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function average(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0) / present.length;
}

function peak(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

export function DiskPage(): ReactNode {
  const { t } = useTranslation();
  const theme = useDataTheme();
  const colorFor = useStableColors();

  const [range, setRange] = useState<DiskIoRange>('1h');
  const [op, setOp] = useState<DiskIoOp>('write');
  const [view, setView] = useState<DiskIoView>('disks');
  const [selectedDisks, setSelectedDisks] = useState<string[]>([]);
  const [referenceDisk, setReferenceDisk] = useState<string>('');
  const [project, setProject] = useState('');
  const [top, setTop] = useState(5);
  const [containers, setContainers] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [showMarkers, setShowMarkers] = useState<'on' | 'off'>('on');

  const { data: statusData, isLoading } = useQuery({
    queryKey: ['disk-io', 'status'],
    queryFn: () => api.diskStatus(),
    refetchInterval: REFRESH_MS,
  });
  const status = statusData?.status;

  const params = useMemo(() => {
    const result: Record<string, string> = { range, op, view, top: String(top) };
    if (selectedDisks.length > 0) result.disks = selectedDisks.join(',');
    if (view === 'stacked' && referenceDisk) result.disk = referenceDisk;
    if (project) result.project = project;
    if (containers.length > 0) result.containers = containers.join(',');
    return result;
  }, [range, op, view, top, selectedDisks, referenceDisk, project, containers]);

  const { data: seriesData } = useQuery({
    queryKey: ['disk-io', 'series', params],
    queryFn: () => api.diskSeries(params),
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
    enabled: Boolean(status?.enabled),
  });
  const series = seriesData?.series;

  if (isLoading || !status) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const watched = status.disks.map((disk) => disk.name);

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('disk.title')}</h1>
          <p className="text-[0.8125rem] text-[var(--text-muted)] mt-0.5 max-w-prose">{t('disk.subtitle')}</p>
        </div>
        <DiskTabs />
      </div>

      {!status.enabled ? (
        <Card>
          <EmptyState
            icon={<IconDisk size={28} />}
            title={t('disk.disabledTitle')}
            description={t('disk.disabledBody')}
            action={
              <Link to="/settings">
                <Button variant="primary">{t('disk.goToSettings')}</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          {!status.procAvailable ? (
            <Banner tone="danger" title={t('disk.noProc')}>
              {t('disk.noProcBody')}
            </Banner>
          ) : null}
          {status.procAvailable && status.disks.length > 0 && !status.attributionAvailable ? (
            <Banner tone="info" title={t('disk.noBlkio')}>
              {t('disk.noBlkioBody')}
            </Banner>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {status.disks.map((disk) => (
              <DiskCard key={disk.name} disk={disk} color={colorFor(`disk:${disk.name}`)} />
            ))}
            {status.swap ? <SwapCard swap={status.swap} /> : null}
          </div>

          <Card className="p-5 space-y-4">
            <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
              <FilterGroup label={t('disk.range')}>
                <FilterPills
                  value={range}
                  onChange={setRange}
                  options={DISK_IO_RANGES.map((key) => ({ key, label: key.replace(/(\d+)/, '$1 ') }))}
                />
              </FilterGroup>
              <FilterGroup label={t('disk.op')}>
                <FilterPills
                  value={op}
                  onChange={setOp}
                  options={[
                    { key: 'write', label: t('disk.opWrite') },
                    { key: 'read', label: t('disk.opRead') },
                  ]}
                />
              </FilterGroup>
              <FilterGroup label={t('disk.view')}>
                <FilterPills
                  value={view}
                  onChange={setView}
                  options={[
                    { key: 'disks', label: t('disk.viewDisks') },
                    { key: 'stacked', label: t('disk.viewStacked') },
                  ]}
                />
              </FilterGroup>
              <FilterGroup label={t('disk.markers')}>
                <FilterPills
                  value={showMarkers}
                  onChange={setShowMarkers}
                  options={[
                    { key: 'on', label: t('disk.markersOn') },
                    { key: 'off', label: t('disk.markersOff') },
                  ]}
                />
              </FilterGroup>
            </div>

            <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
              {view === 'disks' ? (
                <FilterGroup label={t('disk.disks')}>
                  <ToggleChips
                    options={watched}
                    selected={selectedDisks}
                    onChange={setSelectedDisks}
                  />
                </FilterGroup>
              ) : (
                <>
                  <FilterGroup label={t('disk.referenceDisk')}>
                    <Select
                      value={referenceDisk || series?.stack?.disk || ''}
                      onChange={(event) => setReferenceDisk(event.target.value)}
                      className="w-36"
                    >
                      {watched.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </Select>
                  </FilterGroup>
                  <FilterGroup label={t('disk.project')}>
                    <Select value={project} onChange={(event) => setProject(event.target.value)} className="w-44">
                      <option value="">{t('disk.allProjects')}</option>
                      {(series?.projects ?? []).map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </Select>
                  </FilterGroup>
                  <FilterGroup label={t('disk.top')}>
                    <Select
                      value={String(top)}
                      onChange={(event) => setTop(Number(event.target.value))}
                      className="w-40"
                      disabled={containers.length > 0}
                    >
                      {[3, 5, 6].map((count) => (
                        <option key={count} value={count}>
                          {t('disk.topN', { count })}
                        </option>
                      ))}
                    </Select>
                  </FilterGroup>
                  <ContainerPicker
                    available={(series?.containers ?? []).filter((c) => !project || c.project === project)}
                    selected={containers}
                    onChange={setContainers}
                  />
                </>
              )}
            </div>

            {series ? (
              <SourceNotice series={series} memorySince={status.memorySince} historyEnabled={status.historyEnabled} />
            ) : null}

            {series ? (
              <SeriesChart
                series={series}
                view={view}
                theme={theme}
                colorFor={colorFor}
                cursor={cursor}
                onCursor={setCursor}
                showMarkers={showMarkers === 'on'}
              />
            ) : (
              <Skeleton className="h-64 w-full" />
            )}
          </Card>

          {series && showMarkers === 'on' ? <EventList events={series.events} truncated={series.eventsTruncated} /> : null}

          <p className="text-[0.75rem] text-[var(--text-muted)] leading-snug max-w-prose">{t('disk.approxNote')}</p>
        </>
      )}
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="space-y-1.5">
      <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--text-faint)]">{label}</p>
      {children}
    </div>
  );
}

function ToggleChips({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}): ReactNode {
  const active = (name: string) => selected.length === 0 || selected.includes(name);
  const toggle = (name: string) => {
    const current = selected.length === 0 ? options : selected;
    const next = current.includes(name) ? current.filter((item) => item !== name) : [...current, name];
    onChange(next.length === options.length || next.length === 0 ? [] : next);
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((name) => (
        <button
          key={name}
          type="button"
          aria-pressed={active(name)}
          onClick={() => toggle(name)}
          className={cx(
            'rounded-full px-3 py-1 text-[0.75rem] font-medium tabular-nums transition-colors duration-[var(--dur-fast)]',
            active(name)
              ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
              : 'bg-[var(--bg-inset)] text-[var(--text-muted)] hover:text-[var(--text)]',
          )}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

function ContainerPicker({
  available,
  selected,
  onChange,
}: {
  available: Array<{ name: string; project: string | null }>;
  selected: string[];
  onChange: (next: string[]) => void;
}): ReactNode {
  const { t } = useTranslation();
  return (
    <details className="relative">
      <summary className="list-none cursor-pointer space-y-1.5">
        <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--text-faint)]">
          {t('disk.containers')}
        </p>
        <span className="inline-flex h-9 items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-inset)] px-3 text-[0.8125rem]">
          {selected.length > 0 ? t('disk.containersSelected', { count: selected.length }) : t('disk.containersTop')}
        </span>
      </summary>
      <div className="absolute z-20 mt-1 max-h-72 w-64 overflow-auto rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-elevated)] p-2 shadow-[var(--shadow-lg)]">
        {selected.length > 0 ? (
          <button
            type="button"
            className="mb-1 w-full rounded px-2 py-1 text-left text-[0.75rem] text-[var(--accent)] hover:bg-[var(--bg-hover)]"
            onClick={() => onChange([])}
          >
            {t('disk.clearContainers')}
          </button>
        ) : null}
        {available.map((container) => (
          <label
            key={container.name}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[0.8125rem] hover:bg-[var(--bg-hover)]"
          >
            <input
              type="checkbox"
              checked={selected.includes(container.name)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, container.name]
                    : selected.filter((name) => name !== container.name),
                )
              }
            />
            <span className="truncate">{container.name}</span>
            {container.project ? (
              <span className="ml-auto truncate text-[0.6875rem] text-[var(--text-faint)]">{container.project}</span>
            ) : null}
          </label>
        ))}
      </div>
    </details>
  );
}

function SourceNotice({
  series,
  memorySince,
  historyEnabled,
}: {
  series: DiskIoSeriesResponse;
  memorySince: number | null;
  historyEnabled: boolean;
}): ReactNode {
  const { t } = useTranslation();
  if (series.source === 'memory') {
    return (
      <Banner tone="info" title={t('disk.sourceMemory')}>
        {t(historyEnabled ? 'disk.sourcePendingBody' : 'disk.sourceMemoryBody', {
          since: formatDateTime(memorySince ?? series.coverageFrom),
        })}
      </Banner>
    );
  }
  if (series.source === 'mixed') {
    return (
      <Banner tone="info" title={t('disk.sourceMixed')}>
        {t('disk.sourceMixedBody')}{' '}
        {series.coverageFrom ? t('disk.partialCoverage', { since: formatDateTime(series.coverageFrom) }) : null}
      </Banner>
    );
  }
  return null;
}

interface Row {
  key: string;
  label: string;
  color: string;
  values: Array<number | null>;
  peaks?: Array<number | null>;
}

function SeriesChart({
  series,
  view,
  theme,
  colorFor,
  cursor,
  onCursor,
  showMarkers,
}: {
  series: DiskIoSeriesResponse;
  view: DiskIoView;
  theme: string;
  colorFor: (key: string) => string;
  cursor: number | null;
  onCursor: (index: number | null) => void;
  showMarkers: boolean;
}): ReactNode {
  const { t } = useTranslation();

  const markers: ChartMarker[] = useMemo(
    () => (showMarkers ? series.events.map((event) => ({ at: event.at, shape: SHAPE[event.kind] })) : []),
    [series.events, showMarkers],
  );

  const rows: Row[] = useMemo(() => {
    if (view === 'stacked' && series.stack) {
      return [
        ...series.stack.containers.map((container) => ({
          key: `container:${container.name}`,
          label: container.name,
          color: colorFor(`container:${container.name}`),
          values: container.values,
        })),
        { key: 'others', label: t('disk.others'), color: OTHERS_COLOR, values: series.stack.others },
        { key: 'unattributed', label: t('disk.unattributed'), color: UNATTRIBUTED_COLOR, values: series.stack.unattributed },
      ];
    }
    return series.disks.map((disk) => ({
      key: `disk:${disk.name}`,
      label: disk.name,
      color: colorFor(`disk:${disk.name}`),
      values: disk.values,
      peaks: disk.peaks,
    }));
  }, [series, view, colorFor, t]);

  const chartSeries: Series[] = useMemo(
    () =>
      rows.map((row) => ({
        label: row.label,
        color: row.color,
        values: row.values,
        fill: view === 'disks' && rows.length === 1,
      })),
    [rows, view],
  );

  const hasData = rows.some((row) => row.values.some((value) => value !== null));
  if (!hasData) {
    return <EmptyState icon={<IconDisk size={24} />} title={t('disk.noData')} />;
  }

  const stackTotal = view === 'stacked' && series.stack ? series.stack : null;
  const totalAverage = stackTotal ? rows.reduce((sum, row) => sum + (average(row.values) ?? 0), 0) : null;
  const atCursor = cursor !== null ? series.timestamps[cursor] : null;
  const cursorEvents =
    showMarkers && atCursor
      ? series.events.filter((event) => event.at >= atCursor && event.at < atCursor + series.stepSeconds * 1000)
      : [];

  return (
    <div className="space-y-3">
      <Chart
        timestamps={series.timestamps}
        series={chartSeries}
        height={260}
        stacked={view === 'stacked'}
        structureKey={`${theme}|${rows.map((row) => `${row.key}=${row.color}`).join(',')}`}
        formatValue={(value) => mbMin(value)}
        onCursor={onCursor}
        markers={markers}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-[0.75rem] text-[var(--text-muted)]">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{t('disk.unit')}</span>
          {markers.length > 0 ? <MarkerLegend /> : null}
        </span>
        {atCursor ? (
          <span className="tabular-nums">
            {formatDateTime(atCursor)}
            {cursorEvents.length > 0 ? <CursorEvents events={cursorEvents} /> : null}
          </span>
        ) : null}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="text-left text-[0.6875rem] uppercase tracking-wide text-[var(--text-faint)]">
              <th className="py-1.5 pr-3 font-medium">{t('disk.series')}</th>
              {cursor !== null ? <th className="py-1.5 pr-3 text-right font-medium">{formatDateTime(atCursor)}</th> : null}
              <th className="py-1.5 pr-3 text-right font-medium">{t('disk.average')}</th>
              <th className="py-1.5 text-right font-medium">{t('disk.peak')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const mean = average(row.values);
              return (
                <tr key={row.key} className="border-t border-[var(--border)]">
                  <td className="py-1.5 pr-3">
                    <span className="flex items-center gap-2">
                      <span className="size-2.5 shrink-0 rounded-sm" style={{ background: row.color }} aria-hidden="true" />
                      <span className="truncate">{row.label}</span>
                      {totalAverage && mean !== null ? (
                        <span className="text-[var(--text-faint)] tabular-nums">
                          {((mean / totalAverage) * 100).toFixed(0)}%
                        </span>
                      ) : null}
                    </span>
                  </td>
                  {cursor !== null ? (
                    <td className="py-1.5 pr-3 text-right tabular-nums">{mbMin(row.values[cursor])}</td>
                  ) : null}
                  <td className="py-1.5 pr-3 text-right tabular-nums">{mbMin(mean)}</td>
                  <td className="py-1.5 text-right tabular-nums">{mbMin(peak(row.peaks ?? row.values))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {stackTotal && stackTotal.attributedShare !== null ? (
        <p className="text-[0.75rem] text-[var(--text-muted)]">
          {t('disk.attribution', { value: `${Math.round(stackTotal.attributedShare * 100)}%` })}
        </p>
      ) : null}
    </div>
  );
}

function MarkerGlyph({ shape }: { shape: MarkerShape | 'mixed' }): ReactNode {
  const points =
    shape === 'up'
      ? '5,1 9,9 1,9'
      : shape === 'down'
        ? '1,1 9,1 5,9'
        : shape === 'square'
          ? '2,2 8,2 8,8 2,8'
          : '5,1 9,5 5,9 1,5';
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="shrink-0">
      <polygon points={points} fill="var(--text-muted)" />
    </svg>
  );
}

function MarkerLegend(): ReactNode {
  const { t } = useTranslation();
  return (
    <>
      <span className="inline-flex items-center gap-1">
        <MarkerGlyph shape="up" />
        {t('disk.legendUp')}
      </span>
      <span className="inline-flex items-center gap-1">
        <MarkerGlyph shape="down" />
        {t('disk.legendDown')}
      </span>
      <span className="inline-flex items-center gap-1">
        <MarkerGlyph shape="square" />
        {t('disk.legendPull')}
      </span>
      <span className="inline-flex items-center gap-1">
        <MarkerGlyph shape="mixed" />
        {t('disk.legendMixed')}
      </span>
    </>
  );
}

function eventLabel(event: ContainerEvent, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (event.kind === 'pull') return t('disk.eventPull', { image: event.container });
  const action = t(`disk.eventKind_${event.kind}`);
  const exit = event.exitCode !== null && event.exitCode !== 0 ? ` (${t('disk.eventExit', { code: event.exitCode })})` : '';
  const subject = event.source === 'package' ? t('disk.eventPackage', { name: event.container }) : event.container;
  return `${subject} ${action}${exit}`;
}

function CursorEvents({ events }: { events: ContainerEvent[] }): ReactNode {
  const { t } = useTranslation();
  const shown = events.slice(0, CURSOR_EVENTS).map((event) => eventLabel(event, t));
  const rest = events.length - shown.length;
  return <span>{` · ${shown.join(', ')}${rest > 0 ? ` +${rest}` : ''}`}</span>;
}

function EventList({ events, truncated }: { events: ContainerEvent[]; truncated: boolean }): ReactNode {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const newest = useMemo(() => [...events].reverse(), [events]);
  const visible = expanded ? newest : newest.slice(0, EVENTS_PREVIEW);

  return (
    <Card className="p-5 space-y-3">
      <div>
        <h2 className="text-[0.9375rem] font-semibold">{t('disk.eventsTitle')}</h2>
        <p className="text-[0.75rem] text-[var(--text-muted)] mt-0.5">{t('disk.eventsHint')}</p>
      </div>
      {newest.length === 0 ? (
        <p className="text-[0.8125rem] text-[var(--text-muted)]">{t('disk.eventsEmpty')}</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] text-[0.8125rem]">
          {visible.map((event) => (
            <li key={`${event.at}|${event.container}|${event.kind}`} className="flex items-baseline gap-3 py-1.5">
              <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{formatEventTime(event.at)}</span>
              <span className="flex min-w-0 items-baseline gap-2">
                <MarkerGlyph shape={SHAPE[event.kind]} />
                <span className="min-w-0 break-words">{eventLabel(event, t)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {newest.length > EVENTS_PREVIEW ? (
        <Button variant="ghost" onClick={() => setExpanded((value) => !value)}>
          {expanded ? t('disk.eventsLess') : t('disk.eventsMore', { count: newest.length })}
        </Button>
      ) : null}
      {truncated ? (
        <p className="text-[0.75rem] text-[var(--text-muted)]">{t('disk.eventsTruncated', { count: events.length })}</p>
      ) : null}
    </Card>
  );
}

function SwapCard({ swap }: { swap: SwapStatus }): ReactNode {
  const { t } = useTranslation();
  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[0.9375rem] font-semibold">{t('disk.swapTitle')}</h2>
        <span className="text-[0.75rem] text-[var(--text-muted)] tabular-nums">
          {t('disk.swapUsed', { used: formatBytes(swap.usedBytes), total: formatBytes(swap.totalBytes) })}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Metric label={t('disk.swapNow')} value={`${mbMin(swap.outBpsNow)} MB/min`} />
        <Metric label={t('disk.swapHour')} value={`${mbMin(swap.outBpsHour)} MB/min`} />
      </div>
      <p className="text-[0.75rem] text-[var(--text-muted)] leading-snug">{t('disk.swapHint')}</p>
    </Card>
  );
}

function DiskCard({ disk, color }: { disk: DiskSummary; color: string }): ReactNode {
  const { t } = useTranslation();
  const current = disk.current;
  const hourCovered = disk.lifetime.find((entry) => entry.window === '1h')?.coveredSeconds ?? 0;

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: color }} aria-hidden="true" />
            {disk.name}
          </p>
          {disk.label ? <p className="text-[0.75rem] text-[var(--text-faint)] truncate">{disk.label}</p> : null}
        </div>
        {disk.alert.active ? (
          <Badge tone="warn" title={formatDateTime(disk.alert.since)}>
            <IconAlert size={12} />
            {t('disk.alertActive')}
          </Badge>
        ) : (
          <span className="text-[0.6875rem] text-[var(--text-faint)] whitespace-nowrap">
            {t('disk.threshold', { value: disk.thresholdMbPerMin })}
          </span>
        )}
      </div>

      {current ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[0.8125rem]">
          <Metric label={t('disk.now')} value={`${mbMin(current.writeBps)} MB/min`} strong />
          <Metric
            label={t('disk.lastHour')}
            value={`${mbMin(disk.hourWriteBps)} MB/min`}
            note={hourCovered < 3240 ? t('disk.partialWindow', { value: formatDuration(hourCovered) }) : undefined}
            strong
          />
          <Metric
            label={t('disk.avgIo')}
            value={current.avgWriteIoBytes ? `${(current.avgWriteIoBytes / 1024).toFixed(0)} KB` : '-'}
          />
          <Metric
            label={current.flushesPerSecond !== null ? t('disk.flushes') : t('disk.iops')}
            value={(current.flushesPerSecond ?? current.writeIops).toFixed(1)}
          />
        </div>
      ) : (
        <p className="text-[0.8125rem] text-[var(--text-muted)]">{t('disk.waiting')}</p>
      )}

      <div className="space-y-1 border-t border-[var(--border)] pt-3">
        <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--text-faint)]">
          {t('disk.lifetime')}
        </p>
        {disk.tbwTb === null ? (
          <p className="text-[0.75rem] text-[var(--text-muted)]">{t('disk.noTbw')}</p>
        ) : disk.usedTb !== null && disk.usedTb >= disk.tbwTb ? (
          <div className="space-y-1 text-[0.8125rem]">
            <p className="font-medium tabular-nums">
              {t('disk.tbwExceeded', { used: disk.usedTb.toFixed(1), tbw: disk.tbwTb })}
            </p>
            <p className="text-[0.75rem] text-[var(--text-muted)]">{t('disk.tbwExceededHint')}</p>
          </div>
        ) : (
          <>
            {disk.lifetime.map((entry) => {
              const partial = entry.coveredSeconds < entry.windowSeconds * 0.9;
              return (
                <div key={entry.window} className="flex items-baseline justify-between gap-3 text-[0.8125rem]">
                  <span className="text-[var(--text-muted)]">{t(`disk.window_${entry.window}`)}</span>
                  <span className="text-right tabular-nums">
                    {entry.bytesPerSecond === null
                      ? t('disk.notEnoughData')
                      : entry.years === null
                        ? t('disk.noWrites')
                        : t('disk.years', { value: entry.years >= 100 ? '> 99' : entry.years.toFixed(1) })}
                    {entry.bytesPerSecond !== null && partial ? (
                      <span className="block text-[0.6875rem] text-[var(--text-faint)]">
                        {t('disk.partialWindow', { value: formatDuration(entry.coveredSeconds) })}
                      </span>
                    ) : null}
                  </span>
                </div>
              );
            })}
            {disk.remainingTb !== null ? (
              <p className="text-[0.75rem] text-[var(--text-faint)] tabular-nums">
                {t('disk.remaining', { value: disk.remainingTb.toFixed(1), tbw: disk.tbwTb })}
              </p>
            ) : null}
          </>
        )}
      </div>

      {disk.attributedShare !== null ? (
        <p className="text-[0.75rem] text-[var(--text-muted)] border-t border-[var(--border)] pt-3">
          {disk.attributedShare > 0
            ? t('disk.attribution', { value: `${Math.round(disk.attributedShare * 100)}%` })
            : t('disk.attributionNone')}
        </p>
      ) : null}
    </Card>
  );
}

function Metric({
  label,
  value,
  note,
  strong,
}: {
  label: string;
  value: string;
  note?: string;
  strong?: boolean;
}): ReactNode {
  return (
    <div className="min-w-0">
      <p className="text-[0.6875rem] text-[var(--text-faint)]">{label}</p>
      <p className={cx('tabular-nums truncate', strong && 'text-base font-semibold')}>{value}</p>
      {note ? <p className="text-[0.6875rem] text-[var(--text-faint)]">{note}</p> : null}
    </div>
  );
}
