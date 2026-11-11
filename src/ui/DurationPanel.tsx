import { signal } from '@preact/signals';
import { durationPanelOpen, project, selection } from '../model/store';
import { applyDurationOp, selectionInfo, type DurationOp } from '../model/clipboard';

const op = signal<DurationOp>('each');
const val = signal<Record<DurationOp, string>>({ each: '2', total: '24', add: '1', mul: '2' });
const whole = signal(false);

const OPS: { v: DurationOp; label: string; hint: string }[] = [
  { v: 'each', label: 'Cada una =', hint: 'frames por instancia' },
  { v: 'total', label: 'Total =', hint: 'frames (reparte proporcional)' },
  { v: 'add', label: 'Sumar', hint: 'frames a cada una (negativo resta)' },
  { v: 'mul', label: 'Multiplicar ×', hint: 'factor (0.5, 1.5, 2…)' },
];

export function DurationPanel() {
  if (!durationPanelOpen.value) return null;
  const p = project.value;
  const info = selectionInfo(selection.value);
  const fps = p?.fps ?? 24;
  const cur = op.value;
  const v = val.value[cur];
  const apply = (o = cur, raw = v) => applyDurationOp(o, Number(raw.replace(',', '.')), whole.value);
  const setV = (s: string) => (val.value = { ...val.value, [cur]: s });
  return (
    <div class="durpanel">
      <div class="dp-head">
        <b>Duración</b>
        <span class="hint">
          {whole.value ? 'Todo el clip' : info.count ? `${info.count} instancias · ${info.span} f (${(info.span / fps).toFixed(2)} s)` : 'Sin selección'}
        </span>
        <button onClick={() => (durationPanelOpen.value = false)} title="Cerrar">✕</button>
      </div>
      <div class="dp-ops">
        {OPS.map((o) => (
          <button class={cur === o.v ? 'on' : ''} onClick={() => (op.value = o.v)}>{o.label}</button>
        ))}
      </div>
      <div class="dp-row">
        <input type="number" inputMode="decimal" step={cur === 'mul' ? 0.1 : 1} value={v}
          onInput={(e) => setV((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && apply()} />
        <span class="hint">{OPS.find((o) => o.v === cur)!.hint}</span>
        {cur === 'total' && <span class="hint">= {(Number(v) / fps).toFixed(2)} s</span>}
        <button class="primary" onClick={() => apply()}>Aplicar</button>
      </div>
      <div class="dp-row">
        <span class="hint">Rápido:</span>
        <button onClick={() => apply('each', '1')}>en 1s</button>
        <button onClick={() => apply('each', '2')}>en 2s</button>
        <button onClick={() => apply('each', '3')}>en 3s</button>
        <button onClick={() => apply('add', '-1')}>−1</button>
        <button onClick={() => apply('add', '1')}>+1</button>
        <button onClick={() => apply('mul', '0.5')}>×½</button>
        <button onClick={() => apply('mul', '2')}>×2</button>
        <label class="check"><input type="checkbox" checked={whole.value} onChange={() => (whole.value = !whole.value)} /> Todo el clip</label>
      </div>
    </div>
  );
}
