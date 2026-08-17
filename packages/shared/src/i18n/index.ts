import { es, type Catalog } from './es.js';
import { en } from './en.js';
import { gl } from './gl.js';
import type { Translated } from './catalog.js';

export type Locale = 'es' | 'en' | 'gl';

export const catalogs: Record<Locale, Translated<Catalog>> = { es, en, gl };
export const locales: Locale[] = ['es', 'en', 'gl'];
export const defaultLocale: Locale = 'es';

export { es, en, gl };
export type { Catalog, Translated };

export function isLocale(value: unknown): value is Locale {
  return value === 'es' || value === 'en' || value === 'gl';
}

/**
 * Nombre de cada idioma EN SU PROPIO idioma.
 *
 * Nunca traducido: quien busca su lengua en un selector la reconoce escrita como
 * ella la escribe, no como la llama el idioma en el que esta la interfaz.
 */
export const localeNames: Record<Locale, string> = {
  es: 'Espanol',
  en: 'English',
  gl: 'Galego',
};

/**
 * Traductor minimo para servidor y bot. La web usa i18next, que aporta plurales
 * y carga diferida; aqui no hacen falta y no merece la pena arrastrar la
 * dependencia al backend.
 *
 * Devuelve la propia clave si no existe, en vez de lanzar: un texto feo en un
 * mensaje de Telegram es preferible a tumbar el envio de una notificacion.
 */
export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const catalog = catalogs[locale] ?? catalogs[defaultLocale];
  const value = resolve(catalog, key) ?? resolve(catalogs[defaultLocale], key);
  if (typeof value !== 'string') return key;
  return params ? interpolate(value, params) : value;
}

/** Traductor ya ligado a un idioma, para no repetir el locale en cada llamada. */
export function translatorFor(locale: Locale) {
  return (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
}

function resolve(source: unknown, key: string): unknown {
  let current: unknown = source;
  for (const part of key.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Sustituye `{{nombre}}`. Los valores se insertan tal cual: quien construya
 * HTML para Telegram debe escaparlos antes de pasarlos aqui, porque este modulo
 * no sabe en que formato acabara el texto.
 */
function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
