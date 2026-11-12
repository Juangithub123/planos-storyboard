import type { Id } from '../model/types';
import { getAsset } from '../storage/db';
import { drawingsVersion } from './drawings';

/**
 * Videos de referencia: un <video> por asset, que se posiciona (seek) en el tiempo pedido.
 * Mientras busca, se sigue mostrando el último frame decodificado; al terminar se re-renderiza.
 */

interface V {
  el: HTMLVideoElement;
  url: string;
  ready: boolean;
  want: number;
  /** copia del último frame decodificado (evita parpadeos mientras busca) */
  snap: HTMLCanvasElement;
  hasSnap: boolean;
  /** tiempo del video al que corresponde la copia */
  snapTime: number;
}

function snapshot(v: V) {
  const { el, snap } = v;
  if (!el.videoWidth || el.readyState < 2) return;
  if (snap.width !== el.videoWidth || snap.height !== el.videoHeight) {
    snap.width = el.videoWidth;
    snap.height = el.videoHeight;
  }
  snap.getContext('2d')!.drawImage(el, 0, 0);
  v.hasSnap = true;
  v.snapTime = el.currentTime;
}

let projectId = '';
const vids = new Map<Id, V>();
const loading = new Set<Id>();

const bump = () => (drawingsVersion.value = drawingsVersion.value + 1);

export function initVideos(pid: Id) {
  for (const v of vids.values()) {
    v.el.removeAttribute('src');
    URL.revokeObjectURL(v.url);
  }
  vids.clear();
  loading.clear();
  projectId = pid;
}

function load(id: Id) {
  if (loading.has(id)) return;
  loading.add(id);
  const pid = projectId;
  void getAsset(pid, id).then((blob) => {
    if (!blob || pid !== projectId) return;
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    const url = URL.createObjectURL(blob);
    const v: V = { el, url, ready: false, want: 0, snap: document.createElement('canvas'), hasSnap: false, snapTime: -1 };
    el.addEventListener('loadeddata', () => {
      v.ready = true;
      snapshot(v);
      el.currentTime = v.want;
      bump();
    });
    el.addEventListener('seeked', () => {
      snapshot(v);
      if (Math.abs(el.currentTime - v.want) > 0.001) el.currentTime = v.want;
      bump();
    });
    el.src = url;
    vids.set(id, v);
  });
}

/** Devuelve el último frame (canvas, quizás de un tiempo anterior mientras busca) o null si todavía no cargó. */
export function videoFrame(id: Id, time: number): HTMLCanvasElement | null {
  const v = vids.get(id);
  if (!v) {
    load(id);
    return null;
  }
  const t = Math.max(0, Math.min(time, (v.el.duration || 0) - 0.001));
  v.want = t;
  if (v.ready && !v.el.seeking && Math.abs(v.el.currentTime - t) > 0.001) v.el.currentTime = t;
  return v.hasSnap ? v.snap : null;
}

/** Lee la duración (s) y el tamaño de un archivo de video. */
export function probeVideo(file: Blob): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.muted = true;
    const url = URL.createObjectURL(file);
    const done = () => {
      el.ontimeupdate = null;
      el.ondurationchange = null;
      resolve({ duration: el.duration, width: el.videoWidth, height: el.videoHeight });
      URL.revokeObjectURL(url);
    };
    el.onloadedmetadata = () => {
      if (Number.isFinite(el.duration)) return done();
      // WebM grabados por navegadores no traen duración: forzar a que la calcule buscando al final
      el.ondurationchange = () => Number.isFinite(el.duration) && done();
      el.ontimeupdate = () => Number.isFinite(el.duration) && done();
      el.currentTime = 1e101;
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('El navegador no puede leer ese video'));
    };
    el.src = url;
  });
}

/** Rectángulo "contain" para encajar una fuente w×h en el lienzo W×H. */
export function containRect(w: number, h: number, W: number, H: number) {
  const k = Math.min(W / w, H / h);
  const dw = w * k;
  const dh = h * k;
  return { x: (W - dw) / 2, y: (H - dh) / 2, w: dw, h: dh };
}

/**
 * Posiciona el video exactamente en `time` y espera ese frame (para exportar).
 * Si el navegador no lo entrega en 3 s, devuelve el último frame disponible.
 */
export function videoFrameExact(id: Id, time: number): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const deadline = performance.now() + 3000;
    const tick = () => {
      const v = vids.get(id);
      if (!v) load(id);
      else if (v.ready) {
        const t = Math.max(0, Math.min(time, (v.el.duration || 0) - 0.001));
        v.want = t;
        if (v.hasSnap && Math.abs(v.snapTime - t) < 0.002) return resolve(v.snap);
        if (!v.el.seeking) {
          if (Math.abs(v.el.currentTime - t) < 0.002 && v.el.readyState >= 2) {
            snapshot(v);
            return resolve(v.snap);
          }
          v.el.currentTime = t;
        }
      }
      if (performance.now() > deadline) return resolve(v?.hasSnap ? v.snap : null);
      setTimeout(tick, 15);
    };
    tick();
  });
}
