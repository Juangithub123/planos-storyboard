import { useEffect, useRef } from 'preact/hooks';
import { audioMuted, audioVersion, peakRange } from '../audio/engine';
import type { Clip, Project } from '../model/types';
import { segments } from '../model/sequence';

/**
 * Forma de onda del audio del proyecto en el tramo que corresponde al clip actual
 * (según su posición y recorte en la secuencia). Va debajo de las capas en la timeline.
 */
export function AudioHead({ h }: { h: number }) {
  return (
    <div class="ahead" style={{ height: h + 'px' }}>
      <span>♪ Audio</span>
      <button class={'ib' + (audioMuted.value ? ' on' : '')} title={audioMuted.value ? 'Activar sonido' : 'Silenciar (scrub y reproducción)'}
        onClick={() => (audioMuted.value = !audioMuted.value)}>{audioMuted.value ? '🔇︎' : '🔊︎'}</button>
    </div>
  );
}

export function AudioLane({ p, c, cols, fw, h }: { p: Project; c: Clip; cols: number; fw: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ver = audioVersion.value;
  const muted = audioMuted.value;
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const cssW = cols * fw;
    const k = Math.min(1, 16000 / cssW); // límite de ancho de canvas
    cv.width = Math.max(1, Math.floor(cssW * k));
    cv.height = h;
    cv.style.width = cssW + 'px';
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const seg = segments(p).find((s) => s.clip.id === c.id);
    if (!seg) return;
    // fuera del recorte: sombreado
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(seg.a * fw * k, 0, seg.n * fw * k, h);
    const clips = (p.audioTracks ?? []).filter((t) => !t.muted).flatMap((t) => t.clips.map((cl) => ({ cl, vol: t.volume })));
    if (!clips.length) return;
    ctx.fillStyle = muted ? '#6b6f7d' : '#4bb37a';
    const mid = h / 2;
    for (let x = 0; x < cv.width; x++) {
      const f0 = x / (fw * k);
      const f1 = (x + 1) / (fw * k);
      if (f1 <= seg.a || f0 >= seg.a + seg.n) continue;
      const t0 = (seg.start + f0 - seg.a) / p.fps;
      const t1 = (seg.start + f1 - seg.a) / p.fps;
      let amp = 0;
      for (const { cl, vol } of clips) {
        const cs = cl.start / p.fps;
        if (t1 <= cs || t0 >= cs + cl.duration) continue;
        amp = Math.max(amp, peakRange(cl.assetId, t0 - cs + cl.srcIn, t1 - cs + cl.srcIn) * cl.volume * vol);
      }
      if (amp > 0) {
        const a = Math.min(1, amp) * (mid - 1);
        ctx.fillRect(x, mid - a, 1, a * 2);
      }
    }
  }, [p, c, cols, fw, h, ver, muted]);
  return <div class="alane" style={{ height: h + 'px' }}><canvas ref={ref} /></div>;
}
