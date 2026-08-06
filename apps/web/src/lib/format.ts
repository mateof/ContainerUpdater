/**
 * Formateo para la interfaz. Todo respeta el idioma activo.
 */
import { currentLocale } from '@/i18n';

const localeTag = () => (currentLocale() === 'es' ? 'es-ES' : 'en-GB');

export function formatBytes(bytes: number | null | undefined, decimals = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : decimals)} ${units[index]}`;
}

export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined) return '-';
  return `${formatBytes(bytesPerSecond, 0)}/s`;
}

export function formatPercent(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return `${value.toFixed(decimals)}%`;
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '-';
  return new Intl.DateTimeFormat(localeTag(), {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(ts));
}

/**
 * Tiempo relativo ("hace 3 horas"). Se usa Intl.RelativeTimeFormat en vez de
 * una tabla propia para que los plurales y el genero salgan bien en los dos
 * idiomas sin mantenerlos a mano.
 */
export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return '-';
  const formatter = new Intl.RelativeTimeFormat(localeTag(), { numeric: 'auto' });
  const deltaSeconds = Math.round((ts - Date.now()) / 1000);
  const absolute = Math.abs(deltaSeconds);

  if (absolute < 60) return formatter.format(deltaSeconds, 'second');
  if (absolute < 3600) return formatter.format(Math.round(deltaSeconds / 60), 'minute');
  if (absolute < 86400) return formatter.format(Math.round(deltaSeconds / 3600), 'hour');
  if (absolute < 2592000) return formatter.format(Math.round(deltaSeconds / 86400), 'day');
  if (absolute < 31536000) return formatter.format(Math.round(deltaSeconds / 2592000), 'month');
  return formatter.format(Math.round(deltaSeconds / 31536000), 'year');
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds < 0) return '-';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** Digest completo recortado a algo legible: `sha256:6be2079f…`. */
export function shortDigest(digest: string | null | undefined, length = 12): string {
  if (!digest) return '-';
  const value = digest.includes(':') ? (digest.split(':')[1] ?? digest) : digest;
  return value.slice(0, length);
}

/**
 * Nombre corto de una imagen para la interfaz. Se quitan el host de Docker Hub
 * y el `library/` implicito, que no aportan y ocupan la mitad de la columna.
 */
export function displayImage(ref: string): string {
  return ref.replace(/^registry-1\.docker\.io\//, '').replace(/^library\//, '');
}
