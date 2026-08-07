import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProjectFilesError,
  ProjectFilesService,
  isSecretKey,
  maskEnv,
  parseEnv,
  resolveProjectsDir,
} from './project-files.js';
import type { Repositories } from '../db/repositories/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('fatal');

/**
 * Repositorio en memoria. La parte de SQLite ya se prueba por su cuenta; aqui
 * lo que interesa es lo que toca el disco.
 */
function fakeRepos() {
  const rows: Array<{ id: number; name: string; dir: string }> = [];
  const archived: Array<{ kind: string; content: string }> = [];

  return {
    archived,
    repos: {
      managedProjects: {
        list: () => rows,
        findByName: (name: string) => rows.find((row) => row.name === name),
        create: (input: { name: string; dir: string }) => {
          const row = { id: rows.length + 1, ...input };
          rows.push(row);
          return row;
        },
        touch: () => undefined,
        remove: (id: number) => {
          const index = rows.findIndex((row) => row.id === id);
          if (index >= 0) rows.splice(index, 1);
        },
        archive: (input: { kind: string; content: string }) => {
          archived.push({ kind: input.kind, content: input.content });
          return true;
        },
        prune: () => undefined,
      },
    } as unknown as Repositories,
  };
}

describe('parseEnv', () => {
  it('lee pares sencillos y se salta comentarios', () => {
    const entries = parseEnv('# comentario\nTZ=Europe/Madrid\n\nPUID=1000\n');
    expect(entries.map((e) => e.key)).toEqual(['TZ', 'PUID']);
    expect(entries[0]?.value).toBe('Europe/Madrid');
  });

  it('quita las comillas envolventes solo para mostrar', () => {
    expect(parseEnv('A="con espacios"')[0]?.value).toBe('con espacios');
    expect(parseEnv("B='otro'")[0]?.value).toBe('otro');
  });

  it('conserva los iguales que van dentro del valor', () => {
    // Un DSN o una clave en base64 llevan `=` y partir por el primero es lo
    // unico correcto; partir por todos destrozaria el valor.
    expect(parseEnv('DB=postgres://u:p@h/d?a=1&b=2')[0]?.value).toBe('postgres://u:p@h/d?a=1&b=2');
    expect(parseEnv('KEY=YWJjZA==')[0]?.value).toBe('YWJjZA==');
  });

  it('acepta el prefijo export', () => {
    expect(parseEnv('export TOKEN=abc')[0]?.key).toBe('TOKEN');
  });

  it('ignora lineas sin igual o con clave vacia', () => {
    expect(parseEnv('suelta\n=sinclave\n')).toEqual([]);
  });
});

describe('isSecretKey', () => {
  it('reconoce los nombres habituales de secreto', () => {
    for (const key of ['DB_PASSWORD', 'API_TOKEN', 'JWT_SECRET', 'PRIVATE_KEY', 'AUTH_PWD']) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it('deja en claro lo que no lo es', () => {
    for (const key of ['TZ', 'PUID', 'PORT', 'LOG_LEVEL']) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe('maskEnv', () => {
  it('tapa el valor sin revelar su longitud real', () => {
    // Un valor muy largo con su longitud exacta ya dice demasiado.
    const [masked] = maskEnv(parseEnv('SECRET=' + 'x'.repeat(80)));
    expect(masked?.value).toBe('•'.repeat(12));
    expect(masked?.value).not.toContain('x');
  });

  it('no toca lo que no es secreto', () => {
    expect(maskEnv(parseEnv('TZ=Europe/Madrid'))[0]?.value).toBe('Europe/Madrid');
  });
});

describe('ProjectFilesService', () => {
  let root: string;
  /**
   * La raiz con los enlaces ya resueltos.
   *
   * En macOS el directorio temporal esta bajo `/var`, que es un enlace a
   * `/private/var`, y el servicio resuelve las rutas a proposito para que un
   * enlace no permita escribir fuera. Las comprobaciones tienen que usar la
   * ruta resuelta o comparan cosas distintas.
   */
  let realRoot: string;
  let service: ProjectFilesService;
  let fake: ReturnType<typeof fakeRepos>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cu-projects-'));
    realRoot = await realpath(root);
    fake = fakeRepos();
    service = new ProjectFilesService(root, fake.repos, log);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('crea la carpeta con el compose y el .env', async () => {
    const { dir } = await service.create({
      name: 'reproductor',
      compose: 'services:\n  web:\n    image: nginx:alpine',
      env: 'TZ=Europe/Madrid\nDB_PASSWORD=secreta',
      actorUserId: 1,
    });

    expect(dir).toBe(join(realRoot, 'reproductor'));
    expect(await readFile(join(dir, 'docker-compose.yml'), 'utf8')).toContain('nginx:alpine');
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain('DB_PASSWORD=secreta');
  });

  it('escribe el .env solo legible por su propietario', async () => {
    // Es la unica proteccion posible en disco: Compose tiene que leerlo en
    // claro, asi que lo que se puede evitar es que lo lea todo el sistema.
    const { dir } = await service.create({
      name: 'panel',
      compose: 'services: {}',
      env: 'DB_PASSWORD=secreta',
      actorUserId: null,
    });

    const mode = (await stat(join(dir, '.env'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('deja el compose legible, que no lleva secretos', async () => {
    const { dir } = await service.create({
      name: 'panel',
      compose: 'services: {}',
      actorUserId: null,
    });
    expect((await stat(join(dir, 'docker-compose.yml'))).mode & 0o777).toBe(0o644);
  });

  it('anade el salto de linea final y normaliza CRLF', async () => {
    // Un YAML con \r rompe compose en Linux, y pegar desde Windows lo mete.
    const { dir } = await service.create({
      name: 'web',
      compose: 'services:\r\n  web:\r\n    image: nginx',
      actorUserId: null,
    });
    const written = await readFile(join(dir, 'docker-compose.yml'), 'utf8');
    expect(written).not.toContain('\r');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('rechaza nombres que se salgan de la carpeta', async () => {
    for (const name of ['../fuera', 'con/barra', '.oculto', '-opcion', 'MAYUS']) {
      await expect(
        service.create({ name, compose: 'services: {}', actorUserId: null }),
        name,
      ).rejects.toThrow(ProjectFilesError);
    }
  });

  it('rechaza una carpeta que es un enlace fuera de la raiz', async () => {
    // Validar el nombre no basta: si alguien deja un enlace simbolico con ese
    // nombre apuntando fuera, escribir ahi seria escribir donde no se debe.
    const outside = await mkdtemp(join(tmpdir(), 'cu-fuera-'));
    try {
      await symlink(outside, join(root, 'trampa'));
      await expect(
        service.create({ name: 'trampa', compose: 'services: {}', actorUserId: null }),
      ).rejects.toMatchObject({ code: 'outside-root' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('no pisa una carpeta que ya existe', async () => {
    await mkdir(join(root, 'existente'), { recursive: true });
    await writeFile(join(root, 'existente', 'docker-compose.yml'), 'no me toques\n');

    await expect(
      service.create({ name: 'existente', compose: 'services: {}', actorUserId: null }),
    ).rejects.toMatchObject({ code: 'already-exists' });

    expect(await readFile(join(root, 'existente', 'docker-compose.yml'), 'utf8')).toBe(
      'no me toques\n',
    );
  });

  it('archiva la version anterior antes de sobrescribir', async () => {
    await service.create({ name: 'app', compose: 'version: 1\n', env: 'A=1\n', actorUserId: null });
    await service.update({ name: 'app', compose: 'version: 2\n', env: 'A=2\n', actorUserId: null });

    expect(fake.archived).toEqual([
      { kind: 'compose', content: 'version: 1\n' },
      { kind: 'env', content: 'A=1\n' },
    ]);
  });

  it('no archiva si el contenido no ha cambiado', async () => {
    await service.create({ name: 'app', compose: 'version: 1\n', actorUserId: null });
    await service.update({ name: 'app', compose: 'version: 1\n', actorUserId: null });
    expect(fake.archived).toEqual([]);
  });

  it('borra el .env cuando se vacia del todo', async () => {
    const { dir } = await service.create({
      name: 'app',
      compose: 'services: {}',
      env: 'A=1',
      actorUserId: null,
    });
    await service.update({ name: 'app', compose: 'services: {}', env: '', actorUserId: null });
    await expect(stat(join(dir, '.env'))).rejects.toThrow();
  });

  it('deja el .env intacto si no se manda', async () => {
    // Guardar solo el compose no puede llevarse por delante las contrasenas.
    const { dir } = await service.create({
      name: 'app',
      compose: 'services: {}',
      env: 'DB_PASSWORD=secreta',
      actorUserId: null,
    });
    await service.update({ name: 'app', compose: 'services: {v: 1}', actorUserId: null });
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain('secreta');
  });

  it('devuelve los secretos ocultos al leer', async () => {
    await service.create({
      name: 'app',
      compose: 'services: {}',
      env: 'TZ=Europe/Madrid\nDB_PASSWORD=secreta',
      actorUserId: null,
    });

    const files = await service.read('app');
    expect(files.env.find((e) => e.key === 'TZ')?.value).toBe('Europe/Madrid');
    expect(files.env.find((e) => e.key === 'DB_PASSWORD')?.value).not.toContain('secreta');
    expect(await service.revealEnvValue('app', 'DB_PASSWORD')).toBe('secreta');
  });

  it('no deja leer los ficheros de un proyecto que no gestiona', async () => {
    await mkdir(join(root, 'ajeno'), { recursive: true });
    await writeFile(join(root, 'ajeno', 'docker-compose.yml'), 'services: {}\n');
    await expect(service.read('ajeno')).rejects.toMatchObject({ code: 'not-managed' });
  });

  it('olvidar no borra nada del disco', async () => {
    const { dir } = await service.create({
      name: 'app',
      compose: 'services: {}',
      actorUserId: null,
    });
    service.forget('app');
    expect(await readFile(join(dir, 'docker-compose.yml'), 'utf8')).toContain('services');
  });

  it('descartar se niega a borrar fuera de la raiz', async () => {
    // Un borrado recursivo con la ruta equivocada es el peor fallo posible aqui.
    const outside = await mkdtemp(join(tmpdir(), 'cu-fuera-'));
    try {
      await writeFile(join(outside, 'importante.txt'), 'no me borres');
      await service.discard(outside);
      expect(await readFile(join(outside, 'importante.txt'), 'utf8')).toBe('no me borres');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('sin carpeta raiz explica por que no se puede crear', async () => {
    const sinRaiz = new ProjectFilesService(null, fake.repos, log);
    const info = await sinRaiz.dirInfo();
    expect(info.writable).toBe(false);
    expect(info.reason).toContain('CU_PROJECTS_DIR');
  });
});

describe('resolveProjectsDir', () => {
  it('respeta lo que diga el usuario', async () => {
    expect(await resolveProjectsDir('/elegida', ['/otra'])).toBe('/elegida');
  });

  it('descarta las carpetas que no admiten escritura', async () => {
    // Es el caso normal: el montaje recomendado las pone en solo lectura, y
    // entonces la creacion queda desactivada hasta montar una a proposito.
    expect(await resolveProjectsDir(undefined, ['/no/existe/tampoco'])).toBeNull();
  });

  it('coge la primera escribible', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cu-escribible-'));
    try {
      expect(await resolveProjectsDir(undefined, ['/no/existe', dir])).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
