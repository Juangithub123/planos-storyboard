import type { Id, Instance, Layer } from './types';

/** Funciones puras de edición de tiempos. Nunca mutan: devuelven capas nuevas. */

export function layerTotal(layer: Layer): number {
  let t = 0;
  for (const i of layer.instances) t += i.duration;
  return t;
}

export function layerEnd(layer: Layer): number {
  return layer.start + layerTotal(layer);
}

export function instanceStart(layer: Layer, idx: number): number {
  let t = layer.start;
  for (let k = 0; k < idx; k++) t += layer.instances[k].duration;
  return t;
}

/** índice de la instancia que cubre el frame (sin behaviors), o -1 */
export function instanceIndexAt(layer: Layer, frame: number): number {
  let t = layer.start;
  if (frame < t) return -1;
  for (let k = 0; k < layer.instances.length; k++) {
    t += layer.instances[k].duration;
    if (frame < t) return k;
  }
  return -1;
}

function withInstances(layer: Layer, instances: Instance[], start = layer.start): Layer {
  return { ...layer, instances, start };
}

/** Cambia la duración de una instancia; lo que sigue se corre (ripple). */
export function setDuration(layer: Layer, idx: number, duration: number): Layer {
  const d = Math.max(1, Math.round(duration));
  const inst = layer.instances.slice();
  inst[idx] = { ...inst[idx], duration: d };
  return withInstances(layer, inst);
}

/**
 * Parte la instancia que contiene `frame` en dos. La segunda mitad empieza en `frame`
 * y recibe `newDrawingId`. Si el frame ya es inicio de instancia devuelve la misma capa.
 * Si el frame está después del final, agrega una instancia (con hueco vacío si hace falta).
 * Si está antes del inicio, agrega delante (con hueco vacío si hace falta).
 */
export function splitAt(
  layer: Layer,
  frame: number,
  newDrawingId: Id | null,
  makeId: () => Id,
): { layer: Layer; index: number } {
  const inst = layer.instances.slice();
  const end = layerEnd(layer);
  if (inst.length === 0) {
    return { layer: withInstances(layer, [{ id: makeId(), duration: 1, drawingId: newDrawingId }], frame), index: 0 };
  }
  if (frame >= end) {
    let index = inst.length;
    if (frame > end) {
      inst.push({ id: makeId(), duration: frame - end, drawingId: null });
      index++;
    }
    inst.push({ id: makeId(), duration: 1, drawingId: newDrawingId });
    return { layer: withInstances(layer, inst), index };
  }
  if (frame < layer.start) {
    const gap = layer.start - frame - 1;
    const add: Instance[] = [{ id: makeId(), duration: 1, drawingId: newDrawingId }];
    if (gap > 0) add.push({ id: makeId(), duration: gap, drawingId: null });
    return { layer: withInstances(layer, [...add, ...inst], frame), index: 0 };
  }
  const idx = instanceIndexAt(layer, frame);
  const s = instanceStart(layer, idx);
  if (s === frame) return { layer, index: idx };
  const cur = inst[idx];
  const first = frame - s;
  inst.splice(idx, 1, { ...cur, duration: first }, { id: makeId(), duration: cur.duration - first, drawingId: newDrawingId });
  return { layer: withInstances(layer, inst), index: idx + 1 };
}

export function insertInstance(layer: Layer, idx: number, instance: Instance): Layer {
  const inst = layer.instances.slice();
  inst.splice(idx, 0, instance);
  return withInstances(layer, inst);
}

/** Borra la instancia; lo que sigue se corre hacia atrás. */
export function removeInstance(layer: Layer, idx: number): Layer {
  const inst = layer.instances.slice();
  inst.splice(idx, 1);
  return withInstances(layer, inst);
}

/** Mueve una instancia a otra posición dentro de la capa. */
export function moveInstance(layer: Layer, from: number, to: number): Layer {
  const inst = layer.instances.slice();
  const [it] = inst.splice(from, 1);
  inst.splice(Math.max(0, Math.min(inst.length, to)), 0, it);
  return withInstances(layer, inst);
}

// ---------------------------------------------------------------------------
// Selección multicapa

/** layerId -> índices seleccionados */
export type Selection = Record<Id, number[]>;

interface Range {
  lo: number;
  hi: number;
  start: number;
  end: number;
}

function rangeOf(layer: Layer, idxs: number[]): Range | null {
  const valid = idxs.filter((i) => i >= 0 && i < layer.instances.length);
  if (!valid.length) return null;
  const lo = Math.min(...valid);
  const hi = Math.max(...valid);
  const start = instanceStart(layer, lo);
  let end = start;
  for (let k = lo; k <= hi; k++) end += layer.instances[k].duration;
  return { lo, hi, start, end };
}

/** Extremos de la selección en el tiempo (sobre todas las capas). */
export function selectionSpan(layers: Layer[], sel: Selection): { start: number; end: number } | null {
  let start = Infinity;
  let end = -Infinity;
  for (const l of layers) {
    const r = sel[l.id] && rangeOf(l, sel[l.id]);
    if (!r) continue;
    start = Math.min(start, r.start);
    end = Math.max(end, r.end);
  }
  return start === Infinity ? null : { start, end };
}

/**
 * Reemplaza las instancias lo..hi por las nuevas duraciones, que empiezan en newStart.
 * El desplazamiento del inicio lo absorbe la instancia anterior (o layer.start);
 * el cambio del final se propaga a lo que sigue (ripple).
 */
function applyRange(layer: Layer, r: Range, durations: number[], newStart: number): Layer {
  const inst = layer.instances.slice();
  for (let k = r.lo; k <= r.hi; k++) inst[k] = { ...inst[k], duration: durations[k - r.lo] };
  let start = layer.start;
  const dBefore = newStart - r.start;
  if (dBefore !== 0) {
    if (r.lo === 0) start = Math.max(0, start + dBefore);
    else inst[r.lo - 1] = { ...inst[r.lo - 1], duration: Math.max(1, inst[r.lo - 1].duration + dBefore) };
  }
  return withInstances(layer, inst, start);
}

/**
 * Escala la selección en el tiempo respecto a `anchor` (frame absoluto), como el
 * Alt+drag de After Effects: cada borde b pasa a anchor + round((b - anchor) * factor).
 * Todas las capas usan el mismo ancla y factor, así quedan sincronizadas.
 * Mínimo 1 frame por instancia.
 */
export function scaleSelection(layers: Layer[], sel: Selection, anchor: number, factor: number): Layer[] {
  const f = Math.max(0, factor);
  return layers.map((l) => {
    const r = sel[l.id] && rangeOf(l, sel[l.id]);
    if (!r) return l;
    const map = (b: number) => anchor + Math.round((b - anchor) * f);
    const bounds: number[] = [];
    let b = r.start;
    bounds.push(map(b));
    for (let k = r.lo; k <= r.hi; k++) {
      b += l.instances[k].duration;
      bounds.push(Math.max(bounds[bounds.length - 1] + 1, map(b)));
    }
    const durations = bounds.slice(1).map((x, i) => x - bounds[i]);
    return applyRange(l, r, durations, Math.max(0, bounds[0]));
  });
}

/** Suma `delta` frames a cada instancia seleccionada (mínimo 1). Ripple del resto. */
export function addEach(layers: Layer[], sel: Selection, delta: number): Layer[] {
  return mapSelected(layers, sel, (d) => d + delta);
}

/** Fija cada instancia seleccionada a `n` frames. */
export function setEach(layers: Layer[], sel: Selection, n: number): Layer[] {
  return mapSelected(layers, sel, () => n);
}

/** Multiplica las duraciones (escalado proporcional anclado al inicio de la selección). */
export function multiply(layers: Layer[], sel: Selection, factor: number): Layer[] {
  const span = selectionSpan(layers, sel);
  if (!span) return layers;
  return scaleSelection(layers, sel, span.start, factor);
}

/** Hace que la selección completa dure `total` frames, repartiendo proporcionalmente. */
export function fitTotal(layers: Layer[], sel: Selection, total: number): Layer[] {
  const span = selectionSpan(layers, sel);
  if (!span) return layers;
  const len = span.end - span.start;
  if (len <= 0) return layers;
  return scaleSelection(layers, sel, span.start, Math.max(1, Math.round(total)) / len);
}

function mapSelected(layers: Layer[], sel: Selection, fn: (d: number) => number): Layer[] {
  return layers.map((l) => {
    const idxs = sel[l.id];
    if (!idxs?.length) return l;
    const set = new Set(idxs);
    const inst = l.instances.map((it, k) =>
      set.has(k) ? { ...it, duration: Math.max(1, Math.round(fn(it.duration))) } : it,
    );
    return withInstances(l, inst);
  });
}

/**
 * Parte una capa en el frame `f` (para cortar un clip en dos).
 * Devuelve la parte izquierda (todo lo anterior a f) y la derecha (desde f, re-basada a 0).
 * Si una instancia cruza el corte, la parte derecha recibe `rightDrawing(drawingId)`
 * (para duplicar el dibujo y que los clips no compartan imágenes).
 */
export function splitLayerAt(
  layer: Layer,
  f: number,
  rightDrawing: (id: Id | null) => Id | null,
  makeId: () => Id,
): { left: Layer; right: Layer } {
  const left: Instance[] = [];
  const right: Instance[] = [];
  let t = layer.start;
  let rightStart = Math.max(0, layer.start - f);
  for (const it of layer.instances) {
    const a = t;
    const b = t + it.duration;
    t = b;
    if (b <= f) left.push(it);
    else if (a >= f) right.push(it);
    else {
      left.push({ ...it, duration: f - a });
      right.push({ id: makeId(), duration: b - f, drawingId: rightDrawing(it.drawingId) });
    }
  }
  if (layer.start >= f) rightStart = layer.start - f;
  return {
    left: { ...layer, instances: left, start: left.length ? layer.start : 0 },
    right: { ...layer, id: makeId(), instances: right, start: right.length ? rightStart : 0 },
  };
}

/** Inserta instancias en el frame f de la capa (partiendo si cae en medio). Ripple del resto. */
export function insertInstancesAt(layer: Layer, f: number, items: Instance[], makeId: () => Id): { layer: Layer; first: number } {
  if (!items.length) return { layer, first: -1 };
  const end = layerEnd(layer);
  let base = layer;
  let at: number;
  if (!layer.instances.length) {
    return { layer: { ...layer, start: f, instances: items.slice() }, first: 0 };
  }
  if (f >= end) {
    const inst = layer.instances.slice();
    if (f > end) inst.push({ id: makeId(), duration: f - end, drawingId: null });
    at = inst.length;
    inst.push(...items);
    return { layer: { ...layer, instances: inst }, first: at };
  }
  if (f < layer.start) {
    const gap = layer.start - f;
    const pre = [...items];
    const tot = items.reduce((s, i) => s + i.duration, 0);
    if (gap > 0) pre.push({ id: makeId(), duration: gap, drawingId: null });
    void tot;
    return { layer: { ...layer, start: f, instances: [...pre, ...layer.instances] }, first: 0 };
  }
  const idx = instanceIndexAt(layer, f);
  if (instanceStart(layer, idx) === f) at = idx;
  else {
    const cur = layer.instances[idx];
    const first = f - instanceStart(layer, idx);
    const inst = layer.instances.slice();
    inst.splice(idx, 1, { ...cur, duration: first }, { ...cur, id: makeId(), duration: cur.duration - first });
    base = { ...layer, instances: inst };
    at = idx + 1;
  }
  const inst = base.instances.slice();
  inst.splice(at, 0, ...items);
  return { layer: { ...base, instances: inst }, first: at };
}
