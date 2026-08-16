-- Segundo factor con codigo temporal (TOTP), opcional.
--
-- Opcional de verdad: sin activarlo nada cambia. La aplicacion gestiona todos
-- los contenedores de un NAS, asi que quedarse fuera por haber perdido el movil
-- seria un desastre; de ahi los codigos de recuperacion, que no son un adorno.

CREATE TABLE user_totp (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- El secreto va CIFRADO con el mismo sobre que las credenciales de registry.
  -- Quien lo lea puede generar codigos validos indefinidamente, asi que es tan
  -- sensible como una contrasena.
  secret_ct    TEXT    NOT NULL,
  iv           TEXT    NOT NULL,
  tag          TEXT    NOT NULL,
  key_version  INTEGER NOT NULL DEFAULT 1,

  /*
   * Hasta que no se confirma con un codigo valido, el segundo factor NO esta
   * activo. Sin esto, alguien que no llegara a escanear el QR se quedaria sin
   * poder entrar, que es la peor forma posible de activar una proteccion.
   */
  confirmed_at INTEGER,

  /*
   * Ultimo intervalo de 30 segundos aceptado.
   *
   * Impide reutilizar un codigo: con la ventana de margen, uno vale hasta
   * minuto y medio y podria emplearse varias veces (por ejemplo si alguien lo
   * ve por encima del hombro). Se rechaza todo intervalo que no avance.
   */
  last_step    INTEGER,
  created_at   INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Codigos de recuperacion
-- ---------------------------------------------------------------------------
--
-- Se guarda solo el SHA-256, igual que los tokens de sesion. No hace falta
-- Argon2: son aleatorios de unos 50 bits, no contrasenas elegidas por una
-- persona, asi que no hay diccionario contra el que defenderse y el coste extra
-- solo ralentizaria el login.
--
-- Se marcan como usados en vez de borrarse, para que la lista siga diciendo
-- cuantos quedan y quede constancia de que se gasto uno.

CREATE TABLE user_recovery_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT    NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_recovery_user ON user_recovery_codes(user_id);
CREATE UNIQUE INDEX idx_recovery_hash ON user_recovery_codes(user_id, code_hash);
