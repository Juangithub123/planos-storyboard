import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { Editor, screen } from './ui/Editor';
import { ProjectList } from './ui/ProjectList';
import { flushProject } from './model/store';
import { flushDrawings, hasPendingDrawingSaves } from './render/drawings';
import './styles.css';

registerSW({ immediate: true });

// Guardar todo apenas la app pasa a segundo plano (Android puede matar la pestaña).
const flushAll = () => {
  void flushProject();
  void flushDrawings();
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAll();
});
window.addEventListener('pagehide', flushAll);
window.addEventListener('beforeunload', (e) => {
  flushAll();
  if (hasPendingDrawingSaves()) e.preventDefault();
});

function App() {
  return screen.value === 'editor' ? <Editor /> : <ProjectList />;
}

render(<App />, document.getElementById('app')!);
