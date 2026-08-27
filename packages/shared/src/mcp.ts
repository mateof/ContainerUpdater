/**
 * Permisos de un token de MCP.
 *
 * Un token de estos deja que una IA hable con la aplicacion, y esta aplicacion
 * manda sobre el socket de Docker, o sea que puede con toda la maquina. Por eso
 * los permisos no son una lista de endpoints sino de CAPACIDADES, cada una con
 * su alcance y su riesgo dicho en voz alta.
 *
 * Tres criterios al partirlos:
 *
 * 1. **Leer no es tocar.** Casi todo el valor de conectar una IA esta en que
 *    mire (que tengo, que puertos uso, que esta desactualizado), y eso no rompe
 *    nada. Va todo junto en un permiso comodo de dar.
 * 2. **Lo que puede filtrar secretos va aparte**, aunque sea "solo leer". Un log
 *    lleva contrasenas en los arranques, y un `.env` es literalmente el fichero
 *    de secretos. Que alguien de "leer" no significa que quiera dar eso.
 * 3. **Lo destructivo, uno por uno.** Borrar una imagen, bajar un proyecto y
 *    reescribir un compose son daños distintos y de distinto tamaño.
 */

export const MCP_SCOPES = [
  'read',
  'logs',
  'secrets',
  'containers',
  'updates',
  'images.delete',
  'projects.write',
  'projects.lifecycle',
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

export interface McpScopeInfo {
  scope: McpScope;
  /** Si conviene avisar antes de concederlo. */
  risk: 'low' | 'medium' | 'high';
}

/**
 * Riesgo de cada permiso, para que la pantalla lo pinte y no haya que
 * recordarlo. Se declara aqui y no en la interfaz porque es una propiedad del
 * permiso, no de como se dibuje.
 */
export const MCP_SCOPE_RISK: Record<McpScope, McpScopeInfo['risk']> = {
  read: 'low',
  logs: 'medium',
  secrets: 'high',
  containers: 'medium',
  updates: 'medium',
  'images.delete': 'high',
  'projects.write': 'high',
  'projects.lifecycle': 'high',
};

export function isMcpScope(value: unknown): value is McpScope {
  return typeof value === 'string' && (MCP_SCOPES as readonly string[]).includes(value);
}

export interface McpToken {
  id: number;
  name: string;
  scopes: McpScope[];
  createdAt: number;
  lastUsedAt: number | null;
  /** Caducidad, o null si no caduca. */
  expiresAt: number | null;
  /** Primeros caracteres, para reconocerlo en la lista sin guardarlo entero. */
  hint: string;
}

/** Lo que se devuelve UNA sola vez al crearlo. */
export interface McpTokenCreated {
  token: McpToken;
  /** El secreto en claro. No se puede volver a consultar. */
  secret: string;
}

/**
 * Clientes para los que se ofrece la orden ya escrita.
 *
 * No se inventa la sintaxis de cada uno: los que tienen una orden propia la
 * llevan, y el resto reciben el JSON de configuracion, que es lo que de verdad
 * entienden todos.
 */
export const MCP_CLIENTS = ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'generic'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];
