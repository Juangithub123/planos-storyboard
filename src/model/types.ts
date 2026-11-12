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
  /** paint = dibujo; video = video de referencia (una sola instancia, no editable) */
  kind: 'paint' | 'video';
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
  /** grupo/carpeta al que pertenece (las capas de un grupo son contiguas) */
  groupId?: Id | null;
  /** capas de video: asset en IndexedDB */
  assetId?: Id;
  /** capas de video: frames del video que se saltean al inicio (al cortar un clip) */
  srcIn?: number;
}

export interface Group {
  id: Id;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  collapsed: boolean;
}

export interface Cam {
  /** centro del encuadre, en px del lienzo */
  x: number;
  y: number;
  /** 1 = cuadro completo; 2 = acercamiento al doble */
  zoom: number;
  /** grados */
  rot: number;
}

export interface Camera {
  enabled: boolean;
  start: Cam;
  end: Cam;
  ease: 'linear' | 'ease';
}

export interface AudioClip {
  id: Id;
  assetId: Id;
  name: string;
  /** frame de la secuencia (proyecto) donde empieza */
  start: number;
  /** segundos del archivo que se saltean */
  srcIn: number;
  /** segundos que suena */
  duration: number;
  volume: number;
}

export interface AudioTrack {
  id: Id;
  name: string;
  volume: number;
  muted: boolean;
  clips: AudioClip[];
}

export interface Asset {
  name: string;
  mime: string;
  /** duración en segundos (video) */
  duration?: number;
}

export interface Clip {
  id: Id;
  name: string;
  /** capas de arriba (índice 0) hacia abajo */
  layers: Layer[];
  groups?: Group[];
  camera?: Camera;
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
  /** archivos importados (videos de referencia) */
  assets?: Record<Id, Asset>;
  audioTracks?: AudioTrack[];
  createdAt: number;
  updatedAt: number;
  lastBackupAt: number;
}

export function uid(): Id {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
