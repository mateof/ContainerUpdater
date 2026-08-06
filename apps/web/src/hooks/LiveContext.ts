import { createContext, useContext } from 'react';
import type { LiveState } from './useEvents';

/**
 * Estado en vivo compartido.
 *
 * Vive en un contexto y no en cada pagina para que solo haya UNA conexion SSE
 * abierta: una por vista significaria varios muestreadores en el servidor y
 * tantas conexiones como pestanas.
 */
export const LiveContext = createContext<LiveState>({
  metrics: [],
  connected: false,
  jobs: new Map(),
  activeJob: null,
  activeRun: null,
  checkingImage: null,
});

export function useLive(): LiveState {
  return useContext(LiveContext);
}
