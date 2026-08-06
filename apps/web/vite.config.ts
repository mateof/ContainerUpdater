import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      '@cu/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    // El servidor sirve los .br y .gz pregenerados. Sin sourcemaps en
    // produccion: pesan mas que el propio bundle y aqui no aportan.
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          // uPlot solo se usa en el panel, que va en carga diferida: asi no
          // entra en el arranque del login.
          charts: ['uplot'],
          // react-dom/client se lista aparte: sin el, el grueso de react-dom
          // entra por esa ruta de importacion y acaba en el chunk principal.
          vendor: ['react', 'react-dom', 'react-dom/client', 'react-router-dom'],
          // Los primitivos de Radix son estables y los comparten todas las
          // vistas: en su propio chunk sobreviven a los despliegues en cache.
          ui: [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-switch',
            '@radix-ui/react-tooltip',
          ],
          // Los catalogos de los dos idiomas mas i18next pesan lo suyo y no
          // cambian entre despliegues: en su propio chunk se cachean aparte y
          // un cambio en el codigo de la app no obliga a volver a bajarlos.
          i18n: ['i18next', 'react-i18next'],
          data: ['@tanstack/react-query'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // En desarrollo el backend corre aparte; en produccion todo sale del
      // mismo origen y este proxy no existe.
      '/api': { target: 'http://127.0.0.1:8099', changeOrigin: false },
    },
  },
});
