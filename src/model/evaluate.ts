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

// ---------------------------------------------------------------------------
// Grupos

import type { Group } from './types';

export function groupOf(clip: Clip, L: Layer): Group | null {
  if (!L.groupId) return null;
  return clip.groups?.find((g) => g.id === L.groupId) ?? null;
}

/** Visible de verdad: la capa y su grupo. */
export function isVisible(clip: Clip, L: Layer): boolean {
  const g = groupOf(clip, L);
  return L.visible && (!g || g.visible);
}

/** Bloqueada por sí misma, por su grupo, o por ser capa de video. */
export function isLocked(clip: Clip, L: Layer): boolean {
  const g = groupOf(clip, L);
  return L.locked || !!g?.locked || L.kind === 'video';
}

export type Row = { type: 'group'; group: Group; first: number } | { type: 'layer'; layer: Layer; index: number };

/** Filas de la timeline: encabezado de grupo antes de su primera capa; los grupos plegados ocultan sus capas. */
export function timelineRows(clip: Clip): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  clip.layers.forEach((L, i) => {
    const g = groupOf(clip, L);
    if (g && !seen.has(g.id)) {
      seen.add(g.id);
      rows.push({ type: 'group', group: g, first: i });
    }
    if (!g || !g.collapsed) rows.push({ type: 'layer', layer: L, index: i });
  });
  return rows;
}
