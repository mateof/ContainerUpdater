import { es, type Catalog } from './es.js';
import { en } from './en.js';
import { gl } from './gl.js';
import type { Translated } from './catalog.js';

/**
 * La lista manda; el tipo se deriva de ella.
 *
 * Antes eran dos declaraciones independientes (la union escrita a mano y el
 * array) que coincidian por disciplina. Asi es imposible anadir un idioma al
 * array y que el tipo no se entere, o al reves.
 */
export const locales = ['es', 'en', 'gl'] as const;
export type Locale = (typeof locales)[number];

export const catalogs: Record<Locale, Translated<Catalog>> = { es, en, gl };
export const defaultLocale: Locale = 'es';

export { es, en, gl };
export type { Catalog, Translated };

/**
 * Derivado de `locales` y no repitiendo la union a mano: era el cuarto sitio
 * donde estaban escritos los idiomas, y cada copia es una que se puede olvidar.
 */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
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
 * Recursos con la forma que espera i18next, uno por catalogo.
 *
 * Vive aqui y no en la web por un motivo concreto: la web tenia esa lista
 * escrita a mano y al anadir el galego se olvido. El idioma salia en el
 * selector, se podia elegir, y todos los textos seguian en castellano porque
 * i18next no lo conocia y caia al idioma por defecto. No fallaba nada, ni
 * siquiera de forma visible.
 *
 * Aqui, ademas de no haber lista que olvidar, hay tests que lo comprueban.
 */
export function i18nResources(): Record<string, { translation: Translated<Catalog> }> {
  return Object.fromEntries(
    locales.map((locale) => [locale, { translation: catalogs[locale] }]),
  );
}

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
