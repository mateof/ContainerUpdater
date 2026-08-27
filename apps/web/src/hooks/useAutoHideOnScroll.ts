import { useEffect, useState } from 'react';

/**
 * Esconde una barra al bajar y la devuelve al primer gesto hacia arriba.
 *
 * Es el patron de las aplicaciones moviles, y la gracia esta en el detalle: no
 * reaparece al llegar arriba del todo, reaparece **en cuanto empiezas a subir**.
 * Eso es lo que la hace util, porque cuando quieres el buscador estas a mitad de
 * la lista y no arriba.
 *
 * Devuelve solo un booleano y no toca el DOM: quien lo use decide como esconder
 * la barra. Aqui se hace con `transform`, que va al compositor y no provoca
 * recalculo de la maquetacion, en lugar de con `height` o `display`.
 */
/**
 * Recibe el ELEMENTO y no una `RefObject` a proposito.
 *
 * Con una `RefObject`, el efecto se ejecuta una sola vez y puede hacerlo cuando
 * `current` todavia es null (pasa con el contenido de un dialogo, que se monta
 * en un portal): entonces no se suscribe a nada y no vuelve a intentarlo, asi
 * que la barra no se mueve nunca y ademas no falla, que es lo peor. Recibiendo
 * el elemento por estado, el efecto se repite en cuanto aparece.
 */
export function useAutoHideOnScroll(
  element: HTMLElement | null,
  options: { threshold?: number; revealAt?: number } = {},
): boolean {
  /**
   * `threshold`: movimiento minimo para hacer caso. Sin el, el temblor de un
   * trackpad o el rebote del movil harian parpadear la barra.
   *
   * `revealAt`: por debajo de esta altura la barra siempre se ve, porque cerca
   * del principio no hay nada que ganar escondiendola.
   */
  const { threshold = 8, revealAt = 48 } = options;
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!element) return;

    let anterior = element.scrollTop;

    const onScroll = (): void => {
      const actual = element.scrollTop;

      if (actual < revealAt) {
        setHidden(false);
        anterior = actual;
        return;
      }

      const delta = actual - anterior;
      // Los movimientos pequeños no cuentan, ni para esconder ni para mostrar.
      if (Math.abs(delta) < threshold) return;

      setHidden(delta > 0);
      anterior = actual;
    };

    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [element, threshold, revealAt]);

  return hidden;
}
