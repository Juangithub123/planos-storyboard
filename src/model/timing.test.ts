import { describe, expect, it } from 'vitest';
import type { Behavior, Layer } from './types';
import {
  addEach, fitTotal, instanceIndexAt, layerEnd, moveInstance, multiply, removeInstance,
  scaleSelection, setDuration, setEach, splitAt,
} from './timing';
import { clipLength, resolveAt, trimRange } from './evaluate';

let n = 0;
const mk = () => 'i' + n++;
function layer(id: string, durs: number[], start = 0, pre: Behavior = 'none', post: Behavior = 'none'): Layer {
  return {
    kind: 'paint', id, name: id, visible: true, locked: false, opacity: 1, blend: 'normal',
    start, pre, post,
    instances: durs.map((d, k) => ({ id: id + k, duration: d, drawingId: id + 'd' + k })),
  };
}
const durs = (l: Layer) => l.instances.map((i) => i.duration);

describe('edición básica', () => {
  it('estirar hace ripple', () => {
    const l = setDuration(layer('a', [2, 2, 4]), 0, 5);
    expect(durs(l)).toEqual([5, 2, 4]);
    expect(instanceIndexAt(l, 5)).toBe(1);
    expect(layerEnd(l)).toBe(11);
  });
  it('mínimo 1 frame', () => {
    expect(durs(setDuration(layer('a', [3]), 0, 0))).toEqual([1]);
  });
  it('split en el medio', () => {
    const r = splitAt(layer('a', [8]), 4, 'nuevo', mk);
    expect(durs(r.layer)).toEqual([4, 4]);
    expect(r.index).toBe(1);
    expect(r.layer.instances[1].drawingId).toBe('nuevo');
  });
  it('split después del final agrega hueco', () => {
    const r = splitAt(layer('a', [2]), 5, 'x', mk);
    expect(durs(r.layer)).toEqual([2, 3, 1]);
    expect(r.layer.instances[1].drawingId).toBeNull();
    expect(r.index).toBe(2);
  });
  it('split antes del inicio', () => {
    const r = splitAt(layer('a', [2], 5), 1, 'x', mk);
    expect(r.layer.start).toBe(1);
    expect(durs(r.layer)).toEqual([1, 3, 2]);
  });
  it('borrar y mover', () => {
    expect(durs(removeInstance(layer('a', [1, 2, 3]), 1))).toEqual([1, 3]);
    expect(durs(moveInstance(layer('a', [1, 2, 3]), 0, 2))).toEqual([2, 3, 1]);
  });
});

describe('selección y escalado', () => {
  it('proporcional 2-2-4 x1.5 = 3-3-6', () => {
    const [l] = scaleSelection([layer('a', [2, 2, 4])], { a: [0, 1, 2] }, 0, 1.5);
    expect(durs(l)).toEqual([3, 3, 6]);
  });
  it('proporcional sin deriva y mínimo 1', () => {
    const [l] = scaleSelection([layer('a', [1, 1, 1, 1, 1, 1])], { a: [0, 1, 2, 3, 4, 5] }, 0, 1.5);
    expect(durs(l).reduce((a, b) => a + b)).toBe(9);
    const [s] = scaleSelection([layer('a', [2, 2, 2])], { a: [0, 1, 2] }, 0, 0.1);
    expect(durs(s)).toEqual([1, 1, 1]);
  });
  it('multicapa queda sincronizada con el mismo ancla', () => {
    const a = layer('a', [4, 4]);
    const b = layer('b', [2, 2, 2, 2]);
    const [a2, b2] = scaleSelection([a, b], { a: [0, 1], b: [0, 1, 2, 3] }, 0, 2);
    expect(durs(a2)).toEqual([8, 8]);
    expect(durs(b2)).toEqual([4, 4, 4, 4]);
  });
  it('ripple de lo que sigue y la anterior absorbe el corrimiento del inicio', () => {
    const a = layer('a', [4, 2, 2, 5]);
    // selecciono 1..2 (frames 4-8), ancla en el final (8), factor 2 -> inicio pasa a 0
    const [l] = scaleSelection([a], { a: [1, 2] }, 8, 2);
    expect(durs(l)).toEqual([1, 4, 4, 5]);
  });
  it('ancla a la derecha al principio de la capa mueve start', () => {
    const [l] = scaleSelection([layer('a', [2, 2], 6)], { a: [0, 1] }, 10, 0.5);
    expect(l.start).toBe(8);
    expect(durs(l)).toEqual([1, 1]);
  });
  it('panel: setEach, addEach, multiply, fitTotal', () => {
    const L = [layer('a', [2, 3, 5])];
    const all = { a: [0, 1, 2] };
    expect(durs(setEach(L, all, 2)[0])).toEqual([2, 2, 2]);
    expect(durs(addEach(L, all, -2)[0])).toEqual([1, 1, 3]);
    expect(durs(multiply(L, all, 2)[0])).toEqual([4, 6, 10]);
    const f = fitTotal(L, all, 15)[0];
    expect(durs(f).reduce((a, b) => a + b)).toBe(15);
  });
});

describe('behaviors y clip', () => {
  it('none / hold / repeat', () => {
    const none = layer('a', [2, 3], 2);
    expect(resolveAt(none, 0)).toBeNull();
    expect(resolveAt(none, 7)).toBeNull();
    expect(resolveAt(none, 4)!.index).toBe(1);
    const hold = layer('a', [2, 3], 2, 'hold', 'hold');
    expect(resolveAt(hold, 0)!.index).toBe(0);
    expect(resolveAt(hold, 30)!.index).toBe(1);
    const rep = layer('a', [2, 3], 0, 'none', 'repeat');
    expect(resolveAt(rep, 5)!.index).toBe(0);
    expect(resolveAt(rep, 7)!.index).toBe(1);
  });
  it('largo automático y trim', () => {
    const clip = {
      id: 'c', name: 'c', layers: [layer('a', [2, 3]), layer('b', [4], 6)],
      playIn: null, playOut: null, trimIn: 2, trimOut: 50,
    };
    expect(clipLength(clip)).toBe(10);
    expect(trimRange(clip)).toEqual([2, 9]);
  });
});
