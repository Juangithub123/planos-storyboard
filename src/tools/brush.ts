/**
 * Pincel por estampado de círculos sobre un buffer del tamaño del proyecto.
 * El buffer se pinta opaco y se compone con la opacidad del trazo al final,
 * así las superposiciones dentro de un mismo trazo no se acumulan.
 */

export interface BrushParams {
  size: number;
  color: string;
  pressureSize: boolean;
}

export interface Pt {
  x: number;
  y: number;
  p: number;
}

export class StrokeBuffer {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private last: Pt | null = null;
  private smooth: Pt | null = null;
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;

  constructor(w: number, h: number, private params: BrushParams) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.fillStyle = params.color;
  }

  private radius(p: number) {
    const s = this.params.pressureSize ? this.params.size * (0.15 + 0.85 * p) : this.params.size;
    return Math.max(0.5, s / 2);
  }

  private stamp(x: number, y: number, r: number) {
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fill();
    if (x - r < this.minX) this.minX = x - r;
    if (y - r < this.minY) this.minY = y - r;
    if (x + r > this.maxX) this.maxX = x + r;
    if (y + r > this.maxY) this.maxY = y + r;
  }

  add(pt: Pt) {
    // suavizado leve de posición para trazos con temblor
    const s = this.smooth ? { x: this.smooth.x + (pt.x - this.smooth.x) * 0.6, y: this.smooth.y + (pt.y - this.smooth.y) * 0.6, p: pt.p } : pt;
    this.smooth = s;
    const prev = this.last;
    if (!prev) {
      this.stamp(s.x, s.y, this.radius(s.p));
      this.last = s;
      return;
    }
    const dx = s.x - prev.x;
    const dy = s.y - prev.y;
    const dist = Math.hypot(dx, dy);
    const r0 = this.radius(prev.p);
    const r1 = this.radius(s.p);
    const spacing = Math.max(0.4, Math.min(r0, r1) * 0.25);
    const n = Math.floor(dist / spacing);
    for (let i = 1; i <= n; i++) {
      const t = (i * spacing) / dist;
      this.stamp(prev.x + dx * t, prev.y + dy * t, r0 + (r1 - r0) * t);
    }
    if (n > 0) {
      const t = (n * spacing) / dist;
      this.last = { x: prev.x + dx * t, y: prev.y + dy * t, p: prev.p + (s.p - prev.p) * t };
    }
  }

  /** Rectángulo afectado, recortado al canvas, o null si está vacío. */
  bounds(w: number, h: number) {
    const x = Math.max(0, Math.floor(this.minX) - 1);
    const y = Math.max(0, Math.floor(this.minY) - 1);
    const x2 = Math.min(w, Math.ceil(this.maxX) + 1);
    const y2 = Math.min(h, Math.ceil(this.maxY) + 1);
    if (x2 <= x || y2 <= y) return null;
    return { x, y, w: x2 - x, h: y2 - y };
  }
}
