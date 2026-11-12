import {
  clip, clipId, commit, frame, layer, layerId, makeLayer, project, say, selection, withClip, withLayers,
} from './store';
import {
  addEach, fitTotal, insertInstancesAt, instanceIndexAt, instanceStart, multiply, selectionSpan, setEach,
  splitLayerAt, type Selection,
} from './timing';
import { clipLength, isLocked } from './evaluate';
import { inheritGroup, normalizeGroups } from './groups';
import { uid, type Clip, type Instance, type Layer } from './types';
import { createDrawing, loadDrawing } from '../render/drawings';
import { openClip, targetIndex } from './actions';

/** Fase 2: selección, duración numérica, copiar/pegar, cortar y mover clips. */

/** Selección sin capas bloqueadas ni índices inválidos. */
export function cleanSelection(c: Clip, sel: Selection): Selection {
  const out: Selection = {};
  for (const L of c.layers) {
    if (isLocked(c, L)) continue;
    const idxs = (sel[L.id] ?? []).filter((i) => i >= 0 && i < L.instances.length);
    if (idxs.length) out[L.id] = [...new Set(idxs)].sort((a, b) => a - b);
  }
  return out;
}

export function selectAllClip(): Selection {
  const c = clip.peek();
  if (!c) return {};
  const s: Selection = {};
  for (const L of c.layers) if (!isLocked(c, L) && L.instances.length) s[L.id] = L.instances.map((_, k) => k);
  return s;
}

export type DurationOp = 'each' | 'total' | 'add' | 'mul';

/** Aplica una operación del panel numérico a la selección (o a todo el clip). */
export function applyDurationOp(op: DurationOp, value: number, wholeClip: boolean) {
  const p = project.peek();
  const c = clip.peek();
  if (!p || !c) return;
  const sel = cleanSelection(c, wholeClip ? selectAllClip() : selection.peek());
  if (!Object.keys(sel).length) return say('No hay instancias seleccionadas');
  if (!Number.isFinite(value)) return;
  let layers: Layer[];
  if (op === 'each') layers = setEach(c.layers, sel, Math.max(1, Math.round(value)));
  else if (op === 'total') layers = fitTotal(c.layers, sel, value);
  else if (op === 'add') layers = addEach(c.layers, sel, Math.round(value));
  else layers = multiply(c.layers, sel, value);
  commit(withLayers(p, c.id, layers), 'duración');
  if (!wholeClip) selection.value = sel;
}

export function selectionInfo(sel: Selection): { count: number; span: number } {
  const c = clip.peek();
  if (!c) return { count: 0, span: 0 };
  const s = cleanSelection(c, sel);
  const count = Object.values(s).reduce((n, a) => n + a.length, 0);
  const sp = selectionSpan(c.layers, s);
  return { count, span: sp ? sp.end - sp.start : 0 };
}

// --- duplicación de dibujos
async function dupDrawing(id: string | null): Promise<string | null> {
  if (!id) return null;
  const e = await loadDrawing(id);
  const nid = uid();
  createDrawing(nid, e?.canvas);
  return nid;
}

async function dupInstances(items: Instance[]): Promise<Instance[]> {
  const out: Instance[] = [];
  for (const it of items) out.push({ id: uid(), duration: it.duration, drawingId: await dupDrawing(it.drawingId) });
  return out;
}

async function dupLayer(L: Layer, name = L.name): Promise<Layer> {
  // los videos comparten el asset; los dibujos se duplican
  return { ...L, id: uid(), name, groupId: null, instances: L.kind === 'video' ? L.instances.map((i) => ({ ...i, id: uid() })) : await dupInstances(L.instances) };
}

async function dupClip(c: Clip, name: string): Promise<Clip> {
  // grupos nuevos con los mismos datos
  const gmap = new Map((c.groups ?? []).map((g) => [g.id, uid()]));
  const layers: Layer[] = [];
  for (const L of c.layers) layers.push({ ...(await dupLayer(L)), groupId: L.groupId ? gmap.get(L.groupId) ?? null : null });
  const groups = (c.groups ?? []).map((g) => ({ ...g, id: gmap.get(g.id)! }));
  return { ...c, id: uid(), name, layers, groups };
}

// --- portapapeles (en memoria, dentro del mismo proyecto)
type Clipboard =
  | { kind: 'instances'; projectId: string; rows: Instance[][] }
  | { kind: 'layer'; projectId: string; layer: Layer }
  | { kind: 'clip'; projectId: string; clip: Clip };

let clipboard: Clipboard | null = null;

export function copyInstances() {
  const p = project.peek();
  const c = clip.peek();
  if (!p || !c) return;
  let sel = cleanSelection(c, selection.peek());
  if (!Object.keys(sel).length) {
    const L = layer.peek();
    const k = targetIndex();
    if (!L || k < 0) return say('No hay instancias para copiar');
    sel = { [L.id]: [k] };
  }
  const rows: Instance[][] = [];
  for (const L of c.layers) {
    const idxs = sel[L.id];
    if (!idxs?.length) continue;
    rows.push(L.instances.slice(Math.min(...idxs), Math.max(...idxs) + 1));
  }
  clipboard = { kind: 'instances', projectId: p.id, rows };
  say(`Copiadas ${rows.reduce((s, r) => s + r.length, 0)} instancias`);
}

export function copyLayer() {
  const p = project.peek();
  const L = layer.peek();
  if (!p || !L) return;
  clipboard = { kind: 'layer', projectId: p.id, layer: L };
  say(`Capa "${L.name}" copiada`);
}

export function copyClip(cid = clipId.peek()) {
  const p = project.peek();
  if (!p?.clips[cid]) return;
  clipboard = { kind: 'clip', projectId: p.id, clip: p.clips[cid] };
  say(`Clip "${p.clips[cid].name}" copiado`);
}

/** Pega según lo que haya en el portapapeles. */
export async function paste(only?: Clipboard['kind']) {
  const p0 = project.peek();
  const c = clip.peek();
  if (!p0 || !c || !clipboard || clipboard.projectId !== p0.id) return say('No hay nada copiado');
  const cb = clipboard;
  if (only && cb.kind !== only) return say(only === 'clip' ? 'No hay un clip copiado' : 'Nada para pegar acá');
  if (cb.kind === 'instances') {
    const startIdx = Math.max(0, c.layers.findIndex((l) => l.id === layerId.peek()));
    const layers = c.layers.slice();
    const sel: Selection = {};
    const f = frame.peek();
    for (let r = 0; r < cb.rows.length; r++) {
      let li = startIdx + r;
      if (li >= layers.length) {
        layers.push(makeLayer(`Capa ${layers.length + 1}`));
        li = layers.length - 1;
      }
      if (layers[li].locked) continue;
      const items = await dupInstances(cb.rows[r]);
      const res = insertInstancesAt(layers[li], f, items, uid);
      layers[li] = res.layer;
      sel[layers[li].id] = items.map((_, k) => res.first + k);
    }
    commit(withLayers(project.peek()!, c.id, layers), 'pegar instancias');
    selection.value = sel;
  } else if (cb.kind === 'layer') {
    const p = project.peek()!;
    const cur = p.clips[clipId.peek()];
    const at = Math.max(0, cur.layers.findIndex((l) => l.id === layerId.peek()));
    const nl = inheritGroup(cur, at, await dupLayer(cb.layer, cb.layer.name + ' copia'));
    commit(withClip(p, cur.id, (cc) => ({ ...cc, layers: [...cc.layers.slice(0, at), nl, ...cc.layers.slice(at)] })), 'pegar capa');
    layerId.value = nl.id;
  } else {
    const nc = await insertClipCopy(cb.clip, cb.clip.name + ' copia');
    openClip(nc.id);
  }
}

async function insertClipCopy(src: Clip, name: string, afterId = clipId.peek()) {
  const nc = await dupClip(src, name);
  const p = project.peek()!;
  const at = p.clipOrder.indexOf(afterId) + 1;
  const order = [...p.clipOrder.slice(0, at), nc.id, ...p.clipOrder.slice(at)];
  commit({ ...p, clipOrder: order, clips: { ...p.clips, [nc.id]: nc } }, 'pegar clip');
  return nc;
}

export async function duplicateClip(cid = clipId.peek()) {
  const p = project.peek();
  if (!p?.clips[cid]) return;
  return insertClipCopy(p.clips[cid], p.clips[cid].name + ' copia', cid);
}

/** Corta el clip actual en el cabezal: lo que sigue pasa a un clip nuevo a continuación. */
export async function splitClipAtPlayhead() {
  const c = clip.peek();
  if (!c) return;
  const f = frame.peek();
  const len = clipLength(c);
  if (f <= 0 || f >= len) return say('Poné el cabezal dentro del clip para cortarlo');
  const loaded = new Map<string, HTMLCanvasElement | undefined>();
  for (const L of c.layers) {
    const k = instanceIndexAt(L, f);
    const id = k >= 0 ? L.instances[k].drawingId : null;
    if (id && instanceStart(L, k) < f) loaded.set(id, (await loadDrawing(id))?.canvas);
  }
  const left: Layer[] = [];
  const right: Layer[] = [];
  for (const L of c.layers) {
    const r = splitLayerAt(L, f, (id) => {
      if (!id) return null;
      const nid = uid();
      createDrawing(nid, loaded.get(id));
      return nid;
    }, uid);
    if (L.kind === 'video') r.right.srcIn = (L.srcIn ?? 0) + Math.max(0, f - L.start);
    left.push(r.left);
    right.push(r.right);
  }
  const p = project.peek()!;
  const marks = { playIn: null, playOut: null, trimIn: null, trimOut: null };
  const a: Clip = normalizeGroups({ ...c, ...marks, layers: left });
  const b: Clip = normalizeGroups({ ...c, ...marks, id: uid(), name: c.name + ' B', layers: right });
  const at = p.clipOrder.indexOf(c.id) + 1;
  const order = [...p.clipOrder.slice(0, at), b.id, ...p.clipOrder.slice(at)];
  commit({ ...p, clipOrder: order, clips: { ...p.clips, [c.id]: a, [b.id]: b } }, 'cortar clip');
  openClip(b.id);
}

export function moveClip(cid: string, to: number) {
  const p = project.peek();
  if (!p) return;
  const from = p.clipOrder.indexOf(cid);
  if (from < 0) return;
  const order = p.clipOrder.slice();
  order.splice(from, 1);
  order.splice(Math.max(0, Math.min(order.length, to)), 0, cid);
  if (order.join() === p.clipOrder.join()) return;
  commit({ ...p, clipOrder: order }, 'mover clip');
}

/** Selecciona la capa de arriba/abajo de la actual. */
export function selectLayerRel(dir: -1 | 1) {
  const c = clip.peek();
  if (!c) return;
  const i = c.layers.findIndex((l) => l.id === layerId.peek());
  const j = Math.max(0, Math.min(c.layers.length - 1, i + dir));
  layerId.value = c.layers[j].id;
}
