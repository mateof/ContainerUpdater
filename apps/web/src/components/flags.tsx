import type { ReactNode } from 'react';
import type { Locale } from '@cu/shared';

/**
 * Banderas del selector de idioma.
 *
 * Dibujadas a mano en SVG y no con emoji por un motivo concreto: **Galicia no
 * tiene bandera emoji**. Su secuencia de subdivision (`ES-GA`) existe en Unicode
 * pero casi ningun sistema la pinta, y sale un rectangulo negro. Mezclar emoji
 * para dos idiomas y un dibujo para el tercero quedaria descuadrado, asi que van
 * los tres igual.
 *
 * Son deliberadamente simples: a 20 pixeles de ancho, el detalle no se ve y solo
 * pesa. La de Reino Unido va simplificada, sin los bordes finos blancos de las
 * diagonales, que a este tamano se convierten en un borron gris.
 *
 * Nota sobre usar banderas para idiomas: es discutible, porque un idioma no es un
 * pais (el ingles no es solo britanico y el gallego no es un estado). Se usan
 * porque se reconocen de un vistazo, que es para lo que sirve un icono en un
 * menu, y siempre acompanadas del nombre del idioma escrito.
 */

const VIEWBOX = '0 0 20 14';

function Frame({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg
      viewBox={VIEWBOX}
      width="20"
      height="14"
      aria-hidden="true"
      // El borde despega la bandera del fondo cuando alguno de sus colores
      // coincide con el del menu, que le pasa a la blanca de Galicia en tema
      // claro.
      className="shrink-0 rounded-[2px] ring-1 ring-black/10"
    >
      {children}
    </svg>
  );
}

/** Tres bandas horizontales, la amarilla del doble de alto. */
function SpainFlag(): ReactNode {
  return (
    <Frame>
      <rect width="20" height="14" fill="#AA151B" />
      <rect y="3.5" width="20" height="7" fill="#F1BF00" />
    </Frame>
  );
}

/** Union Jack simplificada: sin los ribetes finos de las diagonales. */
function UkFlag(): ReactNode {
  return (
    <Frame>
      <rect width="20" height="14" fill="#012169" />
      <path d="M0 0 20 14M20 0 0 14" stroke="#FFF" strokeWidth="2.8" />
      <path d="M0 0 20 14M20 0 0 14" stroke="#C8102E" strokeWidth="1.4" />
      <path d="M10 0v14M0 7h20" stroke="#FFF" strokeWidth="4.6" />
      <path d="M10 0v14M0 7h20" stroke="#C8102E" strokeWidth="2.8" />
    </Frame>
  );
}

/**
 * Galicia: campo blanco con banda azul en diagonal.
 *
 * La banda va de la esquina superior izquierda a la inferior derecha. Se dibuja
 * como un trazo y no como un poligono porque asi el grosor es uno solo y no hay
 * que calcular los vertices.
 */
function GaliciaFlag(): ReactNode {
  return (
    <Frame>
      <rect width="20" height="14" fill="#FFF" />
      <path d="M0 0 20 14" stroke="#0080C8" strokeWidth="3.2" />
    </Frame>
  );
}

const FLAGS: Record<Locale, () => ReactNode> = {
  es: SpainFlag,
  en: UkFlag,
  gl: GaliciaFlag,
};

export function LocaleFlag({ locale }: { locale: Locale }): ReactNode {
  const Flag = FLAGS[locale];
  return <Flag />;
}
