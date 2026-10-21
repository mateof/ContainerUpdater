import { describe, expect, it } from 'vitest';
import { explainDockerError, launchLogLines, releasedImages } from './updater.js';

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

describe('launchLogLines', () => {
  it('no anuncia lo que se va a descartar', () => {
    // El fallo que arreglo: el log listaba las variables tal como llegaron, asi
    // que decia haber puesto un PATH que `validateEnv` nunca dejo pasar. Quien
    // leyera el registro se creeria que el arranque corrio con ese PATH.
    const lines = launchLogLines({
      profiles: ['debug', '--project-directory'],
      env: { TAG: '3.20', PATH: '/usr/malo', '1MALA': 'x' },
    });

    expect(lines).toContain('Perfiles activados: debug');
    expect(lines).toContain('Variables de esta ejecucion: TAG');
    expect(lines).toContain('Variable ignorada por estar reservada: PATH');
    expect(lines).toContain('Variable ignorada por tener un nombre no valido: 1MALA');
    // Y en ninguna linea aparece el perfil descartado.
    expect(lines.join('\n')).not.toContain('--project-directory');
  });

  it('nunca escribe el valor de una variable', () => {
    // El log se guarda en la base y se ensena en la web: si alguien pasa una
    // contrasena por aqui, no puede acabar en pantalla.
    const lines = launchLogLines({ env: { DB_PASSWORD: 'secreto-de-verdad' } });

    expect(lines.join('\n')).toContain('DB_PASSWORD');
    expect(lines.join('\n')).not.toContain('secreto-de-verdad');
  });

  it('no dice nada cuando no hay opciones', () => {
    expect(launchLogLines(undefined)).toEqual([]);
    expect(launchLogLines({ profiles: [], env: {} })).toEqual([]);
  });
});

describe('releasedImages', () => {
  const NGINX_OLD = { imageId: 'sha256:old', imageRef: 'registry-1.docker.io/library/nginx:alpine' };
  const REDIS = { imageId: 'sha256:redis', imageRef: 'registry-1.docker.io/library/redis:7' };

  it('devuelve la imagen que ningun contenedor usa tras actualizar', () => {
    expect(releasedImages([NGINX_OLD, REDIS], new Set(['sha256:new', 'sha256:redis']))).toEqual([
      NGINX_OLD,
    ]);
  });

  it('conserva la imagen vieja si otro contenedor la sigue usando', () => {
    expect(releasedImages([NGINX_OLD], new Set(['sha256:new', 'sha256:old']))).toEqual([]);
  });

  it('no devuelve nada si compose no ha cambiado ninguna imagen', () => {
    expect(releasedImages([NGINX_OLD, REDIS], new Set(['sha256:old', 'sha256:redis']))).toEqual([]);
  });

  it('propone borrar una sola vez la imagen que compartian varios servicios', () => {
    const replica = { ...NGINX_OLD };
    expect(releasedImages([NGINX_OLD, replica], new Set())).toEqual([NGINX_OLD]);
  });

  it('ignora contenedores sin id de imagen', () => {
    expect(releasedImages([{ imageId: '', imageRef: null }], new Set())).toEqual([]);
  });
});
