import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger.js';
import { ComposeRunner } from './compose.js';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

describe('recreateService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'cu-recreate-')));
    await writeFile(join(dir, 'compose.yml'), 'services:\n  svc:\n    image: x\n');
    await writeFile(join(dir, 'docker'), `#!/bin/sh\necho "$@" >> "${dir}/calls"\n`, { mode: 0o755 });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('no borra el contenedor antes de crear el nuevo, porque Compose solo hereda los volumenes anonimos del que existe', async () => {
    const runner = new ComposeRunner(join(dir, 'docker'), [dir], 10_000, 'unix:///nada.sock', log);
    await runner.recreateService(
      { projectName: 'p', workingDir: dir, configFiles: [join(dir, 'compose.yml')] },
      { scope: 'service', serviceName: 'svc' },
    );
    const calls = (await readFile(join(dir, 'calls'), 'utf8')).trim().split('\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/ up --detach --force-recreate svc$/);
  });
});
