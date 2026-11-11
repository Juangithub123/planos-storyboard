import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

/**
 * Ayuda:
 *  - HelpOverlay: oscurece la app y marca con números cada zona que tenga `data-help`
 *    (título) y `data-help-text` (descripción). Tocar un número o una entrada resalta la zona.
 *  - DocsModal: documentación completa por secciones.
 */

export const helpOpen = signal(false);
export const docsOpen = signal<string | null>(null);

interface Region {
  n: number;
  title: string;
  text: string;
  docs?: string;
  r: DOMRect;
}

function visibleRegions(): Region[] {
  const out: Region[] = [];
  document.querySelectorAll<HTMLElement>('[data-help]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return;
    // ¿está tapada por otra vista (ej. Secuencia encima del editor)?
    const cx = Math.min(innerWidth - 1, Math.max(0, r.left + Math.min(r.width / 2, 30)));
    const cy = Math.min(innerHeight - 1, Math.max(0, r.top + Math.min(r.height / 2, 20)));
    const hit = document.elementsFromPoint(cx, cy).find((e) => !(e as HTMLElement).closest?.('.help-overlay'));
    if (hit && !el.contains(hit) && !hit.contains(el)) return;
    // recortar a la pantalla
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    const cr = new DOMRect(x, y, Math.min(innerWidth, r.right) - x, Math.min(innerHeight, r.bottom) - y);
    out.push({ n: 0, title: el.dataset.help!, text: el.dataset.helpText ?? '', docs: el.dataset.helpDocs, r: cr });
  });
  out.sort((a, b) => (Math.abs(a.r.top - b.r.top) > 30 ? a.r.top - b.r.top : a.r.left - b.r.left));
  out.forEach((x, i) => (x.n = i + 1));
  return out;
}

export function HelpOverlay() {
  const [regions, setRegions] = useState<Region[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [left, setLeft] = useState(false);
  const [mini, setMini] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const open = helpOpen.value;

  useLayoutEffect(() => {
    if (!open) return;
    const upd = () => setRegions(visibleRegions());
    upd();
    addEventListener('resize', upd);
    return () => removeEventListener('resize', upd);
  }, [open]);

  useEffect(() => {
    if (active === null) return;
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-n="${active}"]`);
    if (list && item) list.scrollTop = item.offsetTop - list.offsetTop - 8;
  }, [active]);

  if (!open) return null;
  const close = () => {
    helpOpen.value = false;
    setActive(null);
  };
  const act = regions.find((r) => r.n === active);
  // globo con la explicación junto a la zona activa (arriba o abajo, según el espacio)
  let bubble = null;
  if (act) {
    const W = Math.min(340, innerWidth - 24);
    const cx = act.r.left + act.r.width / 2;
    const bx = Math.max(12, Math.min(innerWidth - W - 12, cx - W / 2));
    const above = act.r.top > innerHeight - act.r.bottom;
    const style = above
      ? { left: bx + 'px', width: W + 'px', bottom: innerHeight - act.r.top + 10 + 'px' }
      : { left: bx + 'px', width: W + 'px', top: act.r.bottom + 10 + 'px' };
    bubble = (
      <div class="help-bubble" style={style} onPointerDown={(e) => e.stopPropagation()}>
        <b><span class="help-badge static">{act.n}</span> {act.title}</b>
        <p>{act.text}</p>
        {act.docs && <a onClick={() => { docsOpen.value = act.docs!; close(); }}>Ver en la documentación →</a>}
      </div>
    );
  }

  return (
    <div class="help-overlay" onPointerDown={(e) => e.target === e.currentTarget && setActive(null)}>
      {regions.map((g) => (
        <div class={'help-box' + (active === g.n ? ' on' : '')}
          style={{ left: g.r.left + 'px', top: g.r.top + 'px', width: g.r.width + 'px', height: g.r.height + 'px' }}
          onPointerDown={(e) => { e.stopPropagation(); setActive(g.n); }}>
          <span class="help-badge">{g.n}</span>
          {active === g.n && <span class="help-tag">{g.title}</span>}
        </div>
      ))}
      {bubble}
      <div class={'help-card' + (left ? ' left' : '') + (mini ? ' mini' : '')}>
        <div class="hc-head">
          <b>Ayuda · ¿qué es cada cosa?</b>
          <button onClick={() => setMini(!mini)} title={mini ? 'Mostrar lista' : 'Minimizar lista'}>{mini ? '▾' : '▴'}</button>
          <button onClick={() => setLeft(!left)} title="Mover al otro lado">⇄</button>
          <button onClick={() => { docsOpen.value = 'inicio'; close(); }}>Documentación</button>
          <button onClick={close} title="Cerrar ayuda">✕</button>
        </div>
        {!mini && <p class="hint">Tocá un número sobre la app o una entrada de la lista. Cambiá a la vista Secuencia y volvé a abrir la ayuda para ver sus partes.</p>}
        <div class="hc-list" ref={listRef} hidden={mini}>
          {regions.map((g) => (
            <div class={'hc-item' + (active === g.n ? ' on' : '')} data-n={g.n} onClick={() => setActive(g.n)}>
              <span class="help-badge static">{g.n}</span>
              <div>
                <b>{g.title}</b>
                <p>{g.text}</p>
                {g.docs && (
                  <a onClick={(e) => { e.stopPropagation(); docsOpen.value = g.docs!; close(); }}>Ver en la documentación →</a>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documentación

interface Section {
  id: string;
  title: string;
  body: () => ComponentChildren;
}

const K = ({ children }: { children: ComponentChildren }) => <kbd>{children}</kbd>;

const SECTIONS: Section[] = [
  {
    id: 'inicio', title: 'Qué es Planos',
    body: () => (
      <>
        <p>Planos es una herramienta liviana de storyboard y animatic pensada para tablet con stylus. Sigue el modelo de TVPaint:</p>
        <ul>
          <li><b>Proyecto</b>: tiene resolución y fps fijos, y una secuencia ordenada de <b>clips</b> (planos).</li>
          <li><b>Clip</b>: un plano con varias <b>capas</b>. Su largo es automático: lo que dura la capa más larga.</li>
          <li><b>Capa</b>: una fila de <b>instancias</b> consecutivas. Tiene visibilidad, bloqueo, opacidad, modo de fusión y comportamiento antes/después.</li>
          <li><b>Instancia</b>: un dibujo que se sostiene una cantidad de frames (su duración). Una instancia puede estar vacía (hueco).</li>
        </ul>
        <p>Flujo típico: creás un proyecto, dibujás los paneles de cada plano, ajustás tiempos en la timeline, revisás todo de corrido en <b>Secuencia</b> y hacés backups seguido.</p>
        <p>Tocá el botón <b>?</b> de la barra superior para ver sobre la app dónde está cada cosa.</p>
      </>
    ),
  },
  {
    id: 'proyectos', title: 'Proyectos, guardado y backup',
    body: () => (
      <>
        <ul>
          <li>Todo se guarda <b>automáticamente en este dispositivo</b> después de cada trazo o cambio. No hace falta internet y nada se sube a ningún servidor.</li>
          <li>Instalá la app desde el menú de Chrome (<i>Instalar app</i>) para que funcione offline y para que el navegador no borre los datos.</li>
          <li>El único riesgo real es borrar los datos del navegador o desinstalar Chrome. Por eso conviene el <b>Backup</b>: descarga un <code>.planos.zip</code> con el proyecto completo. El botón se pone rojo si pasó más de un día con cambios sin backup.</li>
          <li><b>Importar backup…</b> (en la lista de proyectos) carga un .zip como proyecto nuevo, sin pisar ninguno existente.</li>
          <li>☰ vuelve a la lista de proyectos. Desde ahí también podés hacer backup o borrar proyectos.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'dibujo', title: 'Dibujo',
    body: () => (
      <>
        <ul>
          <li><b>Lápiz</b> (<K>B</K>) y <b>goma</b> (<K>E</K>) con presión: en el panel lateral elegís tamaño, opacidad y si la presión cambia el tamaño.</li>
          <li><b>Color</b>: el selector y la paleta del proyecto. <b>+</b> agrega el color actual a la paleta; mantener presionado (o click derecho) un color lo quita.</li>
          <li>Dibujás siempre en la <b>capa actual</b> (resaltada en la timeline) y en el <b>frame del cabezal</b>:
            <ul>
              <li>Si el cabezal cae sobre una instancia con dibujo, editás ese dibujo, que se ve en todos sus frames.</li>
              <li>Si cae en un frame vacío o fuera de la capa, se crea una instancia nueva ahí.</li>
              <li>Con <b>Auto-inst</b> activado, dibujar en el medio de una instancia sostenida la parte en el cabezal y dibujás en una instancia nueva.</li>
            </ul>
          </li>
          <li>No se puede dibujar en capas bloqueadas u ocultas.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'gestos', title: 'Gestos y pie menu',
    body: () => (
      <>
        <ul>
          <li><b>Sólo el stylus dibuja</b>: la mano o los dedos no pintan (palm rejection).</li>
          <li><b>1 dedo</b>: mover el lienzo. <b>2 dedos</b>: zoom, rotar y mover. Cerca de 0° la rotación se endereza sola.</li>
          <li><b>Tap con 2 dedos</b> = deshacer, <b>tap con 3 dedos</b> = rehacer.</li>
          <li><b>⤢</b> en la barra superior vuelve a encuadrar el lienzo.</li>
          <li><b>Pie menu</b>: mantené el stylus quieto en el lienzo ~1 segundo. Tiene lápiz, goma, deshacer, rehacer, capa ↑/↓, nueva instancia, papel cebolla y una lista de capas. El tiempo se ajusta (o se desactiva) en el panel lateral → Entrada. Con mouse se abre con click derecho.</li>
          <li>Sin stylus podés activar <i>Dibujar con el dedo</i> en el panel lateral.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'timeline', title: 'Timeline e instancias',
    body: () => (
      <>
        <ul>
          <li>Los frames van de izquierda a derecha y cada fila es una capa. Cada bloque es una instancia y el número abajo a la izquierda es su duración en frames.</li>
          <li><b>Regla</b>: tocá o arrastrá para mover el cabezal (scrub). La línea amarilla marca el final del clip.</li>
          <li><b>Tocar una instancia</b> la selecciona y mueve el cabezal ahí. Con lápiz o mouse, arrastrar sobre algo no seleccionado hace scrub.</li>
          <li><b>Estirar / acortar</b>: arrastrá la manija gris del borde derecho de una instancia. Lo que sigue se corre (ripple), nada se pisa.</li>
          <li><b>Reordenar</b>: arrastrá una instancia ya seleccionada (en táctil: mantené presionado ~0,4 s y arrastrá). La barra amarilla muestra dónde cae.</li>
          <li>Botones: <b>+ Inst</b> (instancia vacía en el cabezal), <b>Dup</b> (duplica el dibujo), <b>Vacía</b> (hueco después), <b>Borrar</b>, <b>−1/+1</b> (duración), <b>Hold</b>.</li>
          <li>Transporte: inicio, instancia anterior/siguiente, frame anterior/siguiente, play (<K>espacio</K>), final. Con el teclado, <K>←</K> <K>→</K> mueven de a un frame.</li>
          <li><b>− / +</b> al final de la barra (o <K>Ctrl</K>+rueda) cambian el zoom de la timeline.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'capas', title: 'Capas y behaviors (Cut / Hold / Loop)',
    body: () => (
      <>
        <ul>
          <li>En cada encabezado de capa: ◉ visibilidad, 🔓 bloqueo, nombre (doble toque para renombrar) y dos selectores: <b>antes</b> y <b>después</b> de sus instancias.</li>
          <li><b>Cut</b>: fuera de sus instancias la capa no muestra nada.</li>
          <li><b>Hold</b>: sostiene el primer/último dibujo hasta el inicio/final del clip. El botón <b>Hold</b> de la barra alterna el "después" de la capa actual.</li>
          <li><b>Loop</b>: repite las instancias en ciclo.</li>
          <li>Las extensiones de Hold/Loop se ven rayadas en la timeline.</li>
          <li><b>+ Capa</b>, <b>↑ ↓</b> (orden), <b>Copiar capa</b>, <b>− Capa</b>. Opacidad y modo de fusión de la capa actual están en el panel lateral.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'marks', title: 'Mark In/Out y recorte',
    body: () => (
      <>
        <ul>
          <li><b>In / Out</b>: limitan el rango de <b>reproducción en loop</b> mientras animás (barra azul en la regla). No cambian el clip. ✕ los borra.</li>
          <li><b>[ Rec / Rec ]</b>: el <b>recorte</b> define qué parte del clip entra al animatic (Secuencia y exports). Lo que queda afuera se ve sombreado. ✕ lo borra.</li>
          <li>Los dos se marcan en la posición del cabezal.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'seleccion', title: 'Multiselección y escalado de tiempos',
    body: () => (
      <>
        <ul>
          <li><b>Multi</b>: con esto activado cada toque suma o quita instancias de la selección, y arrastrar dibuja un rectángulo que selecciona en varias capas a la vez. En PC también sirven <K>Shift</K>/<K>Ctrl</K>+click.</li>
          <li><b>Todo</b> (<K>Ctrl</K>+<K>A</K>) selecciona el clip entero. <K>Esc</K> limpia la selección.</li>
          <li>Con más de una instancia seleccionada aparece una <b>caja azul con dos manijas</b>:
            <ul>
              <li>Manija derecha: el ancla es el inicio de la selección. Manija izquierda: el ancla es el final.</li>
              <li><b>⇔ Prop</b> (como Alt+drag en After Effects): todo se escala en proporción, redondeado a frames enteros y con mínimo 1. Todas las capas usan el mismo ancla y factor, así que quedan sincronizadas.</li>
              <li><b>± Delta</b>: a cada instancia se le suma o resta la misma cantidad de frames.</li>
              <li>Lo que sigue después de la selección se corre (ripple).</li>
            </ul>
          </li>
          <li><b>−1 / +1</b> con varias seleccionadas modifica todas.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'duracion', title: 'Panel de duración',
    body: () => (
      <>
        <p>Se abre con <b>Duración…</b> y aplica sobre la selección (o sobre todo el clip si marcás <i>Todo el clip</i>):</p>
        <ul>
          <li><b>Cada una =</b> N frames por instancia (ej. animar en 2s).</li>
          <li><b>Total =</b> N frames: la selección completa pasa a durar eso, repartido proporcionalmente. También muestra el equivalente en segundos.</li>
          <li><b>Sumar</b> ±N frames a cada una.</li>
          <li><b>Multiplicar ×</b> F (0.5, 1.5, 2…).</li>
          <li>Botones rápidos: en 1s/2s/3s, −1, +1, ×½, ×2.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'copiar', title: 'Copiar y pegar',
    body: () => (
      <>
        <ul>
          <li><b>Copiar</b> (<K>Ctrl</K>+<K>C</K>) copia las instancias seleccionadas, de una o varias capas.</li>
          <li><b>Pegar</b> (<K>Ctrl</K>+<K>V</K>) las inserta en el cabezal: la primera fila en la capa actual y las siguientes en las capas de abajo (si faltan capas, se crean). Lo que había después se corre.</li>
          <li><b>Copiar capa</b> y después <b>Pegar</b>: inserta una copia de la capa en el clip actual (sirve entre clips).</li>
          <li>En Secuencia: <b>Copiar</b> un clip y <b>Pegar clip</b>.</li>
          <li>Los dibujos se duplican: modificar una copia no afecta al original.</li>
          <li>El portapapeles vale dentro del proyecto abierto.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'clips', title: 'Clips y vista Secuencia',
    body: () => (
      <>
        <ul>
          <li>Barra superior: ‹ › y el selector para cambiar de clip, <b>+ Clip</b> (nuevo después del actual), <b>Cortar</b> (parte el clip en el cabezal en dos clips), <b>Dup clip</b>, <b>Renombrar</b>, <b>− Clip</b>.</li>
          <li><b>Secuencia</b> muestra arriba el animatic completo (cada clip con su recorte), con play, timecode y una tira para hacer scrub. Abajo está el storyboard con miniaturas numeradas y la duración de cada plano.</li>
          <li>En el storyboard: tocá un plano para abrirlo, arrastralo para reordenar (en táctil: mantené presionado), y usá ◀ ▶, Dup, Copiar y ✕.</li>
          <li>La numeración de planos es automática según el orden.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'cebolla', title: 'Papel cebolla',
    body: () => (
      <>
        <ul>
          <li>Botón <b>Cebolla</b> en la timeline (o en el pie menu). Muestra los dibujos anteriores en rojo y los siguientes en verde, contando por <b>instancias</b>, no por frames.</li>
          <li>Funciona también en frames vacíos: si el cabezal está después del final de la capa, ves los últimos dibujos para guiarte en el siguiente.</li>
          <li>En el panel lateral elegís cuántos antes/después, la opacidad, y si se aplica sólo a la capa actual o a todas.</li>
          <li>Durante la reproducción se oculta.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'atajos', title: 'Atajos de teclado',
    body: () => (
      <table class="keys">
        <tbody>
          <tr><td><K>B</K> / <K>E</K></td><td>Lápiz / goma</td></tr>
          <tr><td><K>Espacio</K></td><td>Play / pausa</td></tr>
          <tr><td><K>←</K> <K>→</K></td><td>Frame anterior / siguiente</td></tr>
          <tr><td><K>Ctrl</K>+<K>Z</K> / <K>Ctrl</K>+<K>Y</K></td><td>Deshacer / rehacer</td></tr>
          <tr><td><K>Ctrl</K>+<K>C</K> / <K>Ctrl</K>+<K>V</K></td><td>Copiar / pegar instancias</td></tr>
          <tr><td><K>Ctrl</K>+<K>A</K></td><td>Seleccionar todo el clip</td></tr>
          <tr><td><K>Supr</K></td><td>Borrar instancias seleccionadas</td></tr>
          <tr><td><K>Esc</K></td><td>Limpiar selección</td></tr>
          <tr><td>Click derecho</td><td>Pie menu</td></tr>
        </tbody>
      </table>
    ),
  },
];

export function DocsModal() {
  const cur = docsOpen.value;
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [cur]);
  if (!cur) return null;
  const sec = SECTIONS.find((s) => s.id === cur) ?? SECTIONS[0];
  const i = SECTIONS.indexOf(sec);
  return (
    <div class="docs-overlay" onPointerDown={(e) => e.target === e.currentTarget && (docsOpen.value = null)}>
      <div class="docs">
        <nav>
          <b>Documentación</b>
          {SECTIONS.map((s) => (
            <button class={s.id === sec.id ? 'on' : ''} onClick={() => (docsOpen.value = s.id)}>{s.title}</button>
          ))}
        </nav>
        <article ref={bodyRef}>
          <div class="docs-head">
            <h2>{sec.title}</h2>
            <button onClick={() => (docsOpen.value = null)} title="Cerrar">✕</button>
          </div>
          {sec.body()}
          <div class="docs-nav">
            {i > 0 && <button onClick={() => (docsOpen.value = SECTIONS[i - 1].id)}>← {SECTIONS[i - 1].title}</button>}
            <span class="grow" />
            {i < SECTIONS.length - 1 && <button onClick={() => (docsOpen.value = SECTIONS[i + 1].id)}>{SECTIONS[i + 1].title} →</button>}
          </div>
        </article>
      </div>
    </div>
  );
}
