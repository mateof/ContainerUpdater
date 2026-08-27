-- Tokens para que una IA hable con la aplicacion por MCP.
--
-- El secreto se guarda HASHEADO, igual que las sesiones y por el mismo motivo:
-- quien consiga leer la base no debe poder usar los tokens. Se muestra una vez
-- al crearlo y no se puede volver a consultar.
--
-- Ojo con lo que es esto: un token de MCP habla con una aplicacion que manda
-- sobre el socket de Docker, asi que segun los permisos que lleve puede con toda
-- la maquina. De ahi que los permisos se guarden por token y no haya un "todo".
CREATE TABLE mcp_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,

  -- sha256 del secreto. Mismo esquema que `sessions`.
  token_hash   TEXT    NOT NULL UNIQUE,

  -- Primeros caracteres del secreto, para poder reconocerlo en la lista. No
  -- sirven para autenticar: son demasiado pocos para adivinar el resto.
  hint         TEXT    NOT NULL,

  -- JSON array de permisos. Se guarda como texto porque es una lista corta que
  -- solo se lee entera; una tabla aparte solo anadiria una union.
  scopes       TEXT    NOT NULL DEFAULT '[]',

  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,

  -- Caducidad opcional. NULL = no caduca, que es lo razonable para un token de
  -- uso personal en una maquina de casa, pero conviene poder acotarlo.
  expires_at   INTEGER
);

CREATE INDEX idx_mcp_tokens_hash ON mcp_tokens(token_hash);
