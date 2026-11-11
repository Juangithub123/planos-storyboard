import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import {
  autoInstance, clip, clipId, commit, frame, layerId, onion, playing, preview, project, selection, withLayer,
} from '../model/store';
import { clipLength, playRange, trimRange } from '../model/evaluate';
import { instanceIndexAt, instanceStart, layerEnd, setDuration } from '../model/timing';
import type { Behavior, Layer, Project } from '../model/types';
import {
  addLayer, clearPlayMarks, clearTrim, deleteInstance, deleteLayer, duplicateInstance, gotoEnd, gotoStart,
  insertEmptyAfter, markPlay, markTrim, moveLayer, newInstanceHere, nudgeDuration, renameLayer, setBehavior,
  setFrame, stepFrame, stepInstance, togglePlay, toggleHold,
} from '../model/actions';
import { drawingsVersion, peekThumb } from '../render/drawings';

/** ancho de un frame en px */
const fw = signal(18);
const ROW_H = 46;
const HEAD_W = 176;
const px = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v + 'px']));

const BEH: { v: Behavior; label: string }[] = [
  { v: 'none', label: 'Cut' },
  { v: 'hold', label: 'Hold' },
  { v: 'repeat', label: 'Loop' },
];

function Thumb({ id }: { id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ver = drawingsVersion.value;
  useEffect(() => {
    const src = peekThumb(id);
    const c = ref.current;
    if (!c) return;
    if (!src) return;
    c.width = src.width;
    c.height = src.height;
    const x = c.getContext('2d')!;
    x.fillStyle = '#fff';
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(src, 0, 0);
  }, [id, ver]);
  return <canvas ref={ref} class="thumb" />;
}

function LayerHeader({ L, active }: { L: Layer; active: boolean }) {
  const p = project.value!;
  const toggle = (key: 'visible' | 'locked') =>
    commit(withLayer(p, clipId.value, L.id, (l) => ({ ...l, [key]: !l[key] })), key);
  return (
    <div class={'lhead' + (active ? ' active' : '')} style={px({ height: ROW_H })} onPointerDown={() => (layerId.value = L.id)}>
      <button class={'ib' + (L.visible ? '' : ' off')} title="Visible" onClick={() => toggle('visible')}>
        {L.visible ? '◉' : '○'}
      </button>
      <button class={'ib' + (L.locked ? ' on' : '')} title="Bloquear" onClick={() => toggle('locked')}>
        {L.locked ? '🔒︎' : '🔓︎'}
      </button>
      <div class="lname" onDblClick={() => {
        const n = prompt('Nombre de la capa', L.name);
        if (n) renameLayer(L.id, n);
      }}>
        <span>{L.name}</span>
        <span class="beh">
          <select value={L.pre} title="Antes" onChange={(e) => setBehavior('pre', (e.target as HTMLSelectElement).value as Behavior, L.id)}>
            {BEH.map((b) => <option value={b.v}>{b.label}</option>)}
          </select>
          <select value={L.post} title="Después" onChange={(e) => setBehavior('post', (e.target as HTMLSelectElement).value as Behavior, L.id)}>
            {BEH.map((b) => <option value={b.v}>{b.label}</option>)}
          </select>
        </span>
      </div>
    </div>
  );
}

interface StretchState {
  pointerId: number;
  layerId: string;
  index: number;
  startX: number;
  startDur: number;
  before: Project;
  last: Project | null;
}

function LayerTrack({ L, len, active }: { L: Layer; len: number; active: boolean }) {
  const w = fw.value;
  const sel = selection.value[L.id] ?? [];
  const blocks = [];
  let t = L.start;
  const total = layerEnd(L) - L.start;
  if (total > 0 && L.pre !== 'none' && L.start > 0) {
    blocks.push(<div class={'ext ' + L.pre} style={px({ left: 0, width: L.start * w })} />);
  }
  L.instances.forEach((it, k) => {
    const x = t * w;
    const bw = it.duration * w;
    t += it.duration;
    const selected = sel.includes(k);
    blocks.push(
      <div
        class={'inst' + (it.drawingId ? '' : ' empty') + (selected ? ' sel' : '')}
        style={px({ left: x, width: bw })}
        data-k={k}
      >
        {it.drawingId && bw >= 30 ? <Thumb id={it.drawingId} /> : null}
        {bw >= 22 ? <span class="dur">{it.duration}</span> : null}
        <div class="handle" data-handle={k} />
      </div>,
    );
  });
  if (total > 0 && L.post !== 'none' && t < len) {
    blocks.push(<div class={'ext ' + L.post} style={px({ left: t * w, width: (len - t) * w })} />);
  }
  return (
    <div class={'ltrack' + (active ? ' active' : '')} data-layer={L.id} style={px({ height: ROW_H })}>
      {blocks}
    </div>
  );
}

export function Timeline() {
  const c = clip.value;
  const p = project.value;
  const scroller = useRef<HTMLDivElement>(null);
  const stretch = useRef<StretchState | null>(null);
  const tapStart = useRef<{ x: number; y: number; id: number; pen: boolean } | null>(null);
  const scrubbing = useRef<number | null>(null);

  // seguir al cabezal mientras reproduce
  const f = frame.value;
  useEffect(() => {
    const s = scroller.current;
    if (!s) return;
    const x = HEAD_W + f * fw.peek();
    if (x < s.scrollLeft + HEAD_W || x > s.scrollLeft + s.clientWidth - 40) s.scrollLeft = x - HEAD_W - 60;
  }, [f]);

  if (!c || !p) return null;
  const len = clipLength(c);
  const w = fw.value;
  const cols = Math.max(len + 48, 120);
  const [pa, pb] = playRange(c);
  const [ta, tb] = trimRange(c);
  const hasPlay = c.playIn !== null || c.playOut !== null;
  const hasTrim = c.trimIn !== null || c.trimOut !== null;

  const frameFromEvent = (e: PointerEvent) => {
    const s = scroller.current!;
    const r = s.getBoundingClientRect();
    const x = e.clientX - r.left + s.scrollLeft - HEAD_W;
    return Math.max(0, Math.floor(x / fw.peek()));
  };

  // ---- regla (scrub)
  const onRulerDown = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    scrubbing.current = e.pointerId;
    playing.value = false;
    setFrame(frameFromEvent(e));
  };
  const onRulerMove = (e: PointerEvent) => {
    if (scrubbing.current === e.pointerId) setFrame(frameFromEvent(e));
  };
  const onRulerUp = () => (scrubbing.current = null);

  // ---- pistas
  const onTracksDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    const row = target.closest('[data-layer]') as HTMLElement | null;
    const handle = target.closest('[data-handle]') as HTMLElement | null;
    if (handle && row) {
      e.preventDefault();
      const lid = row.dataset.layer!;
      const k = Number(handle.dataset.handle);
      const L = c.layers.find((l) => l.id === lid)!;
      if (L.locked) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      stretch.current = {
        pointerId: e.pointerId, layerId: lid, index: k, startX: e.clientX,
        startDur: L.instances[k].duration, before: project.peek()!, last: null,
      };
      layerId.value = lid;
      selection.value = { [lid]: [k] };
      return;
    }
    tapStart.current = { x: e.clientX, y: e.clientY, id: e.pointerId, pen: e.pointerType !== 'touch' };
    if (e.pointerType !== 'touch') {
      // con lápiz/mouse arrastrar en las pistas hace scrub
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      scrubbing.current = e.pointerId;
      applyTap(e);
    }
  };

  const applyTap = (e: PointerEvent) => {
    const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const row = target?.closest('[data-layer]') as HTMLElement | null;
    const fr = frameFromEvent(e);
    playing.value = false;
    setFrame(fr);
    if (row) {
      const lid = row.dataset.layer!;
      layerId.value = lid;
      const L = c.layers.find((l) => l.id === lid)!;
      const k = instanceIndexAt(L, fr);
      selection.value = k >= 0 ? { [lid]: [k] } : {};
    }
  };

  const onTracksMove = (e: PointerEvent) => {
    const st = stretch.current;
    if (st && st.pointerId === e.pointerId) {
      const d = Math.round((e.clientX - st.startX) / fw.peek());
      const base = st.before;
      const L = base.clips[clipId.peek()].layers.find((l) => l.id === st.layerId)!;
      const next = withLayer(base, clipId.peek(), st.layerId, () => setDuration(L, st.index, st.startDur + d));
      st.last = next;
      preview(next);
      return;
    }
    if (scrubbing.current === e.pointerId) setFrame(frameFromEvent(e));
  };

  const onTracksUp = (e: PointerEvent) => {
    const st = stretch.current;
    if (st && st.pointerId === e.pointerId) {
      stretch.current = null;
      if (st.last) commit(st.last, 'estirar', st.before);
      else preview(st.before);
      return;
    }
    if (scrubbing.current === e.pointerId) {
      scrubbing.current = null;
      tapStart.current = null;
      return;
    }
    const t = tapStart.current;
    if (t && t.id === e.pointerId && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 10) applyTap(e);
    tapStart.current = null;
  };

  // zoom de la timeline con pinch (2 dedos) sobre la regla, o ctrl+rueda
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    fw.value = Math.max(4, Math.min(80, fw.peek() * Math.exp(-e.deltaY * 0.002)));
  };

  const L = c.layers.find((l) => l.id === layerId.value);
  const ruler = [];
  const step = w >= 14 ? 1 : w >= 7 ? 2 : 5;
  for (let i = 0; i < cols; i++) {
    const major = i === 0 || (i + 1) % (step * 5) === 0;
    if (i % step === 0 || major) {
      ruler.push(
        <div class={'tick' + (major ? ' major' : '')} style={px({ left: i * w, width: w })}>
          {major || w >= 26 ? i + 1 : ''}
        </div>,
      );
    }
  }

  return (
    <div class="timeline">
      <div class="tl-bar">
        <div class="grp">
          <button onClick={gotoStart} title="Inicio">⏮</button>
          <button onClick={() => stepInstance(-1)} title="Instancia anterior">⇤</button>
          <button onClick={() => stepFrame(-1)} title="Frame anterior">◀</button>
          <button class="play" onClick={togglePlay} title="Play (espacio)">{playing.value ? '❚❚' : '▶'}</button>
          <button onClick={() => stepFrame(1)} title="Frame siguiente">▶︎</button>
          <button onClick={() => stepInstance(1)} title="Instancia siguiente">⇥</button>
          <button onClick={gotoEnd} title="Final">⏭</button>
          <span class="counter">{f + 1}<small> / {len}</small></span>
        </div>
        <div class="grp">
          <button onClick={() => markPlay('in')} title="Mark In (loop de reproducción)">In</button>
          <button onClick={() => markPlay('out')} title="Mark Out (loop de reproducción)">Out</button>
          <button onClick={clearPlayMarks} disabled={!hasPlay} title="Borrar Mark In/Out">✕</button>
          <span class="sep" />
          <button class="trim" onClick={() => markTrim('in')} title="Recorte In (entra al animatic)">[ Rec</button>
          <button class="trim" onClick={() => markTrim('out')} title="Recorte Out (entra al animatic)">Rec ]</button>
          <button onClick={clearTrim} disabled={!hasTrim} title="Borrar recorte">✕</button>
        </div>
        <div class="grp">
          <button onClick={newInstanceHere} title="Nueva instancia en el cabezal">+ Inst</button>
          <button onClick={() => void duplicateInstance()} title="Duplicar instancia">Dup</button>
          <button onClick={insertEmptyAfter} title="Insertar instancia vacía después">Vacía</button>
          <button onClick={deleteInstance} title="Borrar instancia">Borrar</button>
          <button onClick={() => nudgeDuration(-1)} title="Acortar 1 frame">−1</button>
          <button onClick={() => nudgeDuration(1)} title="Alargar 1 frame">+1</button>
          <button class={L?.post === 'hold' ? 'on' : ''} onClick={toggleHold} title="Hold hasta el final del clip">Hold</button>
        </div>
        <div class="grp">
          <button class={autoInstance.value ? 'on' : ''} onClick={() => (autoInstance.value = !autoInstance.value)}
            title="Al dibujar en medio de una instancia, crear una nueva en el cabezal">Auto-inst</button>
          <button class={onion.value.enabled ? 'on' : ''} onClick={() => (onion.value = { ...onion.value, enabled: !onion.value.enabled })}
            title="Papel cebolla">Cebolla</button>
        </div>
        <div class="grp">
          <button onClick={addLayer} title="Nueva capa">+ Capa</button>
          <button onClick={() => moveLayer(-1)} title="Subir capa">↑</button>
          <button onClick={() => moveLayer(1)} title="Bajar capa">↓</button>
          <button onClick={deleteLayer} title="Borrar capa">− Capa</button>
          <button onClick={() => (fw.value = Math.max(4, fw.value / 1.25))} title="Alejar timeline">−</button>
          <button onClick={() => (fw.value = Math.min(80, fw.value * 1.25))} title="Acercar timeline">+</button>
        </div>
      </div>

      <div class="tl-scroll" ref={scroller} onWheel={onWheel}>
        <div class="tl-inner" style={px({ width: HEAD_W + cols * w })}>
          <div class="tl-ruler-row">
            <div class="corner" style={px({ width: HEAD_W })}>{c.name}</div>
            <div class="ruler" style={px({ width: cols * w })}
              onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp} onPointerCancel={onRulerUp}>
              {ruler}
              {hasTrim && <div class="trim-shade" style={px({ left: 0, width: ta * w })} />}
              {hasTrim && <div class="trim-shade" style={px({ left: (tb + 1) * w, width: (cols - tb - 1) * w })} />}
              {hasPlay && <div class="play-range" style={px({ left: pa * w, width: (pb - pa + 1) * w })} />}
              <div class="clip-end" style={px({ left: len * w })} />
              <div class="ph-head" style={px({ left: f * w, width: w })} />
            </div>
          </div>
          <div class="tl-rows">
            <div class="heads" style={px({ width: HEAD_W })}>
              {c.layers.map((l) => <LayerHeader key={l.id} L={l} active={l.id === layerId.value} />)}
            </div>
            <div class="tracks" style={px({ width: cols * w })}
              onPointerDown={onTracksDown} onPointerMove={onTracksMove} onPointerUp={onTracksUp} onPointerCancel={onTracksUp}>
              {c.layers.map((l) => <LayerTrack key={l.id} L={l} len={len} active={l.id === layerId.value} />)}
              {hasTrim && <div class="trim-shade" style={px({ left: 0, width: ta * w })} />}
              {hasTrim && <div class="trim-shade" style={px({ left: (tb + 1) * w, width: (cols - tb - 1) * w })} />}
              <div class="clip-end" style={px({ left: len * w })} />
              <div class="playhead" style={px({ left: f * w + w / 2 })} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export { instanceStart };
