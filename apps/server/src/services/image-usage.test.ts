import { describe, expect, it } from 'vitest';
import { usageOf } from './inventory.js';

/**
 * Estado de uso de una imagen.
 *
 * Es lo que decide si se puede borrar y con que consecuencias, asi que merece
 * pruebas propias: confundir "solo parados" con "sin usar" haria que la
 * interfaz ofreciera un borrado limpio cuando en realidad va a dejar
 * contenedores inservibles.
 */
describe('usageOf', () => {
  it('en marcha manda sobre todo lo demas', () => {
    expect(usageOf(['a', 'b'], ['a'])).toBe('running');
  });

  it('con contenedores pero ninguno en marcha es "solo parados"', () => {
    expect(usageOf(['a', 'b'], [])).toBe('stopped');
  });

  it('sin ningun contenedor es huerfana', () => {
    expect(usageOf([], [])).toBe('orphan');
  });

  it('un solo contenedor parado ya cuenta como parado, no como huerfana', () => {
    // La diferencia importa: borrarla exige forzar y rompe ese contenedor.
    expect(usageOf(['solo-uno'], [])).toBe('stopped');
  });
});
