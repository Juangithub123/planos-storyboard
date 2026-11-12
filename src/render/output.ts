import type { Clip, Project } from '../model/types';
import { camAt, camMatrix } from '../model/sequence';
import { isVisible } from '../model/evaluate';
import { loadDrawing } from './drawings';
import { renderClipFrame } from './compositor';
import { videoFrameExact } from './videos';

/**
 * Cuadro "final" de un clip (como se ve en el animatic y en los exports): papel blanco,
 * cámara aplicada, sin papel cebolla. Dibuja en un canvas de cualquier tamaño (escala al ancho).
 */
export function renderOutputFrame(canvas: HTMLCanvasElement | OffscreenCanvas, p: Project, c: Clip, local: number, useCamera = true) {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const k = canvas.width / p.width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let m = new DOMMatrix().scale(k);
  const cam = useCamera ? camAt(c, local) : null;
  if (cam) m = m.multiply(camMatrix(cam, p.width, p.height));
  ctx.setTransform(m);
  if (cam) {
    // con la cámara alejada (zoom < 1) lo que queda fuera del lienzo también es blanco
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, p.width, p.height);
  }
  ctx.imageSmoothingQuality = 'high';
  renderClipFrame(ctx, c, local, p.width, p.height, null, null, p);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Asegura que todo lo que se ve en ese frame esté cargado (dibujos y frame exacto de los videos). */
export async function prepareFrame(p: Project, c: Clip, local: number) {
  const jobs: Promise<unknown>[] = [];
  for (const L of c.layers) {
    if (L.kind === 'video') {
      if (!L.assetId || !isVisible(c, L)) continue;
      const rel = local - L.start;
      const total = L.instances[0]?.duration ?? 0;
      if (rel >= 0 && rel < total) jobs.push(videoFrameExact(L.assetId, (rel + (L.srcIn ?? 0)) / p.fps));
    }
  }
  await Promise.all(jobs);
}

/** Carga todos los dibujos de un clip (antes de exportarlo). */
export async function preloadClipDrawings(c: Clip) {
  const ids = new Set<string>();
  for (const L of c.layers) for (const it of L.instances) if (it.drawingId) ids.add(it.drawingId);
  for (const id of ids) await loadDrawing(id);
}
