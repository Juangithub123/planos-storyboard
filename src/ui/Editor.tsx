import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import {
  canRedo, canUndo, clip, clipId, editLayer, editProject, eraser, fillOpts, fingerDraws, flushProject, frame, layer, onion,
  pencil, pieHoldMs, playing, project, redo, say, selection, shapeOpts, tool, toast, undo, view,
  type ShapeKind, type Tool,
} from '../model/store';
import { groupOf } from '../model/evaluate';
import { editGroup } from '../model/actions';
import { applyFloating, cancelFloating, flipFloating, floating } from '../tools/controller';
import {
  addClip, currentPlayRange, deleteClip, deleteInstance, openClip, preloadClip, renameClip, stepFrame, togglePlay,
} from '../model/actions';
import type { BlendMode } from '../model/types';
import { flushDrawings } from '../render/drawings';
import { exportBackup } from '../storage/backup';
import { CanvasView, fitRequest } from './CanvasView';
import { DocsModal, HelpOverlay, docsOpen, helpOpen } from './Help';
import { Timeline } from './Timeline';
import { DurationPanel } from './DurationPanel';
import { PieMenu } from './PieMenu';
import { SequenceView } from './SequenceView';
import { copyInstances, duplicateClip, paste, selectAllClip, splitClipAtPlayhead } from '../model/clipboard';

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
      } else if ((e.ctrlKey || e.metaKey) && k === 'c') {
        copyInstances();
      } else if ((e.ctrlKey || e.metaKey) && k === 'v') {
        void paste();
      } else if ((e.ctrlKey || e.metaKey) && k === 'a') {
        e.preventDefault();
        selection.value = selectAllClip();
      } else if (k === 'delete' || k === 'backspace') {
        deleteInstance();
      } else if (k === 'escape') {
        if (floating.peek()) cancelFloating();
        else selection.value = {};
      } else if (k === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (k === 'arrowleft') stepFrame(-1);
      else if (k === 'arrowright') stepFrame(1);
      else if (k === 'b') tool.value = 'pencil';
      else if (k === 'e') tool.value = 'eraser';
      else if (k === 'g') tool.value = 'fill';
      else if (k === 'u') tool.value = 'shape';
      else if (k === 'l') tool.value = 'lasso';
      else if (k === 'enter' && floating.peek()) applyFloating();
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
      <span class="hg" data-help="Proyectos" data-help-docs="proyectos"
        data-help-text="Vuelve a la lista de proyectos (guarda todo antes). Ahí podés crear, importar, hacer backup o borrar proyectos.">
        <button onClick={async () => {
          playing.value = false;
          await flushDrawings();
          await flushProject();
          screen.value = 'projects';
        }} title="Proyectos">☰</button>
        <span class="pname">{p.name}</span>
      </span>
      <span class="seg-toggle" data-help="Clip / Secuencia" data-help-docs="clips"
        data-help-text="Clip: editás el plano actual (dibujo + timeline). Secuencia: ves y reproducís el animatic entero y reordenás los planos en el storyboard.">
        <button class={view.value === 'clip' ? 'on' : ''} onClick={() => (view.value = 'clip')}>Clip</button>
        <button class={view.value === 'sequence' ? 'on' : ''} onClick={() => {
          playing.value = false;
          view.value = 'sequence';
        }}>Secuencia</button>
      </span>
      <span class="sep" />
      <span class="hg" data-help="Clip actual" data-help-docs="clips"
        data-help-text="‹ › y el selector cambian de clip. El número es el orden del plano en la secuencia.">
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
      </span>
      <span class="hg" data-help="Operaciones de clip" data-help-docs="clips"
        data-help-text="+ Clip crea uno nuevo después del actual. Cortar parte el clip en el cabezal en dos clips. Dup clip lo duplica entero (con copias de los dibujos). Renombrar y − Clip (borrar).">
      <button onClick={addClip} title="Nuevo clip después del actual">+ Clip</button>
      <button onClick={() => void splitClipAtPlayhead()} title="Cortar el clip en el cabezal">Cortar</button>
      <button onClick={async () => {
        const nc = await duplicateClip();
        if (nc) openClip(nc.id);
      }} title="Duplicar clip">Dup clip</button>
      <button onClick={() => {
        const n = prompt('Nombre del clip', c?.name);
        if (n) renameClip(n);
      }} title="Renombrar clip">Renombrar</button>
      <button onClick={() => confirm('¿Borrar este clip?') && deleteClip()} title="Borrar clip">− Clip</button>
      </span>
      <span class="grow" />
      <span class="hg" data-help="Deshacer / rehacer" data-help-docs="gestos"
        data-help-text="También con tap de 2 dedos (deshacer) y 3 dedos (rehacer) sobre el lienzo, o Ctrl+Z / Ctrl+Y.">
        <button disabled={!canUndo.value} onClick={() => void undo()} title="Deshacer (tap 2 dedos)">↶</button>
        <button disabled={!canRedo.value} onClick={() => void redo()} title="Rehacer (tap 3 dedos)">↷</button>
      </span>
      <button onClick={() => fitRequest.fn()} title="Encuadrar canvas" data-help="Encuadrar"
        data-help-text="Vuelve a centrar y ajustar el lienzo a la pantalla (sin rotación).">⤢</button>
      <button class={needsBackup ? 'warn' : ''} onClick={() => void doBackup()} data-help="Backup" data-help-docs="proyectos"
        data-help-text="Descarga un .planos.zip con todo el proyecto. Se pone rojo si pasó más de un día con cambios sin backup. Se importa desde la lista de proyectos."
        title="Descargar backup .zip del proyecto">{needsBackup ? 'Backup!' : 'Backup'}</button>
      <button class={panelOpen.value ? 'on' : ''} onClick={() => (panelOpen.value = !panelOpen.value)} title="Panel"
        data-help="Panel lateral" data-help-text="Muestra u oculta el panel de la derecha (opciones de herramienta, capa, papel cebolla y entrada).">⚙</button>
      <span class="hg" data-help="Ayuda" data-help-docs="inicio"
        data-help-text="? muestra esta guía sobre la app. 📖 abre la documentación completa.">
        <button class="helpbtn" onClick={() => (helpOpen.value = true)} title="Ayuda: qué es cada cosa">?</button>
        <button onClick={() => (docsOpen.value = 'inicio')} title="Documentación">📖︎</button>
      </span>
    </div>
  );
}

const TOOLS: { v: Tool; icon: string; title: string }[] = [
  { v: 'pencil', icon: '✎', title: 'Lápiz (B)' },
  { v: 'eraser', icon: '⌫', title: 'Goma (E)' },
  { v: 'fill', icon: '◧', title: 'Relleno (G)' },
  { v: 'shape', icon: '◯', title: 'Formas: línea, rectángulo, elipse (U)' },
  { v: 'lasso', icon: '⬚', title: 'Lazo: seleccionar y transformar (L)' },
];

function ToolBar() {
  return (
    <div class="toolbar" data-help="Herramientas" data-help-docs="dibujo"
      data-help-text="✎ lápiz (B), ⌫ goma (E), ◧ relleno (G), ◯ formas (U) y ⬚ lazo para seleccionar y transformar (L). El círculo de abajo muestra el color actual. Las opciones de cada una están en el panel lateral.">
      {TOOLS.map((t) => (
        <button class={tool.value === t.v ? 'on' : ''} onClick={() => (tool.value = t.v)} title={t.title}>{t.icon}</button>
      ))}
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

const SHAPES: { v: ShapeKind; label: string }[] = [
  { v: 'line', label: '╱ Línea' }, { v: 'rect', label: '▭ Rect.' }, { v: 'ellipse', label: '◯ Elipse' },
];

function ColorPicker() {
  const p = project.value!;
  const pc = pencil.value;
  return (
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
  );
}

function ToolOptions() {
  const t = tool.value;
  const pc = pencil.value;
  const er = eraser.value;
  const so = shapeOpts.value;
  const fo = fillOpts.value;
  const pct = (v: number) => Math.round(v * 100) + '%';
  if (t === 'eraser') {
    return (
      <section data-help="Opciones de la goma" data-help-docs="dibujo" data-help-text="Tamaño, fuerza y presión de la goma.">
        <h4>Goma</h4>
        <Range label="Tamaño" min={2} max={250} value={er.size} onInput={(v) => (eraser.value = { ...er, size: v })} />
        <Range label="Fuerza" min={0.05} max={1} step={0.05} value={er.opacity} fmt={pct} onInput={(v) => (eraser.value = { ...er, opacity: v })} />
        <label class="check"><input type="checkbox" checked={er.pressureSize} onChange={() => (eraser.value = { ...er, pressureSize: !er.pressureSize })} /> Presión → tamaño</label>
      </section>
    );
  }
  if (t === 'lasso') {
    return (
      <section data-help="Lazo" data-help-docs="lazo" data-help-text="Rodeá con el stylus la parte del dibujo a seleccionar. Después: arrastrar adentro mueve, las esquinas escalan y el círculo rota. Aplicar confirma, Cancelar descarta.">
        <h4>Lazo</h4>
        <p class="hint">Rodeá una parte del dibujo de la capa actual. Después arrastrala para moverla, usá las esquinas para escalar y el círculo de arriba para rotar (con imán cada 15°).</p>
        {floating.value && (
          <div class="row-btns">
            <button onClick={flipFloating}>⇋ Voltear</button>
            <button class="primary" onClick={applyFloating}>✓ Aplicar</button>
            <button onClick={cancelFloating}>✕ Cancelar</button>
          </div>
        )}
        <p class="hint">Se confirma solo al cambiar de herramienta, frame o capa.</p>
      </section>
    );
  }
  return (
    <section data-help={t === 'fill' ? 'Opciones del relleno' : t === 'shape' ? 'Opciones de formas' : 'Opciones del lápiz'} data-help-docs="dibujo"
      data-help-text={t === 'fill'
        ? 'Tolerancia (cuánto puede variar el color), expandir (cubre el borde suave de la línea), y si los bordes se toman de la capa actual o de todas las capas visibles. Usa el color y la opacidad del lápiz.'
        : 'Tamaño, opacidad, color y paleta del proyecto (+ agrega el color actual; mantener presionado un color lo quita).'}>
      <h4>{t === 'fill' ? 'Relleno' : t === 'shape' ? 'Formas' : 'Lápiz'}</h4>
      {t === 'shape' && (
        <>
          <div class="row-btns">
            {SHAPES.map((s) => (
              <button class={so.kind === s.v ? 'on' : ''} onClick={() => (shapeOpts.value = { ...so, kind: s.v })}>{s.label}</button>
            ))}
          </div>
          {so.kind !== 'line' && (
            <label class="check"><input type="checkbox" checked={so.fill} onChange={() => (shapeOpts.value = { ...so, fill: !so.fill })} /> Rellena</label>
          )}
        </>
      )}
      {t === 'fill' ? (
        <>
          <Range label="Tolerancia" min={0} max={200} value={fo.tolerance} onInput={(v) => (fillOpts.value = { ...fo, tolerance: v })} />
          <Range label="Expandir" min={0} max={6} value={fo.grow} fmt={(v) => v + 'px'} onInput={(v) => (fillOpts.value = { ...fo, grow: v })} />
          <label class="row">
            <span>Bordes de</span>
            <select value={fo.sample} onChange={(e) => (fillOpts.value = { ...fo, sample: (e.target as HTMLSelectElement).value as 'layer' | 'all' })}>
              <option value="all">Todas las capas visibles</option>
              <option value="layer">Sólo la capa actual</option>
            </select>
          </label>
        </>
      ) : (
        <Range label="Tamaño" min={1} max={120} value={pc.size} onInput={(v) => (pencil.value = { ...pc, size: v })} />
      )}
      <Range label="Opacidad" min={0.05} max={1} step={0.05} value={pc.opacity} fmt={pct} onInput={(v) => (pencil.value = { ...pc, opacity: v })} />
      {t === 'pencil' && (
        <label class="check"><input type="checkbox" checked={pc.pressureSize} onChange={() => (pencil.value = { ...pc, pressureSize: !pc.pressureSize })} /> Presión → tamaño</label>
      )}
      <ColorPicker />
    </section>
  );
}

function SidePanel() {
  const p = project.value!;
  const L = layer.value;
  const c = clip.value;
  const g = c && L ? groupOf(c, L) : null;
  const o = onion.value;
  const pct = (v: number) => Math.round(v * 100) + '%';
  return (
    <div class="side">
      <ToolOptions />
      {L && (
        <section data-help="Capa actual" data-help-docs="capas" data-help-text="Opacidad y modo de fusión (multiplicar, trama, etc.) de la capa seleccionada en la timeline.">
          <h4>Capa: {L.name}</h4>
          <Range label="Opacidad" min={0} max={1} step={0.05} value={L.opacity} fmt={pct}
            onInput={(v) => editLayer('opacidad', (l) => ({ ...l, opacity: v }))} />
          <label class="row">
            <span>Fusión</span>
            <select value={L.blend} onChange={(e) => editLayer('fusión', (l) => ({ ...l, blend: (e.target as HTMLSelectElement).value as BlendMode }))}>
              {BLENDS.map((b) => <option value={b.v}>{b.label}</option>)}
            </select>
          </label>
          {L.kind === 'video' && (
            <>
              <label class="row">
                <span>Empieza en el frame</span>
                <input type="number" min={1} value={L.start + 1} class="num"
                  onChange={(e) => editLayer('inicio video', (l) => ({ ...l, start: Math.max(0, Number((e.target as HTMLInputElement).value) - 1 || 0) }))} />
              </label>
              <label class="row">
                <span>Saltear frames del video</span>
                <input type="number" min={0} value={L.srcIn ?? 0} class="num"
                  onChange={(e) => editLayer('offset video', (l) => ({ ...l, srcIn: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) }))} />
              </label>
              <p class="hint">Video de referencia: no se puede dibujar encima. Creá otra capa para dibujar.</p>
            </>
          )}
        </section>
      )}
      {g && (
        <section data-help="Grupo" data-help-docs="capas" data-help-text="Opacidad del grupo de la capa actual: se aplica al resultado de todas sus capas juntas.">
          <h4>Grupo: {g.name}</h4>
          <Range label="Opacidad" min={0} max={1} step={0.05} value={g.opacity} fmt={pct}
            onInput={(v) => editGroup('opacidad', g.id, (x) => ({ ...x, opacity: v }))} />
        </section>
      )}
      <section data-help="Papel cebolla" data-help-docs="cebolla" data-help-text="Cuántos dibujos antes (rojo) y después (verde) mostrar, su opacidad, y si se aplica sólo a la capa actual o a todas.">
        <h4>Papel cebolla</h4>
        <label class="check"><input type="checkbox" checked={o.enabled} onChange={() => (onion.value = { ...o, enabled: !o.enabled })} /> Activado</label>
        <label class="check"><input type="checkbox" checked={o.allLayers} onChange={() => (onion.value = { ...o, allLayers: !o.allLayers })} /> Todas las capas (no sólo la actual)</label>
        <Range label="Antes" min={0} max={5} value={o.before} onInput={(v) => (onion.value = { ...o, before: v })} />
        <Range label="Después" min={0} max={5} value={o.after} onInput={(v) => (onion.value = { ...o, after: v })} />
        <Range label="Opacidad" min={0.05} max={1} step={0.05} value={o.opacity} fmt={pct} onInput={(v) => (onion.value = { ...o, opacity: v })} />
      </section>
      <section data-help="Entrada" data-help-docs="gestos" data-help-text="Dibujar con el dedo (si no tenés el stylus) y el tiempo de espera del pie menu (stylus quieto en el lienzo).">
        <h4>Entrada</h4>
        <label class="check"><input type="checkbox" checked={fingerDraws.value} onChange={() => (fingerDraws.value = !fingerDraws.value)} /> Dibujar con el dedo</label>
        <Range label="Pie menu" min={0} max={2000} step={100} value={pieHoldMs.value}
          fmt={(v) => (v ? (v / 1000).toFixed(1) + 's' : 'off')} onInput={(v) => (pieHoldMs.value = v)} />
        <p class="hint">Con stylus: el dedo mueve/zoomea/rota. Tap con 2 dedos = deshacer, 3 = rehacer.
          Mantené el stylus quieto para abrir el pie menu (con mouse: click derecho).</p>
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
      <HelpOverlay />
      <DocsModal />
      {panelOpen.value && <SidePanel />}
      <Timeline />
      <DurationPanel />
      {view.value === 'sequence' && <SequenceView />}
      <PieMenu />
      <Toast />
    </div>
  );
}
