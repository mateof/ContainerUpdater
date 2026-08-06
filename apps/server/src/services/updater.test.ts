import { describe, expect, it } from 'vitest';
import { explainDockerError } from './updater.js';

describe('explainDockerError', () => {
  it('explica el agotamiento de rangos de red', () => {
    // Es el fallo mas comun en un NAS con muchos proyectos, y el mensaje del
    // daemon no da ninguna pista de que hacer.
    const original =
      'could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network';
    const result = explainDockerError(original);

    expect(result).toContain(original);
    expect(result).toContain('docker network prune');
    expect(result).toContain('default-address-pools');
  });

  it('explica el disco lleno', () => {
    const result = explainDockerError('write /var/lib/docker: no space left on device');
    expect(result).toContain('docker image prune');
  });

  it('explica un puerto ocupado', () => {
    const result = explainDockerError(
      'driver failed programming external connectivity: Bind for 0.0.0.0:8099 failed: port is already allocated',
    );
    expect(result).toContain('Container Manager');
  });

  it('conserva siempre el mensaje original', () => {
    // Quien busque el texto exacto en internet tiene que poder encontrarlo.
    const original = 'port is already allocated';
    expect(explainDockerError(original)).toContain(original);
  });

  it('deja intacto un error que no reconoce', () => {
    expect(explainDockerError('algo raro ha pasado')).toBe('algo raro ha pasado');
  });
});
