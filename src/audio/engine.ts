import { signal } from '@preact/signals';
import type { AudioTrack, Id, Project } from '../model/types';
import { getAsset } from '../storage/db';

/**
 * Audio del proyecto: varias pistas con clips ubicados en frames de la secuencia.
 * Decodifica los archivos una vez (AudioBuffer) y calcula picos para dibujar la forma de onda.
 */

/** Silencia el scrub y la reproducción (no afecta el export). */
export const audioMuted = signal(false);
/** Cambia cuando termina de decodificarse un audio (para redibujar formas de onda). */
export const audioVersion = signal(0);

const PEAKS_PER_SEC = 120;
let projectId = '';
let ctx: AudioContext | null = null;
const buffers = new Map<Id, AudioBuffer>();
const pending = new Map<Id, Promise<AudioBuffer | null>>();
const peaks = new Map<Id, Float32Array>();
let playing: AudioBufferSourceNode[] = [];

export function audioCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function initAudio(pid: Id, p?: Project) {
  stopAudio();
  projectId = pid;
  buffers.clear();
  pending.clear();
  peaks.clear();
  if (p) for (const t of p.audioTracks ?? []) for (const c of t.clips) void loadBuffer(c.assetId);
}

function computePeaks(b: AudioBuffer): Float32Array {
  const n = Math.ceil(b.duration * PEAKS_PER_SEC);
  const out = new Float32Array(n);
  const step = b.sampleRate / PEAKS_PER_SEC;
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      let m = 0;
      const s0 = Math.floor(i * step);
      const s1 = Math.min(d.length, Math.floor((i + 1) * step));
      for (let s = s0; s < s1; s += 4) {
        const v = Math.abs(d[s]);
        if (v > m) m = v;
      }
      if (m > out[i]) out[i] = m;
    }
  }
  return out;
}

export function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  return blob.arrayBuffer().then((ab) => audioCtx().decodeAudioData(ab));
}

export function loadBuffer(id: Id): Promise<AudioBuffer | null> {
  const b = buffers.get(id);
  if (b) return Promise.resolve(b);
  let p = pending.get(id);
  if (p) return p;
  const pid = projectId;
  p = (async () => {
    const blob = await getAsset(pid, id);
    if (!blob || pid !== projectId) return null;
    try {
      const buf = await decodeBlob(blob);
      buffers.set(id, buf);
      peaks.set(id, computePeaks(buf));
      audioVersion.value++;
      return buf;
    } catch (e) {
      console.error('No se pudo decodificar el audio', e);
      return null;
    }
  })();
  pending.set(id, p);
  return p;
}

/** Registra un buffer ya decodificado (al importar). */
export function registerBuffer(id: Id, buf: AudioBuffer) {
  buffers.set(id, buf);
  peaks.set(id, computePeaks(buf));
  audioVersion.value++;
}

/** Pico (0..1) de un asset en el segundo t, o 0 si no está cargado. */
export function peakAt(id: Id, t: number): number {
  const p = peaks.get(id);
  if (!p || t < 0) return 0;
  const i = Math.floor(t * PEAKS_PER_SEC);
  return i < p.length ? p[i] : 0;
}

/** Máximo de picos entre t0 y t1 (para dibujar un píxel que abarca varios picos). */
export function peakRange(id: Id, t0: number, t1: number): number {
  const p = peaks.get(id);
  if (!p) return 0;
  let i0 = Math.max(0, Math.floor(t0 * PEAKS_PER_SEC));
  const i1 = Math.min(p.length - 1, Math.floor(t1 * PEAKS_PER_SEC));
  let m = 0;
  for (; i0 <= i1; i0++) if (p[i0] > m) m = p[i0];
  return m;
}

/**
 * Programa los clips de audio en un contexto (en vivo u offline) desde el segundo `from`
 * de la secuencia hasta `to` (exclusivo), empezando a sonar en `when`.
 */
export function schedule(
  c: BaseAudioContext, dest: AudioNode, tracks: AudioTrack[], fps: number, from: number, to: number, when: number,
): AudioBufferSourceNode[] {
  const out: AudioBufferSourceNode[] = [];
  for (const tr of tracks) {
    if (tr.muted || tr.volume <= 0) continue;
    for (const cl of tr.clips) {
      const buf = buffers.get(cl.assetId);
      if (!buf) {
        void loadBuffer(cl.assetId);
        continue;
      }
      const cs = cl.start / fps;
      const ce = cs + cl.duration;
      if (ce <= from || cs >= to) continue;
      const off = Math.max(0, from - cs);
      const startAt = when + Math.max(0, cs - from);
      const dur = Math.min(ce, to) - Math.max(cs, from);
      if (dur <= 0) continue;
      const src = c.createBufferSource();
      src.buffer = buf;
      const g = c.createGain();
      g.gain.value = cl.volume * tr.volume;
      src.connect(g).connect(dest);
      src.start(startAt, cl.srcIn + off, dur);
      out.push(src);
    }
  }
  return out;
}

export function stopAudio() {
  for (const s of playing) {
    try {
      s.stop();
    } catch {
      /* ya terminado */
    }
  }
  playing = [];
}

/** Reproduce el audio del proyecto desde el frame `fromFrame` de la secuencia, hasta `toFrame` (opcional). */
export function playAudio(p: Project, fromFrame: number, toFrame = Infinity, delay = 0) {
  stopAudio();
  if (audioMuted.peek() || !p.audioTracks?.length) return;
  const c = audioCtx();
  playing = schedule(c, c.destination, p.audioTracks, p.fps, fromFrame / p.fps, toFrame / p.fps, c.currentTime + 0.03 + delay);
}

let lastScrub = 0;
/** Suena un fragmento corto en ese frame (al arrastrar el cabezal). */
export function scrubAudio(p: Project, frame: number) {
  if (audioMuted.peek() || !p.audioTracks?.length) return;
  const now = performance.now();
  if (now - lastScrub < 35) return;
  lastScrub = now;
  const c = audioCtx();
  const len = Math.max(0.07, 1.5 / p.fps);
  const g = c.createGain();
  const t0 = c.currentTime + 0.01;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(1, t0 + 0.008);
  g.gain.setValueAtTime(1, t0 + len - 0.012);
  g.gain.linearRampToValueAtTime(0, t0 + len);
  g.connect(c.destination);
  schedule(c, g, p.audioTracks, p.fps, frame / p.fps, frame / p.fps + len, t0);
}

/** Mezcla todo el audio del proyecto (para exportar). */
export async function mixdown(p: Project, frames: number, sampleRate = 48000): Promise<AudioBuffer | null> {
  if (!p.audioTracks?.some((t) => !t.muted && t.clips.length)) return null;
  for (const t of p.audioTracks) for (const c of t.clips) await loadBuffer(c.assetId);
  const secs = frames / p.fps;
  const off = new OfflineAudioContext(2, Math.max(1, Math.ceil(secs * sampleRate)), sampleRate);
  schedule(off, off.destination, p.audioTracks, p.fps, 0, secs, 0);
  return off.startRendering();
}
