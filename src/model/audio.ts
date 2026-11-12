import { commit, project, say } from './store';
import { uid, type AudioClip, type AudioTrack, type Id, type Project } from './types';
import { decodeBlob, registerBuffer } from '../audio/engine';
import { putAsset } from '../storage/db';

/** Edición de pistas y clips de audio del proyecto. */

function withTracks(p: Project, fn: (t: AudioTrack[]) => AudioTrack[]): Project {
  return { ...p, audioTracks: fn(p.audioTracks ?? []) };
}

export function addTrack(): AudioTrack | null {
  const p = project.peek();
  if (!p) return null;
  const t: AudioTrack = { id: uid(), name: `Audio ${(p.audioTracks?.length ?? 0) + 1}`, volume: 1, muted: false, clips: [] };
  commit(withTracks(p, (ts) => [...ts, t]), 'nueva pista de audio');
  return t;
}

export function updateTrack(label: string, tid: Id, fn: (t: AudioTrack) => AudioTrack) {
  const p = project.peek();
  if (p) commit(withTracks(p, (ts) => ts.map((t) => (t.id === tid ? fn(t) : t))), label);
}

export function deleteTrack(tid: Id) {
  const p = project.peek();
  if (p) commit(withTracks(p, (ts) => ts.filter((t) => t.id !== tid)), 'borrar pista');
}

export function updateAudioClip(label: string, cid: Id, fn: (c: AudioClip) => AudioClip, base = project.peek()) {
  if (!base) return null;
  return withTracks(base, (ts) => ts.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === cid ? fn(c) : c)) })));
}

export function editAudioClip(label: string, cid: Id, fn: (c: AudioClip) => AudioClip) {
  const next = updateAudioClip(label, cid, fn);
  if (next) commit(next, label);
}

export function deleteAudioClip(cid: Id) {
  const p = project.peek();
  if (p) commit(withTracks(p, (ts) => ts.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== cid) }))), 'borrar audio');
}

export function findAudioClip(p: Project, cid: Id): { track: AudioTrack; clip: AudioClip } | null {
  for (const t of p.audioTracks ?? []) for (const c of t.clips) if (c.id === cid) return { track: t, clip: c };
  return null;
}

/** Importa un archivo de audio a una pista (la crea si no hay), empezando en `startFrame` de la secuencia. */
export async function importAudio(file: File, trackId: Id | null, startFrame: number): Promise<AudioClip | null> {
  let p = project.peek();
  if (!p) return null;
  let buf: AudioBuffer;
  try {
    buf = await decodeBlob(file);
  } catch {
    say('No se pudo leer ese audio');
    return null;
  }
  say('Importando audio…');
  const assetId = uid();
  await putAsset(p.id, assetId, file);
  registerBuffer(assetId, buf);
  p = project.peek()!;
  let tid = trackId && p.audioTracks?.some((t) => t.id === trackId) ? trackId : p.audioTracks?.[0]?.id ?? null;
  let tracks = p.audioTracks ?? [];
  if (!tid) {
    const t: AudioTrack = { id: uid(), name: 'Audio 1', volume: 1, muted: false, clips: [] };
    tracks = [...tracks, t];
    tid = t.id;
  }
  const clip: AudioClip = {
    id: uid(), assetId, name: file.name.replace(/\.[^.]+$/, ''), start: Math.max(0, Math.round(startFrame)),
    srcIn: 0, duration: buf.duration, volume: 1,
  };
  commit({
    ...p,
    assets: { ...(p.assets ?? {}), [assetId]: { name: file.name, mime: file.type || 'audio/mpeg', duration: buf.duration } },
    audioTracks: tracks.map((t) => (t.id === tid ? { ...t, clips: [...t.clips, clip] } : t)),
  }, 'importar audio');
  say(`Audio importado: ${buf.duration.toFixed(1)} s`);
  return clip;
}

/** Último frame (exclusivo) donde suena algo. */
export function audioEndFrame(p: Project): number {
  let end = 0;
  for (const t of p.audioTracks ?? []) for (const c of t.clips) end = Math.max(end, c.start + Math.ceil(c.duration * p.fps));
  return end;
}
