import { signal } from '@preact/signals';
import { clipId, project } from '../model/store';
import { totalFrames } from '../model/sequence';
import { flushDrawings } from '../render/drawings';
import { download, safeName } from '../storage/backup';
import { exportVideo, type ExportJob } from '../export/video';
import { exportPng } from '../export/png';
import { exportPdf } from '../export/pdf';

export const exportOpen = signal(false);
const tab = signal<'video' | 'png' | 'pdf'>('video');
const busy = signal<{ done: number; total: number; stage: string } | null>(null);
const result = signal<string | null>(null);
const vScale = signal(1);
const pngOpts = signal<{ clips: 'current' | 'all'; mode: 'composite' | 'layers'; camera: boolean }>({ clips: 'current', mode: 'layers', camera: false });
const pdfGrid = signal<[number, number]>([3, 2]);
let job: ExportJob | null = null;

async function run(kind: 'video' | 'png' | 'pdf') {
  const p = project.peek();
  if (!p) return;
  result.value = null;
  await flushDrawings();
  const j: ExportJob = { cancelled: false, onProgress: (done, total, stage) => (busy.value = { done, total, stage }) };
  job = j;
  busy.value = { done: 0, total: 1, stage: 'Preparando…' };
  try {
    const base = safeName(p.name);
    if (kind === 'video') {
      const r = await exportVideo(p, vScale.peek(), j);
      download(r.blob, `${base}_animatic.${r.ext}`);
      result.value = `Listo: ${(r.blob.size / 1e6).toFixed(1)} MB (${r.ext.toUpperCase()}).` + (r.note ? ' ' + r.note : '');
    } else if (kind === 'png') {
      const blob = await exportPng(p, { ...pngOpts.peek(), currentClipId: clipId.peek() }, j);
      download(blob, `${base}_png.zip`);
      result.value = `Listo: ${(blob.size / 1e6).toFixed(1)} MB.`;
    } else {
      const [cols, rows] = pdfGrid.peek();
      const blob = await exportPdf(p, { cols, rows }, j);
      download(blob, `${base}_storyboard.pdf`);
      result.value = `Listo: ${(blob.size / 1e6).toFixed(1)} MB.`;
    }
  } catch (e) {
    result.value = (e as Error).message === 'cancelado' ? 'Cancelado.' : 'Error: ' + (e as Error).message;
    console.error(e);
  } finally {
    busy.value = null;
    job = null;
  }
}

export function ExportDialog() {
  if (!exportOpen.value) return null;
  const p = project.value!;
  const b = busy.value;
  const total = totalFrames(p);
  const po = pngOpts.value;
  const t = tab.value;
  return (
    <div class="docs-overlay" onPointerDown={(e) => e.target === e.currentTarget && !b && (exportOpen.value = false)}>
      <div class="exp">
        <div class="docs-head">
          <h2>Exportar</h2>
          <button disabled={!!b} onClick={() => (exportOpen.value = false)}>✕</button>
        </div>
        <div class="row-btns">
          <button class={t === 'video' ? 'on' : ''} disabled={!!b} onClick={() => (tab.value = 'video')}>🎬︎ Video animatic</button>
          <button class={t === 'png' ? 'on' : ''} disabled={!!b} onClick={() => (tab.value = 'png')}>🖼︎ Secuencia PNG</button>
          <button class={t === 'pdf' ? 'on' : ''} disabled={!!b} onClick={() => (tab.value = 'pdf')}>📄︎ PDF storyboard</button>
        </div>
        {t === 'video' && (
          <div class="exp-body">
            <p>Todos los clips en orden (con su recorte y cámara) y el audio del proyecto mezclado. {total} frames · {(total / p.fps).toFixed(1)} s a {p.fps} fps.</p>
            <label class="row"><span>Tamaño</span>
              <select value={vScale.value} onChange={(e) => (vScale.value = Number((e.target as HTMLSelectElement).value))}>
                <option value={1}>Completo ({p.width}×{p.height})</option>
                <option value={0.5}>Mitad ({Math.round(p.width / 2)}×{Math.round(p.height / 2)}) — más rápido</option>
              </select>
            </label>
            <p class="hint">Sale en MP4 (H.264 + AAC) si el dispositivo lo soporta; si no, en WebM. Mantené la app abierta mientras exporta.</p>
            <button class="primary" disabled={!!b} onClick={() => void run('video')}>Exportar video</button>
          </div>
        )}
        {t === 'png' && (
          <div class="exp-body">
            <p>Frames del recorte expandidos (los holds incluidos), numerados desde 0001, en un .zip. Ideal para importar en TVPaint.</p>
            <label class="row"><span>Clips</span>
              <select value={po.clips} onChange={(e) => (pngOpts.value = { ...po, clips: (e.target as HTMLSelectElement).value as 'current' | 'all' })}>
                <option value="current">Sólo el clip actual</option>
                <option value="all">Todos los clips (una carpeta por clip)</option>
              </select>
            </label>
            <label class="row"><span>Contenido</span>
              <select value={po.mode} onChange={(e) => (pngOpts.value = { ...po, mode: (e.target as HTMLSelectElement).value as 'composite' | 'layers' })}>
                <option value="layers">Una carpeta por capa (con transparencia)</option>
                <option value="composite">Todo compuesto (fondo blanco)</option>
              </select>
            </label>
            {po.mode === 'composite' && (
              <label class="check"><input type="checkbox" checked={po.camera} onChange={() => (pngOpts.value = { ...po, camera: !po.camera })} /> Aplicar la cámara</label>
            )}
            <button class="primary" disabled={!!b} onClick={() => void run('png')}>Exportar PNG</button>
          </div>
        )}
        {t === 'pdf' && (
          <div class="exp-body">
            <p>Un panel por plano (primer frame del recorte, con cámara) con número, nombre y duración. A4 apaisado.</p>
            <label class="row"><span>Paneles por página</span>
              <select value={pdfGrid.value.join('x')} onChange={(e) => (pdfGrid.value = (e.target as HTMLSelectElement).value.split('x').map(Number) as [number, number])}>
                <option value="2x2">4 (2×2)</option>
                <option value="3x2">6 (3×2)</option>
                <option value="3x3">9 (3×3)</option>
                <option value="4x3">12 (4×3)</option>
              </select>
            </label>
            <button class="primary" disabled={!!b} onClick={() => void run('pdf')}>Exportar PDF</button>
          </div>
        )}
        {b && (
          <div class="exp-progress">
            <div class="bar"><div style={{ width: Math.round((b.done / Math.max(1, b.total)) * 100) + '%' }} /></div>
            <span class="hint">{b.stage} · {b.done}/{b.total}</span>
            <button onClick={() => job && (job.cancelled = true)}>Cancelar</button>
          </div>
        )}
        {result.value && <p class="exp-result">{result.value}</p>}
      </div>
    </div>
  );
}
