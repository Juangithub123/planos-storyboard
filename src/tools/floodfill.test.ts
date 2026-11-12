import { describe, expect, it } from 'vitest';
import { floodFill } from './floodfill';

/** imagen W×H transparente con un cuadrado negro de borde (x0..x1, y0..y1) */
function boxImage(W: number, H: number, x0: number, y0: number, x1: number, y1: number) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if (x === x0 || x === x1 || y === y0 || y === y1) d[(y * W + x) * 4 + 3] = 255;
  return d;
}
const count = (m: Uint8Array) => m.reduce((s, v) => s + v, 0);

describe('floodFill', () => {
  it('rellena el interior de una figura cerrada', () => {
    const d = boxImage(20, 20, 5, 5, 14, 14);
    const r = floodFill(d, 20, 20, 10, 10, 10, 0)!;
    expect(count(r.mask)).toBe(8 * 8);
    expect([r.x, r.y, r.w, r.h]).toEqual([6, 6, 8, 8]);
  });
  it('grow expande sobre el borde', () => {
    const d = boxImage(20, 20, 5, 5, 14, 14);
    const r = floodFill(d, 20, 20, 10, 10, 10, 1)!;
    expect(count(r.mask)).toBe(10 * 10 - 4); // + borde sin esquinas
  });
  it('fuera de la figura rellena el resto', () => {
    const d = boxImage(20, 20, 5, 5, 14, 14);
    const r = floodFill(d, 20, 20, 0, 0, 10, 0)!;
    expect(count(r.mask)).toBe(400 - 100);
  });
  it('transparentes con RGB distinto cuentan como iguales', () => {
    const d = new Uint8ClampedArray(4 * 4 * 4);
    d[0] = 255; // rojo con alfa 0
    const r = floodFill(d, 4, 4, 2, 2, 0, 0)!;
    expect(count(r.mask)).toBe(16);
  });
  it('punto fuera devuelve null', () => {
    expect(floodFill(new Uint8ClampedArray(16), 2, 2, 5, 5, 0, 0)).toBeNull();
  });
});
