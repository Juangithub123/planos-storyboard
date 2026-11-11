import type { Behavior, Clip, Id, Layer } from './types';
import { layerEnd, layerTotal } from './timing';

export interface Resolved {
  index: number;
  drawingId: Id | null;
}

function locate(layer: Layer, rel: number): Resolved {
  let t = 0;
  for (let k = 0; k < layer.instances.length; k++) {
    t += layer.instances[k].duration;
    if (rel < t) return { index: k, drawingId: layer.instances[k].drawingId };
  }
  const k = layer.instances.length - 1;
  return { index: k, drawingId: layer.instances[k].drawingId };
}

function outside(layer: Layer, rel: number, total: number, b: Behavior, which: 'pre' | 'post'): Resolved | null {
  if (b === 'none') return null;
  if (b === 'hold') return which === 'pre' ? locate(layer, 0) : locate(layer, total - 1);
  const m = ((rel % total) + total) % total;
  return locate(layer, m);
}

/** Qué instancia/dibujo se ve en la capa en el frame dado (aplicando pre/post behavior). */
export function resolveAt(layer: Layer, frame: number): Resolved | null {
  const total = layerTotal(layer);
  if (total <= 0) return null;
  const rel = frame - layer.start;
  if (rel < 0) return outside(layer, rel, total, layer.pre, 'pre');
  if (rel >= total) return outside(layer, rel, total, layer.post, 'post');
  return locate(layer, rel);
}

/** Largo automático del clip: la capa que termina más tarde. */
export function clipLength(clip: Clip): number {
  let len = 1;
  for (const l of clip.layers) if (l.instances.length) len = Math.max(len, layerEnd(l));
  return len;
}

/** Rango (inclusivo) que entra al animatic/export. */
export function trimRange(clip: Clip): [number, number] {
  const len = clipLength(clip);
  const a = Math.max(0, Math.min(len - 1, clip.trimIn ?? 0));
  const b = Math.max(a, Math.min(len - 1, clip.trimOut ?? len - 1));
  return [a, b];
}

/** Rango (inclusivo) de reproducción/loop dentro del clip. */
export function playRange(clip: Clip): [number, number] {
  const len = clipLength(clip);
  const a = Math.max(0, Math.min(len - 1, clip.playIn ?? 0));
  const b = Math.max(a, Math.min(len - 1, clip.playOut ?? len - 1));
  return [a, b];
}
