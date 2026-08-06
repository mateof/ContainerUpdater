import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkComposeAccessibility,
  composeProjectKey,
  isInsideAllowedRoots,
  readComposeMembership,
} from './projects.js';
import type { ContainerListItem } from './types.js';

function container(labels: Record<string, string>): ContainerListItem {
  return {
    Id: 'abc123',
    Names: ['/test'],
    Image: 'nginx:alpine',
    ImageID: 'sha256:x',
    Created: 0,
    State: 'running',
    Status: 'Up',
    Labels: labels,
  };
}

describe('readComposeMembership', () => {
  it('separa config_files por comas', () => {
    // Un stack levantado con varios -f trae la lista entera en una sola label.
    // Pasarla como un unico -f hace que compose no encuentre el fichero.
    const membership = readComposeMembership(
      container({
        'com.docker.compose.project': 'app',
        'com.docker.compose.project.working_dir': '/volume1/docker/app',
        'com.docker.compose.project.config_files':
          '/volume1/docker/app/docker-compose.yml,/volume1/docker/app/override.yml',
        'com.docker.compose.service': 'web',
      }),
    );
    expect(membership?.configFiles).toEqual([
      '/volume1/docker/app/docker-compose.yml',
      '/volume1/docker/app/override.yml',
    ]);
  });

  it('distingue proyectos que comparten nombre', () => {
    // Caso verificado en un entorno real: Container Manager deriva el nombre de
    // la carpeta, asi que dos stacks distintos se llaman ambos "docker".
    // Agrupar solo por nombre haria que un `down` cayera en el equivocado.
    const first = readComposeMembership(
      container({
        'com.docker.compose.project': 'docker',
        'com.docker.compose.project.working_dir': '/repos/proyecto-a/docker',
        'com.docker.compose.project.config_files': '/repos/proyecto-a/docker/compose.yml',
      }),
    );
    const second = readComposeMembership(
      container({
        'com.docker.compose.project': 'docker',
        'com.docker.compose.project.working_dir': '/repos/proyecto-b/docker',
        'com.docker.compose.project.config_files': '/repos/proyecto-b/docker/compose.yml',
      }),
    );

    expect(first?.projectName).toBe(second?.projectName);
    expect(first?.key).not.toBe(second?.key);
  });

  it('ignora los contenedores de compose run', () => {
    const membership = readComposeMembership(
      container({
        'com.docker.compose.project': 'app',
        'com.docker.compose.oneoff': 'True',
      }),
    );
    expect(membership).toBeNull();
  });

  it('devuelve null para contenedores sin proyecto', () => {
    expect(readComposeMembership(container({}))).toBeNull();
  });

  it('genera claves estables', () => {
    expect(composeProjectKey('app', '/srv/app')).toBe('app /srv/app');
  });
});

describe('isInsideAllowedRoots', () => {
  it('acepta la propia raiz y lo que cuelga de ella', () => {
    expect(isInsideAllowedRoots('/volume1/docker', ['/volume1/docker'])).toBe(true);
    expect(isInsideAllowedRoots('/volume1/docker/app', ['/volume1/docker'])).toBe(true);
  });

  it('no se deja enganar por un prefijo compartido', () => {
    // `/volume1/docker-secretos` empieza igual que `/volume1/docker` pero es
    // otro directorio. Comparar con startsWith a secas lo aceptaria.
    expect(isInsideAllowedRoots('/volume1/docker-secretos/x', ['/volume1/docker'])).toBe(false);
  });

  it('rechaza rutas de fuera', () => {
    expect(isInsideAllowedRoots('/etc/passwd', ['/volume1/docker'])).toBe(false);
  });
});

describe('checkComposeAccessibility', () => {
  let root: string;
  let allowed: string;
  let outside: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'cu-test-'));
    allowed = join(root, 'permitido');
    outside = join(root, 'fuera');
    await mkdir(join(allowed, 'app'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(allowed, 'app', 'compose.yml'), 'services: {}\n');
    await writeFile(join(outside, 'secreto.yml'), 'services: {}\n');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('acepta un proyecto dentro de las carpetas permitidas', async () => {
    const result = await checkComposeAccessibility(
      {
        workingDir: join(allowed, 'app'),
        configFiles: [join(allowed, 'app', 'compose.yml')],
      },
      [allowed],
    );
    expect(result.accessible).toBe(true);
    expect(result.resolvedFiles).toHaveLength(1);
  });

  it('rechaza un enlace simbolico que escapa de las carpetas permitidas', async () => {
    // Este es el motivo de resolver realpath ANTES de validar. Si se validara
    // la ruta tal cual y despues se resolviera, este enlace pasaria el filtro y
    // acabariamos ejecutando compose sobre un fichero de fuera.
    const link = join(allowed, 'app', 'escape.yml');
    await symlink(join(outside, 'secreto.yml'), link);

    const result = await checkComposeAccessibility(
      { workingDir: join(allowed, 'app'), configFiles: [link] },
      [allowed],
    );
    expect(result.accessible).toBe(false);
    expect(result.reason).toContain('fuera de las carpetas permitidas');
  });

  it('rechaza un fichero que no existe con un mensaje util', async () => {
    const result = await checkComposeAccessibility(
      { workingDir: join(allowed, 'app'), configFiles: [join(allowed, 'app', 'nada.yml')] },
      [allowed],
    );
    expect(result.accessible).toBe(false);
    expect(result.reason).toContain('misma ruta');
  });

  it('rechaza un proyecto sin directorio ni ficheros declarados', async () => {
    const result = await checkComposeAccessibility({ workingDir: '', configFiles: [] }, [allowed]);
    expect(result.accessible).toBe(false);
  });
});
