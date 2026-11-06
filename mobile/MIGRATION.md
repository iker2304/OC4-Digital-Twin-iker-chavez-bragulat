# Migración a `mobile-standalone`

Documento de alcance. Explica **qué del `main`/`development` se conserva, qué se
deja fuera a propósito y en qué orden se irá cubriendo**.

## Punto de partida (lo que ya existe en el repo)

| Pieza | Estado en `development` | Decisión en esta rama |
| --- | --- | --- |
| Frontend | React 19 + Vite + TS + Tailwind 4 + three/R3F en `web/` | **Se reutiliza el stack**, no el código: `mobile/` es una app nueva. |
| Backend | FastAPI (Python) en `backend/` | **No se migra.** La inferencia pasa al dispositivo; sólo queda un Express mínimo opcional. |
| Inferencia | `onnxruntime` en Python dentro de `flow_executor.py` (`ONNXModel`) | Se **porta la semántica** (preproceso + decode YOLO + NMS) a `src/lib/inference/`. |
| Captura móvil | `web/src/pages/MobileCamera.tsx` envía JPEG por WS a `/ws/mobile-stream` | **Sustituido**: ya no hay ida y vuelta al servidor, el frame no sale del móvil. |
| Modelo 3D | `web/public/models/OC4.glb` (+ `OC4-modal.glb`) | Se sincroniza a `mobile/public/models` con `npm run sync:models`. |
| Editor de flujos de nodos | `PipelineEditor.tsx`, `flow_executor.py` | Fuera de alcance en móvil. |
| MQTT, FEM modal, SHM, mapas, Grafana, dataset generation | Múltiples páginas y routers | Fuera de alcance (ver más abajo). |

## Objetivo de la rama

Una app **standalone** para móvil y pantallas horizontales donde el usuario:

1. entiende el proyecto en 4 scrolls,
2. carga un modelo ONNX,
3. apunta con la cámara,
4. y ve la detección (cajas/keypoints) y el gemelo digital 3D **mezclados en el
   mismo encuadre**, sin backend.

Énfasis en *ver* frente al énfasis en *medir* de la app principal.

## Fases

### Fase 1 — Hito actual (hecho)

- [x] Estructura del proyecto (`mobile/`), Tailwind 4, TS estricto, build limpio.
- [x] Onboarding de scroll vertical con 6 pantallas y raíl de progreso.
- [x] Captura con selección de cámara, cambio frontal/trasera y errores legibles.
- [x] `onnxruntime-web` con WebGPU → WASM, auto-configuración de assets.
- [x] Preproceso (letterbox) + decode YOLOv8/v11 (detección y pose) + NMS.
- [x] Overlay 2D en canvas, corregido por `object-fit: cover` y por espejo.
- [x] Capa three.js con `OC4.glb` (o plataforma procedural), grid e iluminación.
- [x] Hologramas 3D por detección, anclados a la cámara a `anchorDepth` m.
- [x] Giroscopio para orientar la vista + recentrado; órbita automática si no hay sensor.
- [x] Deslizador de mezcla real ↔ gemelo.
- [x] Dos composiciones: vertical y horizontal.
- [x] Servidor Express opcional con telemetría SSE y `GET /api/config`.
- [x] Self-test del decodificador (`npm run verify:inference`).

### Fase 2 — Precisión visual (hecho, salvo calibración)

1. [x] **Pose de cámara por PnP**: `src/lib/pose/` porta la lógica de
   `pnp_solver.py` (emparejado de keypoints, solver, robustez) y de
   `ModelViewer.tsx` (`LiveCameraController`). El gemelo cae sobre la plataforma
   real y deja de moverse solo: verificado con `npm run verify:pose` (incluye la
   reproyección a través de una cámara three.js real y el recorte de encuadre).
2. [x] **Suavizado temporal**: slerp de la rotación + rechazo de saltos
   imposibles, en `poseTracker.ts`. Sustituye al Kalman del pipeline Python.
3. [ ] **Calibración de intrínsecos**: hoy el FOV es una perilla manual (68° por
   defecto). Falta cargar un `calibration.json` (fx, fy, cx, cy) y/o un mini
   ajuste con tablero, como `utils/scripts/camera/camera_calibration.py`.
4. [ ] **Correspondencias**: confirmar el orden de los 11 keypoints
   (`keypoint_mapping.json`) contra el modelo entrenado. Si el gemelo aparece
   girado o reflejado con buen RMS, es esto.

### Fase 3 — Producto

5. **PWA**: `vite-plugin-pwa` (ya está en `web/`) para instalable + offline.
   Necesario: cachear `OC4.glb` (~9 MB) y el runtime ORT, con `maximumFileSizeToCacheInBytes`.
6. **Modelo por defecto incluido**: exportar un `yolov8n-pose.onnx` y servirlo en
   `public/models` para que la primera experiencia funcione sin pasos previos.
7. **Sensorización**: leer la telemetría real de la plataforma (MQTT) y animar el
   gemelo con `web/src/physics/StructuralEngine.ts` en vez de una escena estática.
8. **Grabación y exportación**: capturar el canvas compuesto (vídeo + overlay +
   3D) a WebM, y volcar detecciones a CSV/JSON.
9. **Modo multi-cámara** y sincronización vía el servidor Node (ya hay SSE).

## Fuera de alcance (a propósito)

- Autenticación y perfiles (`authStore`, `api/auth.py`).
- FEM modal, SHM/fatiga, mapas Leaflet, Grafana, generación de dataset, editor de
  pipelines. Son módulos de escritorio; si alguno se necesita en móvil, será una
  pantalla nueva que consuma datos ya calculados, no una migración.
- MQTT directo desde el navegador (requiere WS con TLS en el broker).

## Riesgos conocidos

| Riesgo | Impacto | Mitigación actual |
| --- | --- | --- |
| Cámara bloqueada en `http://IP` | No hay captura | Diagnóstico en pantalla (`cameraAccess()`) con los tres arreglos concretos; **túnel HTTPS con dominio real** como vía recomendada; `npm run dev:https` para `https://localhost` |
| Certificado autofirmado no válido para la LAN | `https://<IP>` falla incluso con `HTTPS=1` | El SAN del plugin sólo cubre `localhost`/`127.0.0.1`/`::1` → documentado y avisado en el banner del dev server; el móvil va por túnel |
| WebGPU inestable en algunos Android | Cajas erróneas o lentitud | Se puede forzar WASM; el proveedor real se muestra en el HUD |
| 28 MB de `.wasm` en `dist` | Deploy más pesado | Se sirve desde `/ort/` (local) o CDN, no desde el bundle → pendiente excluir del build |
| Modelos con entrada no cuadrada | Letterbox a cuadrado | Se respeta la relación de aspecto; probar con `inputSize` real |
| Deriva del giroscopio | El gemelo se desvía | En modo pose el giroscopio no se usa: la cámara viene del PnP. El botón «Olvidar pose» lo reinicia |
| FOV aproximado | El gemelo está a escala pero no encaja del todo | Perilla de FOV en el panel; la solución buena es un `calibration.json` |
| Orden de keypoints equivocado | Gemelo girado/reflejado con RMS bajo | Todo el mapeo en `keypoints3d.ts`; se ve con «Marcar keypoints reproyectados» |
