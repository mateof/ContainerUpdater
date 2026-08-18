/*
 * Service worker minimo, deliberadamente cobarde.
 *
 * Existe para una sola cosa: que la aplicacion se pueda instalar en la pantalla
 * de inicio del movil y arranque sin la barra del navegador. NO pretende ser una
 * aplicacion offline, porque un panel que gestiona contenedores en vivo sin
 * conexion al servidor no sirve de nada.
 *
 * Tres reglas que evitan los desastres clasicos de los service workers:
 *
 * 1. NUNCA se toca `/api/`. Ahi viven las mutaciones y el flujo SSE de metricas;
 *    un service worker que intercepte un `EventSource` lo rompe de formas muy
 *    dificiles de depurar.
 * 2. Solo se cachean los assets con hash en el nombre. Su contenido no cambia
 *    nunca, asi que servirlos desde cache no puede dar una version vieja.
 * 3. El HTML va SIEMPRE a la red primero. La cache solo entra si la red falla.
 *    Servir un index cacheado apuntaria a assets que ya no existen tras una
 *    actualizacion, y dejaria la aplicacion rota hasta una recarga forzada.
 */

// La version llega en la URL de registro (`/sw.js?v=0.15.0`). Cambiarla cambia
// el nombre de la cache, con lo que un despliegue nuevo no reutiliza nada del
// anterior.
const VERSION = new URL(self.location.href).searchParams.get('v') ?? 'dev';
const CACHE = `cu-${VERSION}`;

self.addEventListener('install', () => {
  // Sin precarga: no se sabe que assets existen sin leer el HTML, y adivinarlos
  // solo puede acabar cacheando rutas que no existen.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('cu-') && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Assets con hash: cache primero, y si no esta, red y se guarda.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          void cache.put(request, response.clone());
        }
        return response;
      })(),
    );
    return;
  }

  // Navegacion: red primero, cache solo como red de seguridad.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(CACHE);
            void cache.put('/', response.clone());
          }
          return response;
        } catch (error) {
          const cached = await caches.match('/');
          if (cached) return cached;
          throw error;
        }
      })(),
    );
  }
});
