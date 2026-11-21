import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiskIoRepository } from '../../db/repositories/disk-io.js';
import type { Db } from '../../db/index.js';
import { buildSeries, collectChunks } from './query.js';
import { tickToBatch, type Tick } from './model.js';

function makeRepo() {
  const db = new Database(':memory:');
  const dir = fileURLToPath(new URL('../../db/migrations', import.meta.url));
  for (const file of readdirSync(dir).sort()) {
    if (file.endsWith('.sql')) db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  return createDiskIoRepository(db as unknown as Db);
}

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const MB = 1_000_000;

function tick(at: number, diskMb: number, writers: Record<string, number>): Tick {
  const attributed = Object.values(writers).reduce((sum, value) => sum + value, 0);
  return {
    at,
    seconds: 60,
    disks: [
      {
        disk: 'sata3',
        readBytes: 0,
        writeBytes: diskMb * MB,
        readIos: 0,
        writeIos: 1000,
        flushes: null,
        attributedRead: 0,
        attributedWrite: attributed * MB,
      },
    ],
    containerDisks: Object.entries(writers).map(([container, mb]) => ({
      disk: 'sata3',
      container,
      project: container === 'mongodb' ? 'db' : 'media',
      readBytes: 0,
      writeBytes: mb * MB,
    })),
    usage: [],
  };
}

function series(chunks: ReturnType<typeof collectChunks>, view: 'disks' | 'stacked' = 'disks', extra = {}) {
  return buildSeries({
    chunks,
    range: '1h',
    op: 'write',
    view,
    disks: [],
    containers: [],
    top: 1,
    now: NOW,
    intervalSeconds: 60,
    knownContainers: [],
    ...extra,
  });
}

describe('series de escritura en disco', () => {
  it('dice que los datos salen de memoria cuando aun no hay historico', () => {
    const repo = makeRepo();
    const ring = [tick(NOW - 120_000, 60, {}), tick(NOW - 60_000, 120, {})];
    const result = series(collectChunks({ repo, ring, from: NOW - 3600_000, now: NOW }));
    expect(result.source).toBe('memory');
    expect(result.disks[0]!.values.filter((v) => v !== null)).toEqual([1 * MB, 2 * MB]);
  });

  it('mezcla los tramos guardados antes del anillo con el anillo tras un reinicio', () => {
    const repo = makeRepo();
    repo.writeBatch(tickToBatch({ ...tick(NOW - 40 * 60_000, 300, {}), seconds: 300 }));
    const ring = [tick(NOW - 60_000, 60, {})];
    const result = series(collectChunks({ repo, ring, from: NOW - 3600_000, now: NOW }));
    expect(result.source).toBe('mixed');
    expect(result.coverageFrom).toBeLessThan(NOW - 30 * 60_000);
  });

  it('suma el tramo guardado al cerrar y lo medido tras reiniciar mientras ese tramo sigue abierto', () => {
    const repo = makeRepo();
    const bucket = NOW - 5 * 60_000;
    repo.writeBatch(tickToBatch({ ...tick(bucket + 170_000, 170, {}), seconds: 170 }));
    const ring = [tick(bucket + 240_000, 60, {})];
    const chunks = collectChunks({ repo, ring, from: NOW - 3600_000, now: bucket + 250_000 });
    expect(chunks.reduce((sum, chunk) => sum + chunk.seconds, 0)).toBe(230);
  });

  it('no cuenta dos veces un tramo que ya se volvio a guardar con lo medido tras reiniciar', () => {
    const repo = makeRepo();
    const bucket = NOW - 10 * 60_000;
    repo.writeBatch(tickToBatch({ ...tick(bucket + 170_000, 170, {}), seconds: 170 }));
    const afterRestart = tick(bucket + 240_000, 60, {});
    repo.writeBatch(tickToBatch(afterRestart));
    const ring = [afterRestart, tick(bucket + 360_000, 60, {})];
    const chunks = collectChunks({ repo, ring, from: NOW - 3600_000, now: bucket + 370_000 });
    expect(chunks.reduce((sum, chunk) => sum + chunk.seconds, 0)).toBe(290);
  });

  it('apila los que mas escriben, el resto como otros y lo que no explica nadie', () => {
    const repo = makeRepo();
    const ring = [tick(NOW - 60_000, 170, { emby: 10, mongodb: 2 })];
    const result = series(collectChunks({ repo, ring, from: NOW - 3600_000, now: NOW }), 'stacked');
    const index = result.disks[0]!.values.findIndex((value) => value !== null);
    expect(result.stack?.containers.map((c) => c.name)).toEqual(['emby']);
    expect(result.stack?.containers[0]!.values[index]).toBeCloseTo((10 * MB) / 60);
    expect(result.stack?.others[index]).toBeCloseTo((2 * MB) / 60);
    expect(result.stack?.unattributed[index]).toBeCloseTo((158 * MB) / 60);
    expect(result.stack?.attributedShare).toBeCloseTo(12 / 170);
  });

  it('filtra la vista apilada por proyecto de Compose', () => {
    const repo = makeRepo();
    const ring = [tick(NOW - 60_000, 170, { emby: 10, mongodb: 2 })];
    const result = series(collectChunks({ repo, ring, from: NOW - 3600_000, now: NOW }), 'stacked', { project: 'db' });
    expect(result.stack?.containers.map((c) => c.name)).toEqual(['mongodb']);
    expect(result.projects).toEqual(['db', 'media']);
  });

  it('deja los huecos a null en vez de pintar un cero donde no se midio nada', () => {
    const repo = makeRepo();
    const result = series(collectChunks({ repo, ring: [tick(NOW - 60_000, 60, {})], from: NOW - 3600_000, now: NOW }));
    expect(result.disks[0]!.values[0]).toBeNull();
  });
});

describe('repositorio de escritura en disco', () => {
  it('fusiona un tramo escrito dos veces, como al reiniciar dentro de los mismos cinco minutos', () => {
    const repo = makeRepo();
    const first = tickToBatch(tick(NOW - 60_000, 60, { emby: 6 }));
    repo.writeBatch(first);
    repo.writeBatch(first);
    const [bucket] = repo.diskBuckets(NOW - 3600_000, NOW);
    expect(bucket).toMatchObject({ seconds: 120, writeBytes: 120 * MB, attributedWrite: 12 * MB });
    expect(repo.containerDiskBuckets(NOW - 3600_000, NOW)[0]?.writeBytes).toBe(12 * MB);
  });

  it('purga por retencion y anota cuando se introdujeron los TB escritos', () => {
    const repo = makeRepo();
    repo.writeBatch(tickToBatch(tick(NOW - 40 * 24 * 3600_000, 60, {})));
    repo.prune(30, NOW);
    expect(repo.diskBuckets(0, NOW)).toEqual([]);
    expect(repo.saveDevice('sata3', { tbwTb: 512, writtenTb: 0.7 }, NOW)).toMatchObject({ tbw_tb: 512, written_tb: 0.7, written_at: NOW });
    expect(repo.saveDevice('sata3', { tbwTb: 600 }, NOW + 1)).toMatchObject({ tbw_tb: 600, written_at: NOW });
  });
});
