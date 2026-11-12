import { clip, project } from '../model/store';
import { camDrag, camKey, editCamera, setKey } from '../model/camera';
import { defaultCam, defaultCamera } from '../model/sequence';

function Slider(props: { label: string; min: number; max: number; step: number; value: number; fmt: (v: number) => string; onInput: (v: number) => void }) {
  return (
    <label class="range">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        onInput={(e) => props.onInput(Number((e.target as HTMLInputElement).value))} />
      <b>{props.fmt(props.value)}</b>
    </label>
  );
}

/** Cámara del clip: dos keyframes (inicio y fin del recorte) interpolados. */
export function CameraPanel() {
  const p = project.value;
  const c = clip.value;
  if (!p || !c) return null;
  const cam = c.camera ?? defaultCamera(p);
  const key = camKey.value;
  const k = cam[key];
  return (
    <section data-help="Cámara del clip" data-help-docs="camara"
      data-help-text="Movimiento simple de cámara: encuadre de inicio y de fin (posición, zoom y rotación), interpolados a lo largo del recorte del clip. Se ve en Secuencia y en los exports; en el lienzo se dibujan los marcos.">
      <h4>Cámara</h4>
      <label class="check"><input type="checkbox" checked={cam.enabled}
        onChange={() => editCamera('cámara activa', (x) => ({ ...x, enabled: !x.enabled }))} /> Usar cámara en este clip</label>
      {cam.enabled && (
        <>
          <div class="row-btns">
            <button class={key === 'start' ? 'on cam-s' : 'cam-s'} onClick={() => (camKey.value = 'start')}>Inicio</button>
            <button class={key === 'end' ? 'on cam-e' : 'cam-e'} onClick={() => (camKey.value = 'end')}>Fin</button>
            <button class={camDrag.value ? 'on' : ''} onClick={() => (camDrag.value = !camDrag.value)}
              title="Arrastrar en el lienzo mueve el encuadre seleccionado (en vez de dibujar)">✥ Mover</button>
          </div>
          <Slider label="X" min={-p.width * 0.5} max={p.width * 1.5} step={1} value={k.x} fmt={(v) => Math.round(v) + ''} onInput={(v) => setKey({ x: v })} />
          <Slider label="Y" min={-p.height * 0.5} max={p.height * 1.5} step={1} value={k.y} fmt={(v) => Math.round(v) + ''} onInput={(v) => setKey({ y: v })} />
          <Slider label="Zoom" min={0.5} max={4} step={0.05} value={k.zoom} fmt={(v) => v.toFixed(2) + '×'} onInput={(v) => setKey({ zoom: v })} />
          <Slider label="Rotación" min={-180} max={180} step={1} value={k.rot} fmt={(v) => Math.round(v) + '°'} onInput={(v) => setKey({ rot: v })} />
          <label class="row">
            <span>Interpolación</span>
            <select value={cam.ease} onChange={(e) => editCamera('cámara', (x) => ({ ...x, ease: (e.target as HTMLSelectElement).value as 'linear' | 'ease' }))}>
              <option value="ease">Suave (ease in/out)</option>
              <option value="linear">Lineal</option>
            </select>
          </label>
          <div class="row-btns">
            <button onClick={() => editCamera('cámara', (x) => ({ ...x, end: { ...x.start } }))}>Inicio → Fin</button>
            <button onClick={() => editCamera('cámara', (x) => ({ ...x, start: { ...x.end } }))}>Fin → Inicio</button>
            <button onClick={() => setKey(defaultCam(p))}>Reset</button>
          </div>
          <p class="hint">Marco azul = inicio, naranja = fin, blanco = cámara en el frame actual. El movimiento va del primer al último frame del recorte.</p>
        </>
      )}
    </section>
  );
}
