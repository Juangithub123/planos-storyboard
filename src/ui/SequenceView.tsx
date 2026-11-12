import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { clipId, project, view } from '../model/store';
import { clipLength, trimRange } from '../model/evaluate';
import { locate, segments } from '../model/sequence';
import { playAudio, scrubAudio, stopAudio } from '../audio/engine';
import { renderOutputFrame } from '../render/output';
import { AudioTracks } from './AudioTracks';
import { seqFrame, seqPlaying } from './seqState';
import type { Clip, Project } from '../model/types';
import { addClip, deleteClip, openClip, renameClip } from '../model/actions';
import { copyClip, duplicateClip, moveClip, paste } from '../model/clipboard';
import { drawingsVersion, loadDrawing } from '../render/drawings';

const dragInfo = signal<{ id: string; over: number } | null>(null);

const tc = (f: number, fps: number) => {
  const s = Math.floor(f / fps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}:${String(f % fps).padStart(2, '0')}`;
};

function drawClipFrame(canvas: HTMLCanvasElement, p: Project, c: Clip, f: number) {
  renderOutputFrame(canvas, p, c, f);
}

function ClipThumb({ c }: { c: Clip }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const p = project.value!;
  const ver = drawingsVersion.value;
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    cv.width = 240;
    cv.height = Math.round((240 * p.height) / p.width);
    drawClipFrame(cv, p, c, trimRange(c)[0]);
  }, [c, ver, p.width, p.height]);
  return <canvas ref={ref} class="cthumb" />;
}

function Player() {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const p = project.value!;
  const segs = segments(p);
  const total = segs.reduce((s, x) => s + x.n, 0);
  const gf = Math.min(seqFrame.value, Math.max(0, total - 1));
  const ver = drawingsVersion.value;
  const loc = locate(segs, gf);

  useEffect(() => {
    const cv = ref.current;
    const host = wrap.current;
    if (!cv || !host || !loc) return;
    const r = host.getBoundingClientRect();
    const z = Math.min(r.width / p.width, r.height / p.height);
    const w = Math.max(2, Math.round(p.width * z * devicePixelRatio));
    if (cv.width !== w) {
      cv.width = w;
      cv.height = Math.round(p.height * z * devicePixelRatio);
      cv.style.width = p.width * z + 'px';
      cv.style.height = p.height * z + 'px';
    }
    drawClipFrame(cv, p, loc.seg.clip, loc.local);
  });

  useEffect(() => {
    if (!seqPlaying.value) return;
    for (const id of p.clipOrder) for (const L of p.clips[id].layers) for (const it of L.instances) if (it.drawingId) void loadDrawing(it.drawingId);
    const t0 = performance.now();
    const f0 = seqFrame.peek() >= total - 1 ? 0 : seqFrame.peek();
    playAudio(p, f0, total);
    let raf = 0;
    const loop = (t: number) => {
      const f = f0 + Math.floor(((t - t0) * p.fps) / 1000);
      if (f >= total) {
        seqFrame.value = total - 1;
        seqPlaying.value = false;
        return;
      }
      if (f !== seqFrame.peek()) seqFrame.value = f;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      stopAudio();
    };
  }, [seqPlaying.value]);
  void ver;

  const scrub = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    seqFrame.value = Math.max(0, Math.min(total - 1, Math.floor(((e.clientX - r.left) / r.width) * total)));
    scrubAudio(p, seqFrame.value);
  };

  return (
    <div class="player">
      <div class="player-stage" ref={wrap} data-help="Visor del animatic" data-help-docs="clips" data-help-text="Muestra la secuencia completa: cada clip con su recorte, uno tras otro."><canvas ref={ref} /></div>
      <div class="player-bar" data-help="Reproducción" data-help-docs="clips" data-help-text="Play/pausa e inicio. Timecode actual / total (min:seg:frames), el plano que se está viendo y la duración total.">
        <button class="play" onClick={() => (seqPlaying.value = !seqPlaying.value)}>{seqPlaying.value ? '❚❚' : '▶'}</button>
        <button onClick={() => (seqFrame.value = 0)} title="Inicio">⏮</button>
        <span class="counter">{tc(gf, p.fps)}<small> / {tc(total, p.fps)}</small></span>
        <span class="hint">{loc ? `${p.clipOrder.indexOf(loc.seg.clip.id) + 1}. ${loc.seg.clip.name}` : ''}</span>
        <span class="grow" />
        <span class="hint">{total} frames · {(total / p.fps).toFixed(1)} s</span>
      </div>
      <div class="srow"><span class="slabel">Planos</span><div class="strip" data-help="Tira de la secuencia" data-help-docs="clips" data-help-text="Cada bloque es un plano con su duración relativa. Tocá o arrastrá para hacer scrub. En amarillo, el clip actual." onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        seqPlaying.value = false;
        scrub(e);
      }} onPointerMove={(e) => e.buttons && scrub(e)}>
        {segs.map((s, i) => (
          <div class={'seg' + (s.clip.id === clipId.value ? ' cur' : '')} style={{ left: (s.start / total) * 100 + '%', width: (s.n / total) * 100 + '%' }}>
            <span>{i + 1}</span>
          </div>
        ))}
        <div class="seg-ph" style={{ left: (gf / Math.max(1, total)) * 100 + '%' }} />
      </div></div>
      <AudioTracks total={total} />
    </div>
  );
}

export function SequenceView() {
  const p = project.value;
  const grid = useRef<HTMLDivElement>(null);
  if (!p) return null;
  const segs = segments(p);
  const di = dragInfo.value;

  const indexAt = (x: number, y: number) => {
    if (!grid.current) return p.clipOrder.length;
    const cards = [...grid.current.querySelectorAll<HTMLElement>('.ccard')];
    let best = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (y < r.top - 6) { best = Math.min(best, i); break; }
      if (y <= r.bottom + 6 && x < r.left + r.width / 2) { best = i; break; }
    }
    return best;
  };

  const startDrag = (e: PointerEvent, id: string) => {
    const el = e.currentTarget as HTMLElement;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const pid = e.pointerId;
    let active = false;
    let timer = 0;
    const begin = () => {
      active = true;
      el.setPointerCapture(pid);
      dragInfo.value = { id, over: p.clipOrder.indexOf(id) };
      navigator.vibrate?.(15);
    };
    if (e.pointerType === 'touch') timer = window.setTimeout(begin, 380);
    else el.setPointerCapture(pid);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      if (!active) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) {
          if (e.pointerType === 'touch') return cleanup();
          begin();
        } else return;
      }
      ev.preventDefault();
      dragInfo.value = { id, over: indexAt(ev.clientX, ev.clientY) };
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      const d = dragInfo.value;
      if (active && d) {
        const from = p.clipOrder.indexOf(id);
        moveClip(id, d.over > from ? d.over - 1 : d.over);
      } else if (!active && ev.type === 'pointerup' && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) {
        openClip(id);
        view.value = 'clip';
      }
      cleanup();
    };
    const blockTouch = (ev: TouchEvent) => active && ev.preventDefault();
    const cleanup = () => {
      clearTimeout(timer);
      dragInfo.value = null;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('touchmove', blockTouch);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('touchmove', blockTouch, { passive: false });
  };

  return (
    <div class="sequence">
      <Player />
      <div class="seq-tools" data-help="Herramientas del storyboard" data-help-docs="copiar" data-help-text="+ Clip crea un plano nuevo. Pegar clip inserta el clip copiado después del actual.">
        <b>Storyboard</b>
        <span class="hint">Tocá un plano para abrirlo · arrastralo para reordenar (en táctil: mantené presionado)</span>
        <span class="grow" />
        <button onClick={() => { addClip(); view.value = 'sequence'; }}>+ Clip</button>
        <button onClick={() => void paste('clip')} title="Pegar clip copiado después del actual">Pegar clip</button>
      </div>
      <div class="cgrid" ref={grid} data-help="Storyboard" data-help-docs="clips" data-help-text="Planos numerados con miniatura (primer frame del recorte) y duración. Tocar abre el plano; arrastrar reordena (táctil: mantener presionado). ◀ ▶ mueven, Dup duplica, Copiar, ✕ borra. Tocar el nombre lo renombra.">
        {segs.map((s, i) => {
          const c = s.clip;
          const len = clipLength(c);
          const trimmed = s.n !== len;
          return (
            <div class={'ccard' + (c.id === clipId.value ? ' cur' : '') + (di?.id === c.id ? ' dragging' : '') + (di && di.over === i && di.id !== c.id ? ' dropbefore' : '')}
              key={c.id}>
              <div class="cthumb-wrap" onPointerDown={(e) => startDrag(e, c.id)}>
                <ClipThumb c={c} />
                <span class="cnum">{i + 1}</span>
              </div>
              <div class="cmeta">
                <span class="cname" onClick={() => {
                  const n = prompt('Nombre del clip', c.name);
                  if (n) { clipId.value = c.id; renameClip(n); }
                }}>{c.name}</span>
                <span class="hint">{s.n}f · {(s.n / p.fps).toFixed(2)}s{trimmed ? ` (de ${len})` : ''}</span>
              </div>
              <div class="cbtns">
                <button onClick={() => moveClip(c.id, i - 1)} disabled={i === 0} title="Mover antes">◀</button>
                <button onClick={() => moveClip(c.id, i + 1)} disabled={i === segs.length - 1} title="Mover después">▶</button>
                <button onClick={() => void duplicateClip(c.id)} title="Duplicar">Dup</button>
                <button onClick={() => copyClip(c.id)} title="Copiar">Copiar</button>
                <button class="danger" onClick={() => {
                  if (confirm(`¿Borrar el clip "${c.name}"?`)) { clipId.value = c.id; deleteClip(); }
                }} title="Borrar">✕</button>
              </div>
            </div>
          );
        })}
        {di && di.over >= segs.length && <div class="dropend" />}
      </div>
    </div>
  );
}
