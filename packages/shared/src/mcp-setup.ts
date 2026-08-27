import type { McpClient } from './mcp.js';

/**
 * La orden o configuracion lista para pegar en cada cliente.
 *
 * Vive en `shared` y con pruebas porque es facil equivocarse en algo que el
 * usuario copia a ciegas: unas comillas mal en PowerShell y el token se parte, y
 * el error que sale no habla de comillas.
 *
 * Solo se ofrece orden propia para los clientes que de verdad la tienen. Para el
 * resto se da el JSON de configuracion, que es lo que todos entienden, en vez de
 * inventar una sintaxis que no existe.
 */

export type Shell = 'bash' | 'powershell' | 'cmd';

export interface SetupSnippet {
  /** Que es esto: una orden de terminal o un fichero de configuracion. */
  kind: 'command' | 'config';
  /** Donde va, cuando es configuracion. */
  path?: string;
  content: string;
}

/**
 * Escapado para cada consola.
 *
 * El valor va SIEMPRE entrecomillado aunque no lo necesite: un token es
 * `base64url` y hoy no lleva caracteres raros, pero comillas puestas por si
 * acaso no cuestan nada y evitan que un cambio de formato lo rompa en silencio.
 */
export function quote(value: string, shell: Shell): string {
  if (shell === 'powershell') {
    // En PowerShell, dentro de comillas simples solo hay que doblar la simple.
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (shell === 'cmd') {
    // `cmd` no tiene escapado dentro de comillas dobles, asi que se quitan las
    // que hubiera: un token no las lleva, y asi no se genera algo roto.
    return `"${value.replaceAll('"', '')}"`;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface McpSetupInput {
  /** URL completa del endpoint, incluida `/api/mcp`. */
  url: string;
  token: string;
  shell: Shell;
  /** Nombre con el que quedara registrado en el cliente. */
  serverName?: string;
}

/** Configuracion en JSON, que es el formato comun a casi todos los clientes. */
function configJson(input: McpSetupInput): string {
  const nombre = input.serverName ?? 'containerupdater';
  return JSON.stringify(
    {
      mcpServers: {
        [nombre]: {
          type: 'http',
          url: input.url,
          headers: { Authorization: `Bearer ${input.token}` },
        },
      },
    },
    null,
    2,
  );
}

export function buildSetup(client: McpClient, input: McpSetupInput): SetupSnippet {
  const nombre = input.serverName ?? 'containerupdater';
  const { shell } = input;

  switch (client) {
    case 'claude-code':
      return {
        kind: 'command',
        /**
         * `--scope user` NO es opcional aqui.
         *
         * Sin el, `claude mcp add` registra el servidor en el alcance `local`,
         * que es privado **de la carpeta desde la que lo lanzas**. Comprobado:
         * sin la opcion queda escrito bajo el proyecto actual y desde cualquier
         * otra carpeta el servidor no existe; con ella queda en la configuracion
         * del usuario y responde desde todas.
         *
         * Y esto es un panel de la maquina, no una herramienta de un repositorio
         * concreto: se pregunta por el NAS desde donde uno este trabajando.
         */
        content: [
          'claude mcp add',
          '--transport http',
          '--scope user',
          nombre,
          input.url,
          '--header',
          quote(`Authorization: Bearer ${input.token}`, shell),
        ].join(' '),
      };

    case 'claude-desktop':
      return {
        kind: 'config',
        path:
          shell === 'powershell' || shell === 'cmd'
            ? '%APPDATA%\\Claude\\claude_desktop_config.json'
            : '~/Library/Application Support/Claude/claude_desktop_config.json',
        content: configJson(input),
      };

    case 'cursor':
      return { kind: 'config', path: '~/.cursor/mcp.json', content: configJson(input) };

    case 'vscode':
      return {
        kind: 'command',
        content: `code --add-mcp ${quote(
          JSON.stringify({
            name: nombre,
            type: 'http',
            url: input.url,
            headers: { Authorization: `Bearer ${input.token}` },
          }),
          shell,
        )}`,
      };

    case 'generic':
    default:
      return { kind: 'config', content: configJson(input) };
  }
}
