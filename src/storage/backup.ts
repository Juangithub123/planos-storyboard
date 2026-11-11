import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { Project } from '../model/types';
import { uid } from '../model/types';
import { deleteDrawings, getDrawing, listDrawingIds, putDrawing, putProject } from './db';

export function referencedDrawings(p: Project): Set<string> {
  const s = new Set<string>();
  for (const id of p.clipOrder) for (const L of p.clips[id].layers) for (const it of L.instances) if (it.drawingId) s.add(it.drawingId);
  return s;
}

/** Borra de la base los dibujos que ya no usa ninguna instancia (sólo al abrir: el undo arranca vacío). */
export async function collectGarbage(p: Project) {
  const used = referencedDrawings(p);
  const all = await listDrawingIds(p.id);
  const orphan = all.filter((id) => !used.has(id));
  if (orphan.length) await deleteDrawings(p.id, orphan);
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const safe = (s: string) => s.replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]+/g, '_').trim() || 'proyecto';

/** Exporta proyecto + dibujos en un .zip y lo descarga. */
export async function exportBackup(p: Project): Promise<void> {
  const files: Zippable = { 'project.json': strToU8(JSON.stringify({ format: 'planos', version: 1, project: p })) };
  for (const id of referencedDrawings(p)) {
    const b = await getDrawing(p.id, id);
    if (b) files[`drawings/${id}.png`] = [new Uint8Array(await b.arrayBuffer()), { level: 0 }];
  }
  const zip = zipSync(files, { level: 6 });
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  download(new Blob([zip], { type: 'application/zip' }), `${safe(p.name)}-${stamp}.planos.zip`);
}

/** Importa un backup como proyecto nuevo (nunca pisa uno existente). */
export async function importBackup(file: File): Promise<Project> {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const meta = files['project.json'];
  if (!meta) throw new Error('El archivo no es un backup de Planos');
  const data = JSON.parse(strFromU8(meta));
  const src: Project = data.project;
  const p: Project = { ...src, id: uid(), name: src.name + ' (importado)', updatedAt: Date.now() };
  for (const [path, bytes] of Object.entries(files)) {
    const m = path.match(/^drawings\/(.+)\.png$/);
    if (m) await putDrawing(p.id, m[1], new Blob([bytes as BlobPart], { type: 'image/png' }));
  }
  await putProject(p);
  return p;
}
