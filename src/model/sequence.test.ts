import { describe, expect, it } from 'vitest';
import type { Clip, Project } from './types';
import { camAt, locate, segments, toSequenceFrame, totalFrames } from './sequence';

const clip = (id: string, len: number, trimIn: number | null = null, trimOut: number | null = null): Clip => ({
  id, name: id, playIn: null, playOut: null, trimIn, trimOut,
  layers: [{ kind: 'paint', id: id + 'L', name: 'L', visible: true, locked: false, opacity: 1, blend: 'normal', start: 0, pre: 'none', post: 'none', instances: [{ id: 'i', duration: len, drawingId: null }] }],
});
const proj = (clips: Clip[]): Project => ({
  id: 'p', name: 'p', width: 100, height: 50, fps: 24, clipOrder: clips.map((c) => c.id),
  clips: Object.fromEntries(clips.map((c) => [c.id, c])), palette: [], createdAt: 0, updatedAt: 0, lastBackupAt: 0,
});

describe('secuencia', () => {
  const p = proj([clip('a', 10), clip('b', 20, 5, 14), clip('c', 4)]);
  it('segmentos con recorte', () => {
    expect(segments(p).map((s) => [s.start, s.a, s.n])).toEqual([[0, 0, 10], [10, 5, 10], [20, 0, 4]]);
    expect(totalFrames(p)).toBe(24);
  });
  it('locate y toSequenceFrame son inversas', () => {
    const segs = segments(p);
    const l = locate(segs, 12)!;
    expect([l.seg.clip.id, l.local]).toEqual(['b', 7]);
    expect(toSequenceFrame(segs, 'b', 7)).toBe(12);
    expect(toSequenceFrame(segs, 'b', 2)).toBeNull(); // fuera del recorte
  });
  it('cámara interpolada entre inicio y fin del recorte', () => {
    const c = clip('a', 11);
    c.camera = { enabled: true, ease: 'linear', start: { x: 0, y: 0, zoom: 1, rot: 0 }, end: { x: 100, y: 50, zoom: 4, rot: 90 } };
    expect(camAt(c, 0)).toEqual({ x: 0, y: 0, zoom: 1, rot: 0 });
    const mid = camAt(c, 5)!;
    expect(mid.x).toBeCloseTo(50);
    expect(mid.zoom).toBeCloseTo(2); // logarítmico
    expect(camAt(c, 10)!.rot).toBeCloseTo(90);
    c.camera.enabled = false;
    expect(camAt(c, 3)).toBeNull();
  });
});
