import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateSockets, deriveComposeRoots, detectPlatform } from './platform.js';

describe('candidateSockets', () => {
  it('prueba Docker antes que Podman', () => {
    // El orden no es cosmetico: en una maquina con los dos, coger el de Podman
    // haria que la aplicacion no viese los contenedores que el usuario espera.
    const sockets = candidateSockets({});
    expect(sockets.indexOf('/var/run/docker.sock')).toBeLessThan(
      sockets.indexOf('/run/podman/podman.sock'),
    );
  });

  it('incluye el socket rootless solo si hay XDG_RUNTIME_DIR', () => {
    expect(candidateSockets({})).not.toContain('/run/user/1000/podman/podman.sock');
    expect(candidateSockets({ XDG_RUNTIME_DIR: '/run/user/1000' })).toContain(
      '/run/user/1000/podman/podman.sock',
    );
  });
});

describe('detectPlatform', () => {
  it('reconoce Synology por las rutas de los proyectos', async () => {
    const info = await detectPlatform(['/volume1/docker/medios'], 'docker');
    expect(info.id).toBe('synology');
    expect(info.evidence).toContain('/volume1/docker/medios');
  });

  it('reconoce Unraid y lo marca sin comprobar', async () => {
    // Declarar como verificado lo que no se ha probado en la plataforma real
    // enganaria al usuario justo cuando algo falla.
    const info = await detectPlatform(['/mnt/user/appdata/reproductor'], 'docker');
    expect(info.id).toBe('unraid');
    expect(info.verified).toBe(false);
  });

  it('no confunde /mnt/user con /mnt/usuarios', async () => {
    const info = await detectPlatform(['/mnt/usuarios/stacks/web'], 'docker');
    expect(info.id).not.toBe('unraid');
  });

  it('cae al runtime cuando las rutas no dicen nada', async () => {
    const info = await detectPlatform(['/home/ana/proyectos/web'], 'podman');
    expect(info.id).toBe('podman');
  });

  it('devuelve desconocido sin senales', async () => {
    const info = await detectPlatform([], 'unknown');
    expect(info.id).toBe('unknown');
    expect(info.verified).toBe(false);
  });
});

describe('deriveComposeRoots', () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'cu-platform-'));
    await mkdir(join(base, 'stacks', 'reproductor'), { recursive: true });
    await mkdir(join(base, 'stacks', 'panel'), { recursive: true });
    await mkdir(join(base, 'otro', 'servicio'), { recursive: true });
    await mkdir(join(base, 'suelto'), { recursive: true });
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('agrupa proyectos hermanos en su carpeta padre', async () => {
    // Es lo que hace que un stack nuevo en esa misma carpeta funcione sin
    // reiniciar la aplicacion, que es el caso de un NAS.
    const roots = await deriveComposeRoots([
      join(base, 'stacks', 'reproductor'),
      join(base, 'stacks', 'panel'),
    ]);
    expect(roots).toEqual([join(base, 'stacks')]);
  });

  it('no sube al padre cuando solo hay un proyecto ahi', async () => {
    // Regresion de un fallo visto contra una maquina real: con un proyecto
    // colgando directamente del home, subir siempre al padre convertia el home
    // entero en carpeta permitida y absorbia a todos los demas.
    const roots = await deriveComposeRoots([
      join(base, 'stacks', 'reproductor'),
      join(base, 'stacks', 'panel'),
      join(base, 'suelto'),
    ]);
    expect(roots).not.toContain(base);
    expect(roots.sort()).toEqual([join(base, 'stacks'), join(base, 'suelto')].sort());
  });

  it('descarta carpetas que no estan montadas aqui', async () => {
    // El caso real: el contenedor declara su ruta del anfitrion, pero ese
    // volumen no se ha montado. Aceptarla haria que compose fallase mas tarde
    // con un error mucho menos claro.
    const roots = await deriveComposeRoots([
      join(base, 'stacks', 'panel'),
      '/volume9/inexistente/proyecto',
    ]);
    expect(roots).toEqual([join(base, 'stacks', 'panel')]);
  });

  it('nunca permite la raiz del sistema', async () => {
    // Aceptar / equivaldria a no tener lista de permitidos: cualquier YAML del
    // sistema pasaria el filtro. Dos proyectos de primer nivel comparten / como
    // padre, que es justo cuando la regla de agrupacion querria subir.
    const roots = await deriveComposeRoots(['/tmp', '/var']);
    expect(roots).not.toContain('/');
  });

  it('elimina las carpetas que ya cuelgan de otra permitida', async () => {
    await mkdir(join(base, 'stacks', 'reproductor', 'sub-a'), { recursive: true });
    await mkdir(join(base, 'stacks', 'reproductor', 'sub-b'), { recursive: true });

    const roots = await deriveComposeRoots([
      join(base, 'stacks', 'reproductor'),
      join(base, 'stacks', 'panel'),
      join(base, 'stacks', 'reproductor', 'sub-a'),
      join(base, 'stacks', 'reproductor', 'sub-b'),
    ]);
    expect(roots).toEqual([join(base, 'stacks')]);
  });

  it('ignora rutas relativas o vacias', async () => {
    expect(await deriveComposeRoots(['', 'relativa/mala'])).toEqual([]);
  });
});
