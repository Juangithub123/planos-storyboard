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

## Fase 2
Multiselección multicapa (tap, modo Multi, rectángulo, Todo), escalado de la selección con manijas
(proporcional tipo AE o delta), panel de duración (cada una / total / sumar / multiplicar, sobre selección o clip),
reordenar instancias arrastrando (táctil: mantener presionado), copiar/pegar instancias, capas y clips,
cortar clip en el cabezal, duplicar clip, pie menu (stylus quieto ~1 s, click derecho con mouse),
vista Secuencia con reproductor del animatic y storyboard reordenable.
Atajos: Ctrl+Z/Y, Ctrl+C/V, Ctrl+A, Supr, Esc, espacio, flechas, B/E.

## Fase 3
Relleno (bordes de la capa actual o de todas las visibles, tolerancia, expandir), formas (línea, rectángulo,
elipse, con o sin relleno), lazo con mover/escalar/rotar/voltear, grupos de capas (plegar, visibilidad, bloqueo,
opacidad de grupo), capas de referencia de imagen y de video (guardadas en IndexedDB y en el backup),
zoom horizontal y vertical de la timeline con reset y fit. Base de datos v2 (migración automática desde v1).

## Fase 4
Audio del proyecto (pistas, clips movibles, volumen, mute, scrub, forma de onda en la timeline del clip),
cámara por clip (inicio/fin interpolados, marcos en el lienzo, arrastre), export de video (MP4 H.264+AAC
o WebM con WebCodecs), secuencias PNG por capa o compuestas en .zip y PDF de storyboard (escritor propio).
