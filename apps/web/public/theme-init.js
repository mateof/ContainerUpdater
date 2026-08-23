/*
 * Aplica el tema guardado ANTES de que se pinte nada.
 *
 * Va en un fichero propio y no inline por la politica de seguridad: la CSP del
 * servidor es `script-src 'self'`, sin `unsafe-inline` ni hashes, asi que un
 * script inline queda bloqueado. Estuvo inline desde el principio y el
 * navegador lo rechazaba en silencio; con dos temas el efecto era un destello
 * apenas visible, pero con seis se nota cargar en oscuro y saltar a papel.
 *
 * Se carga sincrono desde el `<head>`, que es lo que garantiza que corra antes
 * del primer pintado. Es un fichero de pocos bytes servido desde el mismo
 * origen y con cache larga.
 */
(function () {
  try {
    /*
     * La lista se repite aqui a proposito.
     *
     * Este script corre antes que la aplicacion y no puede importar nada de
     * ella. Si se queda corta, el unico efecto es un destello al cargar un tema
     * nuevo: la aplicacion lo aplica igual al montarse.
     */
    var known = ['dark', 'light', 'terminal', 'neon', 'papel', 'trazo'];
    var stored = localStorage.getItem('cu-theme');
    if (known.indexOf(stored) >= 0) {
      document.documentElement.dataset.theme = stored;
    } else {
      document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)')
        .matches
        ? 'dark'
        : 'light';
    }
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';
  }
})();
