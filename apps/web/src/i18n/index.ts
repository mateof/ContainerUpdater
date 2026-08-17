/**
 * i18n de la interfaz.
 *
 * Los catalogos vienen de `@cu/shared`, los mismos que usa el bot de Telegram.
 * Mantenerlos en un unico sitio es lo que evita que la web diga una cosa y el
 * bot otra distinta para el mismo concepto.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { defaultLocale, i18nResources, isLocale, type Locale } from '@cu/shared';

export const LOCALE_STORAGE_KEY = 'cu-locale';

/**
 * Orden de resolucion: lo que el usuario eligio en este navegador, luego el
 * idioma del navegador, y si no, espanol. El idioma guardado en el perfil lo
 * aplica la app al cargar la sesion, que es el que manda de verdad.
 */
function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // localStorage puede estar bloqueado; no es motivo para fallar.
  }
  const browser = navigator.language.slice(0, 2).toLowerCase();
  return isLocale(browser) ? browser : defaultLocale;
}

void i18next.use(initReactI18next).init({
  // Desde `@cu/shared`, que los deriva de los catalogos y los tiene probados.
  // Estaban escritos a mano aqui y el galego se quedo fuera sin que nada fallara.
  resources: i18nResources(),
  lng: detectLocale(),
  fallbackLng: defaultLocale,
  interpolation: {
    // React ya escapa por su cuenta; volver a escapar aqui mostraria &amp;
    // literales en la interfaz.
    escapeValue: false,
  },
  returnNull: false,
});

export function setLocale(locale: Locale): void {
  void i18next.changeLanguage(locale);
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Sin persistencia el idioma dura la sesion, que es aceptable.
  }
  document.documentElement.lang = locale;
}

export function currentLocale(): Locale {
  return isLocale(i18next.language) ? i18next.language : defaultLocale;
}

export default i18next;
