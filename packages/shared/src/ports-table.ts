import type { ContainerSummary } from './types.js';

/**
 * Resumen de los puertos publicados de la maquina.
 *
 * Vive en `shared` y no en la pantalla porque es logica pura y merece pruebas:
 * decidir que cuenta como ocupado, ordenar por numero de puerto y detectar
 * choques es donde estan las decisiones, no en pintar la tabla.
 */

export interface PortRow {
  /** Puerto en la maquina anfitriona. */
  publicPort: number;
  privatePort: number;
  type: string;
  /** Interfaz a la que esta atado, ya legible. */
  binding: string;
  containerId: string;
  containerName: string;
  projectName: string | null;
  projectKey: string | null;
  image: string;
  running: boolean;
  /**
   * Otro contenedor declara este mismo puerto.
   *
   * Con los dos en marcha no puede pasar (el segundo no arrancaria), pero con
   * uno parado si, y entonces es justo lo que hay que saber antes de intentar
   * levantarlo.
   */
  conflict: boolean;
}

export interface PortsSummary {
  rows: PortRow[];
  /** Puertos distintos que estan ocupados AHORA, por contenedores en marcha. */
  occupiedNow: number;
  /** Declarados por contenedores parados: se ocuparian al arrancarlos. */
  reserved: number;
  conflicts: number;
}

/** `0.0.0.0` y compañia significan "todas las interfaces". */
function bindingLabel(ip: string | undefined): string {
  const value = (ip ?? '').trim();
  if (value === '' || value === '0.0.0.0' || value === '::' || value === '[::]') return '*';
  return value;
}

/**
 * Construye la tabla a partir de los contenedores.
 *
 * Solo entran los puertos PUBLICADOS: un puerto interno no ocupa nada en la
 * maquina, solo dentro de su red, asi que listarlo en un resumen de "que tengo
 * ocupado" seria ruido y ademas engañoso.
 */
export function buildPortsTable(containers: ContainerSummary[]): PortsSummary {
  const rows: PortRow[] = [];

  for (const container of containers) {
    for (const port of container.ports) {
      if (!port.publicPort) continue;
      rows.push({
        publicPort: port.publicPort,
        privatePort: port.privatePort,
        type: port.type,
        binding: bindingLabel(port.ip),
        containerId: container.id,
        containerName: container.name,
        projectName: container.projectName,
        projectKey: container.projectKey,
        image: container.image,
        running: container.state === 'running',
        conflict: false,
      });
    }
  }

  // Choque = mismo puerto y mismo protocolo declarados por contenedores
  // distintos. Se compara por contenedor y no por fila porque un contenedor
  // puede publicar el mismo puerto en dos interfaces y eso no es un choque.
  const porPuerto = new Map<string, Set<string>>();
  for (const row of rows) {
    const clave = `${row.publicPort}/${row.type}`;
    const existentes = porPuerto.get(clave) ?? new Set<string>();
    existentes.add(row.containerId);
    porPuerto.set(clave, existentes);
  }
  for (const row of rows) {
    row.conflict = (porPuerto.get(`${row.publicPort}/${row.type}`)?.size ?? 0) > 1;
  }

  // Por numero de puerto: la pregunta que trae aqui a alguien casi siempre es
  // "quien tiene el 8080", no "que hace el contenedor tal".
  rows.sort((a, b) => a.publicPort - b.publicPort || a.containerName.localeCompare(b.containerName));

  const ocupadosAhora = new Set<string>();
  const reservados = new Set<string>();
  for (const row of rows) {
    const clave = `${row.publicPort}/${row.type}`;
    if (row.running) ocupadosAhora.add(clave);
    else reservados.add(clave);
  }
  // Un puerto que ya cuenta como ocupado no se cuenta ademas como reservado.
  for (const clave of ocupadosAhora) reservados.delete(clave);

  return {
    rows,
    occupiedNow: ocupadosAhora.size,
    reserved: reservados.size,
    conflicts: [...porPuerto.values()].filter((ids) => ids.size > 1).length,
  };
}

/**
 * La tabla en CSV.
 *
 * Separador `;` y BOM al principio, que es lo que hace falta para que Excel en
 * español lo abra con las columnas separadas y los acentos bien. Con comas, un
 * Excel configurado en español mete toda la fila en una sola celda, porque para
 * el la coma es el separador decimal.
 */
export function portsToCsv(rows: PortRow[]): string {
  const cabeceras = ['Puerto', 'Protocolo', 'Interfaz', 'Contenedor', 'Proyecto', 'Imagen', 'Estado', 'Puerto interno'];

  const escapar = (valor: string): string =>
    /[;"\n]/.test(valor) ? `"${valor.replaceAll('"', '""')}"` : valor;

  const lineas = [
    cabeceras.join(';'),
    ...rows.map((row) =>
      [
        String(row.publicPort),
        row.type,
        row.binding,
        row.containerName,
        row.projectName ?? '',
        row.image,
        row.running ? 'En ejecucion' : 'Parado',
        String(row.privatePort),
      ]
        .map(escapar)
        .join(';'),
    ),
  ];

  // El BOM es lo que evita que los acentos salgan rotos en Excel.
  return `﻿${lineas.join('\r\n')}\r\n`;
}
