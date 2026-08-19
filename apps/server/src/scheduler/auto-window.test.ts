import { describe, expect, it } from 'vitest';
import { DEFAULT_TEST_POLICY, DEFAULT_TEST_SETTINGS, updateHold } from '@cu/shared';

/**
 * Que la ventana de mantenimiento no dependa del cron de comprobaciones.
 *
 * Existe por un fallo de diseño real: las actualizaciones automaticas solo se
 * aplicaban pegadas al ciclo de comprobacion, que por defecto corre a las 00,
 * 06, 12 y 18. Con una ventana de 04:00 a 08:00 la unica oportunidad del dia
 * era la de las 06:00, y si en ese momento la version seguia en cuarentena, la
 * siguiente ocasion llegaba 24 horas mas tarde. Con una ventana de 02:00 a
 * 04:00, donde no cae ninguna comprobacion, no se habria aplicado NUNCA.
 *
 * La solucion fue darle a las automaticas su propio reloj, cada media hora. Lo
 * que se prueba aqui es la propiedad que lo justifica: dentro de la franja no
 * hay retencion, asi que basta con preguntar a menudo.
 */
const HORA = 3600_000;

/** Momentos en los que el cron por defecto comprueba. */
const COMPROBACIONES = [0, 6, 12, 18];

function retencionA(hora: number, ventana: [number, number], publicadaHace = 1000 * HORA) {
  const ahora = new Date(2026, 7, 19, hora, 0, 0).getTime();
  return updateHold({
    policy: { ...DEFAULT_TEST_POLICY, minAgeHours: 0 },
    settings: {
      ...DEFAULT_TEST_SETTINGS,
      maintenanceWindowEnabled: true,
      maintenanceStartHour: ventana[0],
      maintenanceEndHour: ventana[1],
    },
    publishedAt: ahora - publicadaHace,
    now: ahora,
  });
}

describe('ventana de mantenimiento frente al cron de comprobaciones', () => {
  it('una ventana donde no cae ninguna comprobacion sigue teniendo horas validas', () => {
    // 02:00-04:00: el cron por defecto no pasa por ahi ni una vez.
    expect(COMPROBACIONES.filter((h) => h >= 2 && h < 4)).toEqual([]);
    // Y sin embargo hay dos horas al dia en las que se puede actualizar. Es lo
    // que hace imprescindible un reloj propio para las automaticas.
    expect(retencionA(2, [2, 4])).toBeNull();
    expect(retencionA(3, [2, 4])).toBeNull();
  });

  it('fuera de la franja retiene, sea la hora que sea', () => {
    for (const hora of [0, 1, 4, 12, 23]) {
      expect(retencionA(hora, [2, 4]), `${hora}:00`).not.toBeNull();
    }
  });

  it('dentro de la franja no retiene en ningun momento, no solo al abrirse', () => {
    // Si solo valiera el instante de apertura, bastaria con un disparo al
    // empezar; como vale toda la franja, sondear cada media hora es correcto.
    for (const hora of [4, 5, 6, 7]) {
      expect(retencionA(hora, [4, 8]), `${hora}:00`).toBeNull();
    }
  });

  it('una version que cumple la cuarentena a media franja entra sin esperar al dia siguiente', () => {
    const ventana: [number, number] = [4, 8];
    // Publicada hace 23 horas con cuarentena de 24: a las 06:00 aun retiene.
    const alasSeis = new Date(2026, 7, 19, 6, 0, 0).getTime();
    const publicada = alasSeis - 23 * HORA;
    const config = {
      policy: { ...DEFAULT_TEST_POLICY, minAgeHours: 24 },
      settings: {
        ...DEFAULT_TEST_SETTINGS,
        maintenanceWindowEnabled: true,
        maintenanceStartHour: ventana[0],
        maintenanceEndHour: ventana[1],
      },
      publishedAt: publicada,
    };
    expect(updateHold({ ...config, now: alasSeis })?.reason).toBe('quarantine');
    // Una hora despues ya ha cumplido, y seguimos dentro de la franja. Sin reloj
    // propio, esto no se aplicaria hasta las 06:00 del dia siguiente.
    expect(updateHold({ ...config, now: alasSeis + 1.5 * HORA })).toBeNull();
  });
});
