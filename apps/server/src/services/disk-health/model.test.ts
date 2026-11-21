import { describe, expect, it } from 'vitest';
import type { StoredRule, TuningRule } from '@cu/shared';
import {
  applyRuleToBody,
  effectiveRule,
  fromDockerHealthcheck,
  healthcheckSource,
  imageKeyOf,
  loggingWarning,
  probesPerMinute,
  ruleDifferences,
} from './model.js';

const EVERY_MINUTE = { test: ['CMD-SHELL', 'true'], intervalSeconds: 60, timeoutSeconds: null, retries: null, startPeriodSeconds: null };

function rule(overrides: Partial<StoredRule>): StoredRule {
  return { scope: 'image', key: 'k', healthcheck: null, logging: null, updatedAt: 0, ...overrides };
}

describe('fromDockerHealthcheck', () => {
  it('pasa los nanosegundos de Docker a segundos', () => {
    expect(fromDockerHealthcheck({ Test: ['CMD', 'x'], Interval: 30e9, Retries: 3 })).toEqual({
      test: ['CMD', 'x'],
      intervalSeconds: 30,
      timeoutSeconds: null,
      retries: 3,
      startPeriodSeconds: null,
    });
  });

  it('reconoce el NONE como desactivado', () => {
    expect(fromDockerHealthcheck({ Test: ['NONE'] })).toBe('disabled');
  });
});

describe('probesPerMinute', () => {
  it('usa los 30 s por defecto de Docker cuando no hay intervalo', () => {
    expect(probesPerMinute({ ...EVERY_MINUTE, intervalSeconds: null })).toBe(2);
    expect(probesPerMinute(EVERY_MINUTE)).toBe(1);
  });

  it('no cuenta sondeos de un healthcheck desactivado o ausente', () => {
    expect(probesPerMinute('disabled')).toBeNull();
    expect(probesPerMinute(null)).toBeNull();
  });
});

describe('healthcheckSource', () => {
  it('distingue el healthcheck del compose del heredado de la imagen', () => {
    expect(healthcheckSource({ effective: EVERY_MINUTE, image: EVERY_MINUTE, compose: null })).toBe('image');
    expect(healthcheckSource({ effective: EVERY_MINUTE, image: null, compose: EVERY_MINUTE })).toBe('compose');
  });

  it('en un contenedor suelto, un healthcheck distinto del de la imagen lo puso quien lo creo', () => {
    expect(
      healthcheckSource({ effective: EVERY_MINUTE, image: { ...EVERY_MINUTE, intervalSeconds: 30 }, compose: undefined }),
    ).toBe('container');
  });

  it('separa desactivado de no tener ninguno', () => {
    expect(healthcheckSource({ effective: 'disabled', image: EVERY_MINUTE, compose: 'disabled' })).toBe('disabled');
    expect(healthcheckSource({ effective: null, image: null, compose: null })).toBe('none');
  });
});

describe('imageKeyOf', () => {
  it('quita la etiqueta para que la regla valga para todas las versiones', () => {
    expect(imageKeyOf('registry-1.docker.io/library/postgres:16')).toBe(imageKeyOf('postgres:17'));
  });
});

describe('effectiveRule', () => {
  it('da prioridad a la regla del contenedor sobre la de su imagen', () => {
    const rules = [rule({ scope: 'image', key: 'img' }), rule({ scope: 'container', key: 'emby' })];
    expect(effectiveRule(rules, 'emby', 'img')?.scope).toBe('container');
    expect(effectiveRule(rules, 'otro', 'img')?.scope).toBe('image');
    expect(effectiveRule(rules, 'otro', 'nada')).toBeNull();
  });
});

describe('ruleDifferences', () => {
  const fiveMinutes: TuningRule = {
    healthcheck: { mode: 'set', command: null, intervalSeconds: 300, timeoutSeconds: null, retries: null, startPeriodSeconds: null },
    logging: { driver: 'json-file', options: { 'max-size': '15m', 'max-file': '3' } },
  };

  it('dice que parte no se cumple todavia', () => {
    expect(ruleDifferences(fiveMinutes, EVERY_MINUTE, { driver: 'json-file', options: { 'max-size': '15m', 'max-file': '3' } })).toEqual([
      'healthcheck',
    ]);
    expect(ruleDifferences(fiveMinutes, { ...EVERY_MINUTE, intervalSeconds: 300 }, { driver: 'db', options: {} })).toEqual([
      'logging',
    ]);
  });

  it('da por cumplido el desactivar si no hay healthcheck', () => {
    expect(ruleDifferences({ healthcheck: { mode: 'disable' }, logging: null }, null, null)).toEqual([]);
  });
});

describe('loggingWarning', () => {
  it('avisa del json-file sin rotar y del driver db de Synology', () => {
    expect(loggingWarning('json-file', {})).toBe('no-rotation');
    expect(loggingWarning('db', {})).toBe('db-driver');
    expect(loggingWarning('json-file', { 'max-size': '15m' })).toBeNull();
    expect(loggingWarning('local', {})).toBeNull();
  });
});

describe('applyRuleToBody', () => {
  it('cambia el intervalo conservando el test que ya tenia el contenedor', () => {
    const body = applyRuleToBody(
      { Image: 'x', HostConfig: {} },
      { healthcheck: { mode: 'set', command: null, intervalSeconds: 300, timeoutSeconds: null, retries: null, startPeriodSeconds: null }, logging: null },
      { Test: ['CMD', 'ping'], Interval: 10e9, Retries: 3 },
    );
    expect(body.Healthcheck).toEqual({ Test: ['CMD', 'ping'], Interval: 300e9, Timeout: undefined, Retries: 3, StartPeriod: undefined });
  });

  it('pone el logging rotado en el HostConfig', () => {
    const body = applyRuleToBody(
      { Image: 'x', HostConfig: { RestartPolicy: { Name: 'always' } } },
      { healthcheck: null, logging: { driver: 'json-file', options: { 'max-size': '15m' } } },
      null,
    );
    expect(body.HostConfig).toEqual({ RestartPolicy: { Name: 'always' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '15m' } } });
  });
});
