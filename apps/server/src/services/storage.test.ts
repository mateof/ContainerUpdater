import { describe, expect, it } from 'vitest';
import { pickLabels } from './storage.js';

/**
 * Estas pruebas existen por un fallo encontrado probando contra Podman de
 * verdad, no en teoria.
 *
 * `/system/df` calcula el tamano de cada volumen pero devuelve sus etiquetas
 * como un objeto VACIO; `/volumes` trae las etiquetas buenas pero sin tamano.
 * La primera version cruzaba las dos fuentes con `??`, que solo cae con null o
 * undefined: el objeto vacio ganaba siempre y ningun volumen mostraba de que
 * proyecto venia. No fallaba nada, simplemente el dato salia en blanco.
 */
describe('cruce de etiquetas de volumen', () => {
  const good = { 'com.docker.compose.project': 'stub-service' };

  it('un objeto vacio NO tapa a las etiquetas buenas', () => {
    expect(pickLabels({}, good)).toEqual(good);
  });

  it('null y undefined tampoco', () => {
    expect(pickLabels(null, good)).toEqual(good);
    expect(pickLabels(undefined, good)).toEqual(good);
  });

  it('si las primeras traen algo, mandan ellas', () => {
    expect(pickLabels(good, { otra: 'cosa' })).toEqual(good);
  });

  it('sin nada en ninguna fuente devuelve null, no un objeto vacio', () => {
    // null es lo que la interfaz sabe mostrar como "sin proyecto". Un objeto
    // vacio pasaria la comprobacion de existencia y se pintaria en blanco.
    expect(pickLabels({}, undefined, null)).toBeNull();
  });
});
