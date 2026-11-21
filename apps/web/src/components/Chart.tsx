/**
 * Graficas de series temporales con uPlot.
 *
 * uPlot dibuja sobre canvas: mil puntos son mil operaciones de dibujo, no mil
 * nodos del DOM. Con treinta contenedores en pantalla, una libreria basada en
 * SVG genera miles de nodos y el navegador de un NAS se arrastra.
 *
 * La instancia se crea una sola vez y despues solo se le pasan datos con
 * `setData`, que no vuelve a construir nada.
 */
import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import type { ReactNode } from 'react';

export interface Series {
  label: string;
  values: Array<number | null>;
  color: string;
  fill?: boolean;
}

interface ChartProps {
  timestamps: number[];
  series: Series[];
  height?: number;
  /** Fija el maximo del eje Y. Util en porcentajes para que 0-100 sea estable. */
  maxY?: number;
  formatValue?: (value: number) => string;
  stacked?: boolean;
  structureKey?: string;
  onCursor?: (index: number | null) => void;
  markers?: ChartMarker[];
}

export type MarkerShape = 'up' | 'down' | 'square';

export interface ChartMarker {
  at: number;
  shape: MarkerShape;
}

export interface MarkerCluster {
  x: number;
  count: number;
  shape: MarkerShape | 'mixed';
}

export function clusterMarkers(positions: Array<{ x: number; shape: MarkerShape }>, gap: number): MarkerCluster[] {
  const sorted = [...positions].sort((a, b) => a.x - b.x);
  const clusters: MarkerCluster[] = [];
  let anchor = Number.NEGATIVE_INFINITY;
  for (const position of sorted) {
    const last = clusters.at(-1);
    if (last && position.x - anchor <= gap) {
      last.count += 1;
      if (last.shape !== position.shape) last.shape = 'mixed';
      continue;
    }
    anchor = position.x;
    clusters.push({ x: position.x, count: 1, shape: position.shape });
  }
  return clusters;
}

function drawMarkers(u: uPlot, markers: ChartMarker[], line: string, ink: string): void {
  if (markers.length === 0) return;
  const ratio = uPlot.pxRatio;
  const { left, top, width, height } = u.bbox;
  const positions = markers
    .map((marker) => ({ x: u.valToPos(marker.at / 1000, 'x', true), shape: marker.shape }))
    .filter((position) => position.x >= left && position.x <= left + width);
  const clusters = clusterMarkers(positions, 24 * ratio);
  const size = 4 * ratio;
  const ctx = u.ctx;
  ctx.save();
  ctx.lineWidth = ratio;
  ctx.strokeStyle = line;
  for (const cluster of clusters) {
    const x = Math.round(cluster.x) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, top + size * 2);
    ctx.lineTo(x, top + height);
    ctx.stroke();
  }
  ctx.fillStyle = ink;
  ctx.font = `${10 * ratio}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  for (const cluster of clusters) {
    const x = Math.round(cluster.x) + 0.5;
    const y = top + size;
    ctx.beginPath();
    if (cluster.shape === 'up') {
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y + size);
      ctx.lineTo(x - size, y + size);
    } else if (cluster.shape === 'down') {
      ctx.moveTo(x - size, y - size);
      ctx.lineTo(x + size, y - size);
      ctx.lineTo(x, y + size);
    } else if (cluster.shape === 'square') {
      ctx.rect(x - size * 0.8, y - size * 0.8, size * 1.6, size * 1.6);
    } else {
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x, y + size);
      ctx.lineTo(x - size, y);
    }
    ctx.closePath();
    ctx.fill();
    if (cluster.count > 1) ctx.fillText(String(cluster.count), x + size + 2 * ratio, y);
  }
  ctx.restore();
}

const NO_MARKERS: ChartMarker[] = [];

export function isolatedIndices(values: ReadonlyArray<number | null | undefined>): number[] {
  const present = (index: number) => values[index] !== null && values[index] !== undefined;
  return values.flatMap((_, index) => (present(index) && !present(index - 1) && !present(index + 1) ? [index] : []));
}

function isolatedPoints(u: uPlot, seriesIdx: number): number[] {
  return isolatedIndices(u.data[seriesIdx] as Array<number | null>);
}

export function toPlotData(
  timestamps: number[],
  series: Series[],
  stacked: boolean,
): uPlot.AlignedData {
  const xs = timestamps.map((ts) => ts / 1000);
  if (!stacked) return [xs, ...series.map((entry) => entry.values)] as uPlot.AlignedData;
  const cumulative: Array<Array<number | null>> = [];
  series.forEach((entry, index) => {
    cumulative.push(
      entry.values.map((value, i) => {
        if (value === null) return null;
        const below = index === 0 ? 0 : cumulative[index - 1]![i];
        return below === null || below === undefined ? null : below + value;
      }),
    );
  });
  return [xs, ...cumulative.reverse()] as uPlot.AlignedData;
}

export function Chart({
  timestamps,
  series,
  height = 160,
  maxY,
  formatValue,
  stacked = false,
  structureKey = '',
  onCursor,
  markers = NO_MARKERS,
}: ChartProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const formatRef = useRef(formatValue);
  formatRef.current = formatValue;
  const cursorRef = useRef(onCursor);
  cursorRef.current = onCursor;
  const markersRef = useRef(markers);
  markersRef.current = markers;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const readVar = (name: string): string =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const resolve = (color: string): string =>
      color.replace(/var\((--[\w-]+)\)/g, (_match, name: string) => readVar(name) || 'currentColor');

    const options: uPlot.Options = {
      width: container.clientWidth,
      height,
      // Sin leyenda ni cursor de puntos: en un panel con muchas graficas
      // pequenas estorban mas de lo que informan.
      legend: { show: false },
      cursor: { show: true, y: false, points: { show: false } },
      scales: {
        x: { time: true },
        y: { range: maxY !== undefined ? [0, maxY] : undefined },
      },
      axes: [
        {
          stroke: readVar('--text-faint'),
          grid: { show: false },
          ticks: { show: false },
          size: 28,
          font: '11px ui-sans-serif, system-ui, sans-serif',
        },
        {
          stroke: readVar('--text-faint'),
          grid: { stroke: readVar('--border'), width: 1 },
          ticks: { show: false },
          size: 42,
          font: '11px ui-sans-serif, system-ui, sans-serif',
          values: (_self, splits) =>
            splits.map((value) => (formatRef.current ? formatRef.current(value) : String(value))),
        },
      ],
      hooks: {
        setCursor: [(u) => cursorRef.current?.(u.cursor.idx ?? null)],
        draw: [(u) => drawMarkers(u, markersRef.current, readVar('--text-faint'), readVar('--text-muted'))],
      },
      series: [
        {},
        ...(stacked ? [...series].reverse() : series).map((entry) => ({
          label: entry.label,
          stroke: stacked ? readVar('--bg-elevated') : resolve(entry.color),
          width: 2,
          fill: stacked
            ? resolve(entry.color)
            : entry.fill
              ? resolve(`color-mix(in oklab, ${entry.color} 18%, transparent)`)
              : undefined,
          points: { show: true, size: 5, filter: isolatedPoints, fill: resolve(entry.color), stroke: resolve(entry.color) },
          // Las muestras pueden faltar (primera lectura sin delta). spanGaps
          // en false deja el hueco visible en vez de inventar una linea recta.
          spanGaps: false,
        })),
      ],
      padding: [8, 8, 0, 0],
    };

    const data = toPlotData(timestamps, series, stacked);

    const plot = new uPlot(options, data, container);
    plotRef.current = plot;

    // ResizeObserver y no un listener de window: la grafica cambia de ancho al
    // plegar la barra lateral, sin que la ventana se mueva.
    const observer = new ResizeObserver(() => {
      plot.setSize({ width: container.clientWidth, height });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // Solo se recrea si cambia la estructura (numero de series o altura), no en
    // cada llegada de datos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, maxY, series.length, stacked, structureKey]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    plot.setData(toPlotData(timestamps, series, stacked));
  }, [timestamps, series, stacked]);

  useEffect(() => {
    plotRef.current?.redraw(false, false);
  }, [markers]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}

/**
 * Grafica minima en linea, para las filas de una tabla. Se dibuja a mano con un
 * path SVG: para veinte puntos, montar uPlot cuesta mas que el propio dibujo.
 */
export function Sparkline({
  values,
  color,
  width = 64,
  height = 20,
}: {
  values: Array<number | null>;
  color: string;
  width?: number;
  height?: number;
}): ReactNode {
  const points = values.filter((v): v is number => v !== null);
  if (points.length < 2) return <div style={{ width, height }} />;

  const max = Math.max(...points, 1);
  const step = width / (points.length - 1);
  const path = points
    .map((value, index) => {
      const x = index * step;
      const y = height - (value / max) * (height - 2) - 1;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} aria-hidden="true" className="shrink-0 overflow-visible">
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** Barra de progreso con color por umbral. */
export function Meter({
  value,
  max = 100,
  label,
}: {
  value: number;
  max?: number;
  label?: string;
}): ReactNode {
  const percent = Math.min(100, Math.max(0, (value / max) * 100));
  const color =
    percent > 90 ? 'var(--danger)' : percent > 75 ? 'var(--warn)' : 'var(--accent)';

  return (
    <div className="w-full" role="meter" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      {label ? (
        <div className="flex justify-between text-[0.6875rem] text-[var(--text-muted)] mb-1">
          <span>{label}</span>
          <span className="tabular-nums">{percent.toFixed(0)}%</span>
        </div>
      ) : null}
      <div className="h-1.5 w-full rounded-full bg-[var(--bg-inset)] overflow-hidden">
        {/* Se anima scaleX en vez de width: width fuerza layout en cada frame. */}
        <div
          className="h-full origin-left rounded-full transition-transform duration-500 ease-out will-change-transform"
          style={{ background: color, transform: `scaleX(${percent / 100})`, width: '100%' }}
        />
      </div>
    </div>
  );
}
