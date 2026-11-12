import { autoInstance, clip, commitStroke, frame, layer, playing, project, say, withLayer } from '../model/store';
import { isLocked, isVisible, resolveAt } from '../model/evaluate';
import { instanceIndexAt, instanceStart, splitAt } from '../model/timing';
import { uid, type Id, type Project } from '../model/types';
import { createDrawing, markDirty, peekDrawing } from '../render/drawings';

/**
 * Destino de una operación de dibujo: el dibujo de la capa actual en el cabezal.
 * Si no hay dibujo ahí (o Auto-inst pide uno nuevo) se crea, y la instancia nueva
 * se agrega al proyecto recién al confirmar (un solo paso de deshacer).
 */
export interface Target {
  layerId: Id;
  drawingId: Id;
  canvas: HTMLCanvasElement;
  /** proyecto con la instancia nueva (null si se edita un dibujo existente) */
  next: Project | null;
  before: Project;
}

export function checkLayer(): boolean {
  const c = clip.peek();
  const L = layer.peek();
  if (!c || !L) return false;
  if (L.kind === 'video') return say('En una capa de video no se puede dibujar'), false;
  if (isLocked(c, L)) return say('La capa está bloqueada'), false;
  if (!isVisible(c, L)) return say('La capa está oculta'), false;
  return true;
}

/**
 * @param mode 'draw' crea instancia si hace falta; 'existing' sólo usa un dibujo que ya se ve en el cabezal
 *             (goma, lazo), incluso si viene de un Hold/Loop.
 */
export function prepareTarget(mode: 'draw' | 'existing'): Target | null {
  const p = project.peek();
  const c = clip.peek();
  const L = layer.peek();
  if (!p || !c || !L || !checkLayer()) return null;
  if (playing.peek()) playing.value = false;
  const f = frame.peek();

  if (mode === 'existing') {
    const r = resolveAt(L, f);
    if (!r?.drawingId) return null;
    const cv = peekDrawing(r.drawingId);
    if (!cv) return say('Cargando dibujo…'), null;
    return { layerId: L.id, drawingId: r.drawingId, canvas: cv, next: null, before: p };
  }

  const idx = instanceIndexAt(L, f);
  const inst = idx >= 0 ? L.instances[idx] : null;
  const atStart = idx >= 0 && instanceStart(L, idx) === f;
  if (inst?.drawingId && (atStart || !autoInstance.peek())) {
    const cv = peekDrawing(inst.drawingId);
    if (!cv) return say('Cargando dibujo…'), null;
    return { layerId: L.id, drawingId: inst.drawingId, canvas: cv, next: null, before: p };
  }
  const drawingId = uid();
  const canvas = createDrawing(drawingId);
  let next: Project;
  if (inst && !inst.drawingId && (atStart || !autoInstance.peek())) {
    next = withLayer(p, c.id, L.id, (l) => ({
      ...l, instances: l.instances.map((it, k) => (k === idx ? { ...it, drawingId } : it)),
    }));
  } else {
    const r = splitAt(L, f, drawingId, uid);
    next = withLayer(p, c.id, L.id, () => r.layer);
  }
  return { layerId: L.id, drawingId, canvas, next, before: p };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Recorta un rectángulo al lienzo; null si queda vacío. */
export function clampRect(r: Rect, W: number, H: number): Rect | null {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const x2 = Math.min(W, Math.ceil(r.x + r.w));
  const y2 = Math.min(H, Math.ceil(r.y + r.h));
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

/**
 * Aplica una operación sobre el dibujo destino dentro de `rect`, guardando el antes/después
 * para deshacer, y agrega la instancia nueva si hacía falta.
 */
export function commitOp(t: Target, rect: Rect | null, op: (ctx: CanvasRenderingContext2D) => void) {
  const W = t.canvas.width;
  const H = t.canvas.height;
  const b = rect && clampRect(rect, W, H);
  if (!b) return false;
  const tctx = t.canvas.getContext('2d', { willReadFrequently: true })!;
  const before = tctx.getImageData(b.x, b.y, b.w, b.h);
  tctx.save();
  op(tctx);
  tctx.restore();
  tctx.globalAlpha = 1;
  tctx.globalCompositeOperation = 'source-over';
  const after = tctx.getImageData(b.x, b.y, b.w, b.h);
  commitStroke({ drawingId: t.drawingId, x: b.x, y: b.y, before, after }, t.next, t.before);
  markDirty(t.drawingId);
  return true;
}

/** Compone un buffer del tamaño del lienzo sobre el destino (pintar o borrar). */
export function commitBuffer(t: Target, buf: HTMLCanvasElement, rect: Rect | null, erase: boolean, alpha: number) {
  return commitOp(t, rect, (ctx) => {
    const b = clampRect(rect!, t.canvas.width, t.canvas.height)!;
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.drawImage(buf, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
  });
}
