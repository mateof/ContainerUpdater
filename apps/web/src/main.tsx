import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import './styles/global.css';
import './i18n';
import { App } from './App';
import { AuthProvider } from './hooks/useAuth';
import { ToastProvider, TooltipProvider } from './components/ui';
import { ApiError } from './api/client';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Los datos llegan por SSE cuando cambian, asi que no hace falta
      // refrescar al volver a la ventana ni sondear en bucle.
      refetchOnWindowFocus: false,
      staleTime: 15_000,
      retry: (failureCount, error) => {
        // Un 401 o un 403 no mejoran reintentando; solo se reintenta lo que
        // puede ser un fallo de red pasajero.
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

/**
 * Registro del service worker, que es lo que hace la aplicacion instalable.
 *
 * Tres detalles que importan:
 *
 * - `updateViaCache: 'none'` obliga al navegador a saltarse su cache HTTP para
 *   el propio script. Sin esto, el servidor lo sirve con `immutable` a un ano,
 *   como al resto de estaticos, y una version nueva del worker podria tardar
 *   dias en llegar.
 * - La version va en la URL para que el fichero cambie de verdad entre
 *   despliegues: el navegador compara byte a byte y, si el contenido fuese
 *   identico, no lo actualizaria.
 * - Solo en produccion. En desarrollo, un worker sirviendo assets cacheados
 *   pelea con el recambio en caliente de Vite.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register(`/sw.js?v=${__APP_VERSION__}`, { updateViaCache: 'none' })
      .catch(() => {
        // Sin worker la aplicacion funciona igual: solo se pierde el poder
        // instalarla. No merece ni un aviso.
      });
  });
}

const container = document.getElementById('root');
if (!container) throw new Error('No se encuentra el elemento #root');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <TooltipProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </TooltipProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
