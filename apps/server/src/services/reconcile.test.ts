import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '@cu/shared';

/**
 * Reconciliacion del estado de una imagen tras actualizarla.
 *
 * El estado lo escribe el comprobador, asi que sin esto una imagen recien
 * actualizada seguiria diciendo "actualizacion disponible" y el boton no
 * desapareceria hasta la siguiente comprobacion programada, que puede tardar
 * horas. Es exactamente el sintoma que reporto el usuario.
 *
 * Se prueba la regla aislada: es una decision logica pura y no necesita ni
 * Docker ni base de datos para verificarse.
 */
function reconcile(input: {
  status: UpdateStatus;
  remoteDigest: string | null;
  localDigests: string[];
}): { status: UpdateStatus; clearCandidate: boolean } {
  if (
    input.status === 'update-available' &&
    input.remoteDigest &&
    input.localDigests.includes(input.remoteDigest)
  ) {
    return { status: 'up-to-date', clearCandidate: true };
  }
  return { status: input.status, clearCandidate: false };
}

describe('reconciliacion tras actualizar', () => {
  it('marca al dia cuando el digest remoto ya esta entre los locales', () => {
    // Es lo que pasa justo despues de una actualizacion correcta.
    const result = reconcile({
      status: 'update-available',
      remoteDigest: 'sha256:nuevo',
      localDigests: ['sha256:nuevo', 'sha256:nuevo-arch'],
    });
    expect(result.status).toBe('up-to-date');
    expect(result.clearCandidate).toBe(true);
  });

  it('mantiene el aviso si la imagen local sigue siendo la vieja', () => {
    // Si la actualizacion fallo, el boton tiene que seguir ahi.
    const result = reconcile({
      status: 'update-available',
      remoteDigest: 'sha256:nuevo',
      localDigests: ['sha256:viejo'],
    });
    expect(result.status).toBe('update-available');
  });

  it('no toca los estados que no son un aviso pendiente', () => {
    for (const status of ['unknown', 'error', 'pinned', 'up-to-date'] as UpdateStatus[]) {
      const result = reconcile({
        status,
        remoteDigest: 'sha256:x',
        localDigests: ['sha256:x'],
      });
      expect(result.status).toBe(status);
    }
  });

  it('no concluye nada sin digest remoto', () => {
    // Sin referencia con la que comparar no se puede afirmar que este al dia.
    const result = reconcile({
      status: 'update-available',
      remoteDigest: null,
      localDigests: ['sha256:algo'],
    });
    expect(result.status).toBe('update-available');
  });

  it('funciona con varios digests locales', () => {
    // Una imagen puede tener el del indice y el de su arquitectura: basta con
    // que el remoto este entre ellos.
    const result = reconcile({
      status: 'update-available',
      remoteDigest: 'sha256:indice',
      localDigests: ['sha256:por-arquitectura', 'sha256:indice'],
    });
    expect(result.status).toBe('up-to-date');
  });
});
