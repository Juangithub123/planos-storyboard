import { signal } from '@preact/signals';
import { clip, layerId, onion, redo, tool, undo } from '../model/store';
import { newInstanceHere } from '../model/actions';
import { selectLayerRel } from '../model/clipboard';

/** Posición (en pantalla) del pie menu abierto, o null. */
export const pie = signal<{ x: number; y: number } | null>(null);

interface Item {
  label: string;
  icon: string;
  on?: () => boolean;
  run: () => void;
  keepOpen?: boolean;
}

const ITEMS: Item[] = [
  { label: 'Lápiz', icon: '✎', on: () => tool.value === 'pencil', run: () => (tool.value = 'pencil') },
  { label: 'Rehacer', icon: '↷', run: () => void redo(), keepOpen: true },
  { label: 'Capa ↑', icon: '▲', run: () => selectLayerRel(-1), keepOpen: true },
  { label: '+ Inst', icon: '+', run: () => newInstanceHere() },
  { label: 'Cebolla', icon: '◐', on: () => onion.value.enabled, run: () => (onion.value = { ...onion.value, enabled: !onion.value.enabled }) },
  { label: 'Capa ↓', icon: '▼', run: () => selectLayerRel(1), keepOpen: true },
  { label: 'Deshacer', icon: '↶', run: () => void undo(), keepOpen: true },
  { label: 'Goma', icon: '⌫', on: () => tool.value === 'eraser', run: () => (tool.value = 'eraser') },
];

const R = 88;

export function PieMenu() {
  const pos = pie.value;
  if (!pos) return null;
  const c = clip.value;
  // mantener el menú dentro de la pantalla
  const x = Math.max(R + 40, Math.min(window.innerWidth - R - 200, pos.x));
  const y = Math.max(R + 40, Math.min(window.innerHeight - R - 40, pos.y));
  const close = () => (pie.value = null);
  return (
    <div class="pie-overlay" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="pie" style={{ left: x + 'px', top: y + 'px' }}>
        <div class="pie-ring" />
        {ITEMS.map((it, i) => {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / ITEMS.length - Math.PI / ITEMS.length * 0;
          const ix = Math.cos(a) * R;
          const iy = Math.sin(a) * R;
          return (
            <button class={'pie-item' + (it.on?.() ? ' on' : '')} style={{ transform: `translate(${ix}px, ${iy}px)` }}
              onClick={() => {
                it.run();
                if (!it.keepOpen) close();
              }}>
              <span class="pi-icon">{it.icon}</span>
              <span class="pi-label">{it.label}</span>
            </button>
          );
        })}
        <button class="pie-center" onClick={close} title="Cerrar">✕</button>
        {c && (
          <div class="pie-layers" style={{ left: R + 52 + 'px' }}>
            {c.layers.map((l) => (
              <button class={l.id === layerId.value ? 'on' : ''} onClick={() => {
                layerId.value = l.id;
                close();
              }}>{l.name}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
