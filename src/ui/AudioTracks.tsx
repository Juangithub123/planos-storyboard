import { useEffect, useRef } from 'preact/hooks';
import { commit, preview, project } from '../model/store';
import { audioMuted, audioVersion, peakRange } from '../audio/engine';
import {
  addTrack, deleteAudioClip, deleteTrack, editAudioClip, findAudioClip, importAudio, updateAudioClip, updateTrack,
} from '../model/audio';
import type { AudioClip, Project } from '../model/types';
import { seqFrame, seqPlaying, selAudio, selTrack } from './seqState';

/**
 * Pistas de audio del proyecto, alineadas con la tira de la secuencia (misma escala).
 * Tocar un clip lo selecciona; arrastrarlo lo mueve en el tiempo.
 */

function ClipWave({ cl, w, h, fps }: { cl: AudioClip; w: number; h: number; fps: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ver = audioVersion.value;
  useEffect(() => {
    const cv = ref.current;
    if (!cv || w < 2) return;
    cv.width = Math.min(4000, Math.ceil(w));
    cv.height = h;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, h);
    ctx.fillStyle = '#9fe0bd';
    const per = cl.duration / cv.width;
    for (let x = 0; x < cv.width; x++) {
      const a = peakRange(cl.assetId, cl.srcIn + x * per, cl.srcIn + (x + 1) * per) * cl.volume;
      const hh = Math.min(1, a) * (h / 2 - 1);
      ctx.fillRect(x, h / 2 - hh, 1, hh * 2);
    }
    void fps;
  }, [cl.assetId, cl.srcIn, cl.duration, cl.volume, w, h, ver]);
  return <canvas ref={ref} class="awave" />;
}

function pick(accept: string, then: (f: File) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.onchange = () => input.files?.[0] && then(input.files[0]);
  input.click();
}

export function AudioTracks({ total }: { total: number }) {
  const p = project.value!;
  const tracks = p.audioTracks ?? [];
  const sel = selAudio.value ? findAudioClip(p, selAudio.value) : null;
  const gf = seqFrame.value;
  const laneRef = useRef<HTMLDivElement>(null);
  const span = Math.max(1, total);

  const startMove = (e: PointerEvent, cl: AudioClip) => {
    e.stopPropagation();
    selAudio.value = cl.id;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const lane = el.parentElement!.getBoundingClientRect();
    const x0 = e.clientX;
    const before = project.peek()!;
    let last: Project | null = null;
    const move = (ev: PointerEvent) => {
      const df = Math.round(((ev.clientX - x0) / lane.width) * span);
      if (!df && !last) return;
      last = updateAudioClip('mover audio', cl.id, (c) => ({ ...c, start: Math.max(0, cl.start + df) }), before);
      if (last) preview(last);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (last) commit(last, 'mover audio', before);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const num = (v: string) => Number(v.replace(',', '.'));

  return (
    <div class="atracks" data-help="Pistas de audio" data-help-docs="audio"
      data-help-text="Audio del animatic. + Pista crea una pista; Importar audio agrega un archivo en el cabezal de la secuencia. Tocá un clip para editarlo (inicio, recorte, volumen) o arrastralo para moverlo. M silencia una pista.">
      <div class="atools">
        <b>Audio</b>
        <button onClick={() => { const t = addTrack(); if (t) selTrack.value = t.id; }}>+ Pista</button>
        <button onClick={() => pick('audio/*', async (f) => {
          seqPlaying.value = false;
          const cl = await importAudio(f, selTrack.value, seqFrame.peek());
          if (cl) selAudio.value = cl.id;
        })} title="Importar un audio en el cabezal de la secuencia">Importar audio…</button>
        <button class={audioMuted.value ? 'on' : ''} onClick={() => (audioMuted.value = !audioMuted.value)}
          title="Silenciar reproducción y scrub (el export incluye el audio igual)">{audioMuted.value ? '🔇︎ Silenciado' : '🔊︎ Sonido'}</button>
        <span class="grow" />
        {sel && (
          <span class="aedit">
            <b>{sel.clip.name}</b>
            <label>Inicio <input type="number" min={1} value={sel.clip.start + 1}
              onChange={(e) => editAudioClip('inicio audio', sel.clip.id, (c) => ({ ...c, start: Math.max(0, Math.round(num((e.target as HTMLInputElement).value)) - 1) }))} />f</label>
            <label>Saltear <input type="number" min={0} step={0.1} value={+sel.clip.srcIn.toFixed(2)}
              onChange={(e) => editAudioClip('recorte audio', sel.clip.id, (c) => ({ ...c, srcIn: Math.max(0, num((e.target as HTMLInputElement).value) || 0) }))} />s</label>
            <label>Dura <input type="number" min={0.1} step={0.1} value={+sel.clip.duration.toFixed(2)}
              onChange={(e) => editAudioClip('duración audio', sel.clip.id, (c) => ({ ...c, duration: Math.max(0.05, num((e.target as HTMLInputElement).value) || c.duration) }))} />s</label>
            <label>Vol <input type="range" min={0} max={1.5} step={0.05} value={sel.clip.volume}
              onInput={(e) => editAudioClip('volumen audio', sel.clip.id, (c) => ({ ...c, volume: num((e.target as HTMLInputElement).value) }))} />
              {Math.round(sel.clip.volume * 100)}%</label>
            <button onClick={() => editAudioClip('audio al cabezal', sel.clip.id, (c) => ({ ...c, start: gf }))} title="Mover el inicio al cabezal">⇥ Cabezal</button>
            <button class="danger" onClick={() => { deleteAudioClip(sel.clip.id); selAudio.value = null; }}>✕</button>
          </span>
        )}
      </div>
      <div class="alist">
        {tracks.length === 0 && <p class="hint">Sin audio. Usá "Importar audio…" para agregar música, diálogos o efectos.</p>}
        {tracks.map((t) => (
          <div class={'atrack' + (selTrack.value === t.id ? ' cur' : '')} key={t.id}>
            <div class="athead" onPointerDown={() => (selTrack.value = t.id)}>
              <span class="atname" onDblClick={() => {
                const n = prompt('Nombre de la pista', t.name);
                if (n) updateTrack('renombrar pista', t.id, (x) => ({ ...x, name: n }));
              }}>{t.name}</span>
              <button class={'ib' + (t.muted ? ' on' : '')} title="Silenciar pista" onClick={() => updateTrack('mute pista', t.id, (x) => ({ ...x, muted: !x.muted }))}>M</button>
              <input type="range" min={0} max={1.5} step={0.05} value={t.volume} title={`Volumen ${Math.round(t.volume * 100)}%`}
                onInput={(e) => updateTrack('volumen pista', t.id, (x) => ({ ...x, volume: Number((e.target as HTMLInputElement).value) }))} />
              <button class="ib" title="Borrar pista" onClick={() => confirm(`¿Borrar la pista "${t.name}" y sus audios?`) && deleteTrack(t.id)}>✕</button>
            </div>
            <div class={'alanes' + (t.muted ? ' muted' : '')} ref={laneRef} onPointerDown={() => { selTrack.value = t.id; selAudio.value = null; }}>
              {t.clips.map((cl) => {
                const left = (cl.start / span) * 100;
                const width = ((cl.duration * p.fps) / span) * 100;
                return (
                  <div class={'aclip' + (sel?.clip.id === cl.id ? ' sel' : '')} style={{ left: left + '%', width: width + '%' }}
                    onPointerDown={(e) => startMove(e, cl)}>
                    <ClipWave cl={cl} w={(width / 100) * (laneRef.current?.clientWidth ?? 600)} h={30} fps={p.fps} />
                    <span>{cl.name}</span>
                  </div>
                );
              })}
              <div class="seg-ph" style={{ left: (gf / span) * 100 + '%' }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
