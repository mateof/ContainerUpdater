/**
 * Tipo estructural de un catalogo de traduccion.
 *
 * `es.ts` se declara `as const`, asi que su tipo lleva los literales exactos y
 * no sirve para tipar otros idiomas. Este helper conserva la forma del arbol
 * pero relaja los valores a `string`, de manera que anadir una clave en espanol
 * rompe el typecheck de ingles hasta que se traduce. Es la red que evita
 * catalogos desincronizados.
 */
export type Translated<T> = {
  [K in keyof T]: T[K] extends string ? string : Translated<T[K]>;
};
