export * from './types.js';
export * from './schemas.js';
export * from './focus.js';
export * from './release.js';
export * from './ports.js';
export * from './ports-table.js';
export * from './mcp.js';
export * from './mcp-setup.js';
export * from './quarantine.js';
// Los valores base de las pruebas viven aqui para que anadir un campo a
// `AppSettings` rompa el typecheck en un sitio y no en diez ficheros de test.
export * from './test-fixtures.js';
export {
  localeNames,
  i18nResources,
  catalogs,
  locales,
  defaultLocale,
  isLocale,
  translate,
  translatorFor,
  es,
  en,
} from './i18n/index.js';
export type { Catalog, Translated } from './i18n/index.js';
