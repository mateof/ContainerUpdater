import { describe, expect, it } from 'vitest';
import { buildPortsTable, portsToCsv } from './ports-table.js';
import type { ContainerSummary } from './types.js';

function contenedor(patch: Partial<ContainerSummary> & { name: string }): ContainerSummary {
  return {
    id: patch.name,
    image: 'nginx:alpine',
    imageRef: 'registry-1.docker.io/library/nginx:alpine',
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
    projectKey: null,
    projectName: null,
    serviceName: null,
    isSelf: false,
    ...patch,
  };
}

const p = (publicPort: number, privatePort = 80, extra: Record<string, unknown> = {}) => ({
  publicPort,
  privatePort,
  type: 'tcp',
  ...extra,
});

describe('resumen de puertos', () => {
  it('solo entran los publicados', () => {
    // Un puerto interno no ocupa nada en la maquina: listarlo en un resumen de
    // "que tengo ocupado" seria enganoso.
    const { rows } = buildPortsTable([
      contenedor({ name: 'a', ports: [p(8080), { privatePort: 5432, type: 'tcp' }] }),
    ]);
    expect(rows.map((r) => r.publicPort)).toEqual([8080]);
  });

  it('se ordena por numero de puerto', () => {
    // La pregunta que trae aqui a alguien es "quien tiene el 8080", no "que
    // hace el contenedor tal".
    const { rows } = buildPortsTable([
      contenedor({ name: 'c', ports: [p(9000)] }),
      contenedor({ name: 'a', ports: [p(80)] }),
      contenedor({ name: 'b', ports: [p(443)] }),
    ]);
    expect(rows.map((r) => r.publicPort)).toEqual([80, 443, 9000]);
  });

  it('la interfaz por defecto se muestra como comodin', () => {
    for (const ip of [undefined, '', '0.0.0.0', '::']) {
      const { rows } = buildPortsTable([contenedor({ name: 'a', ports: [p(80, 80, { ip })] })]);
      expect(rows[0]?.binding, String(ip)).toBe('*');
    }
    // Y una concreta se enseña tal cual, porque cambia a donde responde.
    const { rows } = buildPortsTable([contenedor({ name: 'a', ports: [p(80, 80, { ip: '127.0.0.1' })] })]);
    expect(rows[0]?.binding).toBe('127.0.0.1');
  });

  it('un contenedor parado no ocupa, pero reserva', () => {
    // Distincion que importa: el puerto esta libre AHORA, y dejara de estarlo en
    // cuanto alguien arranque ese contenedor.
    const resumen = buildPortsTable([
      contenedor({ name: 'vivo', ports: [p(80)] }),
      contenedor({ name: 'muerto', state: 'exited', ports: [p(8080)] }),
    ]);
    expect(resumen.occupiedNow).toBe(1);
    expect(resumen.reserved).toBe(1);
  });

  it('el mismo puerto en dos contenedores es un choque', () => {
    // Con los dos en marcha no puede pasar, pero con uno parado si, y es justo
    // lo que hay que saber antes de intentar levantarlo.
    const resumen = buildPortsTable([
      contenedor({ name: 'vivo', ports: [p(8080)] }),
      contenedor({ name: 'parado', state: 'exited', ports: [p(8080)] }),
    ]);
    expect(resumen.conflicts).toBe(1);
    expect(resumen.rows.every((r) => r.conflict)).toBe(true);
  });

  it('el mismo puerto en dos interfaces del MISMO contenedor no es choque', () => {
    const resumen = buildPortsTable([
      contenedor({ name: 'a', ports: [p(80, 80, { ip: '127.0.0.1' }), p(80, 80, { ip: '10.0.0.1' })] }),
    ]);
    expect(resumen.conflicts).toBe(0);
  });

  it('un puerto ocupado no se cuenta ademas como reservado', () => {
    const resumen = buildPortsTable([
      contenedor({ name: 'vivo', ports: [p(80)] }),
      contenedor({ name: 'parado', state: 'exited', ports: [p(80)] }),
    ]);
    expect(resumen.occupiedNow).toBe(1);
    expect(resumen.reserved).toBe(0);
  });
});

describe('exportacion a CSV', () => {
  const { rows } = buildPortsTable([
    contenedor({ name: 'web', projectName: 'tienda', ports: [p(8080, 80)] }),
  ]);

  it('lleva BOM y separador de punto y coma', () => {
    // Sin esto, Excel en español mete la fila entera en una celda y rompe los
    // acentos.
    const csv = portsToCsv(rows);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.split('\r\n')[0]).toContain('Puerto;Protocolo');
  });

  it('escapa lo que llevaria el separador dentro', () => {
    const conPuntoYComa = buildPortsTable([
      contenedor({ name: 'raro;nombre', ports: [p(80)] }),
    ]).rows;
    expect(portsToCsv(conPuntoYComa)).toContain('"raro;nombre"');
  });

  it('una fila por puerto, con su contenedor y proyecto', () => {
    const linea = portsToCsv(rows).split('\r\n')[1];
    expect(linea).toBe('8080;tcp;*;web;tienda;nginx:alpine;En ejecucion;80');
  });
});
