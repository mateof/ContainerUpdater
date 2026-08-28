import { describe, expect, it } from 'vitest';
import { isValidProfile, launchArgs, validateEnv } from './launch.js';

describe('variables de entorno del arranque', () => {
  it('acepta nombres normales', () => {
    const { accepted, issues } = validateEnv({ TAG: 'v2', DB_HOST: 'db', _x1: 'a' });
    expect(accepted).toEqual({ TAG: 'v2', DB_HOST: 'db', _x1: 'a' });
    expect(issues).toEqual([]);
  });

  it('rechaza nombres que no son validos como variable', () => {
    // Van al entorno de un proceso: un nombre con `=` o espacios produce cosas
    // muy dificiles de diagnosticar.
    const { accepted, issues } = validateEnv({ 'MI VAR': 'a', '1TAG': 'b', 'A=B': 'c' });
    expect(accepted).toEqual({});
    expect(issues.map((i) => i.reason)).toEqual(['invalid-name', 'invalid-name', 'invalid-name']);
  });

  it('rechaza las que cambiarian que se ejecuta o contra que daemon', () => {
    // Nadie escribe PATH en un formulario queriendo decir "una variable para mi
    // contenedor". Si llega, es un error o algo peor.
    const { accepted, issues } = validateEnv({
      PATH: '/malo',
      DOCKER_HOST: 'tcp://otro:2375',
      COMPOSE_FILE: '/otro.yml',
      LD_PRELOAD: '/x.so',
      TAG: 'v1',
    });
    expect(accepted).toEqual({ TAG: 'v1' });
    expect(issues.map((i) => i.key).sort()).toEqual([
      'COMPOSE_FILE', 'DOCKER_HOST', 'LD_PRELOAD', 'PATH',
    ]);
    expect(issues.every((i) => i.reason === 'reserved')).toBe(true);
  });

  it('las reservadas se detectan en cualquier caja', () => {
    expect(validateEnv({ path: '/malo' }).issues[0]?.reason).toBe('reserved');
  });

  it('un valor vacio es legitimo, un nombre vacio se ignora', () => {
    const { accepted } = validateEnv({ VACIA: '', '   ': 'x' });
    expect(accepted).toEqual({ VACIA: '' });
  });
});

describe('perfiles', () => {
  it('acepta los que usa Compose', () => {
    for (const p of ['debug', 'dev-tools', 'obs.1', 'a_b']) {
      expect(isValidProfile(p), p).toBe(true);
    }
  });

  it('rechaza los que se leerian como una opcion mas', () => {
    // Van como argumento: uno que empiece por guion se comeria el siguiente.
    for (const p of ['-rf', '--project-directory', '', 'con espacio']) {
      expect(isValidProfile(p), JSON.stringify(p)).toBe(false);
    }
  });
});

describe('argumentos que se generan', () => {
  it('los perfiles van ANTES del subcomando', () => {
    // `compose --profile x up`, no `compose up --profile x`. Es donde los espera
    // Compose y es el error facil de cometer, porque el resto va detras.
    const { before, after } = launchArgs({ profiles: ['debug', 'dev'] });
    expect(before).toEqual(['--profile', 'debug', '--profile', 'dev']);
    expect(after).toEqual([]);
  });

  it('un perfil invalido no llega a la linea de ordenes', () => {
    expect(launchArgs({ profiles: ['--project-directory', 'ok'] }).before).toEqual([
      '--profile',
      'ok',
    ]);
  });

  it('los interruptores van despues, y solo los marcados', () => {
    expect(launchArgs({ build: true, wait: true }).after).toEqual(['--build', '--wait']);
    expect(launchArgs({}).after).toEqual([]);
  });
});
