import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import {
  canRedo, canUndo, clip, clipId, editLayer, editProject, eraser, fingerDraws, flushProject, frame, layer, onion,
  pencil, playing, project, redo, say, tool, toast, undo,
} from '../model/store';
import {
  addClip, currentPlayRange, deleteClip, openClip, preloadClip, renameClip, stepFrame, togglePlay,
} from '../model/actions';
import type { BlendMode } from '../model/types';
import { flushDrawings } from '../render/drawings';
import { exportBackup } from '../storage/backup';
import { CanvasView, fitRequest } from './CanvasView';
import { Timeline } from './Timeline';

export const screen = signal<'projects' | 'editor'>('projects');
const panelOpen = signal(true);

const BLENDS: { v: BlendMode; label: string }[] = [
  { v: 'normal', label: 'Normal' }, { v: 'multiply', label: 'Multiplicar' }, { v: 'screen', label: 'Trama' },
  { v: 'overlay', label: 'Superponer' }, { v: 'darken', label: 'Oscurecer' }, { v: 'lighten', label: 'Aclarar' },
  { v: 'add', label: 'Sumar' },
];

const BACKUP_EVERY = 24 * 3600 * 1000;

export async function doBackup() {
  const p = project.peek();
  if (!p) return;
  await flushDrawings();
  await flushProject();
  await exportBackup(p);
  editProject('backup', (pp) => ({ ...pp, lastBackupAt: Date.now() }));
  say('Backup descargado');
}

function usePlayback() {
  useEffect(() => {
    let raf = 0;
    let t0 = 0;
    let startFrame = 0;
    const loop = (t: number) => {
      const p = project.peek();
      if (!p || !playing.peek()) return;
      const [a, b] = currentPlayRange();
      const n = Math.floor(((t - t0) * p.fps) / 1000);
      const span = b - a + 1;
      const f = a + ((((startFrame - a + n) % span) + span) % span);
      if (f !== frame.peek()) frame.value = f;
      raf = requestAnimationFrame(loop);
    };
    const unsub = playing.subscribe((on) => {
      cancelAnimationFrame(raf);
      if (on) {
        preloadClip();
        const [a, b] = currentPlayRange();
        startFrame = frame.peek() < a || frame.peek() > b ? a : frame.peek();
        t0 = performance.now();
        raf = requestAnimationFrame(loop);
      }
    });
    return () => {
      unsub();
      cancelAnimationFrame(raf);
    };
  }, []);
}

function useKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
      } else if ((e.ctrlKey || e.metaKey) && k === 'y') {
        e.preventDefault();
        void redo();
      } else if (k === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (k === 'arrowleft') stepFrame(-1);
      else if (k === 'arrowright') stepFrame(1);
      else if (k === 'b') tool.value = 'pencil';
      else if (k === 'e') tool.value = 'eraser';
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function Toast() {
  const t = toast.value;
  useEffect(() => {
    if (!t) return;
    const h = setTimeout(() => (toast.value = null), 2200);
    return () => clearTimeout(h);
  }, [t]);
  return t ? <div class="toast">{t.text}</div> : null;
}

function TopBar() {
  const p = project.value!;
  const c = clip.value;
  const needsBackup = Date.now() - p.lastBackupAt > BACKUP_EVERY && p.updatedAt > p.lastBackupAt;
  return (
    <div class="topbar">
      <button onClick={async () => {
        playing.value = false;
        await flushDrawings();
        await flushProject();
        screen.value = 'projects';
      }} title="Proyectos">☰</button>
      <span class="pname">{p.name}</span>
      <span class="sep" />
      <button onClick={() => {
        const i = p.clipOrder.indexOf(clipId.value);
        if (i > 0) openClip(p.clipOrder[i - 1]);
      }} title="Clip anterior">‹</button>
      <select class="clipsel" value={clipId.value} onChange={(e) => openClip((e.target as HTMLSelectElement).value)}>
        {p.clipOrder.map((id, i) => <option value={id}>{i + 1}. {p.clips[id].name}</option>)}
      </select>
      <button onClick={() => {
        const i = p.clipOrder.indexOf(clipId.value);
        if (i < p.clipOrder.length - 1) openClip(p.clipOrder[i + 1]);
      }} title="Clip siguiente">›</button>
      <button onClick={addClip} title="Nuevo clip después del actual">+ Clip</button>
      <button onClick={() => {
        const n = prompt('Nombre del clip', c?.name);
        if (n) renameClip(n);
      }} title="Renombrar clip">Renombrar</button>
      <button onClick={() => confirm('¿Borrar este clip?') && deleteClip()} title="Borrar clip">− Clip</button>
      <span class="grow" />
      <button disabled={!canUndo.value} onClick={() => void undo()} title="Deshacer (tap 2 dedos)">↶</button>
      <button disabled={!canRedo.value} onClick={() => void redo()} title="Rehacer (tap 3 dedos)">↷</button>
      <button onClick={() => fitRequest.fn()} title="Encuadrar canvas">⤢</button>
      <button class={needsBackup ? 'warn' : ''} onClick={() => void doBackup()}
        title="Descargar backup .zip del proyecto">{needsBackup ? 'Backup!' : 'Backup'}</button>
      <button class={panelOpen.value ? 'on' : ''} onClick={() => (panelOpen.value = !panelOpen.value)} title="Panel">⚙</button>
    </div>
  );
}

function ToolBar() {
  return (
    <div class="toolbar">
      <button class={tool.value === 'pencil' ? 'on' : ''} onClick={() => (tool.value = 'pencil')} title="Lápiz (B)">✎</button>
      <button class={tool.value === 'eraser' ? 'on' : ''} onClick={() => (tool.value = 'eraser')} title="Goma (E)">⌫</button>
      <div class="swatch-big" style={{ background: pencil.value.color }} />
    </div>
  );
}

function Range(props: { label: string; min: number; max: number; step?: number; value: number; onInput: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <label class="range">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value}
        onInput={(e) => props.onInput(Number((e.target as HTMLInputElement).value))} />
      <b>{props.fmt ? props.fmt(props.value) : props.value}</b>
    </label>
  );
}

function SidePanel() {
  const p = project.value!;
  const L = layer.value;
  const pc = pencil.value;
  const er = eraser.value;
  const o = onion.value;
  const pct = (v: number) => Math.round(v * 100) + '%';
  return (
    <div class="side">
      {tool.value === 'pencil' ? (
        <section>
          <h4>Lápiz</h4>
          <Range label="Tamaño" min={1} max={120} value={pc.size} onInput={(v) => (pencil.value = { ...pc, size: v })} />
          <Range label="Opacidad" min={0.05} max={1} step={0.05} value={pc.opacity} fmt={pct} onInput={(v) => (pencil.value = { ...pc, opacity: v })} />
          <label class="check"><input type="checkbox" checked={pc.pressureSize} onChange={() => (pencil.value = { ...pc, pressureSize: !pc.pressureSize })} /> Presión → tamaño</label>
          <div class="colors">
            <input type="color" value={pc.color} onInput={(e) => (pencil.value = { ...pc, color: (e.target as HTMLInputElement).value })} />
            {p.palette.map((col, i) => (
              <button class={'sw' + (col === pc.color ? ' on' : '')} style={{ background: col }}
                onClick={() => (pencil.value = { ...pc, color: col })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (confirm('¿Quitar color de la paleta?')) editProject('paleta', (pp) => ({ ...pp, palette: pp.palette.filter((_, k) => k !== i) }));
                }} />
            ))}
            <button class="sw add" title="Agregar color actual a la paleta"
              onClick={() => !p.palette.includes(pc.color) && editProject('paleta', (pp) => ({ ...pp, palette: [...pp.palette, pc.color] }))}>+</button>
          </div>
        </section>
      ) : (
        <section>
          <h4>Goma</h4>
          <Range label="Tamaño" min={2} max={250} value={er.size} onInput={(v) => (eraser.value = { ...er, size: v })} />
          <Range label="Fuerza" min={0.05} max={1} step={0.05} value={er.opacity} fmt={pct} onInput={(v) => (eraser.value = { ...er, opacity: v })} />
          <label class="check"><input type="checkbox" checked={er.pressureSize} onChange={() => (eraser.value = { ...er, pressureSize: !er.pressureSize })} /> Presión → tamaño</label>
        </section>
      )}
      {L && (
        <section>
          <h4>Capa: {L.name}</h4>
          <Range label="Opacidad" min={0} max={1} step={0.05} value={L.opacity} fmt={pct}
            onInput={(v) => editLayer('opacidad', (l) => ({ ...l, opacity: v }))} />
          <label class="row">
            <span>Fusión</span>
            <select value={L.blend} onChange={(e) => editLayer('fusión', (l) => ({ ...l, blend: (e.target as HTMLSelectElement).value as BlendMode }))}>
              {BLENDS.map((b) => <option value={b.v}>{b.label}</option>)}
            </select>
          </label>
        </section>
      )}
      <section>
        <h4>Papel cebolla</h4>
        <label class="check"><input type="checkbox" checked={o.enabled} onChange={() => (onion.value = { ...o, enabled: !o.enabled })} /> Activado</label>
        <Range label="Antes" min={0} max={5} value={o.before} onInput={(v) => (onion.value = { ...o, before: v })} />
        <Range label="Después" min={0} max={5} value={o.after} onInput={(v) => (onion.value = { ...o, after: v })} />
        <Range label="Opacidad" min={0.05} max={1} step={0.05} value={o.opacity} fmt={pct} onInput={(v) => (onion.value = { ...o, opacity: v })} />
      </section>
      <section>
        <h4>Entrada</h4>
        <label class="check"><input type="checkbox" checked={fingerDraws.value} onChange={() => (fingerDraws.value = !fingerDraws.value)} /> Dibujar con el dedo</label>
        <p class="hint">Con stylus: el dedo mueve/zoomea/rota. Tap con 2 dedos = deshacer, 3 = rehacer.</p>
      </section>
      <section>
        <h4>Proyecto</h4>
        <p class="hint">{p.width}×{p.height} · {p.fps} fps · {p.clipOrder.length} clips</p>
      </section>
    </div>
  );
}

export function Editor() {
  usePlayback();
  useKeys();
  if (!project.value) return null;
  return (
    <div class={'editor' + (panelOpen.value ? '' : ' nopanel')}>
      <TopBar />
      <ToolBar />
      <CanvasView />
      {panelOpen.value && <SidePanel />}
      <Timeline />
      <Toast />
    </div>
  );
}
