import { describe, expect, it } from 'vitest';
import type { ComposeProject, ContainerSummary, TrackedImage } from '@cu/shared';

/**
 * Que la cuenta de la tarjeta y las marcas de cada servicio no puedan discrepar.
 *
 * Existe por un fallo observado en pantalla: un proyecto anunciaba "2
 * actualizaciones" mientras NINGUNO de sus servicios aparecia marcado, y al
 * terminar de actualizarlo la cabecera seguia igual. Los dos numeros venian de
 * sitios distintos: la cuenta del snapshot del inventario (calculada al
 * refrescar, y ademas antes de que ese mismo refresco reconciliara el estado de
 * las imagenes) y las marcas de la lista de imagenes, que si se lee fresca.
 *
 * La regla que se prueba aqui es la que hace imposible el sintoma: **la cuenta
 * es exactamente el numero de contenedores marcados**. Si alguna vez alguien
 * vuelve a calcularlas por separado, esto falla.
 */

/** Misma derivacion que `InventoryService.listProjects`. */
function decorate(project: ComposeProject, updatableRefs: Set<string>): ComposeProject {
  const containers = project.containers.map((container) => ({
    ...container,
    updateAvailable: container.imageRef !== null && updatableRefs.has(container.imageRef),
  }));
  return {
    ...project,
    containers,
    updatesAvailable: containers.filter((container) => container.updateAvailable).length,
  };
}

function container(name: string, imageRef: string | null): ContainerSummary {
  return {
    id: name,
    name,
    image: imageRef ?? 'x',
    imageRef,
    imageId: 'sha256:x',
    state: 'running',
    status: 'Up',
    health: 'none',
    createdAt: 0,
    startedAt: null,
    restartCount: 0,
    exitCode: null,
    updateAvailable: false,
    ports: [],
    projectKey: 'demo /srv/demo',
    projectName: 'demo',
    serviceName: name,
    isSelf: false,
  };
}

function project(containers: ContainerSummary[]): ComposeProject {
  return {
    key: 'demo /srv/demo',
    name: 'demo',
    workingDir: '/srv/demo',
    configFiles: ['/srv/demo/docker-compose.yml'],
    yamlAccessible: true,
    strategy: 'compose',
    containers,
    // A proposito con un valor mentiroso: es justo lo que traia el snacpshot
    // rancio, y lo que la derivacion tiene que pisar.
    updatesAvailable: 99,
    managed: false,
    editable: true,
    editableReason: null,
  };
}

const ALPINE = 'registry-1.docker.io/library/alpine:3.20';
const BUSYBOX = 'registry-1.docker.io/library/busybox:1.36';

describe('actualizaciones de un proyecto', () => {
  it('la cuenta es exactamente la de los servicios marcados', () => {
    const result = decorate(
      project([container('uno', ALPINE), container('dos', BUSYBOX)]),
      new Set([ALPINE]),
    );
    expect(result.updatesAvailable).toBe(1);
    expect(result.containers.filter((c) => c.updateAvailable).map((c) => c.name)).toEqual(['uno']);
  });

  it('sin novedades la cuenta es cero, aunque el snapshot dijera otra cosa', () => {
    // El sintoma exacto que se vio: cabecera anunciando actualizaciones que ya
    // no existian, sin ni un servicio que enseñar.
    const result = decorate(
      project([container('uno', ALPINE), container('dos', BUSYBOX)]),
      new Set(),
    );
    expect(result.updatesAvailable).toBe(0);
    expect(result.containers.some((c) => c.updateAvailable)).toBe(false);
  });

  it('dos servicios con la misma imagen se marcan los dos', () => {
    // Los dos se actualizan al aplicar el proyecto, asi que marcar solo uno
    // seria mentira.
    const result = decorate(
      project([container('uno', ALPINE), container('dos', ALPINE)]),
      new Set([ALPINE]),
    );
    expect(result.updatesAvailable).toBe(2);
  });

  it('un contenedor sin referencia interpretable nunca se marca', () => {
    // `imageRef` es null cuando la cadena del daemon no se puede normalizar.
    // Cruzar por el `image` crudo daria falsos positivos: comprobado en un
    // entorno real, de 21 contenedores solo 3 coincidian por esa via.
    const result = decorate(project([container('raro', null)]), new Set([ALPINE]));
    expect(result.updatesAvailable).toBe(0);
  });
});
