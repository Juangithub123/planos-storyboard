/**
 * Relleno por inundación (scanline) sobre una imagen RGBA de referencia.
 * Devuelve una máscara (1 = rellenar) y su rectángulo, o null si el punto está fuera.
 *
 * La comparación usa colores premultiplicados por alfa, así los píxeles transparentes
 * (con cualquier RGB) se consideran iguales entre sí.
 */
export interface FillResult {
  mask: Uint8Array;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function floodFill(
  data: Uint8ClampedArray, W: number, H: number, sx: number, sy: number, tolerance: number, grow: number,
): FillResult | null {
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  const tol = Math.max(0, Math.min(255, tolerance));
  const i0 = (sy * W + sx) * 4;
  const a0 = data[i0 + 3];
  const r0 = (data[i0] * a0) / 255;
  const g0 = (data[i0 + 1] * a0) / 255;
  const b0 = (data[i0 + 2] * a0) / 255;
  const match = (p: number) => {
    const i = p * 4;
    const a = data[i + 3];
    if (Math.abs(a - a0) > tol) return false;
    return (
      Math.abs((data[i] * a) / 255 - r0) <= tol &&
      Math.abs((data[i + 1] * a) / 255 - g0) <= tol &&
      Math.abs((data[i + 2] * a) / 255 - b0) <= tol
    );
  };

  const mask = new Uint8Array(W * H);
  let minX = sx, maxX = sx, minY = sy, maxY = sy;
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    let p = y * W + x;
    if (mask[p] || !match(p)) continue;
    // ir al inicio del tramo
    while (x > 0 && !mask[p - 1] && match(p - 1)) {
      x--;
      p--;
    }
    let upOpen = false;
    let downOpen = false;
    while (x < W && !mask[p] && match(p)) {
      mask[p] = 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (y > 0) {
        const q = p - W;
        const ok = !mask[q] && match(q);
        if (ok && !upOpen) stack.push(x, y - 1);
        upOpen = ok;
      }
      if (y < H - 1) {
        const q = p + W;
        const ok = !mask[q] && match(q);
        if (ok && !downOpen) stack.push(x, y + 1);
        downOpen = ok;
      }
      x++;
      p++;
    }
  }

  // expandir la máscara para tapar el antialias de la línea
  for (let g = 0; g < grow; g++) {
    const x0 = Math.max(0, minX - 1), x1 = Math.min(W - 1, maxX + 1);
    const y0 = Math.max(0, minY - 1), y1 = Math.min(H - 1, maxY + 1);
    const add: number[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = y * W + x;
        if (mask[p]) continue;
        if ((x > 0 && mask[p - 1]) || (x < W - 1 && mask[p + 1]) || (y > 0 && mask[p - W]) || (y < H - 1 && mask[p + W])) add.push(p);
      }
    }
    for (const p of add) mask[p] = 1;
    minX = x0; maxX = x1; minY = y0; maxY = y1;
  }
  return { mask, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
