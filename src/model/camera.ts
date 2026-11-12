import { signal } from '@preact/signals';
import { clip, commit, editClip, preview, project, withClip } from './store';
import { defaultCamera } from './sequence';
import type { Cam, Camera, Project } from './types';

/** Qué keyframe de cámara se edita en el panel. */
export const camKey = signal<'start' | 'end'>('start');
/** Si está activo, arrastrar con el stylus en el lienzo mueve la cámara (en vez de dibujar). */
export const camDrag = signal(false);

export function currentCamera(): Camera | null {
  const p = project.peek();
  const c = clip.peek();
  if (!p || !c) return null;
  return c.camera ?? defaultCamera(p);
}

export function editCamera(label: string, fn: (cam: Camera) => Camera) {
  const p = project.peek();
  if (!p) return;
  editClip(label, (c) => ({ ...c, camera: fn(c.camera ?? defaultCamera(p)) }));
}

export function setKey(patch: Partial<Cam>, key = camKey.peek()) {
  editCamera('cámara', (cam) => ({ ...cam, [key]: { ...cam[key], ...patch } }));
}

/** Arrastre de la cámara en el lienzo: vista previa en vivo y un solo paso de deshacer. */
export function cameraDrag() {
  const p0 = project.peek();
  const c = clip.peek();
  if (!p0 || !c) return null;
  const key = camKey.peek();
  const cam0 = c.camera ?? defaultCamera(p0);
  let last: Project | null = null;
  return {
    move(dx: number, dy: number) {
      const k = { ...cam0[key], x: cam0[key].x + dx, y: cam0[key].y + dy };
      last = withClip(p0, c.id, (cc) => ({ ...cc, camera: { ...cam0, enabled: true, [key]: k } }));
      preview(last);
    },
    end() {
      if (last) commit(last, 'mover cámara', p0);
    },
  };
}
