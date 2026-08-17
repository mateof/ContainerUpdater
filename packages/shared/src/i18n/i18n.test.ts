import { describe, expect, it } from 'vitest';
import { catalogs, i18nResources, isLocale, localeNames, locales, translate } from './index.js';

/**
 * Que todos los idiomas esten de verdad conectados.
 *
 * Existe por un fallo concreto: al anadir el galego, la lista de recursos de
 * i18next estaba escrita a mano en la web y se quedo con los dos anteriores. El
 * idioma aparecia en el selector, se podia elegir, el perfil lo guardaba... y
 * todos los textos seguian en castellano, porque i18next no conocia el idioma y
 * caia al de por defecto.
 *
 * Lo grave es que **nada fallaba**: ni typecheck, ni build, ni tests. Y la
 * comprobacion que hice entonces (buscar "Galego" en el bundle) daba positivo,
 * porque esa palabra es la etiqueta del selector y no prueba nada sobre si el
 * catalogo esta cargado.
 *
 * De ahi que estas pruebas comparen TEXTOS TRADUCIDOS entre idiomas, que es lo
 * unico que distingue "traducido" de "cae al de por defecto".
 */
describe('idiomas conectados', () => {
  it('hay un catalogo por cada idioma declarado', () => {
    for (const locale of locales) {
      expect(catalogs[locale], locale).toBeDefined();
    }
    // Y ninguno de mas: un catalogo sin idioma es un idioma que nadie puede
    // elegir.
    expect(Object.keys(catalogs).sort()).toEqual([...locales].sort());
  });

  it('cada idioma tiene nombre propio en el selector', () => {
    for (const locale of locales) {
      expect(localeNames[locale], locale).toBeTruthy();
    }
  });

  it('los recursos de i18next cubren todos los idiomas', () => {
    // Este es el test que habria pillado el fallo.
    const resources = i18nResources();
    expect(Object.keys(resources).sort()).toEqual([...locales].sort());
    for (const locale of locales) {
      expect(resources[locale]?.translation, locale).toBe(catalogs[locale]);
    }
  });

  it('isLocale acepta todos los declarados y nada mas', () => {
    for (const locale of locales) expect(isLocale(locale), locale).toBe(true);
    for (const bad of ['pt', 'fr', '', 'ES', null, undefined, 42]) {
      expect(isLocale(bad), String(bad)).toBe(false);
    }
  });
});

describe('los catalogos estan traducidos de verdad', () => {
  /**
   * Claves de palabras que cambian entre los tres idiomas.
   *
   * No sirve cualquiera: "CPU" o "Telegram" son iguales en todas partes, y una
   * prueba sobre ellas pasaria aunque el catalogo fuese una copia.
   */
  const DISTINCTIVE = [
    'nav.containers',
    'nav.images',
    'nav.settings',
    'auth.password',
    'common.save',
    'common.close',
  ];

  for (const key of DISTINCTIVE) {
    it(`"${key}" es distinta en los tres idiomas`, () => {
      const values = locales.map((locale) => translate(locale, key));
      expect(new Set(values).size, values.join(' | ')).toBe(locales.length);
    });
  }

  it('ninguna clave se queda sin traducir en ningun idioma', () => {
    // `translate` devuelve la propia clave cuando no la encuentra, asi que una
    // traduccion igual a su clave significa que falta.
    const flatten = (obj: object, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`],
      );

    const keys = flatten(catalogs.es);
    expect(keys.length).toBeGreaterThan(400);

    for (const locale of locales) {
      const missing = keys.filter((key) => translate(locale, key) === key);
      expect(missing, `${locale}: ${missing.slice(0, 5).join(', ')}`).toEqual([]);
    }
  });
});
