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
import { Canvas } from '@react-three/fiber';
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
    if (value < 1e-6) return `${(value * 1e9).toFixed(1)} nm`;
    if (value < 1e-3) return `${(value * 1e6).toFixed(2)} µm`;
    return `${(value * 1e3).toFixed(2)} mm`;
}

/** Peso de cada caso base (nombre del JSON) en el mapa que se pinta. */
export type Weights = Record<string, number>;

/**
 * Reparto de la gravedad entre los casos `x`, `y` y `z`.
 *
 * Los tres casos son la misma plataforma cargada con la gravedad alineada con un
 * eje. Si la plataforma se inclina, la gravedad se reparte entre los tres con los
 * cosenos directores: se pasa `g = (0,−1,0)` al sistema del cuerpo con la
 * inversa de la rotación. Se combinan los tres a la vez, que es lo que pasa de
 * verdad cuando escora.
 */
function gravityWeights(angles: [number, number, number]): Weights {
    const euler = new THREE.Euler(
        (angles[0] * Math.PI) / 180,
        (angles[1] * Math.PI) / 180,
        (angles[2] * Math.PI) / 180,
        'XYZ'
    );
    const inverse = new THREE.Matrix4().makeRotationFromEuler(euler).invert();
    const gravity = new THREE.Vector3(0, -1, 0).applyMatrix4(inverse);
    return {
        'blade-x': Math.abs(gravity.x),
        'blade-y': Math.abs(gravity.y),
        'blade-z': Math.abs(gravity.z),
    };
}

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
function paintBlades(
    scene: THREE.Object3D,
    bake: BladeBake,
    weights: Weights,
    scale: number
): { painted: number; reason: string | null; peak: number } {
    const activos = Object.entries(weights).filter(([name, weight]) => weight > 0 && bake.cases[name]);
    if (activos.length === 0) return { painted: 0, reason: 'ningún caso activo', peak: 0 };

    // three.js **sanea** los nombres al cargar el glTF (`MeshBody1 (2)` llega como
    // `MeshBody1_(2)`), así que no se puede buscar por el nombre del fichero: se
    // comparan las dos cadenas sin espacios ni signos.
    const normalize = (name: string) => name.replace(/[^0-9a-z]/gi, '').toLowerCase();
    const byName = new Map<string, THREE.Object3D>();
    scene.traverse((child) => {
        const key = normalize(child.name);
        if (key && !byName.has(key)) byName.set(key, child);
    });

    // 1) Combinar los casos, pala a pala: u(v) = Σ w_c · |u_c(v)|. Los cinco casos
    //    son lineales, así que superponerlos es válido para un mapa de color.
    const combinado = new Map<string, Float32Array>();
    let peak = 0;
    for (const [bladeName, blade] of Object.entries(bake.blades)) {
        const total = new Float32Array(blade.vertexCount);
        for (const [caseName, weight] of activos) {
            const entry = bake.cases[caseName];
            const encoded = entry.values[bladeName];
            if (!encoded) continue;
            const bytes = base64ToBytes(encoded);
            const factor = (weight * (entry.peaks[bladeName] ?? 0)) / 255;
            const limite = Math.min(total.length, bytes.length);
            for (let index = 0; index < limite; index += 1) total[index] += bytes[index] * factor;
        }
        combinado.set(bladeName, total);
        for (const value of total) if (value > peak) peak = value;
    }
    if (!(peak > 0)) return { painted: 0, reason: 'el caso vale 0 con estos parámetros', peak: 0 };
    // La escala del color **no** se normaliza con el pico del momento: si no, mover
    // el deslizador no cambiaría nada (el máximo siempre saldría rojo). Se fija al
    // máximo del modo (5× en centrífuga, la suma de los tres en gravedad), así que
    // subir la carga **sí** enciende el mapa.
    const referencia = scale > 0 ? scale : peak;

    // 2) Pintar, con **una sola escala** para las tres palas: si cada una se
    //    normalizase por su propio máximo, el mismo color significaría cosas
    //    distintas en cada aspa.
    let painted = 0;
    for (const [bladeName, blade] of Object.entries(bake.blades)) {
        const total = combinado.get(bladeName);
        if (!total) continue;
        let offset = 0;

        for (const primitive of blade.primitives) {
            const slice = total.subarray(offset, offset + primitive.count);
            offset += primitive.count;

            const object = byName.get(normalize(primitive.name));
            if (!object) return { painted, reason: `no encuentro el nodo «${primitive.name}»`, peak };

            const meshes: THREE.Mesh[] = [];
            object.traverse((child) => {
                if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
            });
            const mesh = meshes[primitive.primitive];
            if (!mesh || Array.isArray(mesh.material)) {
                return { painted, reason: `«${primitive.name}» no es una malla simple`, peak };
            }
            const runtime = mesh.geometry.attributes.position.count;
            if (runtime !== primitive.count) {
                return {
                    painted,
                    reason: `«${primitive.name}»: ${runtime} vértices en el .glb, ${primitive.count} en el JSON`,
                    peak,
                };
            }

            const colours = new Float32Array(primitive.count * 3);
            const colour = new THREE.Color();
            for (let index = 0; index < primitive.count; index += 1) {
                colourFor(slice[index] / referencia, colour);
                colours[index * 3] = colour.r;
                colours[index * 3 + 1] = colour.g;
                colours[index * 3 + 2] = colour.b;
            }
            mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));

            if (!mesh.userData.__femMaterial) mesh.userData.__femMaterial = mesh.material;
            // Material **nuevo**, no un clon: el original trae su albedo y su textura,
            // y con `vertexColors` encima el resultado sale oscurecido (el color de
            // vértice multiplica al del material). Aquí se sustituye del todo para
            // que se vea el color del FEM tal cual.
            const previous = mesh.material as THREE.Material;
            mesh.material = new THREE.MeshStandardMaterial({
                vertexColors: true,
                roughness: 0.62,
                metalness: 0.08,
                side: previous.side,
                transparent: previous.transparent,
                opacity: previous.opacity,
            });
            painted += 1;
        }
    }
    return { painted, reason: null, peak };
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
}: {
    mesh: FemMesh;
    magnitudes: number[];
    anchor: Anchor;
    wireframe: boolean;
    opacity: number;
    colourScale: number;
    visible: boolean;
}) {
    const rotation = anchor.rotation.map((degrees) => (degrees * Math.PI) / 180) as [
        number,
        number,
        number,
    ];

    if (!visible) return null;

    return (
        <group position={anchor.position} rotation={rotation}>
            {BLADE_OFFSETS.map((offset) => (
                <group key={offset} rotation={[0, 0, ((anchor.azimuth + offset) * Math.PI) / 180]}>
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
    const [paintedPeak, setPaintedPeak] = useState(0);
    const [anchor, setAnchor] = useState<Anchor>(DEFAULT_ANCHOR);
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

    /** Casos base que se combinan con qué peso, según el modo elegido. */
    const weights = useMemo<Weights>(() => {
        if (mode === 'unit') return caseName ? { [caseName]: 1 } : {};
        if (mode === 'centripetal') return { 'blade-centripetal': amplification };
        if (mode === 'tangential') return { 'blade-tangential': Math.abs(alpha) / ALPHA_REF };
        return gravityWeights(gravityAngles);
    }, [mode, caseName, amplification, alpha, gravityAngles]);
    const [colourScale, setColourScale] = useState<number | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const index = useJson<FemIndex>(`${FEM_BASE}/index.json`);
    const mesh = useJson<FemMesh>(`${FEM_BASE}/mesh.json`);
    const current = useJson<FemCase>(caseName ? `${FEM_BASE}/${caseName}.json` : null);
    const bake = useJson<BladeBake>(
        twinFile === 'OC4.glb' ? `${FEM_BASE}/blade-glb.json` : `${FEM_BASE}/blade-glb-modal.json`
    );

    /**
     * Escala fija del mapa de color por modo: el valor que se pinta como rojo.
     *
     * Centrífuga y tangencial se escalan al máximo del deslizador (5×) y gravedad a
     * la suma de los tres casos (que es el máximo teórico al 100 % en cada eje).
     */
    const paintScale = useMemo(() => {
        const data = bake.data;
        if (!data) return 0;
        const casePeak = (name: string) => {
            const entry = data.cases[name];
            if (!entry) return 0;
            return Math.max(0, ...Object.values(entry.peaks));
        };
        if (mode === 'centripetal') return 5 * casePeak('blade-centripetal');
        if (mode === 'tangential') return 5 * casePeak('blade-tangential');
        if (mode === 'gravity') {
            return casePeak('blade-x') + casePeak('blade-y') + casePeak('blade-z');
        }
        return caseName ? casePeak(caseName) : 0;
    }, [bake.data, mode, caseName]);


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

    // Pintar el gemelo: se quita siempre antes, para que cambiar de caso o
    // apagar la casilla no deje colores viejos pegados.
    useEffect(() => {
        if (!gltf) return;
        unpaintBlades(gltf);
        if (!paint || !bake.data) {
            setPainted({ painted: 0, reason: null });
            setPaintedPeak(0);
            return;
        }
        const result = paintBlades(gltf, bake.data, weights, colourScale ?? paintScale);
        setPainted({ painted: result.painted, reason: result.reason });
        setPaintedPeak(result.peak);
    }, [gltf, paint, bake.data, weights, paintScale, colourScale]);

    // Después de pintar, porque pintar cambia los materiales.
    useEffect(() => {
        if (!gltf) return;
        applyTwinOpacity(gltf, twinOpacity);
    }, [gltf, twinOpacity, paint, bake.data, weights, paintScale, colourScale]);

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
                                        className={`rounded border px-2 py-1 text-[10px] transition ${
                                            mode === id
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
                                            className={`rounded border px-2 py-1 text-[10px] transition ${
                                                entry.case === caseName
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
                                        ω²·r. Referencia a 1 m/s² en la punta: ω ≈{' '}
                                        <span className="font-mono text-slate-400">
                                            {(OMEGA_REF * Math.sqrt(amplification)).toFixed(2)} rad/s
                                        </span>{' '}
                                        ({((OMEGA_REF * Math.sqrt(amplification) * 60) / (2 * Math.PI)).toFixed(1)}{' '}
                                        rpm). 5× es el máximo que se puede pintar.
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
                                        ω actual{' '}
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
                                    <p className="text-[10px] leading-relaxed text-slate-600">
                                        La gravedad se reparte entre los tres casos con los cosenos:{' '}
                                        {(['blade-x', 'blade-y', 'blade-z'] as const)
                                            .map(
                                                (name) =>
                                                    `${name.slice(-1)} ${Math.round(
                                                        (weights[name] ?? 0) * 100
                                                    )}%`
                                            )
                                            .join(' · ')}
                                    </p>
                                </div>
                            ) : null}

                            <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-slate-500">
                                <dt>pico pintado</dt>
                                <dd className="text-right font-mono text-slate-300">
                                    {formatMetres(paintedPeak)}
                                </dd>
                                <dt>casos activos</dt>
                                <dd className="text-right font-mono text-slate-300">
                                    {Object.values(weights).filter((weight) => weight > 0).length}
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
                        />
                    ) : null}

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
