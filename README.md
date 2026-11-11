# Planos — storyboard y animatic para tablet

App web (PWA, offline) para storyboards con modelo tipo TVPaint: proyecto → clips → capas → instancias.

## Desarrollo
```
npm install
npm run dev      # http://localhost:5173
npm test         # tests de timing / behaviors
npm run build
```

## Probar en el tablet Android por USB
Con depuración USB activada:
```
adb reverse tcp:5173 tcp:5173
```
y abrir `http://localhost:5173` en Chrome del tablet.

## Estado (fase 1)
Proyectos/clips/capas, lápiz y goma con presión, gestos (pinch/rotar/pan, tap 2 dedos = deshacer, 3 = rehacer),
timeline horizontal con instancias, estirar con ripple, pre/post Cut/Hold/Loop, Mark In/Out de loop,
recorte In/Out, playback, papel cebolla, auto-instancia, undo/redo, autoguardado en IndexedDB, backup .zip.
