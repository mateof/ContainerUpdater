/**
 * Build del servidor con esbuild.
 *
 * Se empaqueta en un unico fichero para que el runtime no tenga que resolver
 * el workspace `@cu/shared` (que se distribuye como TypeScript sin compilar).
 * Las dependencias nativas quedan externas: sus `.node` no se pueden inlinear y
 * deben resolverse desde node_modules en tiempo de ejecucion.
 */
import { build } from 'esbuild';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(root, 'src/index.ts'), join(root, 'src/healthcheck.ts')],
  outdir: join(root, 'dist'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false, // Los stack traces legibles valen mas que unos KB en un NAS.
  packages: 'external',
  banner: {
    // Algunas dependencias transitivas siguen usando require() en ESM.
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});

// Las migraciones son .sql y esbuild no las toca: se copian tal cual.
const migrationsSrc = join(root, 'src/db/migrations');
const migrationsDst = join(root, 'dist/migrations');
await mkdir(migrationsDst, { recursive: true });
for (const file of await readdir(migrationsSrc)) {
  if (file.endsWith('.sql')) {
    await copyFile(join(migrationsSrc, file), join(migrationsDst, file));
  }
}

console.log('build ok');
