import { zipSync, type Zippable } from 'fflate';
import type { Clip, Layer, Project } from '../model/types';
import { resolveAt, isVisible, trimRange } from '../model/evaluate';
import { renderClipFrame } from '../render/compositor';
import { preloadClipDrawings, prepareFrame, renderOutputFrame } from '../render/output';
import type { ExportJob } from './video';

export interface PngOptions {
  clips: 'current' | 'all';
  mode: 'composite' | 'layers';
  camera: boolean;
  currentClipId: string;
}

const safe = (s: string) => s.replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]+/g, '_').trim().replace(/\s+/g, '_') || 'x';
const pad = (n: number) => String(n).padStart(4, '0');

async function pngBytes(cv: HTMLCanvasElement): Promise<Uint8Array> {
  const b = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/png'));
  return new Uint8Array(await b!.arrayBuffer());
}

/**
 * Secuencias PNG por clip (todo compuesto) o por capa (una carpeta por capa, con transparencia),
 * con todos los frames del recorte expandidos (los holds incluidos), para importar en TVPaint u otro software.
 */
export async function exportPng(p: Project, o: PngOptions, job: ExportJob): Promise<Blob> {
  const clips = (o.clips === 'all' ? p.clipOrder : [o.currentClipId]).map((id) => p.clips[id]);
  const files: Zippable = {};
  const total = clips.reduce((s, c) => {
    const [a, b] = trimRange(c);
    const n = b - a + 1;
    return s + (o.mode === 'layers' ? n * c.layers.filter((l) => isVisible(c, l)).length : n);
  }, 0);
  let done = 0;
  const cv = document.createElement('canvas');
  cv.width = p.width;
  cv.height = p.height;
  const ctx = cv.getContext('2d')!;

  for (const c of clips) {
    const num = String(p.clipOrder.indexOf(c.id) + 1).padStart(2, '0');
    const folder = `${num}_${safe(c.name)}`;
    const [a, b] = trimRange(c);
    await preloadClipDrawings(c);
    const hasVideo = c.layers.some((l) => l.kind === 'video' && isVisible(c, l));

    if (o.mode === 'composite') {
      const cache = new Map<string, Uint8Array>();
      for (let f = a; f <= b; f++, done++) {
        if (job.cancelled) throw new Error('cancelado');
        // los frames idénticos (holds) reutilizan el mismo PNG
        const key = hasVideo || (o.camera && c.camera?.enabled) ? '' : c.layers.map((L) => resolveAt(L, f)?.drawingId ?? '-').join('|');
        let bytes = key ? cache.get(key) : undefined;
        if (!bytes) {
          await prepareFrame(p, c, f);
          renderOutputFrame(cv, p, c, f, o.camera);
          bytes = await pngBytes(cv);
          if (key) cache.set(key, bytes);
        }
        files[`${folder}/${safe(c.name)}_${pad(f - a + 1)}.png`] = [bytes, { level: 0 }];
        if (done % 4 === 0) job.onProgress(done, total, c.name);
      }
    } else {
      for (const L of c.layers) {
        if (!isVisible(c, L)) continue;
        const solo: Clip = { ...c, groups: [], layers: [{ ...L, opacity: 1, blend: 'normal', visible: true, groupId: null } as Layer] };
        const cache = new Map<string, Uint8Array>();
        for (let f = a; f <= b; f++, done++) {
          if (job.cancelled) throw new Error('cancelado');
          const key = L.kind === 'video' ? '' : resolveAt(L, f)?.drawingId ?? '-';
          let bytes = key ? cache.get(key) : undefined;
          if (!bytes) {
            if (L.kind === 'video') await prepareFrame(p, solo, f);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, cv.width, cv.height);
            renderClipFrame(ctx, solo, f, p.width, p.height, null, null, p);
            bytes = await pngBytes(cv);
            if (key) cache.set(key, bytes);
          }
          files[`${folder}/${safe(L.name)}/${safe(L.name)}_${pad(f - a + 1)}.png`] = [bytes, { level: 0 }];
          if (done % 4 === 0) job.onProgress(done, total, `${c.name} · ${L.name}`);
        }
      }
    }
  }
  job.onProgress(total, total, 'Comprimiendo…');
  return new Blob([zipSync(files)], { type: 'application/zip' });
}
