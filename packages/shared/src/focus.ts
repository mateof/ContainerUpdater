/**
 * Filtrado por foco: la lista recortada al llegar desde otra pantalla.
 *
 * Vive aqui, fuera de los componentes, porque es logica pura y porque el
 * componente no tenia forma de probarse: en una version se perdio el caso de
 * `container` (la sustitucion de texto que lo anadia no llego a aplicarse) y ni
 * el typecheck ni el build dijeron nada, porque el codigo sin el seguia siendo
 * valido. La lista salia entera con el aviso de filtrado puesto. Con una funcion
 * pura, ese fallo es un test rojo.
 */
import type { ContainerSummary } from './types.js';

/**
 * De donde viene el recorte.
 *
 * Los cuatro son excluyentes y se aplican en este orden de precedencia: del mas
 * concreto al mas amplio, para que llegar a por un contenedor concreto gane
 * sobre un filtro de proyecto que hubiera quedado en la URL.
 */
export interface ContainerFocus {
  /** Nombre exacto de un contenedor. */
  container?: string | null;
  /** Referencia NORMALIZADA de una imagen, no la cadena cruda del daemon. */
  image?: string | null;
  /** Clave compuesta del proyecto. */
  project?: string | null;
}

/** Si hay algo por lo que recortar. */
export function hasFocus(focus: ContainerFocus): boolean {
  return Boolean(focus.container ?? focus.image ?? focus.project);
}

export function applyContainerFocus(
  containers: ContainerSummary[],
  focus: ContainerFocus,
): ContainerSummary[] {
  if (focus.container) {
    return containers.filter((container) => container.name === focus.container);
  }
  if (focus.image) {
    // Por `imageRef` y no por `image`: son cadenas distintas (el daemon dice
    // `docker.io/...` y la normalizada es `registry-1.docker.io/...`) y comparar
    // la cruda dejaba la lista vacia en casi todos los casos.
    return containers.filter((container) => container.imageRef === focus.image);
  }
  if (focus.project) {
    return containers.filter((container) => container.projectKey === focus.project);
  }
  return containers;
}
