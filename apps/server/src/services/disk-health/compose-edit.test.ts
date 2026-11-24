import { describe, expect, it } from 'vitest';
import type { TuningRule } from '@cu/shared';
import { applyRuleToService, ComposeEditError, detectStyle, parseComposeDuration, readDeclaredService } from './compose-edit.js';

const COMPOSE = `# Proyecto multimedia
services:
  emby:
    image: emby/embyserver:latest # la buena
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8096"]
      interval: 10s
      retries: 3
    volumes:
      - ./config:/config

  mongo:
    image: mongo:7
    ports:
      - "27017:27017"
`;

const EVERY_5_MIN: TuningRule = {
  healthcheck: { mode: 'set', command: null, intervalSeconds: 300, timeoutSeconds: null, retries: null, startPeriodSeconds: null },
  logging: null,
};

const IMAGE_HC = { test: ['CMD', 'true'], intervalSeconds: 30, timeoutSeconds: null, retries: null, startPeriodSeconds: null };

const ROTATED: TuningRule = {
  healthcheck: null,
  logging: { driver: 'json-file', options: { 'max-size': '15m', 'max-file': '3' } },
};

function lines(text: string): string[] {
  return text.split('\n');
}

describe('parseComposeDuration', () => {
  it('entiende las duraciones de Compose, incluidas las compuestas', () => {
    expect(parseComposeDuration('30s')).toBe(30);
    expect(parseComposeDuration('1m30s')).toBe(90);
    expect(parseComposeDuration('2h')).toBe(7200);
    expect(parseComposeDuration('500ms')).toBe(0.5);
  });

  it('no se inventa un valor con texto que no es una duracion', () => {
    expect(parseComposeDuration('5 minutos')).toBeNull();
    expect(parseComposeDuration('${INTERVAL}')).toBeNull();
  });
});

describe('readDeclaredService', () => {
  it('lee el healthcheck y el logging que declara un servicio', () => {
    expect(readDeclaredService(COMPOSE, 'emby').healthcheck).toEqual({
      test: ['CMD', 'curl', '-f', 'http://localhost:8096'],
      intervalSeconds: 10,
      timeoutSeconds: null,
      retries: 3,
      startPeriodSeconds: null,
    });
    expect(readDeclaredService(COMPOSE, 'mongo')).toEqual({ healthcheck: null, logging: null });
  });

  it('reconoce las dos formas de desactivar el healthcheck', () => {
    const disabled = 'services:\n  a:\n    image: x\n    healthcheck:\n      disable: true\n  b:\n    image: y\n    healthcheck:\n      test: ["NONE"]\n';
    expect(readDeclaredService(disabled, 'a').healthcheck).toBe('disabled');
    expect(readDeclaredService(disabled, 'b').healthcheck).toBe('disabled');
  });

  it('trata un test en forma de texto como CMD-SHELL', () => {
    const text = 'services:\n  a:\n    image: x\n    healthcheck:\n      test: curl -f localhost\n';
    expect(readDeclaredService(text, 'a').healthcheck).toMatchObject({ test: ['CMD-SHELL', 'curl -f localhost'] });
  });
});

describe('applyRuleToService', () => {
  it('cambia solo el intervalo y conserva el test, los comentarios y el resto del fichero', () => {
    const { text, changed } = applyRuleToService(COMPOSE, 'emby', EVERY_5_MIN, null);
    expect(changed).toBe(true);
    expect(text).toContain('# Proyecto multimedia');
    expect(text).toContain('image: emby/embyserver:latest # la buena');
    expect(text).toContain('test: ["CMD", "curl", "-f", "http://localhost:8096"]');
    expect(text).toContain('interval: 5m');
    const before = lines(COMPOSE);
    const after = lines(text);
    expect(after.filter((line) => !before.includes(line))).toEqual(['      interval: 5m']);
  });

  it('copia el test de la imagen al compose, porque Podman no combina un healthcheck parcial con el de la imagen', () => {
    const image = { test: ['CMD-SHELL', 'mongosh --quiet'], intervalSeconds: 10, timeoutSeconds: 3, retries: 5, startPeriodSeconds: null };
    const { text } = applyRuleToService(COMPOSE, 'mongo', EVERY_5_MIN, image);
    expect(readDeclaredService(text, 'mongo').healthcheck).toEqual({
      test: ['CMD-SHELL', 'mongosh --quiet'],
      intervalSeconds: 300,
      timeoutSeconds: 3,
      retries: 5,
      startPeriodSeconds: null,
    });
    expect(text).toContain('    healthcheck:\n      test: [CMD-SHELL, mongosh --quiet]\n      interval: 5m');
  });

  it('pide un comando cuando ni el compose ni la imagen tienen healthcheck', () => {
    expect(() => applyRuleToService(COMPOSE, 'mongo', EVERY_5_MIN, null)).toThrow(ComposeEditError);
  });

  it('escribe el comando propio como CMD-SHELL', () => {
    const rule: TuningRule = {
      ...EVERY_5_MIN,
      healthcheck: { ...EVERY_5_MIN.healthcheck!, command: 'mongosh --eval "db.adminCommand(\'ping\')"' } as TuningRule['healthcheck'],
    };
    const { text } = applyRuleToService(COMPOSE, 'mongo', rule, null);
    expect(readDeclaredService(text, 'mongo').healthcheck).toMatchObject({
      test: ['CMD-SHELL', 'mongosh --eval "db.adminCommand(\'ping\')"'],
    });
  });

  it('desactiva el healthcheck con disable', () => {
    const { text } = applyRuleToService(COMPOSE, 'emby', { healthcheck: { mode: 'disable' }, logging: null }, IMAGE_HC);
    expect(readDeclaredService(text, 'emby').healthcheck).toBe('disabled');
  });

  it('vuelve a activar un healthcheck desactivado quitando el disable', () => {
    const disabled = applyRuleToService(COMPOSE, 'emby', { healthcheck: { mode: 'disable' }, logging: null }, IMAGE_HC).text;
    const { text } = applyRuleToService(disabled, 'emby', EVERY_5_MIN, IMAGE_HC);
    expect(text).not.toContain('disable');
    expect(readDeclaredService(text, 'emby').healthcheck).toMatchObject({ intervalSeconds: 300 });
  });

  it('anade el logging rotado con las opciones entre comillas, como las escribe la gente', () => {
    const { text } = applyRuleToService(COMPOSE, 'mongo', ROTATED, null);
    expect(text).toContain('    logging:\n      driver: json-file\n      options:\n        max-size: "15m"\n        max-file: "3"');
    expect(readDeclaredService(text, 'mongo').logging).toEqual(ROTATED.logging);
  });

  it('no cambia nada si el servicio ya cumple la regla', () => {
    const once = applyRuleToService(COMPOSE, 'mongo', ROTATED, null).text;
    expect(applyRuleToService(once, 'mongo', ROTATED, null).changed).toBe(false);
  });

  it('respeta las listas sin sangrar si el fichero las usa asi', () => {
    const flat = 'services:\n  web:\n    image: nginx\n    ports:\n    - "80:80"\n    volumes:\n    - ./html:/usr/share/nginx/html\n';
    expect(detectStyle(flat)).toEqual({ indent: 2, indentSeq: false });
    const { text } = applyRuleToService(flat, 'web', ROTATED, null);
    expect(text.startsWith(flat.trimEnd().split('\n').slice(0, 7).join('\n'))).toBe(true);
  });

  it('respeta una sangria de cuatro espacios', () => {
    const wide = 'services:\n    web:\n        image: nginx\n';
    const { text } = applyRuleToService(wide, 'web', ROTATED, null);
    expect(text).toContain('        logging:\n            driver: json-file');
  });

  it('no toca un servicio con extends ni con claves de fusion, porque el valor real puede venir de otro sitio', () => {
    const extended = 'services:\n  a:\n    extends:\n      file: base.yml\n      service: a\n';
    expect(() => applyRuleToService(extended, 'a', ROTATED, IMAGE_HC)).toThrow(expect.objectContaining({ reason: 'extends' }));
    const merged = 'x-base: &base\n  restart: always\nservices:\n  a:\n    <<: *base\n    image: x\n';
    expect(() => applyRuleToService(merged, 'a', ROTATED, IMAGE_HC)).toThrow(expect.objectContaining({ reason: 'merge-key' }));
  });

  it('avisa de un servicio que no existe en el fichero', () => {
    expect(() => applyRuleToService(COMPOSE, 'jellyfin', ROTATED, IMAGE_HC)).toThrow(
      expect.objectContaining({ reason: 'service-not-found' }),
    );
  });

  it('no reescribe los numeros de ningun servicio, porque Compose lee 0700 en octal y 700 en decimal', () => {
    const tricky = [
      'services:',
      '  a:',
      '    image: x',
      '    user: 0100:0100',
      '    environment:',
      '      UMASK: 022',
      '      QUOTED: "022"',
      '      BIG: 12345678901234567890',
      '      HEX: 0x1F',
      '      OCT: 0o17',
      '      PLUS: +5',
      '      FLOAT: 1.10',
      '      EXP: 1E3',
      '      INF: .INF',
      '      YES: yes',
      '      UPPER: TRUE',
      '      NOTHING:',
      '      TILDE: ~',
      '      DATE: 2026-11-24',
      '      SEXAGESIMAL: 22:22',
      '      UNDERSCORE: 1_000',
      '    configs:',
      '      - source: c',
      '        mode: 0440',
      '  b:',
      '    image: y',
      '    volumes:',
      '      - type: tmpfs',
      '        target: /t',
      '        tmpfs:',
      '          mode: 0700',
      'volumes:',
      '  data:',
      '',
    ].join('\n');
    const { text } = applyRuleToService(tricky, 'a', ROTATED, null);
    const after = lines(text);
    expect(lines(tricky).filter((line) => !after.includes(line))).toEqual([]);
    expect(after.filter((line) => !lines(tricky).includes(line))).toEqual([
      '    logging:',
      '      driver: json-file',
      '      options:',
      '        max-size: "15m"',
      '        max-file: "3"',
    ]);
  });

  it('cambia unos reintentos que ya estaban sin perder su comentario', () => {
    const text = 'services:\n  a:\n    image: x\n    healthcheck:\n      test: ["CMD", "true"]\n      retries: 3 # pocos\n';
    const rule: TuningRule = {
      healthcheck: { mode: 'set', command: null, intervalSeconds: 300, timeoutSeconds: null, retries: 7, startPeriodSeconds: null },
      logging: null,
    };
    expect(applyRuleToService(text, 'a', rule, null).text).toContain('      retries: 7 # pocos');
  });

  it('se niega si el cambio se colaria en otro servicio que comparte el bloque con un ancla', () => {
    const shared = 'services:\n  a:\n    image: x\n    healthcheck: &hc\n      test: ["CMD", "true"]\n      interval: 10s\n  b:\n    image: y\n    healthcheck: *hc\n';
    expect(() => applyRuleToService(shared, 'a', EVERY_5_MIN, null)).toThrow(expect.objectContaining({ reason: 'unsafe-edit' }));
    const whole = 'services:\n  a: &a\n    image: x\n  b:\n    <<: *a\n    command: y\n';
    expect(() => applyRuleToService(whole, 'a', ROTATED, null)).toThrow(expect.objectContaining({ reason: 'unsafe-edit' }));
  });

  it('rechaza un YAML roto en vez de reescribirlo', () => {
    expect(() => applyRuleToService('services:\n  a: [\n', 'a', ROTATED, IMAGE_HC)).toThrow(
      expect.objectContaining({ reason: 'invalid-yaml' }),
    );
  });
});
