/**
 * Pregenera los .br y .gz de los assets tras el build.
 *
 * El servidor los sirve con `preCompressed`, asi que la compresion se paga una
 * vez en el build en lugar de en cada peticion. En un NAS eso importa: comprimir
 * 200 KB de JavaScript en cada carga con una CPU modesta se nota.
 *
 * Se hace con `node:zlib`, sin plugin de Vite: son treinta lineas y evita otra
 * dependencia de build.
 */
import { brotliCompress, gzip, constants } from 'node:zlib';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.svg', '.json', '.map']);
/** Por debajo de 1 KB la compresion no compensa el viaje extra de metadatos. */
const MIN_SIZE = 1024;

const distDir = join(dirname(fileURLToPath(import.meta.url)), 'dist');

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let count = 0;
let saved = 0;

for await (const file of walk(distDir)) {
  if (!COMPRESSIBLE.has(extname(file))) continue;
  if (file.endsWith('.br') || file.endsWith('.gz')) continue;

  const { size } = await stat(file);
  if (size < MIN_SIZE) continue;

  const source = await readFile(file);

  const [brotli, gzipped] = await Promise.all([
    brotliAsync(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: size,
      },
    }),
    gzipAsync(source, { level: 9 }),
  ]);

  await Promise.all([
    writeFile(`${file}.br`, brotli),
    writeFile(`${file}.gz`, gzipped),
  ]);

  count += 1;
  saved += size - brotli.length;
}

console.log(`comprimidos ${count} ficheros, ${(saved / 1024).toFixed(0)} KB ahorrados con brotli`);
