import { signal } from '@preact/signals';

/** Frame global de la secuencia y reproducción (vista Secuencia). */
export const seqFrame = signal(0);
export const seqPlaying = signal(false);
/** Clip de audio seleccionado en la vista Secuencia. */
export const selAudio = signal<string | null>(null);
/** Pista de audio seleccionada (destino de "Importar audio"). */
export const selTrack = signal<string | null>(null);
