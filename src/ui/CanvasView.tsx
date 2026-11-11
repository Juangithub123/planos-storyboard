import { useEffect, useRef } from 'preact/hooks';
import { effect } from '@preact/signals';
import {
  autoInstance, clip, clipId, commitStroke, eraser, fingerDraws, frame, layer, layerId, onion,
  pencil, playing, project, redo, say, tool, undo, withLayer,
} from '../model/store';
import { instanceIndexAt, instanceStart, splitAt } from '../model/timing';
import { uid, type Project } from '../model/types';
import { createDrawing, drawingsVersion, markDirty, peekDrawing } from '../render/drawings';
import { renderClipFrame, type ActiveStroke } from '../render/compositor';
import { StrokeBuffer } from '../tools/brush';

interface View {
  x: number;
  y: number;
  zoom: number;
  rot: number;
}

/** Pedido externo de "encuadrar" (botón de la barra). */
export const fitRequest = { fn: () => {} };

export function CanvasView() {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = cv.current!;
    const host = wrap.current!;
    const ctx = canvas.getContext('2d')!;
    let dpr = window.devicePixelRatio || 1;
    let view: View = { x: 0, y: 0, zoom: 1, rot: 0 };
    let active: ActiveStroke | null = null;
    let stroke: StrokeBuffer | null = null;
    let strokeCommit: { drawingId: string; next: Project | null; before: Project } | null = null;
    let penId: number | null = null;
    let penSeenAt = 0;
    let raf = 0;

    const matrix = () => new DOMMatrix().translate(view.x, view.y).rotate((view.rot * 180) / Math.PI).scale(view.zoom);

    const render = () => {
      raf = 0;
      const p = project.peek();
      const c = clip.peek();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#2a2b31';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!p || !c) return;
      const m = matrix();
      ctx.setTransform(new DOMMatrix().scale(dpr).multiply(m));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, p.width, p.height);
      const o = onion.peek();
      renderClipFrame(
        ctx, c, frame.peek(), p.width, p.height, active,
        o.enabled && !playing.peek() ? { ...o, layerId: layerId.peek() } : null,
      );
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.lineWidth = 1;
      const corners = [new DOMPoint(0, 0), new DOMPoint(p.width, 0), new DOMPoint(p.width, p.height), new DOMPoint(0, p.height)].map(
        (pt) => m.transformPoint(pt),
      );
      ctx.beginPath();
      corners.forEach((pt, i) => (i ? ctx.lineTo(pt.x * dpr, pt.y * dpr) : ctx.moveTo(pt.x * dpr, pt.y * dpr)));
      ctx.closePath();
      ctx.stroke();
    };
    const requestRender = () => {
      if (!raf) raf = requestAnimationFrame(render);
    };

    const fit = () => {
      const p = project.peek();
      if (!p) return;
      const r = host.getBoundingClientRect();
      const z = Math.min((r.width - 24) / p.width, (r.height - 24) / p.height);
      view = { zoom: z, rot: 0, x: (r.width - p.width * z) / 2, y: (r.height - p.height * z) / 2 };
      requestRender();
    };
    fitRequest.fn = fit;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      const r = host.getBoundingClientRect();
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = r.width + 'px';
      canvas.style.height = r.height + 'px';
      requestRender();
    };
    const ro = new ResizeObserver(() => {
      const first = canvas.width === 300 && canvas.height === 150;
      resize();
      if (first) fit();
    });
    ro.observe(host);

    const dispose = effect(() => {
      // dependencias de render
      project.value; clipId.value; frame.value; onion.value; drawingsVersion.value; layerId.value; playing.value;
      requestRender();
    });
    let lastPid = '';
    const disposeFit = effect(() => {
      const p = project.value;
      if (p && p.id !== lastPid) {
        lastPid = p.id;
        requestAnimationFrame(fit);
      }
    });

    const toProject = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const pt = matrix().inverse().transformPoint(new DOMPoint(e.clientX - r.left, e.clientY - r.top));
      return { x: pt.x, y: pt.y };
    };

    // ---------------- dibujo
    const beginStroke = (e: PointerEvent) => {
      const p = project.peek();
      const c = clip.peek();
      const L = layer.peek();
      if (!p || !c || !L) return false;
      if (playing.peek()) playing.value = false;
      if (L.locked) return say('La capa está bloqueada'), false;
      if (!L.visible) return say('La capa está oculta'), false;
      const isEraser = tool.peek() === 'eraser';
      const f = frame.peek();
      const idx = instanceIndexAt(L, f);
      const inst = idx >= 0 ? L.instances[idx] : null;
      const atStart = idx >= 0 && instanceStart(L, idx) === f;
      let drawingId: string;
      let canvasTarget: HTMLCanvasElement;
      let next: Project | null = null;

      if (inst?.drawingId && (atStart || !autoInstance.peek())) {
        drawingId = inst.drawingId;
        const existing = peekDrawing(drawingId);
        if (!existing) return say('Cargando dibujo…'), false;
        canvasTarget = existing;
      } else {
        if (isEraser) return false;
        drawingId = uid();
        canvasTarget = createDrawing(drawingId);
        if (inst && !inst.drawingId && (atStart || !autoInstance.peek())) {
          next = withLayer(p, c.id, L.id, (l) => ({
            ...l, instances: l.instances.map((it, k) => (k === idx ? { ...it, drawingId } : it)),
          }));
        } else {
          const r = splitAt(L, f, drawingId, uid);
          next = withLayer(p, c.id, L.id, () => r.layer);
        }
      }
      const brush = isEraser ? { ...eraser.peek(), color: '#000' } : pencil.peek();
      stroke = new StrokeBuffer(p.width, p.height, brush);
      active = { layerId: L.id, canvas: canvasTarget, buffer: stroke.canvas, eraser: isEraser, alpha: brush.opacity };
      strokeCommit = { drawingId, next, before: p };
      addPoints(e);
      return true;
    };

    const addPoints = (e: PointerEvent) => {
      if (!stroke) return;
      const evs = e.getCoalescedEvents?.() ?? [];
      for (const ev of evs.length ? evs : [e]) {
        const pt = toProject(ev);
        const pr = ev.pointerType === 'mouse' ? 0.6 : ev.pressure || 0.5;
        stroke.add({ x: pt.x, y: pt.y, p: Math.max(0.05, pr) });
      }
      requestRender();
    };

    const endStroke = (cancel = false) => {
      const p = project.peek();
      if (!stroke || !active || !strokeCommit || !p) return;
      const b = stroke.bounds(p.width, p.height);
      if (!cancel && b) {
        const tctx = active.canvas.getContext('2d', { willReadFrequently: true })!;
        const before = tctx.getImageData(b.x, b.y, b.w, b.h);
        tctx.globalAlpha = active.alpha;
        tctx.globalCompositeOperation = active.eraser ? 'destination-out' : 'source-over';
        tctx.drawImage(stroke.canvas, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
        tctx.globalAlpha = 1;
        tctx.globalCompositeOperation = 'source-over';
        const after = tctx.getImageData(b.x, b.y, b.w, b.h);
        commitStroke({ drawingId: strokeCommit.drawingId, x: b.x, y: b.y, before, after }, strokeCommit.next, strokeCommit.before);
        markDirty(strokeCommit.drawingId);
      }
      stroke = null;
      active = null;
      strokeCommit = null;
      requestRender();
    };

    // ---------------- gestos táctiles
    const touches = new Map<number, { x: number; y: number }>();
    let gesture: {
      startView: View;
      startPts: { x: number; y: number }[];
      ids: number[];
    } | null = null;
    let tap = { start: 0, max: 0, moved: 0 };

    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const startGesture = () => {
      const ids = [...touches.keys()].slice(0, 2);
      gesture = { startView: { ...view }, startPts: ids.map((id) => ({ ...touches.get(id)! })), ids };
    };

    const updateGesture = () => {
      if (!gesture) return;
      const pts = gesture.ids.map((id) => touches.get(id)).filter(Boolean) as { x: number; y: number }[];
      if (pts.length !== gesture.ids.length) return startGesture();
      const v0 = gesture.startView;
      const m0 = new DOMMatrix().translate(v0.x, v0.y).rotate((v0.rot * 180) / Math.PI).scale(v0.zoom);
      if (pts.length === 1) {
        view = { ...v0, x: v0.x + pts[0].x - gesture.startPts[0].x, y: v0.y + pts[0].y - gesture.startPts[0].y };
      } else {
        const [a0, b0] = gesture.startPts;
        const [a1, b1] = pts;
        const mid0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
        const mid1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
        const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1;
        const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y) || 1;
        const ang0 = Math.atan2(b0.y - a0.y, b0.x - a0.x);
        const ang1 = Math.atan2(b1.y - a1.y, b1.x - a1.x);
        const zoom = Math.min(40, Math.max(0.05, (v0.zoom * d1) / d0));
        let rot = v0.rot + ang1 - ang0;
        // imán a 0° si está cerca
        if (Math.abs(rot) < 0.06) rot = 0;
        const pp = m0.inverse().transformPoint(new DOMPoint(mid0.x, mid0.y));
        const rs = new DOMMatrix().rotate((rot * 180) / Math.PI).scale(zoom).transformPoint(pp);
        view = { zoom, rot, x: mid1.x - rs.x, y: mid1.y - rs.y };
      }
      requestRender();
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.pointerType === 'pen') penSeenAt = Date.now();
        if (penId !== null) return;
        // cancelar gestos en curso: el lápiz manda
        touches.clear();
        gesture = null;
        if (beginStroke(e)) {
          penId = e.pointerId;
          canvas.setPointerCapture(e.pointerId);
        }
        return;
      }
      // touch
      if (penId !== null) return; // palm rejection durante un trazo
      const canFingerDraw = fingerDraws.peek() && Date.now() - penSeenAt > 2000;
      if (canFingerDraw && touches.size === 0) {
        if (beginStroke(e)) {
          penId = e.pointerId;
          canvas.setPointerCapture(e.pointerId);
          tap = { start: Date.now(), max: 1, moved: 0 };
        }
        touches.set(e.pointerId, local(e));
        return;
      }
      if (touches.size === 0) tap = { start: Date.now(), max: 0, moved: 0 };
      touches.set(e.pointerId, local(e));
      canvas.setPointerCapture(e.pointerId);
      tap.max = Math.max(tap.max, touches.size);
      startGesture();
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId === penId) {
        addPoints(e);
        return;
      }
      if (!touches.has(e.pointerId)) return;
      const prev = touches.get(e.pointerId)!;
      const cur = local(e);
      tap.moved += Math.hypot(cur.x - prev.x, cur.y - prev.y);
      touches.set(e.pointerId, cur);
      if (penId === null) updateGesture();
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId === penId) {
        penId = null;
        endStroke(e.type === 'pointercancel');
        touches.delete(e.pointerId);
        return;
      }
      if (!touches.has(e.pointerId)) return;
      touches.delete(e.pointerId);
      if (touches.size === 0) {
        gesture = null;
        const quick = Date.now() - tap.start < 320 && tap.moved < 14 * tap.max;
        if (quick && tap.max === 2) void undo();
        else if (quick && tap.max === 3) void redo();
      } else startGesture();
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      if (e.ctrlKey || !e.shiftKey) {
        const z = Math.min(40, Math.max(0.05, view.zoom * Math.exp(-e.deltaY * 0.0015)));
        const k = z / view.zoom;
        view = { ...view, zoom: z, x: mx - (mx - view.x) * k, y: my - (my - view.y) * k };
      } else {
        view = { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY };
      }
      requestRender();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    return () => {
      ro.disconnect();
      dispose();
      disposeFit();
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  return (
    <div class="canvas-wrap" ref={wrap}>
      <canvas ref={cv} class="stage" />
    </div>
  );
}
