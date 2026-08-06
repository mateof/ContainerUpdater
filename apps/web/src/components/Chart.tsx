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
}

export function Chart({
  timestamps,
  series,
  height = 160,
  maxY,
  formatValue,
}: ChartProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const formatRef = useRef(formatValue);
  formatRef.current = formatValue;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const readVar = (name: string): string =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();

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
      series: [
        {},
        ...series.map((entry) => ({
          label: entry.label,
          stroke: entry.color,
          width: 2,
          fill: entry.fill ? `color-mix(in oklab, ${entry.color} 18%, transparent)` : undefined,
          points: { show: false },
          // Las muestras pueden faltar (primera lectura sin delta). spanGaps
          // en false deja el hueco visible en vez de inventar una linea recta.
          spanGaps: false,
        })),
      ],
      padding: [8, 8, 0, 0],
    };

    const data: uPlot.AlignedData = [
      timestamps.map((ts) => ts / 1000),
      ...series.map((entry) => entry.values),
    ] as uPlot.AlignedData;

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
  }, [height, maxY, series.length]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    plot.setData([
      timestamps.map((ts) => ts / 1000),
      ...series.map((entry) => entry.values),
    ] as uPlot.AlignedData);
  }, [timestamps, series]);

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
