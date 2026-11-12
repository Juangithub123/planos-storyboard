import type { BlendMode, Clip, Id, Layer, Project } from '../model/types';
import { groupOf, isVisible, resolveAt } from '../model/evaluate';
import { instanceIndexAt } from '../model/timing';
import { peekDrawing } from './drawings';
import { containRect, videoFrame } from './videos';

export const blendOp: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  add: 'lighter',
};

/**
 * Reemplaza el contenido de una capa al componer: lo usan el trazo en curso, las formas,
 * el lazo flotante, etc. `draw` pinta en coordenadas del proyecto (sin opacidad/fusión de capa).
 */
export interface LayerOverride {
  layerId: Id;
  draw: (ctx: CanvasRenderingContext2D) => void;
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

// buffers reutilizables
const pool = new Map<string, HTMLCanvasElement>();
export function buffer(name: string, w: number, h: number): HTMLCanvasElement {
  let c = pool.get(name);
  if (!c) {
    c = document.createElement('canvas');
    pool.set(name, c);
  }
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const x = c.getContext('2d')!;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'source-over';
  x.globalAlpha = 1;
  x.clearRect(0, 0, w, h);
  return c;
}

function drawTinted(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, color: string, alpha: number) {
  const s = buffer('tint', src.width, src.height);
  const sc = s.getContext('2d')!;
  sc.drawImage(src, 0, 0);
  sc.globalCompositeOperation = 'source-in';
  sc.fillStyle = color;
  sc.fillRect(0, 0, s.width, s.height);
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(s, 0, 0);
}

function drawOnion(ctx: CanvasRenderingContext2D, L: Layer, frame: number, onion: OnionOpts) {
  // posición en la línea de tiempo (sin behaviors): fuera de la capa usamos un índice virtual,
  // así en un frame vacío después del final se ven los dibujos anteriores
  let base = instanceIndexAt(L, frame);
  if (base < 0) base = frame < L.start ? -1 : L.instances.length;
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

/** Pinta el contenido propio de una capa (sin opacidad ni fusión). */
function drawLayerContent(ctx: CanvasRenderingContext2D, p: Project | null, L: Layer, frame: number, w: number, h: number) {
  if (L.kind === 'video') {
    if (!L.assetId || !p) return;
    const rel = frame - L.start;
    const total = L.instances[0]?.duration ?? 0;
    if (rel < 0 || rel >= total) return;
    const v = videoFrame(L.assetId, (rel + (L.srcIn ?? 0)) / p.fps);
    if (!v || !v.width) return;
    const r = containRect(v.width, v.height, w, h);
    ctx.drawImage(v, r.x, r.y, r.w, r.h);
    return;
  }
  const r = resolveAt(L, frame);
  if (r?.drawingId) {
    const src = peekDrawing(r.drawingId);
    if (src) ctx.drawImage(src, 0, 0);
  }
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
  override: LayerOverride | null = null,
  onion: OnionOpts | null = null,
  p: Project | null = null,
) {
  const layers = clip.layers;
  let li = layers.length - 1;
  while (li >= 0) {
    const L = layers[li];
    const g = groupOf(clip, L);
    if (g) {
      // componer el grupo entero (sus capas son contiguas) en un buffer y aplicarle su opacidad
      let first = li;
      while (first - 1 >= 0 && layers[first - 1].groupId === g.id) first--;
      if (g.visible && g.opacity > 0) {
        const gb = buffer('group-' + g.id, w, h);
        const gctx = gb.getContext('2d')!;
        for (let k = li; k >= first; k--) drawLayer(gctx, clip, layers[k], frame, w, h, override, onion, p);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = g.opacity;
        ctx.drawImage(gb, 0, 0);
      }
      li = first - 1;
      continue;
    }
    drawLayer(ctx, clip, L, frame, w, h, override, onion, p);
    li--;
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function drawLayer(
  ctx: CanvasRenderingContext2D, clip: Clip, L: Layer, frame: number, w: number, h: number,
  override: LayerOverride | null, onion: OnionOpts | null, p: Project | null,
) {
  if (!isVisible(clip, L)) return;
  if (onion && L.kind === 'paint' && (onion.layerId === null || onion.layerId === L.id) && L.instances.length) {
    drawOnion(ctx, L, frame, onion);
  }
  const op = blendOp[L.blend];
  if (override && override.layerId === L.id) {
    const s = buffer('override', w, h);
    override.draw(s.getContext('2d')!);
    ctx.globalCompositeOperation = op;
    ctx.globalAlpha = L.opacity;
    ctx.drawImage(s, 0, 0);
    return;
  }
  if (op === 'source-over' && L.opacity >= 1) {
    ctx.globalCompositeOperation = op;
    ctx.globalAlpha = 1;
    drawLayerContent(ctx, p, L, frame, w, h);
    return;
  }
  // opacidad/fusión: pasar por un buffer (necesario para el video, que se dibuja escalado)
  const s = buffer('layer', w, h);
  drawLayerContent(s.getContext('2d')!, p, L, frame, w, h);
  ctx.globalCompositeOperation = op;
  ctx.globalAlpha = L.opacity;
  ctx.drawImage(s, 0, 0);
}
