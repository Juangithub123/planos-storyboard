import type { Cam, Camera, Clip, Project } from './types';
import { trimRange } from './evaluate';

/** Línea de tiempo del proyecto: los clips (con su recorte) uno tras otro. */

export interface Segment {
  clip: Clip;
  /** frame de la secuencia donde empieza */
  start: number;
  /** primer frame del clip que entra (trimIn) */
  a: number;
  /** cantidad de frames */
  n: number;
}

export function segments(p: Project): Segment[] {
  let t = 0;
  return p.clipOrder.map((id) => {
    const c = p.clips[id];
    const [a, b] = trimRange(c);
    const s = { clip: c, start: t, a, n: b - a + 1 };
    t += s.n;
    return s;
  });
}

export function totalFrames(p: Project): number {
  return segments(p).reduce((s, x) => s + x.n, 0);
}

/** Frame de la secuencia → (segmento, frame local del clip). */
export function locate(segs: Segment[], gf: number): { seg: Segment; local: number } | null {
  for (const s of segs) if (gf < s.start + s.n) return { seg: s, local: s.a + Math.max(0, gf - s.start) };
  const last = segs[segs.length - 1];
  return last ? { seg: last, local: last.a + last.n - 1 } : null;
}

/** Frame local de un clip → frame de la secuencia (o null si cae fuera del recorte). */
export function toSequenceFrame(segs: Segment[], clipId: string, local: number): number | null {
  const s = segs.find((x) => x.clip.id === clipId);
  if (!s || local < s.a || local >= s.a + s.n) return null;
  return s.start + (local - s.a);
}

// ---------------------------------------------------------------------------
// Cámara

export function defaultCam(p: Project): Cam {
  return { x: p.width / 2, y: p.height / 2, zoom: 1, rot: 0 };
}

export function defaultCamera(p: Project): Camera {
  return { enabled: false, start: defaultCam(p), end: defaultCam(p), ease: 'ease' };
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Cámara interpolada en un frame local del clip (de inicio a fin del recorte). */
export function camAt(c: Clip, local: number): Cam | null {
  const cam = c.camera;
  if (!cam?.enabled) return null;
  const [a, b] = trimRange(c);
  let t = b > a ? (local - a) / (b - a) : 0;
  t = Math.max(0, Math.min(1, t));
  if (cam.ease === 'ease') t = easeInOut(t);
  const lerp = (u: number, v: number) => u + (v - u) * t;
  // zoom interpolado en escala logarítmica (se siente lineal)
  const zoom = Math.exp(lerp(Math.log(cam.start.zoom), Math.log(cam.end.zoom)));
  return { x: lerp(cam.start.x, cam.end.x), y: lerp(cam.start.y, cam.end.y), zoom, rot: lerp(cam.start.rot, cam.end.rot) };
}

/** Matriz lienzo → salida para una cámara (salida del mismo tamaño que el lienzo). */
export function camMatrix(cam: Cam, W: number, H: number): DOMMatrix {
  return new DOMMatrix().translate(W / 2, H / 2).scale(cam.zoom).rotate(-cam.rot).translate(-cam.x, -cam.y);
}
