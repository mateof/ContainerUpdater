import { describe, expect, it } from 'vitest';
import { buildCreateBody, sanitizeHostConfig } from './recreate.js';
import { demultiplexLogs } from './api.js';
import type { ContainerInspect, ImageInspect } from './types.js';

function makeContainer(overrides: Partial<ContainerInspect> = {}): ContainerInspect {
  return {
    Id: 'abc',
    Name: '/miapp',
    Created: '2026-01-01T00:00:00Z',
    Image: 'sha256:vieja',
    State: {
      Status: 'running',
      Running: true,
      Paused: false,
      Restarting: false,
      Dead: false,
      ExitCode: 0,
      StartedAt: '',
      FinishedAt: '',
    },
    RestartCount: 0,
    Config: {
      Env: ['PATH=/usr/bin', 'NODE_ENV=production', 'MI_CLAVE=valor-del-usuario'],
      Cmd: ['node', 'server.js'],
      Labels: { 'org.opencontainers.image.version': '1.0', 'mi.label': 'del-usuario' },
    },
    HostConfig: { Binds: ['/datos:/datos'], RestartPolicy: { Name: 'unless-stopped' } },
    NetworkSettings: {
      Networks: {
        principal: { Aliases: ['web'], IPAddress: '172.18.0.5', EndpointID: 'endpoint-viejo' },
      },
    },
    Mounts: [],
    ...overrides,
  };
}

function makeImage(overrides: Partial<ImageInspect> = {}): ImageInspect {
  return {
    Id: 'sha256:vieja',
    Created: '',
    Size: 0,
    Config: {
      // Estas venian de la imagen, no las puso el usuario.
      Env: ['PATH=/usr/bin', 'NODE_ENV=production'],
      Cmd: ['node', 'server.js'],
      Labels: { 'org.opencontainers.image.version': '1.0' },
    },
    ...overrides,
  };
}

describe('buildCreateBody', () => {
  it('arrastra solo las variables que puso el usuario', () => {
    // Copiar Config.Env tal cual fija los valores por defecto de la imagen
    // VIEJA: si la nueva version cambia NODE_ENV o el PATH, el contenedor
    // recreado se queda con el antiguo y nadie entiende por que.
    const body = buildCreateBody(makeContainer(), makeImage(), 'miapp:2.0');
    expect(body.Env).toEqual(['MI_CLAVE=valor-del-usuario']);
  });

  it('deja que la imagen nueva imponga su Cmd si el usuario no lo cambio', () => {
    const body = buildCreateBody(makeContainer(), makeImage(), 'miapp:2.0');
    expect(body.Cmd).toBeUndefined();
  });

  it('conserva el Cmd si el usuario lo habia sobrescrito', () => {
    const container = makeContainer();
    container.Config.Cmd = ['node', 'otro.js'];
    const body = buildCreateBody(container, makeImage(), 'miapp:2.0');
    expect(body.Cmd).toEqual(['node', 'otro.js']);
  });

  it('arrastra solo las labels del usuario', () => {
    const body = buildCreateBody(makeContainer(), makeImage(), 'miapp:2.0');
    expect(body.Labels).toEqual({ 'mi.label': 'del-usuario' });
  });

  it('apunta a la imagen nueva', () => {
    expect(buildCreateBody(makeContainer(), makeImage(), 'miapp:2.0').Image).toBe('miapp:2.0');
  });

  it('conserva los volumenes anonimos', () => {
    // Un volumen anonimo tiene un nombre de 64 hex y no aparece en Binds. Si no
    // se arrastra, el contenedor nuevo crea otro vacio y los datos anteriores
    // quedan huerfanos sin ningun aviso.
    const anonymous = 'a'.repeat(64);
    const container = makeContainer({
      Mounts: [
        { Type: 'volume', Name: anonymous, Source: '/var/lib/docker/volumes/x', Destination: '/datos', RW: true },
      ],
    });

    const body = buildCreateBody(container, makeImage(), 'miapp:2.0');
    expect(body.HostConfig?.Mounts).toContainEqual(
      expect.objectContaining({ Type: 'volume', Source: anonymous, Destination: '/datos' }),
    );
  });

  it('no duplica un volumen con nombre que ya estaba declarado', () => {
    const named = 'mis-datos';
    const container = makeContainer({
      Mounts: [{ Type: 'volume', Name: named, Source: '/x', Destination: '/datos', RW: true }],
    });
    const body = buildCreateBody(container, makeImage(), 'miapp:2.0');
    // No es anonimo, asi que no se anade a Mounts: ya viene en Binds.
    expect(body.HostConfig?.Mounts ?? []).toHaveLength(0);
  });

  it('conserva la configuracion del host', () => {
    const body = buildCreateBody(makeContainer(), makeImage(), 'miapp:2.0');
    expect(body.HostConfig?.Binds).toEqual(['/datos:/datos']);
    expect(body.HostConfig?.RestartPolicy?.Name).toBe('unless-stopped');
  });

  it('limpia lo que asigna el daemon en la configuracion de red', () => {
    // Reenviar la IP o el EndpointID provoca un conflicto de direccion ya en
    // uso al crear el contenedor nuevo.
    const body = buildCreateBody(makeContainer(), makeImage(), 'miapp:2.0');
    const endpoint = body.NetworkingConfig?.EndpointsConfig?.principal;
    expect(endpoint?.Aliases).toEqual(['web']);
    expect(endpoint?.IPAddress).toBeUndefined();
    expect(endpoint?.EndpointID).toBeUndefined();
  });

  it('funciona aunque no se pueda inspeccionar la imagen vieja', () => {
    // Si la imagen vieja ya no esta, se copia todo: es peor perder variables
    // del usuario que arrastrar alguna de la imagen.
    const body = buildCreateBody(makeContainer(), null, 'miapp:2.0');
    expect(body.Env).toHaveLength(3);
  });
});

describe('sanitizeHostConfig', () => {
  it('quita el swappiness cuando no hay limite de memoria', () => {
    // Verificado: Podman rellena MemorySwappiness con 0 aunque nadie lo haya
    // configurado, y crun sobre cgroup v2 no soporta ese parametro, asi que el
    // contenedor recreado no arranca. Sin limite de memoria el valor no lo puso
    // el usuario y omitirlo no pierde nada.
    const clean = sanitizeHostConfig({ Memory: 0, MemorySwappiness: 0 } as never);
    expect('MemorySwappiness' in clean).toBe(false);
  });

  it('conserva el swappiness si el usuario puso limite de memoria', () => {
    const clean = sanitizeHostConfig({ Memory: 512_000_000, MemorySwappiness: 10 } as never);
    expect((clean as Record<string, unknown>).MemorySwappiness).toBe(10);
  });

  it('quita el -1, que significa sin definir', () => {
    const clean = sanitizeHostConfig({ Memory: 512_000_000, MemorySwappiness: -1 } as never);
    expect('MemorySwappiness' in clean).toBe(false);
  });

  it('omite los campos a null, que son los no configurados', () => {
    const clean = sanitizeHostConfig({ Binds: null, CapAdd: null, Privileged: false } as never);
    expect('Binds' in clean).toBe(false);
    expect('CapAdd' in clean).toBe(false);
    // false es un valor real, no un "sin configurar": tiene que conservarse.
    expect(clean.Privileged).toBe(false);
  });

  it('no toca la configuracion que si puso el usuario', () => {
    const clean = sanitizeHostConfig({
      Binds: ['/datos:/datos'],
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: 'bridge',
    } as never);
    expect(clean.Binds).toEqual(['/datos:/datos']);
    expect(clean.RestartPolicy?.Name).toBe('unless-stopped');
    expect(clean.NetworkMode).toBe('bridge');
  });
});

describe('demultiplexLogs', () => {
  it('separa las tramas del formato multiplexado de Docker', () => {
    // Cabecera de 8 bytes: tipo de flujo, tres de relleno y la longitud en big
    // endian. Volcar el cuerpo tal cual meteria bytes de control en el texto.
    const message = 'hola\n';
    const frame = Buffer.alloc(8 + message.length);
    frame.writeUInt8(1, 0);
    frame.writeUInt32BE(message.length, 4);
    frame.write(message, 8);

    expect(demultiplexLogs(frame)).toBe('hola\n');
  });

  it('devuelve el texto tal cual si no venia multiplexado', () => {
    // Podman y los contenedores con TTY devuelven el log en crudo.
    expect(demultiplexLogs(Buffer.from('texto plano sin cabeceras'))).toBe(
      'texto plano sin cabeceras',
    );
  });

  it('concatena varias tramas', () => {
    const build = (text: string, stream: number): Buffer => {
      const buffer = Buffer.alloc(8 + text.length);
      buffer.writeUInt8(stream, 0);
      buffer.writeUInt32BE(text.length, 4);
      buffer.write(text, 8);
      return buffer;
    };
    const combined = Buffer.concat([build('salida\n', 1), build('error\n', 2)]);
    expect(demultiplexLogs(combined)).toBe('salida\nerror\n');
  });
});
