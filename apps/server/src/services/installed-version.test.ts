import { describe, expect, it } from 'vitest';
import { versionSiSigueValiendo } from './inventory.js';
import type { ImageRow } from '../db/repositories/index.js';

/**
 * Que la version instalada no sobreviva a la imagen que describia.
 *
 * Existe por algo que se veia usando la aplicacion: al actualizar una imagen, la
 * pantalla seguia mostrando la version ANTERIOR como si fuera la recien
 * instalada, y solo se corregia al pulsar "comprobar".
 *
 * Una version guardada describe un contenido concreto, no una etiqueta. En
 * cuanto la etiqueta apunta a otro digest, lo guardado deja de ser cierto, y un
 * dato falso es peor que un hueco: el hueco se ve, el dato falso no.
 */
function fila(patch: Partial<ImageRow> = {}): ImageRow {
  return {
    installed_version: '3.19.9',
    installed_version_method: 'hub',
    installed_version_aliases: '["3.19"]',
    installed_version_for: 'sha256:viejo',
    local_digests: '["sha256:viejo"]',
    ...patch,
  } as ImageRow;
}

describe('vigencia de la version instalada', () => {
  it('se muestra mientras el digest sea el mismo para el que se resolvio', () => {
    const r = versionSiSigueValiendo(fila(), ['sha256:viejo']);
    expect(r.installedVersion).toBe('3.19.9');
    expect(r.installedVersionMethod).toBe('hub');
    expect(r.installedVersionAliases).toEqual(['3.19']);
  });

  it('desaparece en cuanto el digest cambia', () => {
    // Esto es exactamente lo que pasa al actualizar: la etiqueta pasa a apuntar
    // a otro contenido y lo que habia guardado ya no lo describe.
    const r = versionSiSigueValiendo(fila(), ['sha256:nuevo']);
    expect(r.installedVersion).toBeNull();
    expect(r.installedVersionMethod).toBeNull();
    expect(r.installedVersionAliases).toEqual([]);
  });

  it('sin digest local tampoco se afirma nada', () => {
    // Una imagen construida aqui no tiene digest de repositorio con el que
    // comparar, asi que no hay forma de saber si lo guardado sigue valiendo.
    expect(versionSiSigueValiendo(fila(), []).installedVersion).toBeNull();
  });

  it('sin version guardada devuelve vacio, no revienta', () => {
    const r = versionSiSigueValiendo(
      fila({ installed_version: null, installed_version_method: null, installed_version_aliases: null }),
      ['sha256:viejo'],
    );
    expect(r.installedVersion).toBeNull();
    expect(r.installedVersionAliases).toEqual([]);
  });
});
