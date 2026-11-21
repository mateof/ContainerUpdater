import { describe, expect, it } from 'vitest';
import { CounterTracker, counterDelta } from './counters.js';

describe('counterDelta', () => {
  it('resta mientras el contador crece', () => {
    expect(counterDelta(1000, 1500)).toBe(500);
  });

  it('cuenta desde cero cuando el contador retrocede, como tras un reinicio', () => {
    expect(counterDelta(1_000_000, 300)).toBe(300);
  });
});

describe('CounterTracker', () => {
  it('no da delta en la primera lectura de una clave', () => {
    const tracker = new CounterTracker<{ bytes: number }>();
    expect(tracker.observe('sata3', { bytes: 100 })).toBeNull();
    expect(tracker.observe('sata3', { bytes: 250 })).toEqual({ bytes: 150 });
  });

  it('puede contar desde cero un contenedor creado dentro del intervalo', () => {
    const tracker = new CounterTracker<{ bytes: number }>();
    expect(tracker.observe('new', { bytes: 4096 }, true)).toEqual({ bytes: 4096 });
  });

  it('aguanta el reinicio de un contenedor que pone a cero su blkio', () => {
    const tracker = new CounterTracker<{ bytes: number }>();
    tracker.observe('emby', { bytes: 9_000_000 });
    expect(tracker.observe('emby', { bytes: 2_000 })).toEqual({ bytes: 2_000 });
    expect(tracker.observe('emby', { bytes: 5_000 })).toEqual({ bytes: 3_000 });
  });

  it('cuenta desde cero un dispositivo que aparece despues en un contenedor conocido', () => {
    const tracker = new CounterTracker<Record<string, number>>();
    tracker.observe('c1', { 'sata3|w': 10 });
    expect(tracker.observe('c1', { 'sata3|w': 30, 'sata4|w': 7 })).toEqual({ 'sata3|w': 20, 'sata4|w': 7 });
  });

  it('deja a null un contador que el kernel no da en vez de ponerlo a cero', () => {
    const tracker = new CounterTracker<{ bytes: number; flushes: number | null }>();
    tracker.observe('sata3', { bytes: 1, flushes: null });
    expect(tracker.observe('sata3', { bytes: 2, flushes: null })).toEqual({ bytes: 1, flushes: null });
  });

  it('olvida un disco que desaparece y empieza de nuevo si vuelve', () => {
    const tracker = new CounterTracker<{ bytes: number }>();
    tracker.observe('usb1', { bytes: 100 });
    tracker.retain(new Set(['sata3']));
    expect(tracker.size).toBe(0);
    expect(tracker.observe('usb1', { bytes: 500 })).toBeNull();
  });
});
