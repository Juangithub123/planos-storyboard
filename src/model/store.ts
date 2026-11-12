import { computed, signal } from '@preact/signals';
import type { Clip, Id, Layer, Project } from './types';
import { uid } from './types';
import type { Selection } from './timing';
import { putProject } from '../storage/db';
import { getDrawingCanvas, markDirty } from '../render/drawings';

// ---------------------------------------------------------------------------
// Estado

export const project = signal<Project | null>(null);
export const clipId = signal<Id>('');
export const frame = signal(0);
export const layerId = signal<Id>('');
export const selection = signal<Selection>({});
export const playing = signal(false);

export type Tool = 'pencil' | 'eraser' | 'fill' | 'shape' | 'lasso';
export type ShapeKind = 'line' | 'rect' | 'ellipse';
export const tool = signal<Tool>('pencil');
export const pencil = signal({ size: 6, opacity: 1, color: '#1b1b1f', pressureSize: true, pressureOpacity: false });
export const eraser = signal({ size: 30, opacity: 1, pressureSize: true });
export const shapeOpts = signal<{ kind: ShapeKind; fill: boolean }>({ kind: 'line', fill: false });
/** sample: de dónde se toman los bordes para rellenar (capa actual o todas las visibles) */
export const fillOpts = signal<{ tolerance: number; grow: number; sample: 'layer' | 'all' }>({ tolerance: 40, grow: 1, sample: 'all' });
export const onion = signal({ enabled: false, before: 1, after: 1, opacity: 0.35, allLayers: false, colorBefore: '#e0483e', colorAfter: '#2f9e5b' });
/** Al dibujar en medio de una instancia sostenida: crear instancia nueva en el cabezal. */
export const autoInstance = signal(false);
/** Para probar en PC/sin stylus: permitir dibujar con el dedo. */
export const fingerDraws = signal(false);
export const toast = signal<{ text: string; t: number } | null>(null);
/** Vista del editor: el clip actual o la secuencia/storyboard. */
export const view = signal<'clip' | 'sequence'>('clip');
/** Modo multiselección en la timeline (taps suman/quitan, arrastre = rectángulo). */
export const multiMode = signal(false);
/** Cómo escalan las manijas de la selección. */
export const scaleMode = signal<'prop' | 'delta'>('prop');
/** Milisegundos con el stylus quieto para abrir el pie menu (0 = desactivado). */
export const pieHoldMs = signal(1000);
export const durationPanelOpen = signal(false);

export const clip = computed<Clip | null>(() => project.value?.clips[clipId.value] ?? null);
export const layer = computed<Layer | null>(() => clip.value?.layers.find((l) => l.id === layerId.value) ?? null);

export function say(text: string) {
  toast.value = { text, t: Date.now() };
}

// ---------------------------------------------------------------------------
// Fábricas

export function makeLayer(name: string): Layer {
  return {
    kind: 'paint', id: uid(), name, visible: true, locked: false, opacity: 1, blend: 'normal',
    start: 0, pre: 'none', post: 'none', instances: [],
  };
}

export function makeClip(name: string): Clip {
  return { id: uid(), name, layers: [makeLayer('Capa 1')], playIn: null, playOut: null, trimIn: null, trimOut: null };
}

export function makeProject(name: string, width: number, height: number, fps: number): Project {
  const c = makeClip('Plano 1');
  const now = Date.now();
  return {
    id: uid(), name, width, height, fps, clipOrder: [c.id], clips: { [c.id]: c },
    palette: ['#1b1b1f', '#ffffff', '#e0483e', '#f2b84b', '#2f9e5b', '#3b6fd8', '#8a8f98'],
    createdAt: now, updatedAt: now, lastBackupAt: 0,
  };
}

// ---------------------------------------------------------------------------
// Guardado automático del JSON del proyecto

let saveTimer = 0;
let pendingSave: Project | null = null;

function scheduleSave(p: Project) {
  pendingSave = p;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushProject, 300);
}

export async function flushProject() {
  clearTimeout(saveTimer);
  const p = pendingSave;
  pendingSave = null;
  if (p) {
    try {
      await putProject(p);
    } catch (e) {
      console.error(e);
      say('Error al guardar el proyecto');
    }
  }
}

// ---------------------------------------------------------------------------
// Undo / redo

export interface PixelPatch {
  drawingId: Id;
  x: number;
  y: number;
  before: ImageData;
  after: ImageData;
}

interface Entry {
  label: string;
  before: Project | null;
  after: Project | null;
  pixels: PixelPatch | null;
  bytes: number;
}

const undoStack: Entry[] = [];
const redoStack: Entry[] = [];
export const historyVersion = signal(0);
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 100;

function push(e: Entry) {
  undoStack.push(e);
  redoStack.length = 0;
  let total = undoStack.reduce((s, x) => s + x.bytes, 0);
  while (undoStack.length > 1 && (undoStack.length > MAX_ENTRIES || total > MAX_BYTES)) {
    total -= undoStack.shift()!.bytes;
  }
  historyVersion.value++;
}

export function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  historyVersion.value++;
}

export const canUndo = computed(() => (historyVersion.value, undoStack.length > 0));
export const canRedo = computed(() => (historyVersion.value, redoStack.length > 0));

function setProject(p: Project) {
  const next = { ...p, updatedAt: Date.now() };
  project.value = next;
  scheduleSave(next);
}

/** Cambio de estructura con entrada de undo. `before` permite commitear tras una vista previa. */
let lastCommit = { label: '', t: 0 };
const COALESCE = new Set(['opacidad', 'paleta']);

export function commit(next: Project, label: string, before: Project | null = project.value) {
  const now = Date.now();
  const top = undoStack[undoStack.length - 1];
  if (COALESCE.has(label) && top && top.label === label && !top.pixels && lastCommit.label === label && now - lastCommit.t < 800) {
    // sliders: un solo paso de undo por gesto
    top.after = next;
    redoStack.length = 0;
  } else {
    push({ label, before, after: next, pixels: null, bytes: 2048 });
  }
  lastCommit = { label, t: now };
  setProject(next);
}

/** Vista previa en vivo (arrastres) sin historial; después llamar commit(next, label, before). */
export function preview(next: Project) {
  project.value = next;
}

export function commitStroke(patch: PixelPatch, nextProject: Project | null, before: Project | null) {
  const bytes = patch.before.data.byteLength * 2;
  push({ label: 'trazo', before: nextProject ? before : null, after: nextProject, pixels: patch, bytes });
  if (nextProject) setProject(nextProject);
}

async function applyPixels(p: PixelPatch, which: 'before' | 'after') {
  const c = await getDrawingCanvas(p.drawingId);
  c.getContext('2d')!.putImageData(p[which], p.x, p.y);
  markDirty(p.drawingId);
}

/** Ganchos para que herramientas con estado (lazo flotante) se resuelvan antes de deshacer/rehacer. */
export const historyHooks = { before: () => {} };

export async function undo() {
  historyHooks.before();
  const e = undoStack.pop();
  if (!e) return;
  redoStack.push(e);
  if (e.pixels) await applyPixels(e.pixels, 'before');
  if (e.before) setProject(e.before);
  historyVersion.value++;
  fixSelection();
}

export async function redo() {
  historyHooks.before();
  const e = redoStack.pop();
  if (!e) return;
  undoStack.push(e);
  if (e.pixels) await applyPixels(e.pixels, 'after');
  if (e.after) setProject(e.after);
  historyVersion.value++;
  fixSelection();
}

/** Después de undo/redo, asegura que clip/capa actuales existan. */
function fixSelection() {
  const p = project.value;
  if (!p) return;
  if (!p.clips[clipId.value]) clipId.value = p.clipOrder[0];
  const c = p.clips[clipId.value];
  if (!c.layers.some((l) => l.id === layerId.value)) layerId.value = c.layers[0]?.id ?? '';
  selection.value = {};
}

// ---------------------------------------------------------------------------
// Helpers de edición inmutable

export function withClip(p: Project, cid: Id, fn: (c: Clip) => Clip): Project {
  return { ...p, clips: { ...p.clips, [cid]: fn(p.clips[cid]) } };
}

export function withLayer(p: Project, cid: Id, lid: Id, fn: (l: Layer) => Layer): Project {
  return withClip(p, cid, (c) => ({ ...c, layers: c.layers.map((l) => (l.id === lid ? fn(l) : l)) }));
}

export function withLayers(p: Project, cid: Id, layers: Layer[]): Project {
  return withClip(p, cid, (c) => ({ ...c, layers }));
}

export function editClip(label: string, fn: (c: Clip) => Clip) {
  const p = project.value;
  if (!p || !clipId.value) return;
  commit(withClip(p, clipId.value, fn), label);
}

export function editLayer(label: string, fn: (l: Layer) => Layer, lid = layerId.value) {
  const p = project.value;
  if (!p || !clipId.value || !lid) return;
  commit(withLayer(p, clipId.value, lid, fn), label);
}

export function editProject(label: string, fn: (p: Project) => Project) {
  const p = project.value;
  if (p) commit(fn(p), label);
}

export function openProject(p: Project) {
  resetHistory();
  project.value = p;
  clipId.value = p.clipOrder[0];
  layerId.value = p.clips[p.clipOrder[0]].layers[0]?.id ?? '';
  frame.value = 0;
  selection.value = {};
  playing.value = false;
}
