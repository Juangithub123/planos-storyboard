import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Id, Project } from '../model/types';

interface Schema extends DBSchema {
  projects: { key: Id; value: Project };
  drawings: { key: string; value: { key: string; projectId: Id; id: Id; blob: Blob }; indexes: { byProject: Id } };
  assets: { key: string; value: { key: string; projectId: Id; id: Id; blob: Blob }; indexes: { byProject: Id } };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;

export function db() {
  if (!dbp) {
    dbp = openDB<Schema>('planos', 2, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          d.createObjectStore('projects', { keyPath: 'id' });
          const s = d.createObjectStore('drawings', { keyPath: 'key' });
          s.createIndex('byProject', 'projectId');
        }
        if (oldVersion < 2) {
          const a = d.createObjectStore('assets', { keyPath: 'key' });
          a.createIndex('byProject', 'projectId');
        }
      },
      // otra pestaña con una versión más nueva necesita actualizar la base: cerrar la nuestra
      blocking() {
        void dbp?.then((d) => d.close());
        dbp = null;
      },
      // una pestaña vieja tiene la base abierta: avisar
      blocked() {
        alert('Planos está abierto en otra pestaña con una versión anterior. Cerrala para continuar.');
      },
    });
  }
  return dbp;
}

const dkey = (projectId: Id, id: Id) => `${projectId}:${id}`;

export async function listProjects(): Promise<Project[]> {
  const all = await (await db()).getAll('projects');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: Id) {
  return (await db()).get('projects', id);
}

export async function putProject(p: Project) {
  await (await db()).put('projects', p);
}

export async function deleteProject(id: Id) {
  const d = await db();
  const tx = d.transaction(['projects', 'drawings', 'assets'], 'readwrite');
  await tx.objectStore('projects').delete(id);
  for (const store of ['drawings', 'assets'] as const) {
    const idx = tx.objectStore(store).index('byProject');
    for (let c = await idx.openCursor(id); c; c = await c.continue()) await c.delete();
  }
  await tx.done;
}

export async function putDrawing(projectId: Id, id: Id, blob: Blob) {
  await (await db()).put('drawings', { key: dkey(projectId, id), projectId, id, blob });
}

export async function getDrawing(projectId: Id, id: Id): Promise<Blob | undefined> {
  return (await (await db()).get('drawings', dkey(projectId, id)))?.blob;
}

export async function listDrawingIds(projectId: Id): Promise<Id[]> {
  const keys = await (await db()).getAllKeysFromIndex('drawings', 'byProject', projectId);
  return keys.map((k) => k.slice(projectId.length + 1));
}

export async function deleteDrawings(projectId: Id, ids: Id[]) {
  const d = await db();
  const tx = d.transaction('drawings', 'readwrite');
  for (const id of ids) tx.store.delete(dkey(projectId, id));
  await tx.done;
}

/** Pide al navegador que no borre los datos automáticamente. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

// --- assets (videos de referencia)
export async function putAsset(projectId: Id, id: Id, blob: Blob) {
  await (await db()).put('assets', { key: dkey(projectId, id), projectId, id, blob });
}

export async function getAsset(projectId: Id, id: Id): Promise<Blob | undefined> {
  return (await (await db()).get('assets', dkey(projectId, id)))?.blob;
}

export async function listAssetIds(projectId: Id): Promise<Id[]> {
  const keys = await (await db()).getAllKeysFromIndex('assets', 'byProject', projectId);
  return keys.map((k) => k.slice(projectId.length + 1));
}

export async function deleteAssets(projectId: Id, ids: Id[]) {
  const d = await db();
  const tx = d.transaction('assets', 'readwrite');
  for (const id of ids) tx.store.delete(dkey(projectId, id));
  await tx.done;
}
