import { describe, expect, it } from 'vitest';
import { DEFAULT_TEST_POLICY, DEFAULT_TEST_SETTINGS } from './test-fixtures.js';
import { isWithinHours, nextWindowStart, updateHold } from './quarantine.js';

const HOUR = 3600_000;

describe('franja horaria', () => {
  const at = (hour: number) => new Date(2026, 0, 15, hour, 30);

  it('franja normal: de 4 a 6', () => {
    expect(isWithinHours(at(3), 4, 6)).toBe(false);
    expect(isWithinHours(at(4), 4, 6)).toBe(true);
    expect(isWithinHours(at(5), 4, 6)).toBe(true);
    expect(isWithinHours(at(6), 4, 6)).toBe(false);
  });

  it('franja que cruza medianoche: de 22 a 6', () => {
    // El caso que de verdad querria alguien con un NAS, y el que se rompe si se
    // implementa con un simple `hora >= inicio && hora < fin`.
    expect(isWithinHours(at(23), 22, 6)).toBe(true);
    expect(isWithinHours(at(2), 22, 6)).toBe(true);
    expect(isWithinHours(at(7), 22, 6)).toBe(false);
    expect(isWithinHours(at(21), 22, 6)).toBe(false);
  });

  it('inicio igual a fin es el dia entero, no la franja vacia', () => {
    // Si fuese vacia, el auto-update quedaria apagado para siempre sin que
    // ninguna pantalla lo dijera.
    expect(isWithinHours(at(0), 5, 5)).toBe(true);
    expect(isWithinHours(at(13), 5, 5)).toBe(true);
  });

  it('la proxima franja es manana cuando la de hoy ya paso', () => {
    const monday = new Date(2026, 0, 12, 10, 0, 0, 0);
    expect(new Date(nextWindowStart(monday, 4)).getDate()).toBe(13);
    expect(new Date(nextWindowStart(monday, 22)).getDate()).toBe(12);
  });
});

describe('retencion de una actualizacion automatica', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);

  it('retiene mientras la version es demasiado reciente', () => {
    const hold = updateHold({
      policy: { ...DEFAULT_TEST_POLICY, minAgeHours: 72 },
      settings: DEFAULT_TEST_SETTINGS,
      publishedAt: now - 10 * HOUR,
      now,
    });
    expect(hold?.reason).toBe('quarantine');
    expect(hold?.until).toBe(now - 10 * HOUR + 72 * HOUR);
  });

  it('deja pasar cuando la version ya ha cumplido la cuarentena', () => {
    expect(
      updateHold({
        policy: { ...DEFAULT_TEST_POLICY, minAgeHours: 72 },
        settings: DEFAULT_TEST_SETTINGS,
        publishedAt: now - 100 * HOUR,
        now,
      }),
    ).toBeNull();
  });

  it('la politica de la imagen manda sobre el valor global', () => {
    const settings = { ...DEFAULT_TEST_SETTINGS, defaultMinAgeHours: 168 };
    // 0 no es "sin valor": es "esta imagen entra ya, diga lo que diga el global".
    expect(
      updateHold({
        policy: { ...DEFAULT_TEST_POLICY, minAgeHours: 0 },
        settings,
        publishedAt: now - HOUR,
        now,
      }),
    ).toBeNull();
    // null si hereda, y entonces el global si aplica.
    expect(
      updateHold({
        policy: { ...DEFAULT_TEST_POLICY, minAgeHours: null },
        settings,
        publishedAt: now - HOUR,
        now,
      })?.reason,
    ).toBe('quarantine');
  });

  it('con fecha desconocida DEJA PASAR, no retiene para siempre', () => {
    // Es la decision que evita que un registry sin etiquetas OCI convierta el
    // auto-update en algo que no funciona y nadie sabe por que.
    expect(
      updateHold({
        policy: { ...DEFAULT_TEST_POLICY, minAgeHours: 720 },
        settings: DEFAULT_TEST_SETTINGS,
        publishedAt: null,
        now,
      }),
    ).toBeNull();
  });

  it('retiene fuera de la ventana de mantenimiento', () => {
    const settings = {
      ...DEFAULT_TEST_SETTINGS,
      maintenanceWindowEnabled: true,
      maintenanceStartHour: 4,
      maintenanceEndHour: 6,
    };
    const noon = new Date(2026, 0, 15, 12, 0, 0).getTime();
    const hold = updateHold({
      policy: { ...DEFAULT_TEST_POLICY, minAgeHours: 0 },
      settings,
      publishedAt: noon - 1000 * HOUR,
      now: noon,
    });
    expect(hold?.reason).toBe('maintenance-window');

    const dawn = new Date(2026, 0, 15, 5, 0, 0).getTime();
    expect(
      updateHold({
        policy: { ...DEFAULT_TEST_POLICY, minAgeHours: 0 },
        settings,
        publishedAt: dawn - 1000 * HOUR,
        now: dawn,
      }),
    ).toBeNull();
  });

  it('la cuarentena tiene prioridad sobre la ventana al explicarlo', () => {
    // Si se dan las dos, la que se muestra es la que impone mas espera. Decir
    // "espera a las 4" cuando ademas faltan tres dias seria enganoso.
    const settings = {
      ...DEFAULT_TEST_SETTINGS,
      maintenanceWindowEnabled: true,
      maintenanceStartHour: 4,
      maintenanceEndHour: 6,
    };
    const noon = new Date(2026, 0, 15, 12, 0, 0).getTime();
    expect(
      updateHold({
        policy: { ...DEFAULT_TEST_POLICY, minAgeHours: 72 },
        settings,
        publishedAt: noon - HOUR,
        now: noon,
      })?.reason,
    ).toBe('quarantine');
  });
});
