import {
  clip, clipId, commit, editClip, editLayer, frame, layer, layerId, makeClip, makeLayer, playing,
  project, say, selection, withClip, withLayer,
} from './store';
import { addEach, insertInstance, instanceIndexAt, instanceStart, layerEnd, removeInstance, setDuration, splitAt } from './timing';
import { clipLength, playRange, resolveAt } from './evaluate';
import { uid, type Behavior } from './types';
import { createDrawing, loadDrawing } from '../render/drawings';

/** Acciones de alto nivel que usa la UI. */

export function setFrame(f: number) {
  const c = clip.peek();
  if (!c) return;
  frame.value = Math.max(0, Math.round(f));
}

export function stepFrame(d: number) {
  const c = clip.peek();
  if (!c) return;
  const len = clipLength(c);
  setFrame((((frame.peek() + d) % len) + len) % len);
}

export function gotoStart() {
  setFrame(0);
}
export function gotoEnd() {
  const c = clip.peek();
  if (c) setFrame(clipLength(c) - 1);
}

/** Salta al inicio de la instancia anterior/siguiente de la capa actual. */
export function stepInstance(dir: 1 | -1) {
  const L = layer.peek();
  if (!L || !L.instances.length) return;
  const f = frame.peek();
  const starts = L.instances.map((_, k) => instanceStart(L, k));
  if (dir > 0) {
    const n = starts.find((s) => s > f);
    if (n !== undefined) setFrame(n);
  } else {
    const prev = starts.filter((s) => s < f);
    if (prev.length) setFrame(prev[prev.length - 1]);
  }
}

export function togglePlay() {
  playing.value = !playing.peek();
}

// --- marks
export function markPlay(which: 'in' | 'out') {
  const f = frame.peek();
  editClip(which === 'in' ? 'mark in' : 'mark out', (c) => {
    const n = { ...c, [which === 'in' ? 'playIn' : 'playOut']: f };
    if (n.playIn !== null && n.playOut !== null && n.playIn > n.playOut) [n.playIn, n.playOut] = [n.playOut, n.playIn];
    return n;
  });
}
export function clearPlayMarks() {
  editClip('borrar marks', (c) => ({ ...c, playIn: null, playOut: null }));
}
export function markTrim(which: 'in' | 'out') {
  const f = frame.peek();
  editClip(which === 'in' ? 'recorte in' : 'recorte out', (c) => {
    const n = { ...c, [which === 'in' ? 'trimIn' : 'trimOut']: f };
    if (n.trimIn !== null && n.trimOut !== null && n.trimIn > n.trimOut) [n.trimIn, n.trimOut] = [n.trimOut, n.trimIn];
    return n;
  });
}
export function clearTrim() {
  editClip('borrar recorte', (c) => ({ ...c, trimIn: null, trimOut: null }));
}

export function currentPlayRange(): [number, number] {
  const c = clip.peek();
  return c ? playRange(c) : [0, 0];
}

// --- instancias
function selectAt(lid: string, idx: number) {
  selection.value = idx >= 0 ? { [lid]: [idx] } : {};
}

/** Índice de la instancia "objetivo": la seleccionada en la capa actual, o la del cabezal. */
export function targetIndex(): number {
  const L = layer.peek();
  if (!L) return -1;
  const sel = selection.peek()[L.id];
  if (sel?.length === 1) return sel[0];
  return instanceIndexAt(L, frame.peek());
}

export function newInstanceHere() {
  const p = project.peek();
  const L = layer.peek();
  if (!p || !L) return;
  if (L.locked) return say('La capa está bloqueada');
  const f = frame.peek();
  const idx = instanceIndexAt(L, f);
  let nl;
  let ni;
  if (idx >= 0 && instanceStart(L, idx) === f) {
    nl = insertInstance(L, idx, { id: uid(), duration: 1, drawingId: null });
    ni = idx;
  } else {
    const r = splitAt(L, f, null, uid);
    nl = r.layer;
    ni = r.index;
  }
  commit(withLayer(p, clipId.peek(), L.id, () => nl), 'nueva instancia');
  selectAt(L.id, ni);
}

export async function duplicateInstance() {
  const p = project.peek();
  const L = layer.peek();
  const idx = targetIndex();
  if (!p || !L || idx < 0) return;
  const src = L.instances[idx];
  let drawingId: string | null = null;
  if (src.drawingId) {
    const e = await loadDrawing(src.drawingId);
    drawingId = uid();
    createDrawing(drawingId, e?.canvas);
  }
  const nl = insertInstance(L, idx + 1, { id: uid(), duration: src.duration, drawingId });
  commit(withLayer(p, clipId.peek(), L.id, () => nl), 'duplicar instancia');
  selectAt(L.id, idx + 1);
  setFrame(instanceStart(nl, idx + 1));
}

export function insertEmptyAfter() {
  const p = project.peek();
  const L = layer.peek();
  if (!p || !L) return;
  const idx = targetIndex();
  const at = idx < 0 ? L.instances.length : idx + 1;
  const nl = insertInstance(L, at, { id: uid(), duration: 1, drawingId: null });
  commit(withLayer(p, clipId.peek(), L.id, () => nl), 'insertar vacía');
  selectAt(L.id, at);
  setFrame(instanceStart(nl, at));
}

export function deleteInstance() {
  const p = project.peek();
  const c = clip.peek();
  const L = layer.peek();
  if (!p || !c || !L) return;
  const sel = selection.peek();
  const has = Object.values(sel).some((a) => a.length);
  if (!has) {
    const idx = targetIndex();
    if (idx < 0 || L.locked) return;
    commit(withLayer(p, c.id, L.id, (l) => removeInstance(l, idx)), 'borrar instancia');
  } else {
    const layers = c.layers.map((l) => {
      const idxs = sel[l.id];
      if (!idxs?.length || l.locked) return l;
      let nl = l;
      for (const k of [...new Set(idxs)].sort((a, b) => b - a)) if (k < nl.instances.length) nl = removeInstance(nl, k);
      return nl;
    });
    commit(withClip(p, c.id, (cc) => ({ ...cc, layers })), 'borrar instancias');
  }
  selection.value = {};
}

export function nudgeDuration(d: number) {
  const p = project.peek();
  const c = clip.peek();
  const sel = selection.peek();
  if (p && c && Object.values(sel).reduce((n, a) => n + a.length, 0) > 1) {
    const s = Object.fromEntries(Object.entries(sel).filter(([lid]) => !c.layers.find((l) => l.id === lid)?.locked));
    commit(withClip(p, c.id, (cc) => ({ ...cc, layers: addEach(cc.layers, s, d) })), 'duración');
    return;
  }
  const L = layer.peek();
  const idx = targetIndex();
  if (!L || idx < 0) return;
  editLayer('duración', (l) => setDuration(l, idx, l.instances[idx].duration + d));
}

export function setBehavior(which: 'pre' | 'post', b: Behavior, lid = layerId.peek()) {
  editLayer(which === 'pre' ? 'pre-behavior' : 'post-behavior', (l) => ({ ...l, [which]: b }), lid);
}

/** "Hold hasta el final": alterna post-behavior entre hold y cut. */
export function toggleHold() {
  const L = layer.peek();
  if (!L) return;
  setBehavior('post', L.post === 'hold' ? 'none' : 'hold');
}

// --- capas
export function addLayer() {
  const p = project.peek();
  const c = clip.peek();
  if (!p || !c) return;
  const L = makeLayer(`Capa ${c.layers.length + 1}`);
  const at = Math.max(0, c.layers.findIndex((l) => l.id === layerId.peek()));
  commit(withClip(p, c.id, (cc) => ({ ...cc, layers: [...cc.layers.slice(0, at), L, ...cc.layers.slice(at)] })), 'nueva capa');
  layerId.value = L.id;
}

export function deleteLayer() {
  const p = project.peek();
  const c = clip.peek();
  if (!p || !c || c.layers.length <= 1) return say('El clip necesita al menos una capa');
  const at = c.layers.findIndex((l) => l.id === layerId.peek());
  const layers = c.layers.filter((l) => l.id !== layerId.peek());
  commit(withClip(p, c.id, (cc) => ({ ...cc, layers })), 'borrar capa');
  layerId.value = layers[Math.min(at, layers.length - 1)].id;
  selection.value = {};
}

export function moveLayer(dir: -1 | 1) {
  const c = clip.peek();
  if (!c) return;
  const i = c.layers.findIndex((l) => l.id === layerId.peek());
  const j = i + dir;
  if (i < 0 || j < 0 || j >= c.layers.length) return;
  editClip('mover capa', (cc) => {
    const layers = cc.layers.slice();
    [layers[i], layers[j]] = [layers[j], layers[i]];
    return { ...cc, layers };
  });
}

// --- clips
export function addClip() {
  const p = project.peek();
  if (!p) return;
  const c = makeClip(`Plano ${p.clipOrder.length + 1}`);
  const at = p.clipOrder.indexOf(clipId.peek()) + 1;
  const order = [...p.clipOrder.slice(0, at), c.id, ...p.clipOrder.slice(at)];
  commit({ ...p, clipOrder: order, clips: { ...p.clips, [c.id]: c } }, 'nuevo clip');
  openClip(c.id);
}

export function deleteClip() {
  const p = project.peek();
  if (!p || p.clipOrder.length <= 1) return say('El proyecto necesita al menos un clip');
  const id = clipId.peek();
  const at = p.clipOrder.indexOf(id);
  const order = p.clipOrder.filter((x) => x !== id);
  const clips = { ...p.clips };
  delete clips[id];
  commit({ ...p, clipOrder: order, clips }, 'borrar clip');
  openClip(order[Math.min(at, order.length - 1)]);
}

export function openClip(id: string) {
  const p = project.peek();
  if (!p?.clips[id]) return;
  playing.value = false;
  clipId.value = id;
  layerId.value = p.clips[id].layers[0]?.id ?? '';
  frame.value = 0;
  selection.value = {};
}

export function renameClip(name: string) {
  editClip('renombrar clip', (c) => ({ ...c, name }));
}

export function renameLayer(lid: string, name: string) {
  editLayer('renombrar capa', (l) => ({ ...l, name }), lid);
}

/** Precarga los dibujos del clip (para reproducir fluido). */
export function preloadClip() {
  const c = clip.peek();
  if (!c) return;
  for (const L of c.layers) for (const it of L.instances) if (it.drawingId) void loadDrawing(it.drawingId);
}

export { resolveAt, layerEnd };
