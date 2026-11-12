import { clip, commit, layerId, makeLayer, project, say, withClip } from './store';
import { clipLength } from './evaluate';
import { inheritGroup } from './groups';
import { uid, type Layer } from './types';
import { createDrawing, markDirty } from '../render/drawings';
import { containRect, probeVideo } from '../render/videos';
import { putAsset } from '../storage/db';

/** Capas de referencia: imágenes (como dibujo editable) y videos (capa especial, no editable). */

function insertLayer(L: Layer, extra?: (p: NonNullable<typeof project.value>) => NonNullable<typeof project.value>) {
  const p0 = project.peek();
  const c = clip.peek();
  if (!p0 || !c) return;
  const at = Math.max(0, c.layers.findIndex((l) => l.id === layerId.peek()));
  const nl = inheritGroup(c, at, L);
  let p = withClip(p0, c.id, (cc) => ({ ...cc, layers: [...cc.layers.slice(0, at), nl, ...cc.layers.slice(at)] }));
  if (extra) p = extra(p);
  commit(p, 'importar referencia');
  layerId.value = nl.id;
}

const baseName = (name: string) => name.replace(/\.[^.]+$/, '').slice(0, 40) || 'referencia';

/**
 * Importa una imagen como capa nueva: un dibujo (editable) que ocupa todo el clip (Hold antes/después),
 * bloqueada para no dibujarle encima sin querer.
 */
export async function importImageLayer(file: File) {
  const p = project.peek();
  const c = clip.peek();
  if (!p || !c) return;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return say('No se pudo leer la imagen');
  }
  const id = uid();
  const cv = createDrawing(id);
  const r = containRect(bmp.width, bmp.height, p.width, p.height);
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, r.x, r.y, r.w, r.h);
  bmp.close();
  markDirty(id, 0);
  const L: Layer = {
    ...makeLayer('Ref: ' + baseName(file.name)),
    locked: true, pre: 'hold', post: 'hold',
    instances: [{ id: uid(), duration: clipLength(c), drawingId: id }],
  };
  insertLayer(L);
  say('Imagen importada (capa bloqueada: desbloqueala para dibujarle encima)');
}

/** Importa un video como capa de referencia (se guarda en el dispositivo, entra en el backup). */
export async function importVideoLayer(file: File) {
  const p = project.peek();
  if (!p) return;
  let info;
  try {
    info = await probeVideo(file);
  } catch (e) {
    return say((e as Error).message);
  }
  if (!Number.isFinite(info.duration) || info.duration <= 0) return say('No se pudo leer la duración del video');
  const assetId = uid();
  say('Importando video…');
  await putAsset(p.id, assetId, file);
  const frames = Math.max(1, Math.ceil(info.duration * p.fps));
  const L: Layer = {
    ...makeLayer('Video: ' + baseName(file.name)),
    kind: 'video', assetId, opacity: 0.6,
    instances: [{ id: uid(), duration: frames, drawingId: null }],
  };
  insertLayer(L, (pp) => ({
    ...pp,
    assets: { ...(pp.assets ?? {}), [assetId]: { name: file.name, mime: file.type || 'video/mp4', duration: info.duration } },
  }));
  say(`Video importado: ${frames} frames`);
}
