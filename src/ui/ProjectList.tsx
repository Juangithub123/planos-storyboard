import { useEffect, useState } from 'preact/hooks';
import { makeProject, openProject } from '../model/store';
import type { Project } from '../model/types';
import { deleteProject, listProjects, putProject, requestPersistence } from '../storage/db';
import { collectGarbage, exportBackup, importBackup } from '../storage/backup';
import { initDrawings } from '../render/drawings';
import { screen } from './Editor';
import { DocsModal, docsOpen } from './Help';

const PRESETS = [
  { label: '1920×1080 (16:9 HD)', w: 1920, h: 1080 },
  { label: '1280×720 (16:9, más liviano)', w: 1280, h: 720 },
  { label: '1080×1920 (vertical)', w: 1080, h: 1920 },
  { label: '1080×1080 (cuadrado)', w: 1080, h: 1080 },
  { label: '2048×858 (2.39 scope)', w: 2048, h: 858 },
];
const FPS = [12, 24, 25, 30];

export async function enterProject(p: Project) {
  initDrawings(p.id, p.width, p.height);
  await collectGarbage(p).catch(() => {});
  openProject(p);
  screen.value = 'editor';
}

export function ProjectList() {
  const [list, setList] = useState<Project[] | null>(null);
  const [name, setName] = useState('Mi storyboard');
  const [preset, setPreset] = useState(0);
  const [fps, setFps] = useState(24);
  const [persisted, setPersisted] = useState<boolean | null>(null);

  const refresh = () => listProjects().then(setList);
  useEffect(() => {
    refresh();
    navigator.storage?.persisted?.().then(setPersisted).catch(() => {});
  }, []);

  const create = async () => {
    const pr = PRESETS[preset];
    const p = makeProject(name.trim() || 'Sin nombre', pr.w, pr.h, fps);
    await putProject(p);
    setPersisted(await requestPersistence());
    await enterProject(p);
  };

  const onImport = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      await importBackup(f);
      refresh();
    } catch (err) {
      alert('No se pudo importar: ' + (err as Error).message);
    }
  };

  return (
    <div class="projects">
      <header>
        <div class="card-head">
          <h1>Planos</h1>
          <button onClick={() => (docsOpen.value = 'inicio')}>📖︎ Documentación</button>
        </div>
        <p>Storyboard y animatic. Todo se guarda en este dispositivo, sin conexión.</p>
        {persisted === false && (
          <p class="warn-text">
            El navegador todavía no garantizó el almacenamiento persistente. Instalá la app (menú del navegador →
            "Instalar app" / "Agregar a pantalla de inicio") y hacé backups seguido.
          </p>
        )}
      </header>

      <section class="card">
        <h2>Nuevo proyecto</h2>
        <div class="form">
          <label>Nombre<input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
          <label>Formato
            <select value={preset} onChange={(e) => setPreset(Number((e.target as HTMLSelectElement).value))}>
              {PRESETS.map((p, i) => <option value={i}>{p.label}</option>)}
            </select>
          </label>
          <label>FPS
            <select value={fps} onChange={(e) => setFps(Number((e.target as HTMLSelectElement).value))}>
              {FPS.map((f) => <option value={f}>{f}</option>)}
            </select>
          </label>
          <button class="primary" onClick={create}>Crear</button>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Proyectos</h2>
          <label class="btn">Importar backup…<input type="file" accept=".zip" hidden onChange={onImport} /></label>
        </div>
        {list === null ? <p>Cargando…</p> : list.length === 0 ? <p class="hint">Todavía no hay proyectos.</p> : (
          <ul class="plist">
            {list.map((p) => (
              <li>
                <button class="open" onClick={() => enterProject(p)}>
                  <b>{p.name}</b>
                  <small>{p.width}×{p.height} · {p.fps} fps · {p.clipOrder.length} clips · {new Date(p.updatedAt).toLocaleString()}</small>
                  {p.updatedAt > p.lastBackupAt && <small class="warn-text">Cambios sin backup</small>}
                </button>
                <button onClick={async () => {
                  await exportBackup(p);
                  await putProject({ ...p, lastBackupAt: Date.now() });
                  refresh();
                }}>Backup</button>
                <button class="danger" onClick={async () => {
                  if (confirm(`¿Borrar "${p.name}" de este dispositivo? No se puede deshacer.`)) {
                    await deleteProject(p.id);
                    refresh();
                  }
                }}>Borrar</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <DocsModal />
    </div>
  );
}
