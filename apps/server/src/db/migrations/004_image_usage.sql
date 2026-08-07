-- Distinguir las imagenes en uso de las que solo ocupan disco.
--
-- Hasta ahora solo se registraban las imagenes que usaba algun contenedor, asi
-- que las huerfanas (las que quedan tras actualizar, o de una prueba) no
-- aparecian por ningun lado y no habia forma de borrarlas desde la aplicacion.
-- Hay un comentario en el inventario que decia que se conservaban "marcadas
-- como tales", pero el codigo que lo haria nunca existio.
--
-- Al empezar a registrarlas surge un problema: el comprobador consulta el
-- registry para toda fila con `source = 'registry'`, y preguntar por la version
-- nueva de una imagen que no usa nadie es gastar peticiones (y cuota de Docker
-- Hub) para nada. Esta columna es lo que permite listarlas sin comprobarlas.
--
-- El valor por defecto es 1 porque todas las filas que existen ahora mismo se
-- registraron precisamente por estar en uso.

ALTER TABLE tracked_images ADD COLUMN in_use INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_tracked_images_in_use ON tracked_images(in_use);
