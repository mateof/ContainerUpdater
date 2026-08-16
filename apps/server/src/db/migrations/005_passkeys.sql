-- Passkeys (WebAuthn) como alternativa a la contrasena.
--
-- No la sustituyen: la contrasena sigue siendo el camino que siempre funciona.
-- WebAuthn exige contexto seguro (HTTPS o localhost) y un identificador de sitio
-- que sea un DOMINIO, no una IP, asi que en el acceso tipico a un NAS por
-- http://192.168.x.x:8099 los passkeys no estan disponibles. Quedarse sin poder
-- entrar por haber quitado la contrasena seria un desastre.
--
-- No se guarda nada secreto aqui: la clave publica es publica por definicion y
-- la privada nunca sale del autenticador (Bitwarden, el llavero del sistema, una
-- llave fisica). Por eso esta tabla no usa el llavero de cifrado.

CREATE TABLE webauthn_credentials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Identificador que devuelve el autenticador, en base64url. Es unico a nivel
  -- global, no por usuario: si no, un credencial de un usuario podria
  -- presentarse como el de otro en el login sin nombre.
  credential_id  TEXT    NOT NULL UNIQUE,
  public_key     TEXT    NOT NULL,

  /*
   * Contador de firmas, para detectar clonados.
   *
   * Los autenticadores por software (Bitwarden entre ellos) devuelven SIEMPRE
   * cero, asi que un cero nuevo frente a un cero guardado es lo normal y no
   * puede tratarse como sospechoso: hacerlo dejaria fuera justo al gestor que
   * se pide soportar. Solo se rechaza cuando el guardado es mayor que cero y el
   * nuevo no avanza.
   */
  counter        INTEGER NOT NULL DEFAULT 0,

  -- Como se comunica el autenticador (usb, nfc, ble, internal, hybrid). Se
  -- devuelve al navegador para que sepa que ofrecer.
  transports     TEXT,
  -- Identifica el modelo de autenticador. Solo informativo.
  aaguid         TEXT,
  -- Nombre que le pone el usuario, para poder distinguir dos llaves.
  name           TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER
);

CREATE INDEX idx_webauthn_user ON webauthn_credentials(user_id);
