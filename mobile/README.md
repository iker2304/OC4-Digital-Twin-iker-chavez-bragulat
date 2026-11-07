# OC4 Digital Twin · Mobile (standalone)

Cliente móvil/landscape **autocontenido**. Toda la inferencia corre **en el
dispositivo** y el gemelo digital 3D se superpone al vídeo de la cámara en un
z-stack con un control de mezcla.

> Rama: `mobile-standalone` · Basada en `development`.

---

## Qué hace

1. **Onboarding por scroll vertical**: seis pantallas a viewport completo
   (portada → concepto → pipeline → modelo ONNX → cámara → entrar).
2. **Captura**: `getUserMedia` con la cámara trasera (o la que elijas).
3. **Inferencia local**: `onnxruntime-web` (WebGPU y, si no está, WASM) sobre
   cada frame del `<video>`, con letterbox, NMS y decodificación YOLOv8/v11
   (detección **y** pose/keypoints).
4. **Overlay 2D**: cajas, etiquetas y esqueletos dibujados en un `<canvas>` 2D.
5. **Capa 3D**: el `OC4.glb` del gemelo digital en un `<canvas>` WebGL
   transparente. Cada detección se ancla como un holograma en la escena
   (a `anchorDepth` metros) y sigue a la cámara, así que al girar el móvil se
   percibe el anclaje respecto al mundo real.
6. **Mezcla**: un deslizador recorre de *real* a *digital* cambiando la opacidad
   de la capa WebGL sobre el vídeo.
7. **Dos posturas**: vertical (escenario arriba, ajustes en hoja inferior) y
   horizontal (escenario a pantalla completa, mezcla en raíl izquierdo, ajustes
   en raíl derecho).

## Arranque rápido

```bash
cd mobile
npm install             # dependencias + runtime de ORT en public/ort (postinstall)
npm run dev             # http://localhost:5273
```

Un clon de esta rama arranca **con eso y nada más**: el gemelo 3D (`OC4.glb`),
el modelo que carga sola al entrar (`yolo-pose-n-200.onnx`, el **nano 200 ft4
en fp32**, 11,2 MB) y dos modelos más para comparar en `/bench`
(`yolo-pose-s-coco-640` fp32, el mejor de la colección, y
`yolo-pose-n-640-int8`, la variante rápida). Los demás modelos y el `.fbx` se
traen con `npm run sync:models`.

Producción (SPA + API opcional en un único proceso):

```bash
npm start               # build + node server/index.mjs --serve-dist
```

## Documentación

- **[PIPELINE.md](PIPELINE.md)** — cómo se pasa del `.onnx` a un gemelo 3D
  colocado sobre la cámara: PnP, Kalman, la matemática y los umbrales.
- **[DEPLOY.md](DEPLOY.md)** — local, Docker, VPS con nginx en subpath, y qué
  assets no están en el repo.

## Herramienta: `/rotor-fem/`

Calibración de la malla FEM de la pala sobre el gemelo. Superpone la pala mallada
en GiD (tres copias a 120°) con un mapa de color de `|u|` y deja mover el anclaje
(centro, giro, radio y acimut) hasta que encaje con el `.glb`. Incluye un árbol de
los nodos del modelo para colocar el ancla de un clic.

```bash
npm run fem:json        # mobile/fem/*.gid -> public/rotor-fem/*.json
npm run dev             # http://localhost:5273/rotor-fem/
```

Los casos `.gid` son la entrada (174 MB, no versionados); los JSON son lo que sirve
la página (~1,3 MB, sí versionados). Ver el docstring de
`scripts/fem-to-json.py` para el formato y para la normalización de ejes.

## Probar en el móvil (y por qué a veces "no hay cámara")

`getUserMedia` **sólo existe en orígenes seguros**: `https://` o
`http://localhost`. En `http://192.168.x.x:5273` el navegador ni siquiera define
`navigator.mediaDevices`, así que no es un permiso denegado: es que la API no
existe. La app detecta los tres casos y te dice cuál es y cómo resolverlo
(aviso ámbar en la pantalla de la cámara).

| Opción | Cómo | Vale para |
| --- | --- | --- |
| **Túnel HTTPS con dominio real** ⭐ | Levanta tu túnel apuntando a `http://localhost:5273` (ya escucha en `0.0.0.0`) y abre el dominio del túnel en el móvil. | Android **y** iPhone. Es la única fiable: certificado de confianza. |
| **HTTPS local autofirmado** | `npm run dev:https` → `https://localhost:5273` | Sólo el equipo donde corre Vite. El certificado que genera el plugin sólo es válido para `localhost`/`127.0.0.1`/`::1`, así que `https://<IP-LAN>:5273` falla la comprobación de nombre. |
| **Bandera de Android** | `chrome://flags/#unsafely-treat-insecure-origin-as-secure` → añade `http://<IP>:5273` → reinicia Chrome. | Android sin certificados. |

Notas:

- El **navegador integrado de VS Code no implementa `getUserMedia`**: abre la URL
  en un navegador normal. Además rechaza certificados autofirmados
  (`ERR_CERT_AUTHORITY_INVALID`, sin opción de continuar), por lo que tampoco
  sirve para probar `https://localhost`.
- Con túnel, si HMR no conecta, pon `HMR_CLIENT_PORT=443` en `.env.local`.
- Vite acepta cualquier `Host` por defecto (con lista blanca de hosts, los túneles
  fallan con **403 This host is not allowed**). Si quieres restringirlo, usa
  `DEV_ALLOWED_HOSTS`.
- El servidor de desarrollo imprime al arrancar las URLs útiles y el recordatorio
  de que `http://<IP>` no sirve para la cámara.

### Si el iPhone no abre la URL de la LAN

Comprobado en este equipo: la regla de firewall de Windows para `node.exe`
(Inbound / TCP / Allow / Public) existe, no hay reglas de bloqueo y el perfil de
red `WiFi` es `Public`. Es decir, **el firewall de Windows no es el problema**.
Por orden de probabilidad:

1. **El servidor no estaba corriendo.** El último `npm run dev` se cerró con
   Ctrl+C (código 130). Con el servidor parado Safari dice «no se puede conectar
   al servidor». Verifica en el PC: `netstat -ano | findstr LISTENING | findstr 5273`.
2. **Mezclaste http y https.** Si el servidor es `npm run dev` (HTTP) y abres
   `https://…` no carga; al revés, con `npm run dev:https` el `http://…` tampoco.
   Usa el esquema que imprima el banner de arranque.
3. **Permiso de red local en iOS** (Ajustes → Privacidad y seguridad → Red local).
   iOS 14+ bloquea el acceso a dispositivos de la LAN si no está concedido, y
   Safari puede no volver a preguntar.
4. **Aislamiento de clientes / AP isolation** en el router, o el iPhone en otra
   red (SSID de invitados, 5 GHz con subred distinta, datos móviles). Comprueba
   que la IP del iPhone (Ajustes → WiFi → ⓘ) está en `192.168.1.x` como el PC.
5. **Adaptador equivocado.** Este PC tiene 5 IPv4; la de la WiFi real es
   `192.168.1.47`. Las `10.x`/`172.x` son de Hyper-V/WSL y el móvil no las alcanza.

El **túnel HTTPS evita las cinco**: no depende del firewall, ni del aislamiento
del router, ni de la IP correcta.

## Alineado con la realidad (PnP)

Es la lógica del proyecto original, portada al móvil: **los keypoints detectados
dan la pose de la cámara**, y con esa pose el gemelo cae exactamente donde está
la plataforma real. Nada se mueve por su cuenta — ni órbita, ni giroscopio.

| Pieza original | Aquí |
| --- | --- |
| `cv2.solvePnPRansac(... SOLVEPNP_EPNP)` en `pnp_solver.py` | `src/lib/pose/solvePnP.ts` (homografía + Levenberg-Marquardt + pasada robusta) |
| `match_points()` (empareja nombre ↔ `3D_points.json`, descarta `Blade*`) | `src/lib/pose/poseTracker.ts` (empareja índice ↔ `KEYPOINTS_SCENE`, descarta score bajo) |
| `LiveCameraController` en `ModelViewer.tsx` | `src/lib/pose/cameraRig.ts` |
| Calibración intrínseca (`calibration.json`) | `FOV` horizontal ajustable en el panel (68° por defecto) |

**Los 11 keypoints** (`keypoint_mapping.json`) y sus coordenadas 3D están en
`src/lib/pose/keypoints3d.ts`. El frame importa: `3D_points.json` está en
coordenadas **mundo de Blender (Z arriba)** y `OC4.glb` en **Y arriba**, así que
la conversión es `(x, z, −y)`. Con ella los 11 puntos caen dentro del bbox medido
del glb (1.103 × 1.921 × 0.764) a la misma escala, que es lo que permite que la
pose sea métrica sin calibrar nada más.

```bash
npm run verify:pose    # 12 checks: solver + reproyección a través de la cámara three.js
```

Los tests son la parte importante: comprueban que la pose se recupera de sus
propias proyecciones, que aguanta ruido de 0.7 px y 2 keypoints basura, y que una
cámara three.js configurada con esa pose **reproyecta los 3D sobre los mismos
píxeles** — también cuando el vídeo va recortado por `object-fit: cover`. Eso es
exactamente el alineado que se ve en pantalla.

En la app (ajustes → **Pose (PnP)**):

- **Alinear el gemelo con la detección**: activa/desactiva el modo. Al desactivarlo
  vuelve el modo libre (giroscopio/órbita, modelo normalizado, hologramas).
- **Campo de visión horizontal**: la única perilla que hay que tocar. Si el gemelo
  está a escala pero "respira" o se despega al girar, el FOV no es el real de tu
  cámara; con un `calibration.json` bueno (fx, fy, cx, cy) esto deja de ser una
  aproximación.
- **Marcar keypoints reproyectados**: dibuja dónde cree la pose que está cada
  keypoint. Si el alineado es bueno, los círculos caen encima de los detectados.
- Chips: `pose` / `sin pose`, inliers (de 11), RMS en píxeles, distancia y edad.

Si no encaja, por orden: (1) sube/baja el FOV, (2) usa la **cámara trasera** (la
frontal va espejada y la pose no puede encajar), (3) sospecha del orden de los
keypoints si el modelo se ve girado o reflejado — todo el mapeo está en
`keypoints3d.ts` y en `keypoint_mapping.json`.

> Nota: en modo pose el modelo se dibuja a **escala nativa**, sin centrar ni
> normalizar, porque esa es la escala de los puntos 3D. Por eso no hay rejilla ni
> hologramas: se dibujarían dentro del mundo real.

## Publicar por el túnel (modo subdominio)

Pensado para **publicar solo el frontend**: el servidor Node sirve `dist/` *y*
`/api` en el mismo origen, así que el túnel necesita **un único puerto**.

```bash
# 1. En el PC (usa .env.local: PORT=8787, SERVE_DIST=1)
npm start          # build + node server/index.mjs --serve-dist
#   → http://localhost:8787    (y 0.0.0.0:8787, que es lo que ve el agente)

# 2. En el panel del túnel: servicio `digitaltwin` → host.docker.internal:8787,
#    modo SUBDOMINIO → PUBLICAR.  (Docker Desktop en Windows: el agente entra
#    por host.docker.internal, no por 127.0.0.1.)
#    Equivalente con docker run:
#    -e TUNNEL_SERVICES=digitaltwin=host.docker.internal:8787

# 3. Comprobar desde el móvil
#    https://<slug>/api/health   →  JSON con request.host = dominio del túnel
#                                    y request.protocol = https
```

La URL del túnel es un **origen seguro con certificado real**, así que aquí es
donde la cámara funciona en iPhone sin tocar certificados.

### Qué viaja por el túnel

| Recurso | Tamaño | De dónde |
| --- | --- | --- |
| App (JS+CSS) | ~1.7 MB (300 KB gzip) | túnel |
| Runtime ONNX (`ort-wasm…jsep.wasm`) | 28 MB → **5.2 MB** | **CDN**, vía `VITE_ORT_ASSET_BASE=cdn` |
| Modelo por defecto (`yolo-pose-n-200.onnx`) | 11.2 MB | túnel, caché 1 día + ETag |
| Gemelo `OC4.glb` | 9.4 MB | túnel, caché 1 día + ETag |

El `.wasm` **no** se puede comprimir (`mime-db` marca `application/wasm` como no
comprimible), así que en modo túnel se sirve desde jsDelivr y no consume tu
subida del VPS. El sentinel `cdn` usa la versión instalada inyectada, para que
nunca se desincronice el binario. Si el primer arranque del móvil te parece
pesado, pon `VITE_AUTOLOAD_MODEL=0` y carga el modelo desde la UI.

### Checklist de `frontend-tunnel.md` aplicada a esta app

| # | Comprobación | Estado |
| --- | --- | --- |
| 1 | La app escucha en `0.0.0.0` | ✅ el servidor Node hace `listen(PORT, '0.0.0.0')`; Vite con `host: true` |
| 2 | El Host del túnel permitido | ✅ el servidor Node no filtra por Host; Vite acepta cualquiera (`allowedHosts: true`) |
| 3 | Rutas relativas en el cliente | ✅ `API_BASE=/api`, modelos `/models/…`; **cero** `localhost` en `src/` |
| 4 | Backend con `trust proxy` | ✅ `app.set('trust proxy', true)` → verificado: `request.protocol = https` con Host de túnel |
| 5 | URLs absolutas con el Host real | ✅ no se genera ninguna URL absoluta |
| — | Extra: COOP/COEP | ✅ se mantienen a través del proxy (WASM multi-hilo) |
| — | Extra: MIME del `.wasm` | ✅ `application/wasm` explícito, o `instantiateStreaming` muere |
| — | Extra: caché | ✅ assets hasheados inmutables; `index.html` sin caché; `/models` 1 día |

Solo hay que exponer **un** puerto: no hay CORS, no hay mixed content y no hay
`localhost` apuntando a la máquina del visitante.

## Scripts

| Script | Qué hace |
| --- | --- |
| `npm run dev` | Vite en `0.0.0.0:5273` con proxy `/api` → `127.0.0.1:8787`. |
| `npm run dev:https` | Igual, pero con HTTPS autofirmado (válido sólo para `localhost`). |
| `npm run build` | `tsc -b` + build de producción. |
| `npm run typecheck` | Sólo comprobación de tipos. |
| `npm run verify:inference` | Self-test del decodificador (20 checks, sin navegador). |
| `npm run inspect:model <f.onnx>` | Lee el contrato del modelo (formas, tarea, clases) sin dependencias. |
| `npm run sync:models` | Copia `*.glb` desde `../web/public/models`. |
| `npm run sync:ort` | Copia el runtime WASM de `node_modules` a `public/ort/`. |
| `npm run server` | Servidor Node de telemetría (sólo API). Lee `.env.local`. |
| `npm run serve` | Servidor Node sirviendo `dist/` + API (lo que publica el túnel). |
| `npm start` | Build + `serve`. El comando para el túnel. |

## Assets pesados (no versionados)

`public/models/*` y `public/ort/` están mayormente en `.gitignore` porque
duplicarían cientos de MB en el repo. **Sí** se versionan `OC4.glb` (9,4 MB), el
modelo por defecto `yolo-pose-n-200.onnx` (11,2 MB, fp32),
`yolo-pose-s-coco-640.onnx` (39,3 MB, fp32; el de mejor rotor) y
`yolo-pose-n-640-int8.onnx` (3,3 MB, la variante rápida). El resto se materializa
con:

```bash
npm run sync:models   # corre automáticamente antes de dev y build
npm run sync:ort      # automático en `npm install` (postinstall)
```

`sync:models` copia desde `mobile/models/`, `web/public/models/` y la **raíz del
repo** (donde suele caer un `best.onnx` recién exportado). Si falta el `.glb`, la
escena 3D **no** se rompe: dibuja una plataforma procedural y lo avisa.

## Modelo ONNX

**El modelo incluido se carga solo al arrancar**: `public/models/yolo-pose-n-200.onnx`
(nano 200 fine-tuned hasta `nano200_coco_ft4`, **fp32**, 11 keypoints, clases
`WindTurbine` / `Rotor`) más su sidecar `yolo-pose-n-200.labels.txt`. No hay que
subir nada. Cuál se carga se decide en el **build**
(`VITE_DEFAULT_MODEL_URL`, ver [DEPLOY.md](DEPLOY.md)); en dev lo puedes apuntar a
otro sitio desde `.env.local`. Para inspeccionarlo o cambiar de modelo:

```bash
npm run inspect:model -- public/models/yolo-pose-n-200.onnx   # formas, tarea, clases, end2end
npm run inspect:model -- public/models/mi-modelo.onnx --write-labels public/models/mi-modelo.labels.txt
npm run sync:models                                          # trae el resto desde ../web/public/models
```

El selector acepta además cualquier `.onnx` por archivo, drag&drop o URL, y un
`.txt` de etiquetas (un nombre por línea) o un sidecar junto al modelo. Se
auto-detecta:

| Salida | Interpretación |
| --- | --- |
| `[1, 4+nc, N]` | detección (COCO ⇒ etiquetas reales; si `nc ≠ 80`, `class N`) |
| `[1, N, 4+nc]` | detección transpuesta |
| `[1, 5+3k, N]` | pose (`k` ∈ 11/14/17/19/21/23/26) |
| `[1, N, 6+3k]` | **pose end2end** (`end2end=True`, NMS en el grafo) — es el caso de `yolo-pose-n-200.onnx`: `[1, 300, 39]` |
| `[1, N, 6]` / `[1, N, 7]` | detección con NMS integrado |

Entrada dinámica soportada: si la dimensión viene como `-1` se usa 640 y se
reajusta en la primera ejecución. `nchw`/`nhwc` se infiere de la forma.

> `end2end=True` cambia el layout por completo: las filas son
> `[x1, y1, x2, y2, conf, cls, keypoints…]`, no `[cx, cy, w, h, scores…]`. Sin
tratarlo como caso aparte, un modelo de pose con NMS integrado se lee como
«detección de 35 clases». Está cubierto y con test.

## Servidor de telemetría (opcional)

`server/index.mjs` es Express y **no** es necesario para que la app funcione.

| Ruta | Uso |
| --- | --- |
| `GET /api/health` | Estado y número de clientes SSE. |
| `GET /api/config` | Config en runtime (modelo, umbrales) sin recompilar. |
| `POST /api/detections` | El móvil publica sus detecciones. |
| `GET /api/detections/stream` | SSE para espejar en otro dispositivo. |

```bash
npm run server                       # API en 8787
curl http://localhost:8787/api/health
```

## Estructura

```
mobile/
├── server/index.mjs            # Express: SPA + telemetría SSE
├── scripts/                    # sync de assets + self-test del decoder
├── vite.config.ts              # COOP/COEP, proxy /api, host 0.0.0.0
└── src/
    ├── App.tsx                 # onboarding ⇄ live, orquesta los hooks
    ├── lib/
    │   ├── env.ts              # configuración, defaults y diagnóstico de cámara
    │   ├── geometry.ts         # letterbox, cover-crop, NDC
    │   ├── cn.ts
    │   ├── labels.ts           # COCO detect/pose, etiquetas custom
    │   ├── telemetry.ts        # POST opcional al servidor Node
    │   ├── useOrientation.ts   # portrait/landscape
    │   ├── useDeviceOrientation.ts  # giroscopio + referencia de yaw
    │   ├── camera/useCameraStream.ts
    │   └── inference/
    │       ├── ortAssets.ts    # resolución de assets y providers
    │       ├── tensor.ts       # frame → tensor (letterbox + normalize)
    │       ├── decode.ts       # YOLO decode + NMS  ← self-tested
    │       ├── engine.ts       # sesión ORT + mapeo a píxeles de origen
    │       ├── useDetectionEngine.ts
    │       └── useInferenceLoop.ts
    ├── store/appStore.ts       # único store zustand
    └── components/
        ├── onboarding/         # scroller snap + diapositivas
        ├── live/               # CameraStack (z-stack), BlendSlider, ControlPanel
        ├── overlay/            # TwinScene/TwinLayer (3D) + DetectionLayer (2D)
        ├── ui/primitives.tsx
        └── ModelPicker.tsx
```

## Detalles que cuestan tiempo si no se saben

- **COOP/COEP**: el dev server y el servidor Node envían
  `Cross-Origin-Embedder-Policy: credentialless`. Sin aislamiento cross-origin,
  `SharedArrayBuffer` no existe y ORT cae a **un solo hilo** (≈2-3× más lento).
  Usamos `credentialless` y no `require-corp` para no romper el CDN de ORT.
- **Runtime de ORT (WASM)**: la causa nº1 de «no available backend found». El
  pegamento JS y el `.wasm` tienen que ser de la **misma versión**, y hay tres
  formas de romperlo:
  1. fijar la versión a mano (CDN 1.20 con glue 1.30) → `initWasm()` falla;
  2. dejar que el *pre-bundler* de Vite resuelva el `new URL('…wasm')` interno →
     pide una ruta inexistente y el servidor devuelve el **index.html**
     (`expected magic word 00 61 73 6d, found 3c 21 64 6f` = `<!do`);
  3. servir el `.wasm` con MIME incorrecto → muere `instantiateStreaming`.

  Por eso: `optimizeDeps.exclude: ['onnxruntime-web']`, **sin** `wasmPaths` por
  defecto (lo resuelve Vite, así siempre coinciden gluc/instrumento y binario) y
  versión inyectada desde `node_modules` por `vite.config.ts`. `VITE_ORT_ASSET_BASE`
  existe para un CDN o para `/ort/` **sólo cuando sirve `server/index.mjs`**: a
  través de Vite, un `/ort/` del proyecto se reescribe a `…mjs?import` y falla.
- **Watcher y assets pesados**: `public/ort` y `public/models` están excluidos de
  `server.watch`. En Windows, reescribir un `.wasm` de 28 MB con el servidor
  levantado mata el proceso con `EBUSY`.
- **Origen seguro**: `navigator.mediaDevices` **no existe** en `http://<IP>`
  (no es un permiso, es la ausencia de la API). Ver la sección «Probar en el móvil».
  `env.ts` → `cameraAccess()` distingue origen inseguro, navegador integrado y
  navegador sin soporte, y devuelve los arreglos concretos.
- **`object-fit: cover`**: el vídeo recorta el frame casi siempre. Las cajas se
  calculan con la misma transformación (`computeCover`) o se despegan del
  objeto. La cámara frontal añade espejo en X a las dos capas.
- **Coordenadas**: las detecciones se devuelven en píxeles del **vídeo de
  origen** (no en los del modelo letterboxed ni en los de pantalla).
- **Bucle de inferencia**: nunca lanza una ejecución con otra en vuelo, respeta
  `maxFps` y se salta frames si la pestaña está oculta. El gemelo apaga su
  `frameloop` cuando la capa está invisible.
- **Giroscopio**: iOS 13+ exige `DeviceOrientationEvent.requestPermission()`
  desde un gesto del usuario; se pide en el mismo click de «Entrar en directo».
  El giro se mide como delta contra una referencia (`recentrar`).
- **Hologramas**: el grupo de cajas se cuelga de la **cámara** y se posiciona en
  espacio de vista a partir de las NDC de la detección. Es exacto y evita
  estimación de pose (PnP) que necesitaría correspondencias 3D.

## Estado y siguientes pasos

Ver [`MIGRATION.md`](./MIGRATION.md) para el alcance de la migración, lo que se
queda fuera a propósito y el plan por fases.
