import type { BlendMode, Clip, Id } from '../model/types';
import { resolveAt } from '../model/evaluate';
import { instanceIndexAt } from '../model/timing';
import { peekDrawing } from './drawings';

export const blendOp: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  add: 'lighter',
};

export interface ActiveStroke {
  layerId: Id;
  /** dibujo sobre el que se pinta (puede no estar todavía en la capa) */
  canvas: HTMLCanvasElement;
  buffer: HTMLCanvasElement;
  eraser: boolean;
  alpha: number;
}

export interface OnionOpts {
  /** null = todas las capas visibles */
  layerId: Id | null;
  before: number;
  after: number;
  opacity: number;
  colorBefore: string;
  colorAfter: string;
}

let scratch: HTMLCanvasElement | null = null;
function getScratch(w: number, h: number) {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  const s = scratch.getContext('2d')!;
  s.globalCompositeOperation = 'source-over';
  s.globalAlpha = 1;
  s.clearRect(0, 0, w, h);
  return scratch;
}

function drawTinted(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, color: string, alpha: number) {
  const s = getScratch(src.width, src.height);
  const sc = s.getContext('2d')!;
  sc.drawImage(src, 0, 0);
  sc.globalCompositeOperation = 'source-in';
  sc.fillStyle = color;
  sc.fillRect(0, 0, s.width, s.height);
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(s, 0, 0);
}

/**
 * Dibuja el frame del clip en ctx (cuya transformación ya mapea coordenadas del proyecto).
 * No dibuja el papel: eso lo hace quien llama.
 */
export function renderClipFrame(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  frame: number,
  w: number,
  h: number,
  active: ActiveStroke | null = null,
  onion: OnionOpts | null = null,
) {
  for (let li = clip.layers.length - 1; li >= 0; li--) {
    const L = clip.layers[li];
    if (!L.visible) continue;

    if (onion && (onion.layerId === null || onion.layerId === L.id) && L.instances.length) {
      // posición en la línea de tiempo (sin behaviors): fuera de la capa usamos un índice virtual,
      // así en un frame vacío después del final se ven los dibujos anteriores (donde vas a dibujar el siguiente)
      let base = instanceIndexAt(L, frame);
      if (base < 0) base = frame < L.start ? -1 : L.instances.length;
      {
        const draw = (dir: -1 | 1, n: number, color: string) => {
          let k = base;
          for (let step = 1; step <= n; step++) {
            k += dir;
            while (k >= 0 && k < L.instances.length && !L.instances[k].drawingId) k += dir;
            if (k < 0 || k >= L.instances.length) break;
            const c = peekDrawing(L.instances[k].drawingId!);
            if (c) drawTinted(ctx, c, color, onion.opacity * (1 - (step - 1) / (n + 1)));
          }
        };
        draw(-1, onion.before, onion.colorBefore);
        draw(1, onion.after, onion.colorAfter);
      }
    }

    let src: HTMLCanvasElement | null = null;
    if (active && active.layerId === L.id) src = active.canvas;
    else {
      const r = resolveAt(L, frame);
      if (r?.drawingId) src = peekDrawing(r.drawingId);
    }
    ctx.globalCompositeOperation = blendOp[L.blend];
    ctx.globalAlpha = L.opacity;

    if (active && active.layerId === L.id) {
      // componer dibujo + trazo en curso en un buffer temporal
      const s = getScratch(w, h);
      const sc = s.getContext('2d')!;
      sc.drawImage(active.canvas, 0, 0);
      sc.globalAlpha = active.alpha;
      sc.globalCompositeOperation = active.eraser ? 'destination-out' : 'source-over';
      sc.drawImage(active.buffer, 0, 0);
      ctx.drawImage(s, 0, 0);
    } else if (src) {
      ctx.drawImage(src, 0, 0);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
