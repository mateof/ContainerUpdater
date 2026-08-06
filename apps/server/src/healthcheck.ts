/**
 * Healthcheck del contenedor.
 *
 * Se ejecuta como proceso aparte desde HEALTHCHECK del Dockerfile. Solo
 * comprueba que el servidor HTTP responde: si ademas exigiera conexion con
 * Docker, el contenedor se marcaria como no saludable cuando el problema real
 * es que falta montar el socket, y con `restart: unless-stopped` entraria en
 * bucle de reinicios sin que nadie llegue a leer el mensaje de error.
 */
import http from 'node:http';

const port = Number(process.env.PORT ?? 8080);

const request = http.request(
  { host: '127.0.0.1', port, path: '/api/health', timeout: 4000 },
  (response) => {
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);

request.on('error', () => process.exit(1));
request.on('timeout', () => {
  request.destroy();
  process.exit(1);
});
request.end();
