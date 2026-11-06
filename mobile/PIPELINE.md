# Del ONNX al gemelo en 3D: el pipeline, paso a paso

Este documento explica **cómo se pasa de un frame de cámara a un gemelo digital
colocado encima de la plataforma real**, con las fórmulas que usa el código y los
números concretos (sigma, umbrales, covarianzas). Está pensado para que otra
persona —o un LLM— pueda entenderlo sin abrir los 200 ficheros de `src/`.

Regla que gobierna todo lo que hay debajo: **el modelo da puntos 2D, no pose**.
La pose de la cámara se resuelve con geometría (PnP), y por eso el resultado es
estable, explicable y no depende de que la red haya "visto" ese encuadre en el
entrenamiento.

```
 vídeo  ──►  letterbox  ──►  ONNX  ──►  decode+NMS  ──►  keypoints 2D
                                                            │
                                    ┌───────────────────────┴─────────────┐
                                    ▼                                     ▼
                            solvePnP (6 GDL)                     ángulo del rotor (1 GDL)
                                    │                                     │
                                    └──────────►  cámara three.js  ◄──────┘
                                                        │
                                            gemelo 3D sobre el vídeo
```

---

## 0. El modelo (`public/models/*.onnx`)

Export de YOLO *pose* con **NMS dentro del grafo** (`scripts/export-onnx.py --nms`).
La salida es `(1, 300, 39)` en este proyecto: 300 detecciones como máximo y, por
fila, `4 caja + 1 confianza + 1 clase + 11 keypoints × 3`.

`39 = 4 + 1 + 1 + 33`, y los keypoints van como `(x, y, score)` en píxeles de la
**entrada del modelo** (640, 480, 416… según el export).

Dos clases, con la misma `kpt_shape: [11, 3]` para las dos:

| clase | qué anota | slots con sentido |
|---|---|---|
| `WindTurbine` (0) | la plataforma completa | los **11** |
| `Rotor` (1) | el rotor, para el ángulo de las palas | `0,1,3,4,6,7` (6); el resto va a `v=0` |

Ese detalle importa: un modelo con `kpt_shape` global gasta los mismos 11 canales
en las dos clases, y el rotor solo usa 6. Las posiciones de los 5 restantes no
significan nada, y el pipeline las descarta por confianza (`score < 0.5`).

---

## 1. Frame → tensor

`src/lib/camera/syncedFrame.ts` captura el `<video>` en un canvas y
`src/lib/inference/tensor.ts` lo convierte:

1. **Letterbox**: se escala manteniendo proporción y se rellena con gris
   `114` hasta el cuadrado de entrada (`computeLetterbox`).
2. Se reordena a `NCHW` o `NHWC` según lo que declare el modelo.
3. Se normaliza a `[0,1]` dividiendo por 255.

El **letterbox es reversible**, y de eso depende todo lo demás: las coordenadas
que salen del tensor viven en el cuadrado, no en el vídeo. `engine.ts` guarda
`scale`, `padX`, `padY` y las usa para devolver las detecciones a píxeles de la
**fuente** (`Detection.bbox` y `Keypoint.x/y` están siempre en píxeles del vídeo,
nunca del tensor).

---

## 2. Decodificar la salida

`src/lib/inference/decode.ts` deduce el layout del tensor por su forma, sin
configuración:

| forma | qué es |
|---|---|
| `(1, 4+3k, N)` | export crudo de pose (sin NMS) |
| `(1, N, 6+3k)` | end-to-end: NMS dentro, fila `[x1,y1,x2,y2,conf,cls,kpts…]` |
| `(1, 4+nc, N)` | export crudo de detección |

Cuando el modelo ya trae NMS se salta el suyo; si no, aplica NMS por clase
(`IoU 0.5`). Salen `Detection[]` con las cajas y los keypoints en píxeles del
vídeo, que es el contrato de entrada del resto del pipeline.

---

## 3. De keypoints a correspondencias 2D↔3D

`src/lib/pose/keypoints3d.ts` tiene la tabla de los 11 puntos en **metros**, en
el orden exacto en que los emite el modelo:

| # | nombre | x | y | z (Blender) |
|---|---|---|---|---|
| 0 | `pontoon_right_3` | −0.216 | −0.003 | 0.341 |
| 1 | `pontoon_left_3` | 0.218 | −0.003 | 0.341 |
| 2 | `pontoon_left_1` | 0.249 | 0.051 | 0.341 |
| 3 | `pontoon_front_1` | −0.032 | 0.428 | 0.341 |
| 4 | `pontoon_center_front` | 0.001 | 0.481 | 0.350 |
| 5 | `pontoon_front_2` | 0.036 | 0.429 | 0.340 |
| 6 | `Hub` | 0.001 | 0.306 | 1.145 |
| 7 | `pontoon_center_right` | −0.278 | −0.003 | 0.350 |
| 8 | `pontoon_center_left` | 0.280 | −0.003 | 0.350 |
| 9 | `pontoon_front_3` | −0.247 | 0.051 | 0.341 |
| 10 | `pilar_center` | 0.001 | 0.194 | 0.788 |

Dos trampas que cuestan horas si se ignoran:

- **El orden es el de los slots del modelo**, no un orden "natural". Si se
  permuta, el solver *sí* encuentra pose (los pontones forman un triángulo casi
  simétrico) pero devuelve el objeto girado: el gemelo nunca encaja y parece un
  problema de ejes. El orden se validó contra una foto real con
  `npm run find:mapping`: 10/11 inliers a 3,6 px.
- **Dos sistemas de referencia**. Blender (Z arriba, el de `3D_points.json`) y
  glTF/three.js (Y arriba, el de `OC4.glb`). La conversión es
  `(x, y, z) → (x, z, −y)`, y `KEYPOINTS_SCENE` ya está en el frame del `.glb`,
  que es donde trabaja el solver. `npm run verify:frame` comprueba que cada punto
  cae a menos de 0,5 cm de un vértice de la malla.

`poseTracker.correspondences()` descarta los keypoints con `score < 0.5` en vez
de inventarles una posición: el solver sabe trabajar con puntos que faltan, no
con puntos que están mal.

---

## 4. Intrínsecos: de una FOV a `K`

No hay calibración de cámara. `intrinsicsFromFov()` construye una matriz pinhole
a partir del campo de visión, que se mide **sobre el lado mayor de la imagen**:

$$
f = \frac{\max(w, h)/2}{\tan(\theta/2)}, \qquad
K = \begin{pmatrix} f & 0 & w/2 \\ 0 & f & h/2 \\ 0 & 0 & 1 \end{pmatrix},
\quad \theta = 68^\circ
$$

Es el lado largo porque el eje largo del sensor es el mismo objeto físico en
vertical y en horizontal: medir la FOV sobre `width` en un frame vertical (576×1024)
implicaría ~100° verticales, que ningún móvil tiene, y **una focal mal estimada
sesga la distancia y la inclinación** que luego se recuperan.

---

## 5. La pose: PnP en dos fases

`solvePnP.ts` resuelve, por frame, la transformación rígida que lleva el modelo
al frame de la cámara:

$$
X_{cam} = R\,X + t, \qquad R = \mathrm{Rodrigues}(r_{vec})
$$

con la convención de OpenCV (`x` derecha, `y` abajo, `z` hacia delante) y
proyección pinhole:

$$
u = f_x \frac{X_c}{Z_c} + c_x, \qquad v = f_y \frac{Y_c}{Z_c} + c_y
$$

### 5.1 Semilla: homografía del plano del pontón

9 de los 11 puntos están en el plano de flotación (`y = 0.345` m en el frame de
la escena), así que con los coplanares se resuelve primero una homografía
`H` por mínimos cuadrados (`AᵀA h = Aᵀb`, con `h33 = 1`) y se descompone
`H ≈ K [c_X, c_Z, t']`.

Hay dos detalles que no son obvios:

- **Mano de la base.** `(X, Z)` no es una pareja dextrógira en un mundo con Y
  arriba (`X × Z = −Y`). Ensamblar `R = (c_X, c_Z, c_X × c_Z)` da una pose con
  dos ejes intercambiados que reproyecta fatal. Lo correcto es poner la imagen de
  **Y** en la segunda columna, `c_Y = c_Z × c_X`, y reortogonalizar después.
- **Ambigüedad de dos pliegues.** El signo de la escala es ambiguo: se generan
  los **dos** candidatos (`±`) y se queda el de menor error de reproyección.

La semilla barata alternativa es la pose del frame anterior: si está disponible y
es plausible, también compite como candidata.

### 5.2 Refinamiento: Levenberg–Marquardt con Huber

Con los 11 puntos (incluidos el `Hub` y el `pilar`, que **no** están en el plano
y por eso fijan la escala y la inclinación) se minimiza el error de reproyección:

$$
r_i = \left( u_i - \hat{u}_i,\; v_i - \hat{v}_i \right), \qquad
\rho(r) = \begin{cases} \tfrac12 r^2 & |r| \le \delta \\ \delta\left(|r| - \tfrac12\delta\right) & |r| > \delta \end{cases}
$$

Se actualiza la rotación **por la derecha** (`R ← R·Exp(δ)`), así que

$$
\frac{\partial X_{cam}}{\partial \delta} = -R\,[X]_\times
$$

y con `∂(u,v)/∂X_cam` sale un Jacobiano 2×6. Las ecuaciones normales se resuelven
amortiguadas:

$$
(H + \lambda\,\mathrm{diag}(H))\,\delta = -g
$$

con `λ` inicial 1e-3, que baja a la mitad al aceptar un paso y se multiplica por 4
al rechazarlo. `δ = 3` px de umbral de Huber, 20 iteraciones como máximo.

La pasada robusta que sustituye al `solvePnPRansac` del pipeline Python: al
terminar, **se descartan los puntos con error > 12 px y se vuelve a ajustar solo
con los inliers**, hasta 3 veces. Huber solo baja el peso; con un punto
equivocado a 60 px el sesgo sigue ahí.

Resultado: `{ rvec, tvec, rmsError, inliers, pairs }`.

### 5.3 ¿Es una pose creíble?

`solvePnP` devuelve `null` si hay menos de 4 correspondencias o si no queda
ninguna pose sana. Un `null` significa **mantener la anterior**, nunca "identidad".
Y una pose que pasa el solver todavía tiene que pasar `plausiblePose()`:

| comprobación | umbral | por qué |
|---|---|---|
| RMS de reproyección | ≤ 25 px | por encima es ruido disfrazado de pose |
| distancia al origen | 0,25 – 40 m | la plataforma mide ~1 m |
| finitud | `rvec`/`tvec` finitos | NaN envenena todos los frames siguientes |

### 5.4 Guardia de salto y re-adquisición

`smoothPose()` **no interpola**: si la medida entra dentro de lo físicamente
posible, se aplica tal cual. Interpolar (lo que hacía el 35 % por muestra) es un
retardo de primer orden: el gemelo va por detrás y "patina" al mover el móvil.

Solo se rechaza lo imposible:

- giro entre frames > **35°** (escalado hasta ×3 si el intervalo es largo: a 5 fps
  la cámara sí recorre más),
- desplazamiento > **0,6 m** (mismo escalado),
- excepción: si la medida ajusta **la mitad de bien** que la que está en pantalla,
  gana la medida. La de pantalla es demostrablemente la mala.

Y a los **900 ms** sin pose aceptada se olvida la historia: la anterior deja de
usarse como semilla y el umbral de outliers sube a 20 px. Sin eso el filtro se
puede bloquear para siempre, porque una semilla mala hace que toda solución
nueva parezca un salto.

---

## 6. Estabilizar: Kalman sobre los keypoints

`keypointKalman.ts`. El modelo tarda ~0,5–2 s por frame en un móvil, pero la
cámara va a 30 fps. Sin filtro el gemelo se queda quieto un segundo y salta.

Estado por keypoint y por eje: **posición y velocidad** en píxeles de la fuente.

$$
x = \begin{pmatrix} p \\ v \end{pmatrix}, \quad
F(dt) = \begin{pmatrix} 1 & dt \\ 0 & 1 \end{pmatrix}, \quad
Q(dt) = q \begin{pmatrix} dt^4/4 & dt^3/2 \\ dt^3/2 & dt^2 \end{pmatrix}
$$

con `q = 4000`, ruido de medida `R = 9 px²` (el jitter real es de 1–2 px) y
covarianza inicial `P₀ = diag(100, 1e4)` (se sabe la posición, no la velocidad).
La predicción es una recta (`p + v·dt`) y la covarianza crece mientras no hay
medida, así que **la siguiente medida pesa más cuanto más tiempo ha pasado**.

`useInferenceLoop.ts` pide la predicción cada `33 ms` y como máximo extrapola
`1200 ms`; pasado ese punto prefiere no dibujar antes que inventar. En cada
predicción se **vuelve a resolver el PnP** con los keypoints filtrados, así que la
pose también va a ritmo de frame aunque la red no haya corrido.

---

## 7. El rotor: un grado de libertad, no seis

`rotorAngle.ts`. La pose base deja fija toda la plataforma **menos un número**:
cuánto ha girado el rotor. El `Hub` dice dónde está el centro, no hacia dónde
apuntan las palas.

Un segundo PnP de 6 GDL sería la herramienta equivocada: el rotor tiene
exactamente 1 GDL (giro sobre su propio eje, que la pose base ya sitúa en el
espacio) y ajustar 6 incógnitas a 6 puntos casi colineales haría que **se
inclinara en vez de girar**. En vez de eso se hace un barrido del ángulo y se
queda el que mejor explica los puntos de pala detectados:

$$
\theta^\* = \arg\min_\theta \sum_i \mathrm{dist}\Big(p_i,\; \pi\big(\text{seg}_k(\theta)\big)\Big)^2
$$

- geometría fija del `OC4.glb`: buje en `(0.0009, 1.145, −0.2576)`, palas a
  **330°, 90°, 210°**, raíz `r = 0.21 m`, punta `r = 0.63 m`;
- barrido grueso de **3°** y luego fino de **0,25°**;
- puntos a más de **90 px** de su segmento se descartan; RMS > **45 px** → no se
  cree el ajuste (palas ocultas, detección basura);
- el ángulo aplicado se mezcla al **40 %** por frame (`ROTOR_SMOOTHING`).

El orden de las palas importa: son iguales en forma pero no en color (roja 330°,
azul 90°, amarilla 210°), y eso resuelve la ambigüedad de 120°.

---

## 8. Pose OpenCV → cámara three.js

`cameraRig.ts`. Aquí es donde un error de signo produce un gemelo "casi bien"
pero sutilmente girado:

- `solvePnP` trabaja en el frame OpenCV: `x` derecha, `y` **abajo**, `z` **adelante**.
- three.js usa `x` derecha, `y` **arriba**, `z` **atrás**. Los dos frames difieren
  en `D = diag(1, −1, −1)`.
- Para una cámara con rotación `Q` (columnas = ejes locales en coordenadas del
  mundo) y posición `C`: `x_view = Qᵀ(X − C)`.

Igualando términos, `Qᵀ = D·R` y `−Qᵀ·C = D·t`, o sea:

$$
Q = R^{\top} D, \qquad C = -R^{\top} t
$$

El **FOV vertical** no se toma de la cámara, se deriva de la focal *después* del
recorte `object-fit: cover`: `fy_display = f_y · cover.scale`, y de ahí
`camera.fov = 2·atan(h/2 / fy_display)`. Si no se hace así, el gemelo aparece
desplazado exactamente lo que el navegador haya recortado. Y hay que llamar a
`updateProjectionMatrix()`: mutar `fov`/`aspect` no basta, la matriz está cacheada.

---

## 9. Dibujar

- **Capa 2D** (`overlay/DetectionLayer.tsx`): cajas y keypoints en píxeles,
  proyectados con el mismo letterbox inverso que la detección.
- **Capa 3D** (`overlay/TwinScene.tsx` → `TwinLayer.tsx`): el `OC4.glb` se dibuja
  en el origen del mundo y la cámara se coloca en la pose resuelta, así que la
  plataforma virtual cae sobre la real. La mezcla real↔digital es la **opacidad**
  del canvas 3D, movida por el slider (`opacity: blend · twinOpacity`).
- Autocomprobación: `projectToSource()` proyecta los 11 puntos 3D con la pose
  resultante; si el solver acierta, caen sobre los keypoints detectados. Es lo que
  permite afirmar "la pose ajusta a 3,6 px" sin mirar la pantalla.

### Cuándo el gemelo no debe verse

`shouldShowTwin()`: en modo pose el gemelo es la réplica *de algo concreto*, y
dejarlo cuando ese algo no está en pantalla es mentir. Se oculta si no hay
detección durante **250 ms** (los fallos de YOLO son de un frame) o si la última
pose tiene más de **2500 ms**.

---

## 10. Cómo verificarlo sin móvil

```bash
npm run verify:pose        # PnP con proyecciones sintéticas (geometría pura)
npm run verify:frame       # los 11 puntos caen sobre vértices del .glb (< 0,5 cm)
npm run verify:inference   # tensor ↔ decode, con un .onnx real
npm run find:mapping       # revalida el orden de los slots contra una foto
npm run inspect:model      # formas de entrada/salida del .onnx
```

Si tocas cualquier constante de este documento, el sitio donde se nota es
`npm run verify:pose` primero y el móvil después.

---

## Glosario

| símbolo | significado |
|---|---|
| `K` | intrínsecos pinhole (`f`, `c`) |
| `R`, `t` | rotación (Rodrigues) y traslación, mundo → cámara |
| `H` | homografía del plano del pontón |
| `ρ` | pérdida de Huber |
| `H`, `g` | Hessiano aproximado y gradiente del coste (LM) |
| `P`, `Q`, `F` | covarianza, ruido de proceso y transición del Kalman |
| `D` | `diag(1,−1,−1)`, cambio de base OpenCV ↔ three.js |

## Mapa de ficheros

| paso | fichero |
|---|---|
| captura y letterbox | `src/lib/camera/*.ts`, `src/lib/inference/tensor.ts` |
| ONNX y sesión | `src/lib/inference/engine.ts`, `ortAssets.ts` |
| decode + NMS | `src/lib/inference/decode.ts` |
| orquestación | `src/lib/inference/useInferenceLoop.ts` |
| tabla 3D de keypoints | `src/lib/pose/keypoints3d.ts` |
| PnP + LM + Huber | `src/lib/pose/solvePnP.ts`, `linalg.ts` |
| filtros y guardias | `src/lib/pose/poseTracker.ts`, `keypointKalman.ts` |
| ángulo del rotor | `src/lib/pose/rotorAngle.ts` |
| pose → cámara | `src/lib/pose/cameraRig.ts` |
| render | `src/components/overlay/*`, `src/components/live/*` |
