import parser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Linter deliberadamente MINIMO.
 *
 * Existe por un fallo concreto que rompio la pantalla de Ajustes durante cuatro
 * dias: un `useEffect` quedo por debajo de un `return` temprano. En el primer
 * render (cargando) se ejecutaban cinco hooks y se salia; en el segundo, seis.
 * React aborta con el error 310 y no pinta absolutamente nada, asi que la
 * pantalla aparecia en blanco.
 *
 * Ni el typecheck ni los tests podian verlo: los tipos cuadran perfectamente y
 * no hay prueba de render en el proyecto. La regla `rules-of-hooks` existe
 * justo para esto.
 *
 * Se activa SOLO esa regla. Un linter con cien reglas de estilo en un proyecto
 * que no lo tenia significa tocar cada fichero y discutir sobre comillas; esto
 * es una red para una clase de fallo que ya ha ocurrido y no se ve de otra
 * forma.
 */
export default [
  {
    // Los `eslint-disable` de `exhaustive-deps` que hay por el codigo apuntan a
    // una regla que aqui no se activa; sin esto, cada uno sale como aviso.
    linterOptions: { reportUnusedDisableDirectives: false },
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
  },
];
