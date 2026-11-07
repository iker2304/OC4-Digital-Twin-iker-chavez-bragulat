/**
 * `/rotor-fem/` — calibración de la malla FEM de la pala sobre el gemelo.
 *
 * Para qué sirve: los casos de carga de `mobile/fem/*.gid` son una **sola pala**
 * mallada en su propio sistema de ejes. El gemelo (`OC4.glb`) es otra malla, en
 * metros y con Y arriba. Esta pantalla superpone la pala FEM sobre el modelo y
 * deja mover el anclaje (centro, giro, radio y acimut) hasta que encaja; cuando
 * encaje, esos números son los que hay que hornear en la app.
 *
 * La malla se dibuja **tres veces a 120°**, que es como están las palas reales
 * (`BLADE_AZIMUTHS_DEG` en `lib/pose/rotorAngle.ts`: 330°, 90°, 210°).
 *
 * Los datos los genera `scripts/fem-to-json.py`; aquí solo se pintan.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TWIN_MODEL_URL, withBase } from '../lib/env';
import { buildTree, type TreeNode } from './glbTree';
import { DEFAULT_ANCHOR, type Anchor, type BladeBake, type FemCase, type FemIndex, type FemMesh } from './types';

const FEM_BASE = withBase('/rotor-fem');

/**
 * Los dos exports del mismo gemelo. `OC4.glb` es el que usan las constantes de
 * `lib/pose` y el que se hornea en `oc4-mode-map`, pero la app puede estar
 * sirviendo `OC4-modal.glb` (`TWIN_MODEL_URL`), así que se puede cambiar: el
 * anclaje que se busque aquí tiene que encajar **con el que se renderiza**.
 */
const TWIN_FILES = ['OC4.glb', 'OC4-modal.glb'] as const;

/** Azimuts de las tres palas, en grados a partir del ancla. */
const BLADE_OFFSETS = [0, 120, 240];

/**
 * La malla de la pala va **a lo largo de −Z** en su propio sistema (raíz en
 * z = −0,015, punta en z = −0,63). Para colocarla radial desde el buje se gira
 * −90° sobre Y, que lleva −Z a +X; después el grupo de acimut la gira sobre Z.
 */
const BLADE_ORIENTATION: [number, number, number] = [0, -Math.PI / 2, 0];

/* ------------------------------------------------------------------ datos */

function useJson<T>(url: string | null): { data: T | null; error: string | null } {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!url) {
            setData(null);
            return;
        }
        let cancelled = false;
        setError(null);
        fetch(url)
            .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json() as Promise<T>;
            })
            .then((json) => {
                if (!cancelled) setData(json);
            })
            .catch((cause: unknown) => {
                if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
            });
        return () => {
            cancelled = true;
        };
    }, [url]);

    return { data, error };
}

/* --------------------------------------------------------------- escena 3D */

/** Azul → cian → verde → amarillo → rojo, con el valor normalizado 0..1. */
function colourFor(value: number, target: THREE.Color): THREE.Color {
    const t = Math.min(1, Math.max(0, value));
    return target.setHSL(0.66 * (1 - t), 0.85, 0.5 + 0.08 * t);
}

/**
 * Paleta **divergente** para campos con signo: azul (−1) → gris claro (0) → rojo (+1).
 *
 * En el cero el color se lava a gris en vez de saltar de un extremo al otro, que
 * es lo que hace la paleta secuencial si se le mete un valor negativo.
 */
function colourForSigned(value: number, target: THREE.Color): THREE.Color {
    const t = Math.min(1, Math.max(-1, value));
    const fuerza = Math.abs(t);
    // Azul → **blanco** → rojo, igual que el colorbar. La saturación sube deprisa
    // (exponente < 1) para que los valores pequeños ya se vean con color y no se
    // confundan con el material blanco del gemelo.
    return target.setHSL(
        t >= 0 ? 0 : 0.6,
        Math.min(1, 0.9 * Math.pow(fuerza, 0.55)),
        0.93 - 0.43 * Math.pow(fuerza, 0.7)
    );
}

/** int8 en base64 (los componentes con signo). */
function base64ToInt8(encoded: string): Int8Array {
    const bytes = base64ToBytes(encoded);
    return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}

/**
 * Caché de los campos ya decodificados.
 *
 * `atob` más el bucle de `charCodeAt` son, con diferencia, lo más caro del
 * repintado: 60.000 bytes por pala, caso y componente, y con el rotor girando
 * esto se llama nueve veces por segundo. Decodificar una vez deja el repintado en
 * unos pocos milisegundos.
 */
const FIELD_CACHE = new Map<string, Uint8Array | Int8Array>();

function cachedBytes(key: string, decode: () => Uint8Array | Int8Array): Uint8Array | Int8Array {
    const hit = FIELD_CACHE.get(key);
    if (hit) return hit;
    const value = decode();
    FIELD_CACHE.set(key, value);
    return value;
}

/* ------------------------------------------------------- casos de carga */

/**
 * Radio de punta de pala en metros (el mismo `BLADE_TIP_R` de
 * `lib/pose/rotorAngle.ts`). Todo el escalado de los casos unitarios se refiere
 * a este radio: la carga triangular vale 1 en la punta.
 */
const BLADE_TIP_M = 0.63;
/** El caso unitario equivale a **1 m/s²** en la punta de la pala. */
const REFERENCE_ACCEL = 1;
/** ω que da 1 m/s² centrípeto en la punta: ω = √(a/r) ≈ 1,26 rad/s. */
const OMEGA_REF = Math.sqrt(REFERENCE_ACCEL / BLADE_TIP_M);
/** α que da 1 m/s² tangencial en la punta: α = a/r ≈ 1,59 rad/s². */
const ALPHA_REF = REFERENCE_ACCEL / BLADE_TIP_M;

export type LoadMode = 'unit' | 'centripetal' | 'tangential' | 'gravity';

/** Metros a la unidad que toque: las escalas van de nanómetros a micrómetros. */
function formatMetres(value: number): string {
    const magnitud = Math.abs(value);
    if (magnitud < 1e-6) return `${(value * 1e9).toFixed(1)} nm`;
    if (magnitud < 1e-3) return `${(value * 1e6).toFixed(2)} µm`;
    return `${(value * 1e3).toFixed(2)} mm`;
}

/** Peso de cada caso base (nombre del JSON) en el mapa que se pinta. */
export type Weights = Record<string, number>;

/** Ref muda para el giro: se lee en `useFrame`, no dispara renders. */
type SpinRef = { current: number };

/**
 * Gravedad en el sistema **de una pala**, repartida entre los casos `x`, `y`, `z`.
 *
 * Los tres casos son la misma pala cargada con la gravedad alineada con un eje.
 * Dos rotaciones, en este orden:
 *
 * 1. `platformRotation` lleva la vertical del mundo (0,−1,0) al sistema de la
 *    plataforma, que es donde están definidos los casos.
 * 2. `azimuth` (radianes) es el ángulo **de esa pala** en el plano de barrido. La
 *    pala está girada ese ángulo, así que su gravedad es la de la plataforma
 *    girada −azimuth sobre Z. Aquí es donde entra el desfase de 120°: las tres
 *    palas no ven la misma gravedad.
 *
 * El resultado son los cosenos directores, o sea el peso de cada caso.
 */
function bladeGravityWeights(
    angles: [number, number, number],
    spin: number,
    registration: number[][] | null
): Weights {
    // 1) Del mundo al sistema de la plataforma, que es donde se aplican los giros.
    const euler = new THREE.Euler(
        (angles[0] * Math.PI) / 180,
        (angles[1] * Math.PI) / 180,
        (angles[2] * Math.PI) / 180,
        'XYZ'
    );
    const inverse = new THREE.Matrix4().makeRotationFromEuler(euler).invert();
    const gravedad = new THREE.Vector3(0, -1, 0).applyMatrix4(inverse);

    // 2) El rotor gira sobre Z: la gravedad vista por la pala da vueltas con él.
    gravedad.applyAxisAngle(new THREE.Vector3(0, 0, 1), -spin);

    // 3) **Al sistema de los casos**, que es el del modelo FEM. Aquí estaba el
    //    error: los casos `blade-x/y/z` son la gravedad según los ejes del FEM,
    //    donde la pala va a lo largo de **−Z** (no del eje radial del gemelo). Sin
    //    esta traspuesta, una pala vertical aparecía cargada de flexión cuando en
    //    realidad solo está comprimida axialmente: el reparto salía por los ejes
    //    del modelo, que no son los de la pala.
    if (registration) {
        const matrix = new THREE.Matrix3().set(
            registration[0][0], registration[0][1], registration[0][2],
            registration[1][0], registration[1][1], registration[1][2],
            registration[2][0], registration[2][1], registration[2][2]
        );
        gravedad.applyMatrix3(matrix.transpose());
    }

    // Con signo: si la gravedad va al revés del eje del caso, el desplazamiento se
    // invierte, y eso es lo que se pinta cuando el campo tiene signo.
    return {
        'blade-x': gravedad.x,
        'blade-y': gravedad.y,
        'blade-z': gravedad.z,
    };
}

/** Sin casos activos no hay nada que pintar: objeto compartido para no crear basura. */
const NO_WEIGHTS: Weights = {};

/** base64 → bytes. `atob` devuelve binario, no hay UTF-8 de por medio. */
function base64ToBytes(encoded: string): Uint8Array {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/**
 * Pinta `|u|` interpolado **sobre las mallas de pala del propio `.glb`**.
 *
 * Es lo contrario de superponer la malla del solver: aquí no se aсtúa la
 * geometría para nada, solo se le añade un atributo de color. El resultado
 * coincide con el gemelo al 100 % porque *es* el gemelo.
 *
 * Devuelve cuántas primitivas se pintaron (0 si el `.glb` no es el que se horneó:
 * el recuento de vértices deja de cuadrar y se descarta en vez de pintar basura).
 */
/**
 * Prepara una malla de pala para pintarla **suave**.
 *
 * El `.glb` trae las palas casi sin indexar (20.216 vértices para 10.632
 * triángulos), así que cada triángulo tiene sus propios vértices con su normal y
 * su color. El resultado se ve a facetas: triángulos de colores y sombreado duro.
 *
 * Aquí se agrupan los vértices que están **en la misma posición** y se usa ese
 * grupo para dos cosas: promediar el color (mapa continuo) y recalcular las
 * normales como media de las caras que comparten el punto (sombreado liso). Se
 * hace una sola vez por malla y se guarda en `userData`.
 */
function prepareBladeMesh(mesh: THREE.Mesh): void {
    if (mesh.userData.__femPrepared) return;
    const geometry = mesh.geometry;
    const position = geometry.attributes.position as THREE.BufferAttribute | undefined;
    const normal = geometry.attributes.normal as THREE.BufferAttribute | undefined;
    if (!position) return;

    const count = position.count;
    const keyOf = (index: number) =>
        `${Math.round(position.getX(index) * 1e5)}|${Math.round(position.getY(index) * 1e5)}|${Math.round(position.getZ(index) * 1e5)}`;

    const porPosicion = new Map<string, number[]>();
    const claves: string[] = new Array(count);
    for (let index = 0; index < count; index += 1) {
        const key = keyOf(index);
        claves[index] = key;
        const lista = porPosicion.get(key);
        if (lista) lista.push(index);
        else porPosicion.set(key, [index]);
    }

    if (normal) {
        const suma = new Map<string, THREE.Vector3>();
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        const c = new THREE.Vector3();
        const acumula = (i0: number, i1: number, i2: number) => {
            a.fromBufferAttribute(position, i0);
            b.fromBufferAttribute(position, i1);
            c.fromBufferAttribute(position, i2);
            const cara = new THREE.Vector3()
                .subVectors(b, a)
                .cross(new THREE.Vector3().subVectors(c, a));
            if (cara.lengthSq() === 0) return;
            for (const vertex of [i0, i1, i2]) {
                const key = claves[vertex];
                const previo = suma.get(key);
                if (previo) previo.add(cara);
                else suma.set(key, cara);
            }
        };

        const index = geometry.index;
        if (index) {
            for (let triangle = 0; triangle < index.count; triangle += 3) {
                acumula(index.getX(triangle), index.getX(triangle + 1), index.getX(triangle + 2));
            }
        } else {
            for (let triangle = 0; triangle + 2 < count; triangle += 3) {
                acumula(triangle, triangle + 1, triangle + 2);
            }
        }

        for (let vertex = 0; vertex < count; vertex += 1) {
            const total = suma.get(claves[vertex]);
            if (!total || total.lengthSq() === 0) continue;
            normal.setXYZ(vertex, total.x, total.y, total.z);
        }
        normal.needsUpdate = true;
    }

    mesh.userData.__femGroups = [...porPosicion.values()].filter((grupo) => grupo.length > 1);
    mesh.userData.__femPrepared = true;
}

/**
 * Pinta el campo FEM **sobre las mallas de pala del propio `.glb`**.
 *
 * La superposición de cargas se hace bien: los casos de gravedad (`blade-x/y/z`)
 * se combinan **como vectores**, con sus cosenos directores y con su signo. Sumar
 * módulos, que es lo que se hacía antes, no es lo mismo (sobreestima, y con un
 * peso negativo ni siquiera está definido). Centrífuga y tangencial son casos
 * positivos y simétricos, así que ahí basta el módulo.
 *
 * `field` decide qué se pinta (el 100 % es **siempre el caso de referencia**, no el
 * máximo del modo: centrífuga a 5× pasa del 100 %, y tangencial se sale por abajo):
 * - `magnitude`: |u|, de 0 % hacia arriba.
 * - `signed`: con signo. Con un solo caso lo pone el peso (α > 0 acelera, α < 0
 *   frena); con varios (gravedad) es la proyección sobre el eje de la pala, que es
 *   lo que distingue tracción de compresión.
 */
function paintBlades(
    scene: THREE.Object3D,
    bake: BladeBake,
    weightFor: (bladeName: string) => Weights,
    range: { min: number; max: number } | null,
    field: 'magnitude' | 'signed',
    smooth: boolean
): {
    painted: number;
    reason: string | null;
    peak: number;
    /** Rango real del campo (lo que hay, sin escalar). */
    min: number;
    max: number;
    /** Extremos usados para el color: los forzados o los reales. */
    scaleMin: number;
    scaleMax: number;
} {
    // three.js **sanea** los nombres al cargar el glTF (`MeshBody1 (2)` llega como
    // `MeshBody1_(2)`), así que no se puede buscar por el nombre del fichero: se
    // comparan las dos cadenas sin espacios ni signos.
    const normalize = (name: string) => name.replace(/[^0-9a-z]/gi, '').toLowerCase();
    const byName = new Map<string, THREE.Object3D>();
    scene.traverse((child) => {
        const key = normalize(child.name);
        if (key && !byName.has(key)) byName.set(key, child);
    });

    const valores = new Map<string, Float32Array>();
    let peak = 0;
    let min = Infinity;
    let max = -Infinity;
    let algunActivo = false;

    for (const [bladeName, blade] of Object.entries(bake.blades)) {
        const total = blade.vertexCount;
        const eje = blade.axis ?? [1, 0, 0];
        const salida = new Float32Array(total);
        const escalar = new Float32Array(total);
        const vx = new Float32Array(total);
        const vy = new Float32Array(total);
        const vz = new Float32Array(total);
        let hayVector = false;
        /** Pesos efectivamente aplicados, para saber si el signo es único. */
        const aplicados: number[] = [];

        const pesos = weightFor(bladeName);
        // Un caso conocido con peso 0 (α = 0, por ejemplo) sigue siendo un campo:
        // se pinta en el cero de la escala en vez de dejar las palas sin color.
        if (Object.keys(pesos).some((name) => bake.cases[name])) algunActivo = true;

        for (const [caseName, weight] of Object.entries(pesos)) {
            if (!weight) continue;
            const entry = bake.cases[caseName];
            if (!entry) continue;
            const comps = entry.vectors?.[bladeName];
            if (comps) {
                // --- caso vectorial (gravedad): se suma con su signo
                const peakComponente = entry.vectorPeaks?.[bladeName] ?? 0;
                if (!(peakComponente > 0)) continue;
                const factor = (weight * peakComponente) / 127;
                const cx = cachedBytes(`${caseName}|${bladeName}|x`, () =>
                    base64ToInt8(comps.x)
                ) as Int8Array;
                const cy = cachedBytes(`${caseName}|${bladeName}|y`, () =>
                    base64ToInt8(comps.y)
                ) as Int8Array;
                const cz = cachedBytes(`${caseName}|${bladeName}|z`, () =>
                    base64ToInt8(comps.z)
                ) as Int8Array;
                const limite = Math.min(total, cx.length);
                for (let index = 0; index < limite; index += 1) {
                    vx[index] += cx[index] * factor;
                    vy[index] += cy[index] * factor;
                    vz[index] += cz[index] * factor;
                }
                hayVector = true;
                algunActivo = true;
                aplicados.push(weight);
                continue;
            }
            // --- caso escalar (centrífuga, tangencial): el módulo basta
            if (!(weight > 0)) continue;
            const encoded = entry.values[bladeName];
            if (!encoded) continue;
            const bytes = cachedBytes(`${caseName}|${bladeName}|m`, () =>
                base64ToBytes(encoded)
            ) as Uint8Array;
            const factor = (weight * (entry.peaks[bladeName] ?? 0)) / 255;
            const limite = Math.min(total, bytes.length);
            for (let index = 0; index < limite; index += 1) escalar[index] += bytes[index] * factor;
            aplicados.push(weight);
            algunActivo = true;
        }

        // Con **un solo caso** activo el campo entero va en una dirección: el signo
        // lo pone el peso (α > 0 acelera, α < 0 frena), así que el valor firmado es
        // el módulo con ese signo. Con varios (gravedad) el signo cambia de una zona
        // a otra, y lo que tiene sentido es proyectar sobre el eje de la pala.
        const signoUnico = aplicados.length === 1 ? Math.sign(aplicados[0]) : 0;

        for (let index = 0; index < total; index += 1) {
            const modulo = hayVector ? Math.hypot(vx[index], vy[index], vz[index]) : 0;
            const axial = vx[index] * eje[0] + vy[index] * eje[1] + vz[index] * eje[2];
            salida[index] =
                field === 'signed'
                    ? signoUnico
                        ? signoUnico * (modulo + escalar[index])
                        : axial + escalar[index]
                    : modulo + escalar[index];
            const absoluto = Math.abs(salida[index]);
            if (absoluto > peak) peak = absoluto;
            if (salida[index] < min) min = salida[index];
            if (salida[index] > max) max = salida[index];
        }
        valores.set(bladeName, salida);
    }

    if (!algunActivo) {
        return {
            painted: 0,
            reason: 'ningún caso activo',
            peak: 0,
            min: 0,
            max: 0,
            scaleMin: 0,
            scaleMax: 0,
        };
    }
    // Extremos del color: los que fije el usuario o, por defecto, **el rango real
    // del campo que se acaba de calcular**. Así cada análisis (x, y, z, centrífuga,
    // tangencial) se ve con su propia escala y no con un múltiplo del caso unitario
    // que dejaba medio mapa pegado al gris.
    const scaleMin = range?.min ?? Math.min(min, 0);
    const scaleMax = range?.max ?? max;
    const abajo = scaleMin < 0 ? Math.abs(scaleMin) : 0;
    /** Divergente: −1 en `scaleMin`, 0 en el cero del campo, +1 en `scaleMax`. */
    const normSigned = (value: number) =>
        value >= 0 ? (scaleMax > 0 ? value / scaleMax : 0) : abajo > 0 ? value / abajo : 0;
    const span = scaleMax - scaleMin;
    /** Secuencial: 0 en `scaleMin`, 1 en `scaleMax`. */
    const normLinear = (value: number) => (span > 0 ? (value - scaleMin) / span : 0);

    let painted = 0;
    for (const [bladeName, blade] of Object.entries(bake.blades)) {
        const total = valores.get(bladeName);
        if (!total) continue;
        let offset = 0;

        for (const primitive of blade.primitives) {
            const slice = total.subarray(offset, offset + primitive.count);
            offset += primitive.count;

            const object = byName.get(normalize(primitive.name));
            if (!object) {
                return {
                    painted,
                    reason: `no encuentro el nodo «${primitive.name}»`,
                    peak,
                    min,
                    max,
                    scaleMin,
                    scaleMax,
                };
            }

            const meshes: THREE.Mesh[] = [];
            object.traverse((child) => {
                if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
            });
            const mesh = meshes[primitive.primitive];
            if (!mesh || Array.isArray(mesh.material)) {
                return {
                    painted,
                    reason: `«${primitive.name}» no es una malla simple`,
                    peak,
                    min,
                    max,
                    scaleMin,
                    scaleMax,
                };
            }
            const runtime = mesh.geometry.attributes.position.count;
            if (runtime !== primitive.count) {
                return {
                    painted,
                    reason: `«${primitive.name}»: ${runtime} vértices en el .glb, ${primitive.count} en el JSON`,
                    peak,
                    min,
                    max,
                    scaleMin,
                    scaleMax,
                };
            }

            // El atributo se **reutiliza** entre repintados: cuando el rotor gira en
            // gravedad esto se llama 10 veces por segundo y crear 180.000 flotantes
            // nuevos cada vez se nota.
            let colours = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
            if (!colours || colours.count !== primitive.count) {
                colours = new THREE.BufferAttribute(new Float32Array(primitive.count * 3), 3);
                mesh.geometry.setAttribute('color', colours);
            }
            prepareBladeMesh(mesh);

            // Color **promediado** entre los vértices que comparten posición: sin
            // esto cada triángulo tiene sus propios vértices y el mapa sale a
            // facetas aunque el campo sea continuo. El buffer se reutiliza entre
            // repintados: esto corre a 9 Hz mientras el rotor gira y reservar
            // 20.000 flotantes por vuelta de pala se nota en el recolector.
            let suave = slice;
            const grupos = smooth ? (mesh.userData.__femGroups as number[][] | undefined) : undefined;
            if (grupos && grupos.length > 0) {
                let buffer = mesh.userData.__femSmooth as Float32Array | undefined;
                if (!buffer || buffer.length !== primitive.count) {
                    buffer = new Float32Array(primitive.count);
                    mesh.userData.__femSmooth = buffer;
                }
                buffer.set(slice);
                for (const grupo of grupos) {
                    let suma = 0;
                    for (const vertex of grupo) suma += slice[vertex];
                    const media = suma / grupo.length;
                    for (const vertex of grupo) buffer[vertex] = media;
                }
                suave = buffer;
            }

            const array = colours.array as Float32Array;
            const colour = new THREE.Color();
            for (let index = 0; index < primitive.count; index += 1) {
                const normalized =
                    field === 'signed' ? normSigned(suave[index]) : normLinear(suave[index]);
                if (field === 'signed') colourForSigned(normalized, colour);
                else colourFor(normalized, colour);
                array[index * 3] = colour.r;
                array[index * 3 + 1] = colour.g;
                array[index * 3 + 2] = colour.b;
            }
            colours.needsUpdate = true;

            if (!mesh.userData.__femMaterial) {
                const previous = mesh.material as THREE.Material;
                mesh.userData.__femMaterial = previous;
                // Material **nuevo**, no un clon: el original trae su albedo y su
                // textura, y con `vertexColors` encima el resultado sale oscurecido
                // (el color de vértice multiplica al del material).
                mesh.material = new THREE.MeshStandardMaterial({
                    vertexColors: true,
                    roughness: 0.62,
                    metalness: 0.08,
                    side: previous.side,
                    transparent: previous.transparent,
                    opacity: previous.opacity,
                });
            }
            painted += 1;
        }
    }
    return { painted, reason: null, peak, min, max, scaleMin, scaleMax };
}

/** Quita el color y devuelve los materiales originales. */
function unpaintBlades(scene: THREE.Object3D): void {
    scene.traverse((child) => {
        const original = child.userData.__femMaterial as THREE.Material | undefined;
        if (!original) return;
        const mesh = child as THREE.Mesh;
        if (mesh.material !== original && !Array.isArray(mesh.material)) mesh.material.dispose();
        mesh.material = original;
        mesh.geometry.deleteAttribute('color');
        delete child.userData.__femMaterial;
    });
}

/**
 * Opacidad de todo el gemelo, para poder ver las palas por dentro.
 *
 * `depthWrite` se apaga al hacerlo translúcido: si no, la cara de delante tapa
 * la de detrás y no se ve nada de lo que hay dentro, que es justo lo que se
 * busca con el deslizador.
 */
function applyTwinOpacity(scene: THREE.Object3D, opacity: number): void {
    const translucid = opacity < 1;
    scene.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
            if (!material) continue;
            material.transparent = translucid;
            material.opacity = opacity;
            material.depthWrite = !translucid;
            material.needsUpdate = true;
        }
    });
}

function BladeGeometry({
    mesh,
    magnitudes,
    wireframe,
    opacity,
    colourScale,
}: {
    mesh: FemMesh;
    magnitudes: number[];
    wireframe: boolean;
    opacity: number;
    colourScale: number;
}) {
    const geometry = useMemo(() => {
        const result = new THREE.BufferGeometry();
        result.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
        result.setIndex(mesh.indices);

        const peak = Math.max(1e-30, colourScale);
        const colours = new Float32Array(magnitudes.length * 3);
        const colour = new THREE.Color();
        for (let index = 0; index < magnitudes.length; index += 1) {
            colourFor(magnitudes[index] / peak, colour);
            colours[index * 3] = colour.r;
            colours[index * 3 + 1] = colour.g;
            colours[index * 3 + 2] = colour.b;
        }
        result.setAttribute('color', new THREE.BufferAttribute(colours, 3));
        result.computeVertexNormals();
        result.computeBoundingSphere();
        return result;
    }, [mesh, magnitudes, colourScale]);

    // La geometría son 22.448 triángulos con atributos propios: no la recoge el
    // recolector de basura de three.js sola.
    useEffect(() => () => geometry.dispose(), [geometry]);

    return (
        <mesh geometry={geometry}>
            <meshStandardMaterial
                vertexColors
                side={THREE.DoubleSide}
                wireframe={wireframe}
                transparent={opacity < 1}
                opacity={opacity}
                roughness={0.55}
                metalness={0.05}
            />
        </mesh>
    );
}

function Blades({
    mesh,
    magnitudes,
    anchor,
    wireframe,
    opacity,
    colourScale,
    visible,
    spin,
}: {
    mesh: FemMesh;
    magnitudes: number[];
    anchor: Anchor;
    wireframe: boolean;
    opacity: number;
    colourScale: number;
    visible: boolean;
    /** Ángulo girado del rotor en radianes (lo lleva `Rotor`). */
    spin: SpinRef;
}) {
    const rotation = anchor.rotation.map((degrees) => (degrees * Math.PI) / 180) as [
        number,
        number,
        number,
    ];

    const girando = useRef<THREE.Group>(null);
    // El giro se aplica por frame y no por estado: 60 renders por segundo solo
    // para mover un grupo no aportan nada y arrastran a todo el árbol de React.
    useFrame(() => {
        if (girando.current) girando.current.rotation.z = spin.current;
    });

    if (!visible) return null;

    return (
        <group position={anchor.position} rotation={rotation}>
            <group ref={girando}>
                {BLADE_OFFSETS.map((offset) => (
                    <group
                        key={offset}
                        rotation={[0, 0, ((anchor.azimuth + offset) * Math.PI) / 180]}
                    >
                        <group position={[anchor.radial, 0, 0]} rotation={BLADE_ORIENTATION}>
                            <BladeGeometry
                                mesh={mesh}
                                magnitudes={magnitudes}
                                wireframe={wireframe}
                                opacity={opacity}
                                colourScale={colourScale}
                            />
                        </group>
                    </group>
                ))}
            </group>
            {/* Marcador del ancla: sin él no hay forma de saber dónde está el origen. */}
            <mesh>
                <sphereGeometry args={[0.012, 16, 16]} />
                <meshBasicMaterial color="#f472b6" />
            </mesh>
            <axesHelper args={[0.25]} />
        </group>
    );
}

function Twin({ scene, visible }: { scene: THREE.Object3D | null; visible: boolean }) {
    if (!scene || !visible) return null;
    return <primitive object={scene} />;
}

/**
 * Gira el rotor **del propio .glb** y acumula el ángulo que leen las aspas FEM.
 *
 * El nodo que hace de rotor se llama `rotate` en `OC4.glb` y `rotation` en
 * `OC4-modal.glb`; en los dos su eje de giro es **Z** (las tres palas están
 * repartidas en el plano XY, igual que en la malla FEM). Se rota en el espacio
 * local del nodo, así que la orientación de reposo se respeta.
 */
function Rotor({ node, omega, spin }: { node: THREE.Object3D | null; omega: SpinRef; spin: SpinRef }) {
    useFrame((_, delta) => {
        const speed = omega.current;
        // Si la pestaña estuvo en segundo plano, `delta` llega enorme: el rotor
        // daría un salto de varias vueltas.
        if (speed) spin.current += speed * Math.min(delta, 0.1);
        if (!node) return;
        const base = node.userData.__spinBase as number | undefined;
        const origin = base ?? node.rotation.z;
        if (base === undefined) node.userData.__spinBase = origin;
        node.rotation.z = origin + spin.current;
    });
    return null;
}

/** Flecha de la vertical del mundo: sin ella no se ve que lo que se inclina es la plataforma. */
function GravityVector() {
    return (
        <group position={[0, 1.5, 0]}>
            <mesh position={[0, -0.25, 0]}>
                <cylinderGeometry args={[0.005, 0.005, 0.5, 8]} />
                <meshBasicMaterial color="#22d3ee" />
            </mesh>
            <mesh position={[0, -0.53, 0]} rotation={[Math.PI, 0, 0]}>
                <coneGeometry args={[0.018, 0.06, 12]} />
                <meshBasicMaterial color="#22d3ee" />
            </mesh>
        </group>
    );
}

/* ---------------------------------------------------------------- interfaz */

function NumberField({
    label,
    value,
    step = 0.001,
    onChange,
    suffix,
    format = (input) => Number(input.toFixed(5)),
}: {
    label: string;
    value: number;
    step?: number;
    onChange: (value: number) => void;
    suffix?: string;
    format?: (value: number) => number | string;
}) {
    return (
        <label className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
            <span className="w-16 shrink-0 font-mono">{label}</span>
            <input
                type="number"
                step={step}
                value={Number.isFinite(value) ? format(value) : 0}
                onChange={(event) => onChange(Number(event.target.value))}
                className="w-full rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-right font-mono text-[11px] text-slate-200 outline-none focus:border-sky-400/60"
            />
            {suffix ? <span className="w-6 text-[10px] text-slate-600">{suffix}</span> : null}
        </label>
    );
}

function TreeRow({
    node,
    depth,
    expanded,
    toggle,
    onAnchor,
}: {
    node: TreeNode;
    depth: number;
    expanded: Set<string>;
    toggle: (key: string) => void;
    onAnchor: (centre: [number, number, number]) => void;
}) {
    const key = `${depth}:${node.name}`;
    const open = expanded.has(key);
    const hasChildren = node.children.length > 0;
    const isRotor = node.kind === 'rotor';

    return (
        <li>
            <div
                className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-white/[0.04]"
                style={{ paddingLeft: depth * 10 }}
            >
                <button
                    type="button"
                    onClick={() => hasChildren && toggle(key)}
                    className={`w-3 shrink-0 text-[10px] ${hasChildren ? 'text-slate-400' : 'text-transparent'}`}
                    aria-label={open ? 'Contraer' : 'Expandir'}
                >
                    {open ? '▾' : '▸'}
                </button>
                <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${isRotor ? 'bg-pink-400' : 'bg-sky-400/70'}`}
                />
                <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300" title={node.name}>
                    {node.name}
                </span>
                <span className="shrink-0 text-[10px] text-slate-600">{node.meshCount || ''}</span>
                {node.centre ? (
                    <button
                        type="button"
                        onClick={() => onAnchor(node.centre as [number, number, number])}
                        title="Centrar el ancla en esta pieza"
                        className="shrink-0 rounded px-1 text-[10px] text-slate-500 hover:text-sky-300"
                    >
                        ⊕
                    </button>
                ) : null}
            </div>
            {open && hasChildren ? (
                <ul>
                    {node.children.map((child) => (
                        <TreeRow
                            key={child.name}
                            node={child}
                            depth={depth + 1}
                            expanded={expanded}
                            toggle={toggle}
                            onAnchor={onAnchor}
                        />
                    ))}
                </ul>
            ) : null}
        </li>
    );
}

/* ------------------------------------------------------------------- página */

export function RotorFemPage() {
    const [gltf, setGltf] = useState<THREE.Object3D | null>(null);
    const [glbError, setGlbError] = useState<string | null>(null);
    const [twinFile, setTwinFile] = useState<string>(TWIN_FILES[0]);

    const [caseName, setCaseName] = useState<string | null>(null);
    const [mode, setMode] = useState<LoadMode>('centripetal');
    /** Escala del caso centrípeto: 1 = caso unitario, 5 = el máximo pedido. */
    const [amplification, setAmplification] = useState(1);
    /** ω objetivo del caso tangencial, en rad/s. */
    const [omegaTarget, setOmegaTarget] = useState(OMEGA_REF);
    /** ω real, que persigue a la objetivo con la inercia que se elija. */
    const [omega, setOmega] = useState(OMEGA_REF);
    /** Constante de tiempo de la inercia, en segundos. */
    const [inertia, setInertia] = useState(0.8);
    /** Inclinación de la plataforma (grados, XYZ) para repartir la gravedad. */
    const [gravityAngles, setGravityAngles] = useState<[number, number, number]>([0, 0, 0]);
    /** ω libre del modo gravedad: la carga reparte distinto según dónde esté cada pala. */
    const [gravityOmega, setGravityOmega] = useState(0);
    /**
     * Ángulo del rotor **muestreado** para pintar. El giro de verdad va en
     * `spinRef` y no dispara renders; este se actualiza a 9 Hz porque cada cambio
     * repinta las palas.
     */
    const [spinAngle, setSpinAngle] = useState(0);
    /** Rango **real** del campo (m). Es la escala automática del colorbar. */
    const [autoRange, setAutoRange] = useState<[number, number]>([0, 0]);
    /**
     * Extremos forzados del colorbar (m). `null` = automático, que es lo normal: el
     * máximo y el mínimo del propio análisis. Se fijan moviendo las manijas.
     */
    const [scaleRange, setScaleRange] = useState<{ min: number; max: number } | null>(null);
    /** Promediar el color entre vértices que comparten posición (quita facetas). */
    const [smooth, setSmooth] = useState(true);
    /** Duración del último repintado, en ms. Con el rotor girando se ve el coste. */
    const [paintMs, setPaintMs] = useState(0);
    const [anchor, setAnchor] = useState<Anchor>(DEFAULT_ANCHOR);

    /** Ángulo girado del rotor, en radianes. Lo escriben y leen los `useFrame`. */
    const spinRef = useRef(0);
    /**
     * Aceleración **solo visual** del giro. A 1× el rotor da 12 rpm (una vuelta
     * cada 5 s), que es lo correcto pero se hace eterno mirarlo; el color y los
     * números no cambian con esto.
     */
    const [spinGain, setSpinGain] = useState(1);
    /** ω instantánea que se le da al rotor. En un ref para no re-renderizar. */
    const omegaRef = useRef(0);
    const [wireframe, setWireframe] = useState(false);
    const [opacity, setOpacity] = useState(0.85);
    const [showTwin, setShowTwin] = useState(true);
    const [twinOpacity, setTwinOpacity] = useState(1);
    const [showBlades, setShowBlades] = useState(false);
    const [paint, setPaint] = useState(true);
    const [painted, setPainted] = useState<{ painted: number; reason: string | null }>({
        painted: 0,
        reason: null,
    });
    /** Peso del caso tangencial que sale de la inercia: α = (ω_obj − ω)/τ. */
    const alpha = (omegaTarget - omega) / Math.max(0.05, inertia);

    /**
     * Persecución de ω con inercia de primer orden.
     *
     * A 12 Hz y no por frame: repintar 60.200 vértices × 3 palas a 60 fps no aporta
     * nada visual y calienta la máquina para nada.
     */
    useEffect(() => {
        if (mode !== 'tangential') {
            setOmega(omegaTarget);
            return;
        }
        const timer = window.setInterval(() => {
            setOmega((current) => {
                const step = 0.08 / Math.max(0.05, inertia);
                const next = current + (omegaTarget - current) * Math.min(1, step);
                return Math.abs(next - omegaTarget) < 1e-3 ? omegaTarget : next;
            });
        }, 80);
        return () => window.clearInterval(timer);
    }, [mode, omegaTarget, inertia]);

    /**
     * ω con la que gira el rotor de la escena.
     *
     * En centrífuga es la que corresponde a la carga (ω = √(a/r)); en tangencial,
     * la que persigue el deslizador. En los otros modos el rotor está parado.
     */
    useEffect(() => {
        const fisica =
            mode === 'tangential'
                ? omega
                : mode === 'centripetal'
                    ? OMEGA_REF * Math.sqrt(amplification)
                    : mode === 'gravity'
                        ? gravityOmega
                        : 0;
        omegaRef.current = fisica * spinGain;
    }, [mode, omega, amplification, gravityOmega, spinGain]);

    // Mientras el rotor gira en gravedad, cada pala cambia de orientación y con ella
    // su reparto de carga: hay que volver a pintar. A 9 Hz basta para que se vea el
    // barrido sin repintar 180.000 vértices sesenta veces por segundo.
    useEffect(() => {
        if (mode !== 'gravity') return;
        // Al entrar hay que sincronizar: el rotor puede venir girando de otro modo,
        // y si el reparto arranca en 0 no coincide con la posición que se ve.
        setSpinAngle(spinRef.current);
        const timer = window.setInterval(() => setSpinAngle(spinRef.current), 110);
        return () => window.clearInterval(timer);
    }, [mode]);

    /** Inclinación de la plataforma; solo se aplica en el modo de gravedad. */
    const platformRotation = useMemo(
        () =>
            (mode === 'gravity'
                ? gravityAngles.map((degrees) => (degrees * Math.PI) / 180)
                : [0, 0, 0]) as [number, number, number],
        [mode, gravityAngles]
    );

    /**
     * Qué se pinta: el módulo (0..100 %) o la componente axial con signo
     * (−100 % compresión ↔ +100 % tracción).
     */
    const [field, setField] = useState<'magnitude' | 'signed'>('magnitude');
    /**
     * Peso del caso tangencial: α relativo al caso unitario, **con signo**.
     * Acelerar y frenar deforman la pala en sentidos opuestos; quedarse con el
     * módulo los hacía indistinguibles.
     */
    const tangentialWeight = useMemo(
        () => Math.round((alpha / ALPHA_REF) * 20) / 20,
        [alpha]
    );
    const [colourScale, setColourScale] = useState<number | null>(null);

    // Cada análisis tiene su propia escala: al cambiar de modo o de campo se vuelve
    // a la automática en vez de arrastrar la del anterior.
    useEffect(() => {
        setScaleRange(null);
    }, [mode, field, twinFile]);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const index = useJson<FemIndex>(`${FEM_BASE}/index.json`);
    const mesh = useJson<FemMesh>(`${FEM_BASE}/mesh.json`);
    const current = useJson<FemCase>(caseName ? `${FEM_BASE}/${caseName}.json` : null);
    const bake = useJson<BladeBake>(
        twinFile === 'OC4.glb' ? `${FEM_BASE}/blade-glb.json` : `${FEM_BASE}/blade-glb-modal.json`
    );

    /**
     * Escala del mapa: **el 100 % es el caso de referencia**, no el máximo del modo.
     *
     * Un caso unitario del FEM es la carga de referencia, y un factor de carga puede
     * salirse de él en los dos sentidos: la centrífuga va con ω², así que a 5× son
     * 500 % (y satura en rojo), y la tangencial pasa de negativo a positivo según
     * acelere o frene. Normalizar al máximo del deslizador, que era lo que hacía
     * antes, escondía justo esa información.
     */
    const paintScale = useMemo(() => {
        const data = bake.data;
        if (!data) return 0;
        const casePeak = (name: string) => {
            const entry = data.cases[name];
            if (!entry) return 0;
            return Math.max(0, ...Object.values(entry.peaks));
        };
        if (mode === 'centripetal') return casePeak('blade-centripetal');
        if (mode === 'tangential') return casePeak('blade-tangential');
        if (mode === 'gravity') {
            // Los cosenos reparten |g| = 1, así que aquí no se pasa del mayor caso.
            return Math.max(casePeak('blade-x'), casePeak('blade-y'), casePeak('blade-z'));
        }
        return caseName ? casePeak(caseName) : 0;
    }, [bake.data, mode, caseName]);


    /**
     * Nodo del .glb que hace de rotor: `rotate` en `OC4.glb` y `rotation` en
     * `OC4-modal.glb`. Se busca por nombre normalizado porque three.js sanea los
     * nombres al cargar.
     */
    const rotorNode = useMemo(() => {
        if (!gltf) return null;
        const todos: THREE.Object3D[] = [];
        gltf.traverse((child) => todos.push(child));
        return (
            todos.find((child) => {
                const key = child.name.replace(/[^0-9a-z]/gi, '').toLowerCase();
                return key === 'rotate' || key === 'rotation';
            }) ?? null
        );
    }, [gltf]);

    /**
     * Peso de cada caso base **para una pala concreta**, según el modo elegido.
     *
     * Solo la gravedad depende de la pala: centrífuga y tangencial son simétricas y
     * las tres ven lo mismo.
     */
    const weightFor = useCallback(
        (bladeName: string): Weights => {
            if (mode === 'unit') return caseName ? { [caseName]: 1 } : NO_WEIGHTS;
            if (mode === 'centripetal') return { 'blade-centripetal': amplification };
            if (mode === 'tangential') return { 'blade-tangential': tangentialWeight };
            // Cada pala lleva su propia matriz FEM → .glb, así que el reparto no
            // necesita el acimut: se coge la gravedad del mundo, se pasa al sistema
            // de la plataforma, se gira lo que haya girado el rotor y se proyecta
            // sobre los ejes de los casos. Para una pala vertical sale z ≈ 100 %
            // (solo compresión), que es lo que toca.
            const icp = bake.data?.blades[bladeName]?.icp;
            return bladeGravityWeights(gravityAngles, spinAngle, icp?.rotation ?? null);
        },
        [
            mode,
            caseName,
            amplification,
            tangentialWeight,
            gravityAngles,
            spinAngle,
            bake.data,
        ]
    );

    /** Nombres de las palas del bake, para los textos de la interfaz. */
    const bladeNames = useMemo(() => Object.keys(bake.data?.blades ?? {}), [bake.data]);

    // El `.glb` se carga a mano (no con `useGLTF`) porque el árbol vive **fuera**
    // del `<Canvas>`, y los hooks de R3F solo existen dentro.
    useEffect(() => {
        let cancelled = false;
        setGltf(null);
        setGlbError(null);
        new GLTFLoader().load(
            withBase(`/models/${twinFile}`),
            (loaded) => {
                if (!cancelled) setGltf(loaded.scene);
            },
            undefined,
            (cause) => {
                if (!cancelled) setGlbError(cause instanceof Error ? cause.message : 'error al cargar el .glb');
            }
        );
        return () => {
            cancelled = true;
        };
    }, [twinFile]);

    // Primer caso por defecto, en cuanto se sabe cuáles hay.
    useEffect(() => {
        if (!caseName && index.data?.cases.length) setCaseName(index.data.cases[0].case);
    }, [index.data, caseName]);

    // El árbol se abre con el primer nivel desplegado.
    const tree = useMemo(() => (gltf ? buildTree(gltf) : null), [gltf]);
    const firstRender = useRef(true);
    useEffect(() => {
        if (!tree || !firstRender.current) return;
        firstRender.current = false;
        setExpanded(new Set(tree.children.map((child) => `0:${child.name}`)));
    }, [tree]);

    const toggle = useCallback((key: string) => {
        setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    const setAnchorField = useCallback(<K extends keyof Anchor>(field: K, value: Anchor[K]) => {
        setAnchor((previous) => ({ ...previous, [field]: value }));
    }, []);

    const setPositionAxis = useCallback((axis: 0 | 1 | 2, value: number) => {
        setAnchor((previous) => {
            const position: [number, number, number] = [...previous.position];
            position[axis] = value;
            return { ...previous, position };
        });
    }, []);

    const setRotationAxis = useCallback((axis: 0 | 1 | 2, value: number) => {
        setAnchor((previous) => {
            const rotation: [number, number, number] = [...previous.rotation];
            rotation[axis] = value;
            return { ...previous, rotation };
        });
    }, []);

    const bladeMesh = useMemo(() => {
        const data = current.data;
        if (!data) return null;
        if (data.positions && data.indices) {
            return {
                nodeCount: data.nodeCount,
                triangleCount: (data.indices.length / 3) | 0,
                positions: data.positions,
                indices: data.indices,
                signature: 'inline',
                frame: data.case,
            } satisfies FemMesh;
        }
        return mesh.data;
    }, [current.data, mesh.data]);

    const peak = colourScale ?? paintScale ?? current.data?.stats.max ?? 1;

    /**
     * Escala **estática** del análisis, sacada de los picos de los casos del JSON.
     *
     * Antes salía del campo calculado en cada repintado, y como el reparto cambia
     * con el giro del rotor, el máximo se movía solo y arrastraba las manijas. El
     * rango de un caso es un dato del análisis, no algo que dependa del instante.
     *
     * Para gravedad se toma el mayor de los tres (x, y, z) y, con signo, el mismo
     * valor en negativo.
     */
    const staticRange = useMemo(() => {
        const data = bake.data;
        if (!data) return { min: 0, max: 0 };
        const peakOf = (name: string) => {
            const entry = data.cases[name];
            return entry ? Math.max(0, ...Object.values(entry.peaks)) : 0;
        };
        let max = 0;
        if (mode === 'unit') max = caseName ? peakOf(caseName) : 0;
        else if (mode === 'centripetal') max = peakOf('blade-centripetal');
        else if (mode === 'tangential') max = peakOf('blade-tangential');
        else if (mode === 'gravity') {
            max = Math.max(peakOf('blade-x'), peakOf('blade-y'), peakOf('blade-z'));
        }
        return { min: field === 'signed' ? -max : 0, max };
    }, [bake.data, mode, caseName, field]);

    /**
     * Extremos del colorbar: los forzados o los reales del campo.
     *
     * Para el campo con signo el mínimo se recorta a 0 cuando el campo es todo
     * positivo, de forma que el azul ocupa su mitad solo si hay algo que enseñar.
     */
    const escalaMin = scaleRange?.min ?? staticRange.min;
    const escalaMax = scaleRange?.max ?? staticRange.max;

    /**
     * Gradiente del colorbar **tal y como está mapeando ahora**.
     *
     * Fuera de las manijas el color va saturado (todo azul a la izquierda del
     * azul, todo rojo a la derecha del rojo) y solo entre ellas se interpola. Con
     * un gradiente fijo el colorbar mentía: parecía que la escala seguía entera
     * aunque las manijas estuvieran juntas.
     */
    const gradientCss = useMemo(() => {
        const total = staticRange.max - staticRange.min;
        if (!(total > 0)) return 'linear-gradient(90deg, #334155, #334155)';
        const pos = (value: number) =>
            Math.max(0, Math.min(100, ((value - staticRange.min) / total) * 100));
        const zero = Math.max(0, Math.min(100, ((0 - staticRange.min) / total) * 100));
        const left = pos(escalaMin);
        const right = pos(escalaMax);
        if (field === 'signed') {
            const centro = Math.max(left, Math.min(right, zero));
            return `linear-gradient(90deg,
                hsl(216,85%,52%) 0%,
                hsl(216,85%,52%) ${left}%,
                hsl(0,0%,100%) ${centro}%,
                hsl(0,85%,52%) ${right}%,
                hsl(0,85%,52%) 100%)`.replace(/\s+/g, ' ');
        }
        return `linear-gradient(90deg,
            hsl(238,85%,50%) 0%,
            hsl(238,85%,50%) ${left}%,
            hsl(178,85%,50%) ${left + (right - left) * 0.25}%,
            hsl(119,85%,50%) ${left + (right - left) * 0.5}%,
            hsl(60,85%,50%) ${left + (right - left) * 0.75}%,
            hsl(0,85%,50%) ${right}%,
            hsl(0,85%,50%) 100%)`.replace(/\s+/g, ' ');
    }, [staticRange, escalaMin, escalaMax, field]);

    // Pintar el gemelo: se quita siempre antes, para que cambiar de caso o
    // apagar la casilla no deje colores viejos pegados.
    useEffect(() => {
        if (!gltf) return;
        if (!paint || !bake.data) {
            // Solo se despinta al apagar: si se hiciera en cada pasada se perderían
            // los buffers y el material reutilizados, que es lo que hace barato
            // repintar mientras el rotor gira.
            unpaintBlades(gltf);
            setPainted({ painted: 0, reason: null });
            return;
        }
        const started = performance.now();
        const result = paintBlades(
            gltf,
            bake.data,
            weightFor,
            scaleRange ?? (staticRange.max > 0 ? staticRange : null),
            field,
            smooth
        );
        setPaintMs(performance.now() - started);
        setPainted({ painted: result.painted, reason: result.reason });
        // Solo se guarda si cambia de verdad: esto se ejecuta a 9 Hz mientras gira y
        // un `setState` por tick con el mismo valor dispara renders para nada.
        setAutoRange((previous) =>
            Math.abs(previous[0] - result.min) > 1e-13 || Math.abs(previous[1] - result.max) > 1e-13
                ? [result.min, result.max]
                : previous
        );
    }, [gltf, paint, bake.data, weightFor, scaleRange, staticRange, field, smooth]);

    // Al cambiar de gemelo (o desmontar) hay que devolver los materiales del anterior.
    useEffect(() => {
        if (!gltf) return;
        return () => unpaintBlades(gltf);
    }, [gltf]);

    // Después de pintar, porque pintar cambia los materiales.
    useEffect(() => {
        if (!gltf) return;
        applyTwinOpacity(gltf, twinOpacity);
    }, [gltf, twinOpacity, paint, bake.data, weightFor, scaleRange, field]);

    const residual = bake.data?.blades.base?.icp;

    return (
        <div className="flex min-h-screen flex-col bg-[#070b14] text-slate-200 lg:flex-row">
            {/* ------------------------------------------------------ lateral */}
            <aside className="shrink-0 space-y-4 overflow-y-auto border-b border-white/10 p-4 lg:h-screen lg:w-[380px] lg:border-b-0 lg:border-r">
                <header>
                    <h1 className="text-sm font-black uppercase tracking-[0.18em] text-sky-400/80">
                        Rotor · FEM
                    </h1>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                        Malla de la pala de <code className="text-slate-400">mobile/fem/*.gid</code>{' '}
                        superpuesta al gemelo. Mueve el anclaje hasta que encaje.
                    </p>
                </header>

                {/* Casos de carga */}
                <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                    <h2 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        Casos de carga
                    </h2>
                    {index.error ? (
                        <p className="text-[11px] text-amber-300">
                            No pude leer <code>rotor-fem/index.json</code>. Genera los datos con{' '}
                            <code>python scripts/fem-to-json.py</code>.
                        </p>
                    ) : (
                        <>
                            <div className="flex flex-wrap gap-1">
                                {(
                                    [
                                        ['unit', 'unitarios'],
                                        ['centripetal', 'centrífuga'],
                                        ['tangential', 'tangencial'],
                                        ['gravity', 'gravedad xyz'],
                                    ] as const
                                ).map(([id, label]) => (
                                    <button
                                        key={id}
                                        type="button"
                                        onClick={() => {
                                            // En tangencial se arranca desde parado: la carga
                                            // existe mientras acelera, así que si ω ya vale lo
                                            // que el objetivo no se vería nada.
                                            if (id === 'tangential') setOmega(0);
                                            else setOmega(omegaTarget);
                                            // Cada modo tiene su propia escala buena: se vuelve
                                            // a la automática para no heredar la del anterior.
                                            setColourScale(null);
                                            setMode(id);
                                        }}
                                        className={`rounded border px-2 py-1 text-[10px] transition ${mode === id
                                                ? 'border-sky-400/60 bg-sky-400/10 text-slate-100'
                                                : 'border-white/10 bg-white/[0.03] text-slate-400 hover:bg-white/[0.07]'
                                            }`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>

                            {mode === 'unit' ? (
                                <div className="mt-2 flex flex-wrap gap-1">
                                    {(index.data?.cases ?? []).map((entry) => (
                                        <button
                                            key={entry.case}
                                            type="button"
                                            onClick={() => setCaseName(entry.case)}
                                            className={`rounded border px-2 py-1 text-[10px] transition ${entry.case === caseName
                                                    ? 'border-sky-400/60 bg-sky-400/10 text-slate-100'
                                                    : 'border-white/10 bg-white/[0.03] text-slate-400 hover:bg-white/[0.07]'
                                                }`}
                                        >
                                            {entry.case.replace(/^blade-/, '')}
                                        </button>
                                    ))}
                                </div>
                            ) : null}

                            {mode === 'centripetal' ? (
                                <div className="mt-2 space-y-1">
                                    <label className="flex items-center gap-2 text-[11px] text-slate-400">
                                        <span className="w-20 shrink-0">escala</span>
                                        <input
                                            type="range"
                                            min={0.25}
                                            max={5}
                                            step={0.05}
                                            value={amplification}
                                            onChange={(event) => setAmplification(Number(event.target.value))}
                                            className="flex-1"
                                        />
                                        <span className="w-12 text-right font-mono text-slate-300">
                                            {amplification.toFixed(2)}×
                                        </span>
                                    </label>
                                    <p className="text-[10px] leading-relaxed text-slate-600">
                                        Carga triangular (0 en el buje, 1 en la punta) escalada por
                                        ω²·r. El 100 % del color es el caso unitario: ω ≈{' '}
                                        <span className="font-mono text-slate-400">
                                            {(OMEGA_REF * Math.sqrt(amplification)).toFixed(2)} rad/s
                                        </span>{' '}
                                        ({((OMEGA_REF * Math.sqrt(amplification) * 60) / (2 * Math.PI)).toFixed(1)}{' '}
                                        rpm). Como va con ω², a 5× son <strong>500 %</strong> y el
                                        mapa satura.
                                    </p>
                                </div>
                            ) : null}

                            {mode === 'tangential' ? (
                                <div className="mt-2 space-y-1">
                                    <label className="flex items-center gap-2 text-[11px] text-slate-400">
                                        <span className="w-20 shrink-0">ω objetivo</span>
                                        <input
                                            type="range"
                                            min={0}
                                            max={6}
                                            step={0.05}
                                            value={omegaTarget}
                                            onChange={(event) => setOmegaTarget(Number(event.target.value))}
                                            className="flex-1"
                                        />
                                        <span className="w-12 text-right font-mono text-slate-300">
                                            {omegaTarget.toFixed(2)}
                                        </span>
                                    </label>
                                    <label className="flex items-center gap-2 text-[11px] text-slate-400">
                                        <span className="w-20 shrink-0">inercia τ</span>
                                        <input
                                            type="range"
                                            min={0.1}
                                            max={3}
                                            step={0.05}
                                            value={inertia}
                                            onChange={(event) => setInertia(Number(event.target.value))}
                                            className="flex-1"
                                        />
                                        <span className="w-12 text-right font-mono text-slate-300">
                                            {inertia.toFixed(2)} s
                                        </span>
                                    </label>
                                    <button
                                        type="button"
                                        onClick={() => setOmega(0)}
                                        className="rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] text-slate-300 hover:bg-white/[0.07]"
                                    >
                                        repetir el arranque (ω = 0)
                                    </button>
                                    <p className="text-[10px] leading-relaxed text-slate-600">
                                        Acelerar y frenar son cargas <strong>opuestas</strong>: α &gt; 0
                                        va en un sentido y α &lt; 0 en el contrario, así que en el mapa
                                        con signo uno sale cálido y el otro frío. ω actual{' '}
                                        <span className="font-mono text-slate-400">{omega.toFixed(2)} rad/s</span> · α
                                        = Δω/τ{' '}
                                        <span className="font-mono text-slate-400">
                                            {Math.abs(alpha).toFixed(2)} rad/s²
                                        </span>{' '}
                                        = {(Math.abs(alpha) / ALPHA_REF).toFixed(2)}× el caso unitario. Con ω
                                        estable, α→0 y el mapa se apaga: la carga tangencial es la
                                        aceleración, no la velocidad.
                                    </p>
                                </div>
                            ) : null}

                            {mode === 'gravity' ? (
                                <div className="mt-2 space-y-1">
                                    {(['balanceo', 'cabeceo', 'guiñada'] as const).map((label, axis) => (
                                        <label
                                            key={label}
                                            className="flex items-center gap-2 text-[11px] text-slate-400"
                                        >
                                            <span className="w-20 shrink-0">{label}</span>
                                            <input
                                                type="range"
                                                min={-90}
                                                max={90}
                                                step={5}
                                                value={gravityAngles[axis as 0 | 1 | 2]}
                                                onChange={(event) => {
                                                    const value = Number(event.target.value);
                                                    setGravityAngles((previous) => {
                                                        const next: [number, number, number] = [...previous];
                                                        next[axis as 0 | 1 | 2] = value;
                                                        return next;
                                                    });
                                                }}
                                                className="flex-1"
                                            />
                                            <span className="w-12 text-right font-mono text-slate-300">
                                                {gravityAngles[axis as 0 | 1 | 2]}°
                                            </span>
                                        </label>
                                    ))}
                                    <label className="flex items-center gap-2 text-[11px] text-slate-400">
                                        <span className="w-20 shrink-0">ω del rotor</span>
                                        <input
                                            type="range"
                                            min={0}
                                            max={6}
                                            step={0.05}
                                            value={gravityOmega}
                                            onChange={(event) => setGravityOmega(Number(event.target.value))}
                                            className="flex-1"
                                        />
                                        <span className="w-12 text-right font-mono text-slate-300">
                                            {gravityOmega.toFixed(2)}
                                        </span>
                                    </label>
                                    <p className="text-[10px] leading-relaxed text-slate-600">
                                        La plataforma se inclina y la flecha cian marca la vertical del
                                        mundo. Con ω &gt; 0 el rotor gira y <strong>cada pala ve otra
                                            gravedad</strong>, así que el mapa cambia mientras barre
                                        (desfase de 120°). Cosenos por pala:{' '}
                                        {bladeNames.map((name) => {
                                            const pesos = weightFor(name);
                                            const detalle = (['blade-x', 'blade-y', 'blade-z'] as const)
                                                .map(
                                                    (caso) =>
                                                        `${caso.slice(-1)} ${Math.round(
                                                            (pesos[caso] ?? 0) * 100
                                                        )}%`
                                                )
                                                .join(' ');
                                            return `${name}: ${detalle}`;
                                        }).join(' · ')}
                                    </p>
                                </div>
                            ) : null}

                            {mode === 'centripetal' || mode === 'tangential' || mode === 'gravity' ? (
                                <label className="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
                                    <span className="w-20 shrink-0">giro visual</span>
                                    <input
                                        type="range"
                                        min={1}
                                        max={8}
                                        step={1}
                                        value={spinGain}
                                        onChange={(event) => setSpinGain(Number(event.target.value))}
                                        className="flex-1"
                                    />
                                    <span className="w-12 text-right font-mono text-slate-300">
                                        {spinGain}×
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            spinRef.current = 0;
                                            setSpinAngle(0);
                                        }}
                                        title="llevar el rotor a su posición de reposo"
                                        className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-white/[0.07]"
                                    >
                                        0°
                                    </button>
                                </label>
                            ) : null}
                            <div className="mt-2">
                                <div className="flex flex-wrap gap-1">
                                    {(
                                        [
                                            ['magnitude', 'módulo |u|'],
                                            ['signed', 'con signo ±'],
                                        ] as const
                                    ).map(([id, label]) => (
                                        <button
                                            key={id}
                                            type="button"
                                            onClick={() => setField(id)}
                                            className={`rounded border px-2 py-1 text-[10px] transition ${field === id
                                                    ? 'border-sky-400/60 bg-sky-400/10 text-slate-100'
                                                    : 'border-white/10 bg-white/[0.03] text-slate-400 hover:bg-white/[0.07]'
                                                }`}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                                {/* El propio colorbar lleva las dos manijas encima: la
                                    izquierda fija el azul, la derecha el rojo. Van en
                                    múltiplo del rango real, que es el valor automático. */}
                                <div className="dual-range mt-1">
                                    <div
                                        className="pointer-events-none absolute inset-x-0 top-[3px] h-2 rounded"
                                        style={{ backgroundImage: gradientCss }}
                                    />
                                    {/* Los dos extremos son **valores absolutos** y el recorrido
                                        es el del análisis: el pulgar en su tope = escala
                                        completa (lo que da «auto»), arrastrar hacia el centro
                                        aprieta. Antes el recorrido era el doble, así que el
                                        valor automático caía en mitad de la barra. */}
                                    <input
                                        type="range"
                                        min={staticRange.min < 0 ? staticRange.min : 0}
                                        max={0}
                                        step={(staticRange.max || 1) / 400}
                                        disabled={!(staticRange.min < 0 && staticRange.max > 0)}
                                        value={Math.min(0, Math.max(staticRange.min, escalaMin))}
                                        aria-label="extremo azul"
                                        onChange={(event) =>
                                            setScaleRange({
                                                min: Number(event.target.value),
                                                max: escalaMax,
                                            })
                                        }
                                    />
                                    <input
                                        type="range"
                                        min={0}
                                        max={staticRange.max > 0 ? staticRange.max : 1}
                                        step={(staticRange.max || 1) / 400}
                                        disabled={!(staticRange.max > 0)}
                                        value={Math.max(0, Math.min(staticRange.max, escalaMax))}
                                        aria-label="extremo rojo"
                                        onChange={(event) =>
                                            setScaleRange({
                                                min: escalaMin,
                                                max: Number(event.target.value),
                                            })
                                        }
                                    />
                                </div>
                                <div className="flex justify-between font-mono text-[10px] text-slate-500">
                                    <span>{formatMetres(escalaMin)}</span>
                                    <span>{formatMetres(escalaMax)}</span>
                                </div>
                                <div className="mt-1 flex items-center justify-between text-[10px] text-slate-600">
                                    <span>
                                        escala {scaleRange === null ? 'del análisis' : 'manual'} · fuera de
                                        las manijas satura · 100 % ={' '}
                                        <span className="font-mono">{formatMetres(paintScale)}</span>
                                    </span>
                                    <span className="flex items-center gap-2">
                                        <label className="flex items-center gap-1 text-slate-400">
                                            <input
                                                type="checkbox"
                                                checked={smooth}
                                                onChange={(event) => setSmooth(event.target.checked)}
                                            />
                                            suavizar
                                        </label>
                                        <span className="font-mono text-slate-500">{paintMs.toFixed(1)} ms</span>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setScaleRange({
                                                    min: Math.min(autoRange[0], 0),
                                                    max: autoRange[1],
                                                })
                                            }
                                            title="fijar la escala al campo que se está viendo ahora"
                                            className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-white/[0.07]"
                                        >
                                            ajustar
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setScaleRange(null)}
                                            title="volver al rango del análisis"
                                            className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-white/[0.07]"
                                        >
                                            auto
                                        </button>
                                    </span>
                                </div>
                            </div>
                            <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-slate-500">
                                <dt>escala del análisis</dt>
                                <dd className="text-right font-mono text-slate-300">
                                    {formatMetres(staticRange.min)} … {formatMetres(staticRange.max)}
                                </dd>
                                <dt>campo actual</dt>
                                <dd className="text-right font-mono text-slate-400">
                                    {formatMetres(autoRange[0])} … {formatMetres(autoRange[1])}
                                </dd>
                            </dl>
                            {current.error ? (
                                <p className="mt-2 text-[11px] text-amber-300">Error: {current.error}</p>
                            ) : null}
                        </>
                    )}
                </section>

                {/* Anclaje */}
                <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                    <div className="mb-2 flex items-center justify-between">
                        <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                            Anclaje del rotor
                        </h2>
                        <button
                            type="button"
                            onClick={() => setAnchor(DEFAULT_ANCHOR)}
                            className="rounded px-1 text-[10px] text-slate-500 hover:text-slate-300"
                        >
                            reset
                        </button>
                    </div>
                    <div className="space-y-1">
                        {([0, 1, 2] as const).map((axis) => (
                            <NumberField
                                key={`p${axis}`}
                                label={`${'xyz'[axis]}`}
                                value={anchor.position[axis]}
                                onChange={(value) => setPositionAxis(axis, value)}
                                suffix="m"
                            />
                        ))}
                        {([0, 1, 2] as const).map((axis) => (
                            <NumberField
                                key={`r${axis}`}
                                label={`r${'xyz'[axis]}`}
                                value={anchor.rotation[axis]}
                                step={1}
                                onChange={(value) => setRotationAxis(axis, value)}
                                suffix="°"
                            />
                        ))}
                        <NumberField
                            label="radial"
                            value={anchor.radial}
                            onChange={(value) => setAnchorField('radial', value)}
                            suffix="m"
                        />
                        <NumberField
                            label="acimut"
                            value={anchor.azimuth}
                            step={1}
                            onChange={(value) => setAnchorField('azimuth', value)}
                            suffix="°"
                        />
                    </div>
                    <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
                        Las tres palas van a acimut, +120° y +240°.
                    </p>
                </section>

                {/* Vista */}
                <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                    <h2 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        Vista
                    </h2>
                    <div className="space-y-1.5 text-[11px] text-slate-400">
                        <label className="flex items-center gap-2">
                            <input
                                type="checkbox"
                                checked={showTwin}
                                onChange={(event) => setShowTwin(event.target.checked)}
                            />
                            gemelo (.glb)
                        </label>
                        <select
                            value={twinFile}
                            onChange={(event) => setTwinFile(event.target.value)}
                            className="w-full rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-sky-400/60"
                        >
                            {TWIN_FILES.map((file) => (
                                <option key={file} value={file}>
                                    {file}
                                    {withBase(`/models/${file}`) === TWIN_MODEL_URL ? ' · el de la app' : ''}
                                </option>
                            ))}
                        </select>
                        <label className="flex items-center gap-2">
                            <input
                                type="checkbox"
                                checked={showBlades}
                                onChange={(event) => setShowBlades(event.target.checked)}
                            />
                            malla FEM
                        </label>
                        <label className="flex items-center gap-2">
                            <input
                                type="checkbox"
                                checked={paint}
                                onChange={(event) => setPaint(event.target.checked)}
                            />
                            pintar las palas del gemelo
                        </label>
                        {paint ? (
                            <p className="pl-5 text-[10px] leading-relaxed text-slate-500">
                                {painted.painted > 0
                                    ? `${painted.painted} primitivas con los resultados interpolados`
                                    : `no pude pintar: ${painted.reason ?? 'el .glb no coincide con el horneado'}`}
                                {residual
                                    ? ` · desajuste de mallas: mediana ${(residual.median * 1e3).toFixed(1)} mm, p95 ${(residual.p95 * 1e3).toFixed(1)} mm`
                                    : null}
                            </p>
                        ) : null}
                        <label className="flex items-center gap-2">
                            <input
                                type="checkbox"
                                checked={wireframe}
                                onChange={(event) => setWireframe(event.target.checked)}
                            />
                            alambre
                        </label>
                        <label className="flex items-center gap-2">
                            <span className="w-14">opacidad</span>
                            <input
                                type="range"
                                min={0.1}
                                max={1}
                                step={0.05}
                                value={opacity}
                                onChange={(event) => setOpacity(Number(event.target.value))}
                                className="flex-1"
                            />
                        </label>
                        <label className="flex items-center gap-2">
                            <span className="w-14">gemelo</span>
                            <input
                                type="range"
                                min={0.1}
                                max={1}
                                step={0.05}
                                value={twinOpacity}
                                onChange={(event) => setTwinOpacity(Number(event.target.value))}
                                className="flex-1"
                            />
                        </label>
                        <label className="flex items-center gap-2">
                            <span className="w-14">color máx</span>
                            <input
                                type="number"
                                value={Number(peak.toExponential(3))}
                                step={Number((peak / 10).toExponential(2))}
                                onChange={(event) => setColourScale(Number(event.target.value))}
                                className="w-full rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-right font-mono text-[11px] text-slate-200 outline-none focus:border-sky-400/60"
                            />
                            <button
                                type="button"
                                onClick={() => setColourScale(null)}
                                title="volver a la escala automática del modo"
                                className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-1 text-[10px] text-slate-400 hover:bg-white/[0.07]"
                            >
                                auto
                            </button>
                        </label>
                        <div className="flex items-center gap-1 pt-1">
                            <span className="h-2 flex-1 rounded-l bg-[hsl(238,85%,50%)]" />
                            <span className="h-2 flex-1 bg-[hsl(178,85%,50%)]" />
                            <span className="h-2 flex-1 bg-[hsl(119,85%,50%)]" />
                            <span className="h-2 flex-1 bg-[hsl(60,85%,50%)]" />
                            <span className="h-2 flex-1 rounded-r bg-[hsl(0,85%,50%)]" />
                        </div>
                        <p className="text-[10px] text-slate-600">
                            0 → {formatMetres(peak)} (escala {colourScale === null ? 'automática del modo' : 'manual'})
                        </p>
                    </div>
                </section>

                {/* Árbol */}
                <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                    <h2 className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        Elementos del .glb
                        <span className="flex items-center gap-1 font-normal normal-case tracking-normal">
                            <span className="h-1.5 w-1.5 rounded-full bg-pink-400" /> rotor
                            <span className="ml-2 h-1.5 w-1.5 rounded-full bg-sky-400/70" /> torre
                        </span>
                    </h2>
                    {glbError ? (
                        <p className="text-[11px] text-amber-300">No pude cargar el .glb: {glbError}</p>
                    ) : null}
                    <div className="max-h-[45vh] overflow-y-auto pr-1">
                        {tree ? (
                            <ul>
                                {tree.children.map((child) => (
                                    <TreeRow
                                        key={child.name}
                                        node={child}
                                        depth={0}
                                        expanded={expanded}
                                        toggle={toggle}
                                        onAnchor={(centre) =>
                                            setAnchor((previous) => ({
                                                ...previous,
                                                position: centre.map((value) =>
                                                    Number(value.toFixed(5))
                                                ) as [number, number, number],
                                            }))
                                        }
                                    />
                                ))}
                            </ul>
                        ) : (
                            <p className="text-[11px] text-slate-600">Cargando modelo…</p>
                        )}
                    </div>
                </section>
            </aside>

            {/* ------------------------------------------------------- lienzo */}
            <main className="relative min-h-[60vh] flex-1 lg:h-screen">
                <Canvas camera={{ position: [1.5, 1.6, 1.7], fov: 42, near: 0.05, far: 100 }}>
                    <color attach="background" args={['#070b14']} />
                    <ambientLight intensity={0.75} />
                    <directionalLight position={[3, 6, 2]} intensity={1.6} />
                    <directionalLight position={[-3, 2, -4]} intensity={0.4} />

                    {/* Toda la plataforma (torre + rotor) se inclina en el modo de
                        gravedad; la rejilla y la flecha se quedan en el mundo para
                        que se vea el escorado. */}
                    <group rotation={platformRotation}>
                        <Twin scene={gltf} visible={showTwin} />

                        {bladeMesh && current.data ? (
                            <Blades
                                mesh={bladeMesh}
                                magnitudes={current.data.magnitudes}
                                anchor={anchor}
                                wireframe={wireframe}
                                opacity={opacity}
                                colourScale={peak}
                                visible={showBlades}
                                spin={spinRef}
                            />
                        ) : null}
                    </group>

                    <Rotor node={rotorNode} omega={omegaRef} spin={spinRef} />
                    {mode === 'gravity' ? <GravityVector /> : null}

                    <Grid
                        args={[6, 6]}
                        cellSize={0.1}
                        cellThickness={0.5}
                        sectionSize={0.5}
                        sectionThickness={1}
                        cellColor="#1e293b"
                        sectionColor="#334155"
                        fadeDistance={8}
                        fadeStrength={1.5}
                        infiniteGrid
                        position={[0, 0, 0]}
                    />
                    <axesHelper args={[0.5]} />
                    <OrbitControls makeDefault target={[0, 0.9, -0.15]} />
                </Canvas>

                <p className="pointer-events-none absolute bottom-3 left-3 rounded bg-black/40 px-2 py-1 text-[10px] text-slate-400">
                    arrastra para girar · rueda para acercar · ⊕ en la lista = centrar el ancla
                </p>
            </main>
        </div>
    );
}
