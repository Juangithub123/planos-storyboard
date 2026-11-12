import { signal } from '@preact/signals';
import { clip, eraser, fillOpts, frame, pencil, project, say, shapeOpts, tool } from '../model/store';
import { buffer, renderClipFrame, type LayerOverride } from '../render/compositor';
import { StrokeBuffer } from './brush';
import { floodFill } from './floodfill';
import { clampRect, commitBuffer, commitOp, prepareTarget, type Rect, type Target } from './target';

export interface Pt {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Selección flotante (lazo)

export interface Floating {
  t: Target;
  src: HTMLCanvasElement;
  /** caja original en el lienzo */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  path: Path2D;
  tx: number;
  ty: number;
  scale: number;
  rot: number;
  flip: boolean;
}

export const floating = signal<Floating | null>(null);

export function floatMatrix(f: Floating): DOMMatrix {
  return new DOMMatrix()
    .translate(f.bx + f.bw / 2 + f.tx, f.by + f.bh / 2 + f.ty)
    .rotate((f.rot * 180) / Math.PI)
    .scale(f.scale * (f.flip ? -1 : 1), f.scale)
    .translate(-f.bw / 2, -f.bh / 2);
}

function floatCorners(f: Floating): Pt[] {
  const m = floatMatrix(f);
  return [
    [0, 0], [f.bw, 0], [f.bw, f.bh], [0, f.bh],
  ].map(([x, y]) => {
    const p = m.transformPoint(new DOMPoint(x, y));
    return { x: p.x, y: p.y };
  });
}

/** Confirma la transformación sobre el dibujo (un paso de deshacer). */
export function applyFloating() {
  const f = floating.peek();
  if (!f) return;
  floating.value = null;
  const cs = floatCorners(f);
  const xs = cs.map((p) => p.x);
  const ys = cs.map((p) => p.y);
  const x0 = Math.min(f.bx, ...xs) - 2;
  const y0 = Math.min(f.by, ...ys) - 2;
  const x1 = Math.max(f.bx + f.bw, ...xs) + 2;
  const y1 = Math.max(f.by + f.bh, ...ys) + 2;
  const unchanged = !f.tx && !f.ty && f.scale === 1 && !f.rot && !f.flip;
  if (unchanged) return;
  commitOp(f.t, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, (ctx) => {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fill(f.path);
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(floatMatrix(f));
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(f.src, 0, 0);
  });
}

export function cancelFloating() {
  floating.value = null;
}

export function flipFloating() {
  const f = floating.peek();
  if (f) floating.value = { ...f, flip: !f.flip };
}

// ---------------------------------------------------------------------------
// Controlador

export interface ToolHost {
  requestRender: () => void;
  /** proyecto → pantalla (px CSS relativos al canvas) */
  toScreen: (p: Pt) => Pt;
}

type Active =
  | { kind: 'brush'; t: Target; stroke: StrokeBuffer; erase: boolean; alpha: number }
  | { kind: 'shape'; t: Target; buf: HTMLCanvasElement; p0: Pt; p1: Pt; alpha: number }
  | { kind: 'lasso'; pts: Pt[] }
  | { kind: 'xform'; mode: 'move' | 'scale' | 'rotate'; s0: Pt; p0: Pt; f0: Floating };

export function createToolController(host: ToolHost) {
  let active: Active | null = null;

  const shapeBounds = (a: Pt, b: Pt, lw: number): Rect => ({
    x: Math.min(a.x, b.x) - lw, y: Math.min(a.y, b.y) - lw,
    w: Math.abs(b.x - a.x) + lw * 2, h: Math.abs(b.y - a.y) + lw * 2,
  });

  const drawShape = (s: Extract<Active, { kind: 'shape' }>) => {
    const ctx = s.buf.getContext('2d')!;
    ctx.clearRect(0, 0, s.buf.width, s.buf.height);
    const o = shapeOpts.peek();
    const pc = pencil.peek();
    ctx.strokeStyle = pc.color;
    ctx.fillStyle = pc.color;
    ctx.lineWidth = pc.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const { p0: a, p1: b } = s;
    ctx.beginPath();
    if (o.kind === 'line') {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      return;
    }
    if (o.kind === 'rect') ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    else ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    if (o.fill) ctx.fill();
    ctx.stroke();
  };

  const doFill = (pt: Pt) => {
    const p = project.peek();
    const c = clip.peek();
    if (!p || !c) return;
    const t = prepareTarget('draw');
    if (!t) return;
    const o = fillOpts.peek();
    let ref: ImageData;
    if (o.sample === 'layer') {
      ref = t.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, p.width, p.height);
    } else {
      const comp = buffer('fill-ref', p.width, p.height);
      const cctx = comp.getContext('2d', { willReadFrequently: true })!;
      renderClipFrame(cctx, c, frame.peek(), p.width, p.height, { layerId: t.layerId, draw: (x) => x.drawImage(t.canvas, 0, 0) }, null, p);
      ref = cctx.getImageData(0, 0, p.width, p.height);
    }
    const r = floodFill(ref.data, p.width, p.height, pt.x, pt.y, o.tolerance, o.grow);
    if (!r) return;
    if (r.w * r.h >= p.width * p.height && o.sample === 'all') say('Relleno de todo el lienzo (no encontró bordes cerrados)');
    const pc = pencil.peek();
    const img = new ImageData(r.w, r.h);
    const col = parseInt(pc.color.slice(1), 16);
    const R = (col >> 16) & 255, G = (col >> 8) & 255, B = col & 255;
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        if (!r.mask[(r.y + y) * p.width + r.x + x]) continue;
        const i = (y * r.w + x) * 4;
        img.data[i] = R; img.data[i + 1] = G; img.data[i + 2] = B; img.data[i + 3] = 255;
      }
    }
    const tmp = buffer('fill-tmp', r.w, r.h);
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    commitOp(t, { x: r.x, y: r.y, w: r.w, h: r.h }, (ctx) => {
      ctx.globalAlpha = pc.opacity;
      ctx.drawImage(tmp, r.x, r.y);
    });
  };

  /** Qué parte de la selección flotante toca un punto de pantalla. */
  const hitFloating = (f: Floating, sp: Pt): 'scale' | 'rotate' | 'move' | null => {
    const cs = floatCorners(f).map(host.toScreen);
    const c = { x: cs.reduce((s, p) => s + p.x, 0) / 4, y: cs.reduce((s, p) => s + p.y, 0) / 4 };
    const rh = rotateHandle(cs, c);
    if (Math.hypot(sp.x - rh.x, sp.y - rh.y) < 22) return 'rotate';
    if (cs.some((p) => Math.hypot(sp.x - p.x, sp.y - p.y) < 22)) return 'scale';
    // dentro del cuadrilátero
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const a = cs[i], b = cs[j];
      if (a.y > sp.y !== b.y > sp.y && sp.x < ((b.x - a.x) * (sp.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside ? 'move' : null;
  };

  return {
    /** Empieza una operación. Devuelve true si captura el puntero. */
    down(e: PointerEvent, pt: Pt, sp: Pt): boolean {
      const p = project.peek();
      if (!p) return false;
      const tl = tool.peek();
      const pressure = e.pointerType === 'mouse' ? 0.6 : e.pressure || 0.5;

      if (tl === 'lasso') {
        const f = floating.peek();
        if (f) {
          const hit = hitFloating(f, sp);
          if (hit) {
            active = { kind: 'xform', mode: hit, s0: sp, p0: pt, f0: f };
            return true;
          }
          applyFloating();
        }
        active = { kind: 'lasso', pts: [pt] };
        host.requestRender();
        return true;
      }
      if (floating.peek()) applyFloating();

      if (tl === 'fill') {
        doFill(pt);
        return false;
      }
      if (tl === 'shape') {
        const t = prepareTarget('draw');
        if (!t) return false;
        const buf = document.createElement('canvas');
        buf.width = p.width;
        buf.height = p.height;
        active = { kind: 'shape', t, buf, p0: pt, p1: pt, alpha: pencil.peek().opacity };
        return true;
      }
      const erase = tl === 'eraser';
      const t = prepareTarget(erase ? 'existing' : 'draw');
      if (!t) return false;
      const brush = erase ? { ...eraser.peek(), color: '#000' } : pencil.peek();
      const stroke = new StrokeBuffer(p.width, p.height, brush);
      stroke.add({ x: pt.x, y: pt.y, p: Math.max(0.05, pressure) });
      active = { kind: 'brush', t, stroke, erase, alpha: brush.opacity };
      host.requestRender();
      return true;
    },

    move(e: PointerEvent, toProject: (ev: PointerEvent) => Pt, sp: Pt) {
      const a = active;
      if (!a) return;
      if (a.kind === 'brush') {
        const evs = e.getCoalescedEvents?.() ?? [];
        for (const ev of evs.length ? evs : [e]) {
          const pt = toProject(ev);
          const pr = ev.pointerType === 'mouse' ? 0.6 : ev.pressure || 0.5;
          a.stroke.add({ x: pt.x, y: pt.y, p: Math.max(0.05, pr) });
        }
      } else if (a.kind === 'shape') {
        a.p1 = toProject(e);
        drawShape(a);
      } else if (a.kind === 'lasso') {
        const pt = toProject(e);
        const last = a.pts[a.pts.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) > 1.5) a.pts.push(pt);
      } else if (a.kind === 'xform') {
        const f0 = a.f0;
        const pt = toProject(e);
        if (a.mode === 'move') {
          floating.value = { ...f0, tx: f0.tx + pt.x - a.p0.x, ty: f0.ty + pt.y - a.p0.y };
        } else {
          const cx = f0.bx + f0.bw / 2 + f0.tx;
          const cy = f0.by + f0.bh / 2 + f0.ty;
          if (a.mode === 'scale') {
            const d0 = Math.hypot(a.p0.x - cx, a.p0.y - cy) || 1;
            const d1 = Math.hypot(pt.x - cx, pt.y - cy);
            floating.value = { ...f0, scale: Math.max(0.02, (f0.scale * d1) / d0) };
          } else {
            const a0 = Math.atan2(a.p0.y - cy, a.p0.x - cx);
            const a1 = Math.atan2(pt.y - cy, pt.x - cx);
            let rot = f0.rot + a1 - a0;
            // imán cada 15°
            const snap = Math.PI / 12;
            if (Math.abs(rot / snap - Math.round(rot / snap)) < 0.08) rot = Math.round(rot / snap) * snap;
            floating.value = { ...f0, rot };
          }
        }
      }
      void sp;
      host.requestRender();
    },

    up(cancel = false) {
      const a = active;
      active = null;
      const p = project.peek();
      if (!a || !p) return;
      if (cancel) {
        host.requestRender();
        return;
      }
      if (a.kind === 'brush') {
        commitBuffer(a.t, a.stroke.canvas, a.stroke.bounds(p.width, p.height), a.erase, a.alpha);
      } else if (a.kind === 'shape') {
        if (Math.hypot(a.p1.x - a.p0.x, a.p1.y - a.p0.y) >= 2) {
          commitBuffer(a.t, a.buf, shapeBounds(a.p0, a.p1, pencil.peek().size + 2), false, a.alpha);
        }
      } else if (a.kind === 'lasso') {
        startFloating(a.pts, p.width, p.height);
      }
      host.requestRender();
    },

    /** Contenido alternativo de la capa mientras hay una operación o selección flotante. */
    override(): LayerOverride | null {
      const a = active;
      if (a?.kind === 'brush') {
        return {
          layerId: a.t.layerId,
          draw: (ctx) => {
            ctx.drawImage(a.t.canvas, 0, 0);
            ctx.globalAlpha = a.alpha;
            ctx.globalCompositeOperation = a.erase ? 'destination-out' : 'source-over';
            ctx.drawImage(a.stroke.canvas, 0, 0);
          },
        };
      }
      if (a?.kind === 'shape') {
        return {
          layerId: a.t.layerId,
          draw: (ctx) => {
            ctx.drawImage(a.t.canvas, 0, 0);
            ctx.globalAlpha = a.alpha;
            ctx.drawImage(a.buf, 0, 0);
          },
        };
      }
      const f = floating.peek();
      if (f) {
        return {
          layerId: f.t.layerId,
          draw: (ctx) => {
            ctx.drawImage(f.t.canvas, 0, 0);
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fill(f.path);
            ctx.globalCompositeOperation = 'source-over';
            ctx.setTransform(floatMatrix(f));
            ctx.drawImage(f.src, 0, 0);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
          },
        };
      }
      return null;
    },

    /** Dibujo en pantalla (coordenadas CSS × dpr): trazado del lazo y manijas de la selección. */
    overlay(ctx: CanvasRenderingContext2D, dpr: number) {
      const a = active;
      ctx.save();
      ctx.scale(dpr, dpr);
      if (a?.kind === 'lasso' && a.pts.length > 1) {
        const sp = a.pts.map(host.toScreen);
        ctx.beginPath();
        sp.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fillStyle = 'rgba(77,124,255,.12)';
        ctx.fill();
        dashed(ctx);
      }
      const f = floating.peek();
      if (f) {
        const cs = floatCorners(f).map(host.toScreen);
        const c = { x: cs.reduce((s, p) => s + p.x, 0) / 4, y: cs.reduce((s, p) => s + p.y, 0) / 4 };
        ctx.beginPath();
        cs.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        dashed(ctx);
        const top = { x: (cs[0].x + cs[1].x) / 2, y: (cs[0].y + cs[1].y) / 2 };
        const rh = rotateHandle(cs, c);
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(rh.x, rh.y);
        ctx.strokeStyle = '#4d7cff';
        ctx.setLineDash([]);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        for (const p of cs) handle(ctx, p.x, p.y, false);
        handle(ctx, rh.x, rh.y, true);
      }
      ctx.restore();
    },

    /** Cancela lo que esté en curso (por ejemplo al abrir el pie menu). */
    cancel() {
      active = null;
      host.requestRender();
    },

    busy() {
      return active !== null;
    },
  };
}

function startFloating(pts: Pt[], W: number, H: number) {
  if (pts.length < 3) return;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const b = clampRect({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }, W, H);
  if (!b || b.w < 3 || b.h < 3) return;
  const t = prepareTarget('existing');
  if (!t) return say('No hay dibujo en el cabezal para seleccionar');
  const path = new Path2D();
  pts.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
  path.closePath();
  const src = document.createElement('canvas');
  src.width = b.w;
  src.height = b.h;
  const sctx = src.getContext('2d')!;
  sctx.translate(-b.x, -b.y);
  sctx.clip(path);
  sctx.drawImage(t.canvas, 0, 0);
  floating.value = { t, src, bx: b.x, by: b.y, bw: b.w, bh: b.h, path, tx: 0, ty: 0, scale: 1, rot: 0, flip: false };
}

function rotateHandle(cs: Pt[], c: Pt): Pt {
  const top = { x: (cs[0].x + cs[1].x) / 2, y: (cs[0].y + cs[1].y) / 2 };
  let dx = top.x - c.x;
  let dy = top.y - c.y;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d;
  dy /= d;
  return { x: top.x + dx * 30, y: top.y + dy * 30 };
}

function dashed(ctx: CanvasRenderingContext2D) {
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.lineDashOffset = 5;
  ctx.strokeStyle = '#4d7cff';
  ctx.stroke();
  ctx.lineDashOffset = 0;
  ctx.setLineDash([]);
}

function handle(ctx: CanvasRenderingContext2D, x: number, y: number, round: boolean) {
  ctx.beginPath();
  if (round) ctx.arc(x, y, 8, 0, Math.PI * 2);
  else ctx.rect(x - 7, y - 7, 14, 14);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = '#4d7cff';
  ctx.lineWidth = 2;
  ctx.stroke();
}
