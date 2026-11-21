import { describe, expect, it } from 'vitest';
import { evaluateAlerts, type ActiveAlert, type AlertInput } from './alerts.js';

const THRESHOLD = 2_000_000;

function disk(rateBps: number | null, name = 'sata3'): AlertInput {
  return { kind: 'disk', name, rateBps, thresholdBps: THRESHOLD };
}

function run(inputs: AlertInput[], active: Map<string, ActiveAlert>, now = 1000) {
  return evaluateAlerts(inputs, active, now);
}

describe('evaluateAlerts', () => {
  it('avisa una vez cuando el ritmo sostenido pasa del umbral', () => {
    const first = run([disk(2_500_000)], new Map());
    expect(first.transitions).toMatchObject([{ type: 'over', name: 'sata3', rateBps: 2_500_000 }]);
    expect(first.next.get('disk:sata3')?.alertedAt).toBe(1000);
  });

  it('no repite el aviso mientras el ritmo siga por encima', () => {
    const first = run([disk(2_500_000)], new Map());
    const second = run([disk(3_000_000)], first.next, 2000);
    expect(second.transitions).toEqual([]);
    expect(second.next.get('disk:sata3')?.alertedAt).toBe(1000);
  });

  it('no se recupera entre el noventa por ciento y el umbral, para no alternar', () => {
    const first = run([disk(2_500_000)], new Map());
    const hovering = run([disk(1_900_000)], first.next, 2000);
    expect(hovering.transitions).toEqual([]);
    expect(hovering.next.has('disk:sata3')).toBe(true);
  });

  it('se recupera al bajar del noventa por ciento y dice desde cuando estaba por encima', () => {
    const first = run([disk(2_500_000)], new Map());
    const recovered = run([disk(1_000_000)], first.next, 5000);
    expect(recovered.transitions).toMatchObject([{ type: 'recovered', since: 1000, rateBps: 1_000_000 }]);
    expect(recovered.next.size).toBe(0);
  });

  it('no toca el estado mientras no haya datos suficientes para juzgar', () => {
    const first = run([disk(2_500_000)], new Map());
    const unknown = run([disk(null)], first.next, 2000);
    expect(unknown.transitions).toEqual([]);
    expect(unknown.next.has('disk:sata3')).toBe(true);
    expect(run([disk(null)], new Map()).transitions).toEqual([]);
  });

  it('descarta en silencio un aviso cuyo sujeto ya no se evalua', () => {
    const first = run([disk(2_500_000)], new Map());
    const gone = run([], first.next, 2000);
    expect(gone.transitions).toEqual([]);
    expect(gone.next.size).toBe(0);
  });

  it('sigue discos y contenedores por separado', () => {
    const result = run(
      [disk(2_500_000), { kind: 'container', name: 'emby', rateBps: 3_000_000, thresholdBps: THRESHOLD }],
      new Map(),
    );
    expect(result.transitions.map((t) => `${t.kind}:${t.name}`)).toEqual(['disk:sata3', 'container:emby']);
  });
});
