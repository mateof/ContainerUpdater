import { describe, expect, it } from 'vitest';
import { buildSetup, quote } from './mcp-setup.js';

const base = { url: 'http://192.168.0.22:8210/api/mcp', token: 'cu_mcp_abc123', shell: 'bash' as const };

describe('entrecomillado por consola', () => {
  it('cada consola tiene el suyo', () => {
    // Un token va entre comillas SIEMPRE. Si algun dia el formato cambia y trae
    // un caracter raro, no se rompe en silencio.
    expect(quote('hola', 'bash')).toBe("'hola'");
    expect(quote('hola', 'powershell')).toBe("'hola'");
    expect(quote('hola', 'cmd')).toBe('"hola"');
  });

  it('la comilla simple se dobla en PowerShell y se escapa en bash', () => {
    expect(quote("a'b", 'powershell')).toBe("'a''b'");
    expect(quote("a'b", 'bash')).toBe("'a'\\''b'");
  });
});

describe('ordenes de conexion', () => {
  it('Claude Code lleva la cabecera entera entrecomillada', () => {
    const s = buildSetup('claude-code', base);
    expect(s.kind).toBe('command');
    expect(s.content).toBe(
      "claude mcp add --transport http --scope user containerupdater http://192.168.0.22:8210/api/mcp --header 'Authorization: Bearer cu_mcp_abc123'",
    );
  });

  it('Claude Code se registra para TODOS los proyectos, no solo el actual', () => {
    // Sin `--scope user`, `claude mcp add` escribe en el alcance `local`, que es
    // privado de la carpeta desde la que se lanza: comprobado en vivo, desde
    // otra carpeta el servidor no aparece. Esto es un panel de la maquina, no
    // una herramienta de un repositorio, asi que tiene que estar en todos.
    expect(buildSetup('claude-code', base).content).toContain('--scope user');
  });

  it('los clientes de fichero reciben JSON y su ruta', () => {
    const s = buildSetup('cursor', base);
    expect(s.kind).toBe('config');
    expect(s.path).toBe('~/.cursor/mcp.json');
    expect(JSON.parse(s.content).mcpServers.containerupdater.url).toBe(base.url);
  });

  it('la ruta de Claude Desktop cambia con el sistema', () => {
    expect(buildSetup('claude-desktop', base).path).toContain('Library/Application Support');
    expect(buildSetup('claude-desktop', { ...base, shell: 'powershell' }).path).toContain('APPDATA');
  });

  it('el token viaja como cabecera y nunca en la URL', () => {
    // En la URL acabaria en historiales y registros del servidor.
    for (const cliente of ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'generic'] as const) {
      const s = buildSetup(cliente, base);
      expect(s.content.includes('Bearer cu_mcp_abc123'), cliente).toBe(true);
      expect(s.content.includes(`${base.url}?`), cliente).toBe(false);
    }
  });

  it('se puede cambiar el nombre con el que queda registrado', () => {
    const s = buildSetup('claude-code', { ...base, serverName: 'nas' });
    expect(s.content).toContain(' nas ');
  });
});
