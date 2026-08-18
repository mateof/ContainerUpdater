import { describe, expect, it, vi } from 'vitest';
import { ContainerRecreator } from './recreate.js';
import type { DockerApi } from './api.js';
import { parseImageReference } from '../registry/reference.js';

/**
 * Que la vuelta atras no se deshaga a si misma.
 *
 * Esta prueba existe por un fallo real, encontrado ejecutando una vuelta atras
 * de verdad contra Podman. La secuencia era:
 *
 *   1. Se descarga la version vieja por digest.  ✔
 *   2. Se le devuelve la etiqueta original.      ✔
 *   3. Se recrea el contenedor... haciendo un pull de esa misma etiqueta, que
 *      se traia OTRA VEZ la version nueva del registry.
 *
 * El resultado era que el contenedor acababa exactamente en la version de la
 * que se queria salir, el trabajo terminaba en "correcto" y no habia ni un
 * error en el log. Nada de esto lo detecta el typecheck ni una prueba de tipos:
 * hace falta comprobar que NO se llama a `pullImage`.
 */
describe('recreacion sin descarga', () => {
  function fakeDocker(): DockerApi {
    return {
      inspectContainer: vi.fn().mockResolvedValue({
        Id: 'abc',
        Name: '/prueba',
        Image: 'sha256:vieja',
        Config: { Image: 'alpine:3.20', Labels: {}, Env: [], StopTimeout: 10 },
        HostConfig: { Binds: [], RestartPolicy: { Name: 'no' } },
        State: { Running: true, ExitCode: 0, StartedAt: '', FinishedAt: '', Status: 'running', Paused: false, Restarting: false, Dead: false },
        RestartCount: 0,
        Mounts: [],
      }),
      inspectImage: vi.fn().mockResolvedValue({ Id: 'sha256:vieja', Config: { Env: [] } }),
      pullImage: vi.fn().mockResolvedValue(undefined),
      renameContainer: vi.fn().mockRejectedValue(new Error('corta aqui')),
      stopContainer: vi.fn(),
      removeContainer: vi.fn(),
      createContainer: vi.fn(),
      startContainer: vi.fn(),
      removeImage: vi.fn(),
    } as unknown as DockerApi;
  }

  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log } as never;
  const ref = parseImageReference('alpine:3.20');

  it('con skipPull NO descarga: la etiqueta local ya apunta a la version buena', async () => {
    const docker = fakeDocker();
    const recreator = new ContainerRecreator(docker, log);

    // Falla al renombrar a proposito: para entonces el pull ya se habria hecho,
    // que es lo unico que interesa comprobar.
    await recreator
      .recreate({
        containerId: 'abc',
        ref,
        credentials: null,
        removeImageFirst: false,
        skipPull: true,
        cleanupOldImage: false,
        onProgress: () => undefined,
      })
      .catch(() => undefined);

    expect(docker.pullImage).not.toHaveBeenCalled();
  });

  it('sin skipPull si descarga, que es lo normal en una actualizacion', async () => {
    const docker = fakeDocker();
    const recreator = new ContainerRecreator(docker, log);

    await recreator
      .recreate({
        containerId: 'abc',
        ref,
        credentials: null,
        removeImageFirst: false,
        cleanupOldImage: false,
        onProgress: () => undefined,
      })
      .catch(() => undefined);

    expect(docker.pullImage).toHaveBeenCalledOnce();
  });
});
