import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import {
  autoInstance, clip, clipId, commit, durationPanelOpen, frame, layerId, multiMode, onion, playing, preview,
  project, scaleMode, selection, withLayer, withLayers,
} from '../model/store';
import { clipLength, playRange, trimRange } from '../model/evaluate';
import {
  addEach, instanceIndexAt, instanceStart, layerEnd, moveInstance, scaleSelection, selectionSpan, setDuration,
  type Selection,
} from '../model/timing';
import type { Behavior, Layer, Project } from '../model/types';
import {
  addLayer, clearPlayMarks, clearTrim, deleteInstance, deleteLayer, duplicateInstance, gotoEnd, gotoStart,
  insertEmptyAfter, markPlay, markTrim, moveLayer, newInstanceHere, nudgeDuration, renameLayer, setBehavior,
  setFrame, stepFrame, stepInstance, togglePlay, toggleHold,
} from '../model/actions';
import { cleanSelection, copyInstances, copyLayer, paste, selectAllClip, selectionInfo } from '../model/clipboard';
import { drawingsVersion, peekThumb } from '../render/drawings';

/** ancho de un frame en px */
const fw = signal(18);
const ROW_H = 46;
const HEAD_W = 176;
const px = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v + 'px']));
/** marcador de destino al reordenar: {layerId, frame} */
const dropMark = signal<{ row: number; x: number } | null>(null);
const rectMark = signal<{ x0: number; x1: number; r0: number; r1: number } | null>(null);

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
    if (!c || !src) return;
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

function LayerTrack({ L, len, active, sel }: { L: Layer; len: number; active: boolean; sel: number[] }) {
  const w = fw.value;
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
      <div class={'inst' + (it.drawingId ? '' : ' empty') + (selected ? ' sel' : '')} style={px({ left: x, width: bw })} data-k={k}>
        {it.drawingId && bw >= 30 ? <Thumb id={it.drawingId} /> : null}
        {bw >= 22 ? <span class="dur">{it.duration}</span> : null}
        {!L.locked && <div class="handle" data-handle={k} />}
      </div>,
    );
  });
  if (total > 0 && L.post !== 'none' && t < len) {
    blocks.push(<div class={'ext ' + L.post} style={px({ left: t * w, width: (len - t) * w })} />);
  }
  return (
    <div class={'ltrack' + (active ? ' active' : '') + (L.locked ? ' locked' : '')} data-layer={L.id} style={px({ height: ROW_H })}>
      {blocks}
    </div>
  );
}

/** Estado de un arrastre en las pistas. */
type Drag =
  | { kind: 'stretch'; id: number; layerId: string; index: number; x0: number; dur0: number; before: Project; last: Project | null }
  | { kind: 'scale'; id: number; edge: 'l' | 'r'; x0: number; sel: Selection; before: Project; last: Project | null }
  | { kind: 'pending'; id: number; x0: number; y0: number; pen: boolean; row: number; k: number; timer: number; movable: boolean }
  | { kind: 'scrub'; id: number }
  | { kind: 'move'; id: number; row: number; k: number }
  | { kind: 'rect'; id: number; f0: number; r0: number; additive: boolean };

export function Timeline() {
  const c = clip.value;
  const p = project.value;
  const scroller = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const rulerScrub = useRef<number | null>(null);

  // seguir al cabezal
  const f = frame.value;
  useEffect(() => {
    const s = scroller.current;
    if (!s || drag.current) return;
    const x = HEAD_W + f * fw.peek();
    if (x < s.scrollLeft + HEAD_W || x > s.scrollLeft + s.clientWidth - 40) s.scrollLeft = x - HEAD_W - 60;
  }, [f]);

  // bloquear el scroll nativo táctil mientras hay un arrastre propio
  useEffect(() => {
    const el = tracksRef.current;
    if (!el) return;
    const block = (e: TouchEvent) => {
      const d = drag.current;
      if (d && d.kind !== 'pending') e.preventDefault();
      else if (d?.kind === 'pending' && multiMode.peek()) e.preventDefault();
    };
    el.addEventListener('touchmove', block, { passive: false });
    return () => el.removeEventListener('touchmove', block);
  });

  if (!c || !p) return null;
  const len = clipLength(c);
  const w = fw.value;
  const cols = Math.max(len + 48, 120);
  const [pa, pb] = playRange(c);
  const [ta, tb] = trimRange(c);
  const hasPlay = c.playIn !== null || c.playOut !== null;
  const hasTrim = c.trimIn !== null || c.trimOut !== null;
  const sel = cleanSelection(c, selection.value);
  const info = selectionInfo(selection.value);

  const localXY = (e: PointerEvent) => {
    const r = tracksRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const frameAt = (e: PointerEvent) => Math.max(0, Math.floor(localXY(e).x / fw.peek()));
  const rowAt = (e: PointerEvent) => Math.max(0, Math.min(c.layers.length - 1, Math.floor(localXY(e).y / ROW_H)));

  // ---- regla (scrub)
  const onRulerDown = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    rulerScrub.current = e.pointerId;
    playing.value = false;
    setFrame(frameAt(e));
  };
  const onRulerMove = (e: PointerEvent) => {
    if (rulerScrub.current === e.pointerId) setFrame(frameAt(e));
  };
  const onRulerUp = () => (rulerScrub.current = null);

  const toggleInSel = (lid: string, k: number) => {
    const cur = { ...selection.peek() };
    const arr = cur[lid] ? cur[lid].slice() : [];
    const i = arr.indexOf(k);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(k);
    if (arr.length) cur[lid] = arr;
    else delete cur[lid];
    selection.value = cur;
  };

  const tapAt = (e: PointerEvent, additive: boolean) => {
    const fr = frameAt(e);
    const row = rowAt(e);
    const L = c.layers[row];
    playing.value = false;
    setFrame(fr);
    layerId.value = L.id;
    const k = instanceIndexAt(L, fr);
    if (additive) {
      if (k >= 0) toggleInSel(L.id, k);
    } else selection.value = k >= 0 ? { [L.id]: [k] } : {};
  };

  const onTracksDown = (e: PointerEvent) => {
    if (drag.current) return;
    const target = e.target as HTMLElement;
    const el = e.currentTarget as HTMLElement;
    const selHandle = target.closest('[data-selhandle]') as HTMLElement | null;
    if (selHandle) {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      drag.current = { kind: 'scale', id: e.pointerId, edge: selHandle.dataset.selhandle as 'l' | 'r', x0: e.clientX, sel, before: p, last: null };
      return;
    }
    const handle = target.closest('[data-handle]') as HTMLElement | null;
    const rowEl = target.closest('[data-layer]') as HTMLElement | null;
    if (handle && rowEl) {
      e.preventDefault();
      const lid = rowEl.dataset.layer!;
      const k = Number(handle.dataset.handle);
      const L = c.layers.find((l) => l.id === lid)!;
      el.setPointerCapture(e.pointerId);
      drag.current = { kind: 'stretch', id: e.pointerId, layerId: lid, index: k, x0: e.clientX, dur0: L.instances[k].duration, before: p, last: null };
      layerId.value = lid;
      if (!sel[lid]?.includes(k)) selection.value = { [lid]: [k] };
      return;
    }
    const row = rowAt(e);
    const L = c.layers[row];
    const k = instanceIndexAt(L, frameAt(e));
    const pen = e.pointerType !== 'touch';
    const additive = multiMode.peek() || e.shiftKey || e.ctrlKey;
    if (pen || multiMode.peek()) el.setPointerCapture(e.pointerId);
    const isSelected = k >= 0 && !!sel[L.id]?.includes(k);
    const movable = k >= 0 && !L.locked && !additive;
    const d: Drag = { kind: 'pending', id: e.pointerId, x0: e.clientX, y0: e.clientY, pen, row, k, timer: 0, movable };
    if (movable && !pen) {
      // táctil: mantener presionado para mover la instancia
      d.timer = window.setTimeout(() => {
        if (drag.current === d) {
          el.setPointerCapture(e.pointerId);
          layerId.value = L.id;
          selection.value = { [L.id]: [k] };
          drag.current = { kind: 'move', id: e.pointerId, row, k };
          navigator.vibrate?.(15);
        }
      }, 380);
    }
    drag.current = d;
    if (pen && !additive && !isSelected) {
      // lápiz/mouse sobre algo no seleccionado: selecciona y hace scrub
      tapAt(e, false);
      drag.current = { kind: 'scrub', id: e.pointerId };
    }
  };

  const onTracksMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const cid = clipId.peek();
    if (d.kind === 'stretch') {
      const dx = Math.round((e.clientX - d.x0) / fw.peek());
      const L = d.before.clips[cid].layers.find((l) => l.id === d.layerId)!;
      d.last = withLayer(d.before, cid, d.layerId, () => setDuration(L, d.index, d.dur0 + dx));
      preview(d.last);
    } else if (d.kind === 'scale') {
      const dx = Math.round((e.clientX - d.x0) / fw.peek());
      const layers0 = d.before.clips[cid].layers;
      const span = selectionSpan(layers0, d.sel);
      if (!span) return;
      const slen = span.end - span.start;
      let layers: Layer[];
      if (scaleMode.peek() === 'prop') {
        const nl = Math.max(1, d.edge === 'r' ? slen + dx : slen - dx);
        layers = scaleSelection(layers0, d.sel, d.edge === 'r' ? span.start : span.end, nl / slen);
      } else {
        // delta: el borde sigue al dedo repartiendo entre las instancias de la fila más poblada
        const n = Math.max(...Object.entries(d.sel).map(([, idx]) => Math.max(...idx) - Math.min(...idx) + 1));
        const per = Math.round((d.edge === 'r' ? dx : -dx) / n);
        layers = addEach(layers0, d.sel, per);
      }
      d.last = withLayers(d.before, cid, layers);
      preview(d.last);
    } else if (d.kind === 'pending') {
      const moved = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
      if (moved < 8) return;
      clearTimeout(d.timer);
      if (multiMode.peek()) {
        const r = tracksRef.current!.getBoundingClientRect();
        const f0 = Math.max(0, Math.floor((d.x0 - r.left) / fw.peek()));
        drag.current = { kind: 'rect', id: d.id, f0, r0: d.row, additive: e.shiftKey || e.ctrlKey };
        onTracksMove(e);
      } else if (d.pen && d.movable) {
        layerId.value = c.layers[d.row].id;
        drag.current = { kind: 'move', id: d.id, row: d.row, k: d.k };
        onTracksMove(e);
      } else {
        drag.current = null; // táctil: dejar el scroll nativo
      }
    } else if (d.kind === 'scrub') {
      setFrame(frameAt(e));
    } else if (d.kind === 'move') {
      dropMark.value = { row: d.row, x: dropFrame(c.layers[d.row], d.k, frameAt(e)).x * fw.peek() };
    } else if (d.kind === 'rect') {
      const f1 = frameAt(e);
      const r1 = rowAt(e);
      rectMark.value = { x0: Math.min(d.f0, f1), x1: Math.max(d.f0, f1) + 1, r0: Math.min(d.r0, r1), r1: Math.max(d.r0, r1) };
    }
  };

  /** índice destino y posición x (en frames) para soltar la instancia k en el frame fr */
  const dropFrame = (L: Layer, k: number, fr: number) => {
    let t = L.start;
    let to = 0;
    let x = L.start;
    for (let i = 0; i < L.instances.length; i++) {
      const mid = t + L.instances[i].duration / 2;
      if (i !== k && fr >= mid) {
        to++;
        x = t + L.instances[i].duration;
      }
      t += L.instances[i].duration;
    }
    // si arrastro hacia adelante, el corrimiento por quitar k ya está contemplado en `to`
    return { to, x: to === 0 ? L.start : x };
  };

  const onTracksUp = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.kind === 'stretch') {
      if (d.last) commit(d.last, 'estirar', d.before);
      else preview(d.before);
    } else if (d.kind === 'scale') {
      if (d.last) commit(d.last, 'escalar selección', d.before);
      else preview(d.before);
    } else if (d.kind === 'pending') {
      clearTimeout(d.timer);
      if (e.type !== 'pointercancel') tapAt(e, multiMode.peek() || e.shiftKey || e.ctrlKey);
    } else if (d.kind === 'move') {
      dropMark.value = null;
      const L = c.layers[d.row];
      const { to } = dropFrame(L, d.k, frameAt(e));
      if (to !== d.k && e.type !== 'pointercancel') {
        const nl = moveInstance(L, d.k, to);
        commit(withLayer(p, c.id, L.id, () => nl), 'mover instancia');
        selection.value = { [L.id]: [to] };
        setFrame(instanceStart(nl, to));
      }
    } else if (d.kind === 'rect') {
      const m = rectMark.value;
      rectMark.value = null;
      if (!m) return;
      const next: Selection = d.additive ? { ...selection.peek() } : {};
      for (let r = m.r0; r <= m.r1; r++) {
        const L = c.layers[r];
        if (!L || L.locked) continue;
        let t = L.start;
        const idxs = new Set(next[L.id] ?? []);
        L.instances.forEach((it, k) => {
          if (t < m.x1 && t + it.duration > m.x0) idxs.add(k);
          t += it.duration;
        });
        if (idxs.size) next[L.id] = [...idxs];
      }
      selection.value = next;
    }
  };

  // zoom de la timeline con ctrl+rueda
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    fw.value = Math.max(4, Math.min(80, fw.peek() * Math.exp(-e.deltaY * 0.002)));
  };

  // caja de la selección (para escalar) cuando hay más de una instancia
  let selBox = null;
  const span = selectionSpan(c.layers, sel);
  if (span && (info.count > 1 || multiMode.value)) {
    const rows = c.layers.map((l, i) => (sel[l.id] ? i : -1)).filter((i) => i >= 0);
    const r0 = Math.min(...rows);
    const r1 = Math.max(...rows);
    selBox = (
      <div class="selbox" style={px({ left: span.start * w, width: (span.end - span.start) * w, top: r0 * ROW_H + 1, height: (r1 - r0 + 1) * ROW_H - 2 })}>
        <div class="selhandle l" data-selhandle="l" title="Escalar desde el inicio" />
        <div class="selhandle r" data-selhandle="r" title="Escalar desde el final" />
      </div>
    );
  }

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
  const dm = dropMark.value;
  const rm = rectMark.value;

  return (
    <div class="timeline">
      <div class="tl-bar">
        <div class="grp" data-help="Transporte" data-help-docs="timeline"
          data-help-text="Inicio, instancia anterior, frame anterior, play/pausa (espacio, loopea entre Mark In/Out), frame siguiente, instancia siguiente y final. El contador muestra frame actual / largo del clip.">
          <button onClick={gotoStart} title="Inicio">⏮</button>
          <button onClick={() => stepInstance(-1)} title="Instancia anterior">⇤</button>
          <button onClick={() => stepFrame(-1)} title="Frame anterior">◀</button>
          <button class="play" onClick={togglePlay} title="Play (espacio)">{playing.value ? '❚❚' : '▶'}</button>
          <button onClick={() => stepFrame(1)} title="Frame siguiente">▶︎</button>
          <button onClick={() => stepInstance(1)} title="Instancia siguiente">⇥</button>
          <button onClick={gotoEnd} title="Final">⏭</button>
          <span class="counter">{f + 1}<small> / {len}</small></span>
        </div>
        <div class="grp" data-help="Selección y escalado" data-help-docs="seleccion"
          data-help-text="Multi: los toques suman/quitan y arrastrar hace un rectángulo. Todo: selecciona el clip. Prop/Delta: cómo escalan las manijas azules de la selección. Duración…: panel numérico.">
          <button class={multiMode.value ? 'on' : ''} onClick={() => (multiMode.value = !multiMode.value)}
            title="Multiselección: tap suma/quita, arrastrar = rectángulo">Multi</button>
          <button onClick={() => (selection.value = selectAllClip())} title="Seleccionar todo el clip">Todo</button>
          <button class="mode" onClick={() => (scaleMode.value = scaleMode.value === 'prop' ? 'delta' : 'prop')}
            title="Cómo escalan las manijas de la selección">{scaleMode.value === 'prop' ? '⇔ Prop' : '± Delta'}</button>
          <button class={durationPanelOpen.value ? 'on' : ''} onClick={() => (durationPanelOpen.value = !durationPanelOpen.value)}
            title="Panel de duración">Duración…</button>
          {info.count > 0 && <span class="selinfo">{info.count} sel · {info.span}f</span>}
        </div>
        <div class="grp" data-help="Instancias" data-help-docs="timeline"
          data-help-text="+ Inst (vacía en el cabezal), Dup (duplica el dibujo), Vacía (hueco después), Borrar, −1/+1 frame, Hold (sostener la capa hasta el final), Copiar y Pegar.">
          <button onClick={newInstanceHere} title="Nueva instancia en el cabezal">+ Inst</button>
          <button onClick={() => void duplicateInstance()} title="Duplicar instancia">Dup</button>
          <button onClick={insertEmptyAfter} title="Insertar instancia vacía después">Vacía</button>
          <button onClick={deleteInstance} title="Borrar instancias seleccionadas">Borrar</button>
          <button onClick={() => nudgeDuration(-1)} title="Acortar 1 frame">−1</button>
          <button onClick={() => nudgeDuration(1)} title="Alargar 1 frame">+1</button>
          <button class={L?.post === 'hold' ? 'on' : ''} onClick={toggleHold} title="Hold hasta el final del clip">Hold</button>
          <button onClick={copyInstances} title="Copiar instancias seleccionadas">Copiar</button>
          <button onClick={() => void paste()} title="Pegar en el cabezal (instancias, capa o clip)">Pegar</button>
        </div>
        <div class="grp" data-help="Mark In/Out y recorte" data-help-docs="marks"
          data-help-text="In/Out: rango de loop al reproducir mientras animás (no cambia el clip). [ Rec / Rec ]: recorte que define qué parte del clip entra al animatic. ✕ borra cada uno.">
          <button onClick={() => markPlay('in')} title="Mark In (loop de reproducción)">In</button>
          <button onClick={() => markPlay('out')} title="Mark Out (loop de reproducción)">Out</button>
          <button onClick={clearPlayMarks} disabled={!hasPlay} title="Borrar Mark In/Out">✕</button>
          <span class="sep" />
          <button class="trim" onClick={() => markTrim('in')} title="Recorte In (entra al animatic)">[ Rec</button>
          <button class="trim" onClick={() => markTrim('out')} title="Recorte Out (entra al animatic)">Rec ]</button>
          <button onClick={clearTrim} disabled={!hasTrim} title="Borrar recorte">✕</button>
        </div>
        <div class="grp" data-help="Auto-instancia y cebolla" data-help-docs="dibujo"
          data-help-text="Auto-inst: al dibujar en medio de una instancia sostenida, la parte y crea una nueva en el cabezal. Cebolla: muestra dibujos anteriores (rojo) y siguientes (verde).">
          <button class={autoInstance.value ? 'on' : ''} onClick={() => (autoInstance.value = !autoInstance.value)}
            title="Al dibujar en medio de una instancia, crear una nueva en el cabezal">Auto-inst</button>
          <button class={onion.value.enabled ? 'on' : ''} onClick={() => (onion.value = { ...onion.value, enabled: !onion.value.enabled })}
            title="Papel cebolla">Cebolla</button>
        </div>
        <div class="grp" data-help="Capas y zoom" data-help-docs="capas"
          data-help-text="+ Capa, subir/bajar la capa actual, Copiar capa (luego Pegar), − Capa. Los − / + del final cambian el zoom de la timeline.">
          <button onClick={addLayer} title="Nueva capa">+ Capa</button>
          <button onClick={() => moveLayer(-1)} title="Subir capa">↑</button>
          <button onClick={() => moveLayer(1)} title="Bajar capa">↓</button>
          <button onClick={copyLayer} title="Copiar capa (después: Pegar)">Copiar capa</button>
          <button onClick={deleteLayer} title="Borrar capa">− Capa</button>
          <button onClick={() => (fw.value = Math.max(4, fw.value / 1.25))} title="Alejar timeline">−</button>
          <button onClick={() => (fw.value = Math.min(80, fw.value * 1.25))} title="Acercar timeline">+</button>
        </div>
      </div>

      <div class="tl-scroll" ref={scroller} onWheel={onWheel}>
        <div class="tl-inner" style={px({ width: HEAD_W + cols * w })}>
          <div class="tl-ruler-row">
            <div class="corner" style={px({ width: HEAD_W })}>{c.name}</div>
            <div class="ruler" data-help="Regla" data-help-docs="timeline"
              data-help-text="Tocá o arrastrá para mover el cabezal. Barra azul: Mark In/Out. Sombreado: fuera del recorte. Línea amarilla: final del clip." style={px({ width: cols * w })}
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
            <div class="heads" data-help="Encabezados de capa" data-help-docs="capas"
              data-help-text="◉ visibilidad, 🔓 bloqueo, nombre (doble toque para renombrar) y comportamiento antes/después de las instancias: Cut, Hold o Loop. Tocá una capa para que sea la actual." style={px({ width: HEAD_W })}>
              {c.layers.map((l) => <LayerHeader key={l.id} L={l} active={l.id === layerId.value} />)}
            </div>
            <div data-help="Instancias en la timeline" data-help-docs="timeline"
              data-help-text="Cada bloque es una instancia y el número es su duración. Manija gris derecha: estirar/acortar (ripple). Arrastrar una instancia seleccionada: reordenar (táctil: mantener presionado). Con varias seleccionadas aparecen manijas azules para escalar."
              class={'tracks' + (multiMode.value ? ' multi' : '')} ref={tracksRef} style={px({ width: cols * w })}
              onPointerDown={onTracksDown} onPointerMove={onTracksMove} onPointerUp={onTracksUp} onPointerCancel={onTracksUp}>
              {c.layers.map((l) => (
                <LayerTrack key={l.id} L={l} len={len} active={l.id === layerId.value} sel={sel[l.id] ?? []} />
              ))}
              {hasTrim && <div class="trim-shade" style={px({ left: 0, width: ta * w })} />}
              {hasTrim && <div class="trim-shade" style={px({ left: (tb + 1) * w, width: (cols - tb - 1) * w })} />}
              <div class="clip-end" style={px({ left: len * w })} />
              {selBox}
              {dm && <div class="dropmark" style={px({ left: dm.x - 2, top: dm.row * ROW_H, height: ROW_H })} />}
              {rm && <div class="rectmark" style={px({ left: rm.x0 * w, width: (rm.x1 - rm.x0) * w, top: rm.r0 * ROW_H, height: (rm.r1 - rm.r0 + 1) * ROW_H })} />}
              <div class="playhead" style={px({ left: f * w + w / 2 })} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
