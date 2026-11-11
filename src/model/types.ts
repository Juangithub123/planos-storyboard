export type Id = string;

export type Behavior = 'none' | 'hold' | 'repeat';
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'add';

export interface Instance {
  id: Id;
  /** duración en frames, >= 1 */
  duration: number;
  /** null = instancia vacía (hueco) */
  drawingId: Id | null;
}

export interface Layer {
  kind: 'paint';
  id: Id;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  /** offset de inicio en frames dentro del clip */
  start: number;
  pre: Behavior;
  post: Behavior;
  instances: Instance[];
}

export interface Clip {
  id: Id;
  name: string;
  /** capas de arriba (índice 0) hacia abajo */
  layers: Layer[];
  playIn: number | null;
  playOut: number | null;
  trimIn: number | null;
  trimOut: number | null;
}

export interface Project {
  id: Id;
  name: string;
  width: number;
  height: number;
  fps: number;
  clipOrder: Id[];
  clips: Record<Id, Clip>;
  palette: string[];
  createdAt: number;
  updatedAt: number;
  lastBackupAt: number;
}

export function uid(): Id {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
