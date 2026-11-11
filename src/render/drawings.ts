import { signal } from '@preact/signals';
import type { Id } from '../model/types';
import { getDrawing, putDrawing } from '../storage/db';

/**
 * Caché de dibujos (canvas a resolución de proyecto) con carga perezosa desde IndexedDB,
 * guardado al terminar cada trazo, miniaturas para la timeline y desalojo LRU.
 */

interface Entry {
  canvas: HTMLCanvasElement;
  thumb: HTMLCanvasElement;
  dirty: boolean;
  used: number;
}

const THUMB_H = 40;
let projectId: Id = '';
let W = 1920;
let H = 1080;
let maxEntries = 80;
const cache = new Map<Id, Entry>();
const loading = new Map<Id, Promise<Entry | null>>();
const missing = new Set<Id>();
const saveTimers = new Map<Id, number>();
const pendingSaves = new Set<Promise<void>>();

/** Se incrementa cuando cambia/carga cualquier dibujo (para re-render). */
export const drawingsVersion = signal(0);
const bump = () => (drawingsVersion.value = drawingsVersion.value + 1);

export function initDrawings(pid: Id, width: number, height: number) {
  projectId = pid;
  W = width;
  H = height;
  cache.clear();
  loading.clear();
  missing.clear();
  // ~600MB de canvases como máximo
  maxEntries = Math.max(24, Math.floor((600 * 1024 * 1024) / (W * H * 4)));
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function makeEntry(canvas: HTMLCanvasElement): Entry {
  const tw = Math.max(1, Math.round((THUMB_H * W) / H));
  const e: Entry = { canvas, thumb: makeCanvas(tw, THUMB_H), dirty: false, used: performance.now() };
  renderThumb(e);
  return e;
}

function renderThumb(e: Entry) {
  const t = e.thumb.getContext('2d')!;
  t.clearRect(0, 0, e.thumb.width, e.thumb.height);
  t.drawImage(e.canvas, 0, 0, e.thumb.width, e.thumb.height);
}

function evict() {
  if (cache.size <= maxEntries) return;
  const entries = [...cache.entries()].filter(([, e]) => !e.dirty).sort((a, b) => a[1].used - b[1].used);
  for (const [id] of entries.slice(0, cache.size - maxEntries)) cache.delete(id);
}

/** Crea un dibujo nuevo vacío (o copia de otro) y lo devuelve. */
export function createDrawing(id: Id, copyFrom?: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(W, H);
  if (copyFrom) c.getContext('2d')!.drawImage(copyFrom, 0, 0);
  const e = makeEntry(c);
  cache.set(id, e);
  missing.delete(id);
  if (copyFrom) markDirty(id);
  evict();
  return c;
}

/** Devuelve el canvas si ya está en memoria; si no, dispara la carga y devuelve null. */
export function peekDrawing(id: Id): HTMLCanvasElement | null {
  const e = cache.get(id);
  if (e) {
    e.used = performance.now();
    return e.canvas;
  }
  void loadDrawing(id);
  return null;
}

export function peekThumb(id: Id): HTMLCanvasElement | null {
  const e = cache.get(id);
  if (e) return e.thumb;
  void loadDrawing(id);
  return null;
}

export function loadDrawing(id: Id): Promise<Entry | null> {
  const e = cache.get(id);
  if (e) return Promise.resolve(e);
  if (missing.has(id)) return Promise.resolve(null);
  let p = loading.get(id);
  if (p) return p;
  const pid = projectId;
  p = (async () => {
    const blob = await getDrawing(pid, id);
    if (pid !== projectId) return null;
    if (!blob) {
      missing.add(id);
      return null;
    }
    const bmp = await createImageBitmap(blob);
    const c = makeCanvas(W, H);
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    const entry = makeEntry(c);
    if (!cache.has(id)) cache.set(id, entry);
    evict();
    bump();
    return cache.get(id)!;
  })().finally(() => loading.delete(id));
  loading.set(id, p);
  return p;
}

/** Garantiza el canvas en memoria (para dibujar sobre él). */
export async function getDrawingCanvas(id: Id): Promise<HTMLCanvasElement> {
  const e = await loadDrawing(id);
  return e ? e.canvas : createDrawing(id);
}

/** Marca un dibujo como modificado: actualiza miniatura y agenda el guardado. */
export function markDirty(id: Id, delay = 250) {
  const e = cache.get(id);
  if (!e) return;
  e.dirty = true;
  e.used = performance.now();
  renderThumb(e);
  bump();
  clearTimeout(saveTimers.get(id));
  saveTimers.set(id, window.setTimeout(() => void saveNow(id), delay));
}

function saveNow(id: Id): Promise<void> {
  saveTimers.delete(id);
  const e = cache.get(id);
  if (!e || !e.dirty) return Promise.resolve();
  const pid = projectId;
  e.dirty = false;
  const p = new Promise<void>((resolve) => {
    e.canvas.toBlob(async (blob) => {
      try {
        if (blob) await putDrawing(pid, id, blob);
        else e.dirty = true;
      } catch (err) {
        console.error('No se pudo guardar el dibujo', err);
        e.dirty = true;
      }
      resolve();
    }, 'image/png');
  });
  pendingSaves.add(p);
  p.finally(() => pendingSaves.delete(p));
  return p;
}

/** Guarda ya todo lo pendiente (al ocultar la página, exportar, cambiar de proyecto). */
export async function flushDrawings() {
  const ids = [...saveTimers.keys()];
  for (const id of ids) clearTimeout(saveTimers.get(id));
  await Promise.all([...ids.map((id) => saveNow(id)), ...pendingSaves]);
}

export function hasPendingDrawingSaves() {
  return saveTimers.size > 0 || pendingSaves.size > 0;
}
