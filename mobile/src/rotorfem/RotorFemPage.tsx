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
import { DEFAULT_ANCHOR, type Anchor, type FemCase, type FemIndex, type FemMesh } from './types';

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
    const [anchor, setAnchor] = useState<Anchor>(DEFAULT_ANCHOR);
    const [wireframe, setWireframe] = useState(false);
    const [opacity, setOpacity] = useState(0.85);
    const [showTwin, setShowTwin] = useState(true);
    const [showBlades, setShowBlades] = useState(true);
    const [colourScale, setColourScale] = useState<number | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const index = useJson<FemIndex>(`${FEM_BASE}/index.json`);
    const mesh = useJson<FemMesh>(`${FEM_BASE}/mesh.json`);
    const current = useJson<FemCase>(caseName ? `${FEM_BASE}/${caseName}.json` : null);

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

    const peak = colourScale ?? current.data?.stats.max ?? 1;

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

                {/* Caso */}
                <section className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                    <h2 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        Caso de carga
                    </h2>
                    {index.error ? (
                        <p className="text-[11px] text-amber-300">
                            No pude leer <code>rotor-fem/index.json</code>. Genera los datos con{' '}
                            <code>python scripts/fem-to-json.py</code>.
                        </p>
                    ) : (
                        <div className="flex flex-wrap gap-1">
                            {(index.data?.cases ?? []).map((entry) => (
                                <button
                                    key={entry.case}
                                    type="button"
                                    onClick={() => {
                                        setCaseName(entry.case);
                                        setColourScale(null);
                                    }}
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
                    )}
                    {current.data ? (
                        <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-slate-500">
                            <dt>nodos</dt>
                            <dd className="text-right font-mono text-slate-300">
                                {current.data.nodeCount}
                            </dd>
                            <dt>|u| máx</dt>
                            <dd className="text-right font-mono text-slate-300">
                                {(current.data.stats.max * 1e9).toFixed(1)} nm
                            </dd>
                            <dt>|u| p95</dt>
                            <dd className="text-right font-mono text-slate-300">
                                {(current.data.stats.p95 * 1e9).toFixed(1)} nm
                            </dd>
                            <dt>frame</dt>
                            <dd className="text-right font-mono text-slate-300">
                                {current.data.alignedTo ? 'común' : 'propio'}
                            </dd>
                        </dl>
                    ) : null}
                    {current.error ? (
                        <p className="mt-2 text-[11px] text-amber-300">Error: {current.error}</p>
                    ) : null}
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
                            <span className="w-14">color máx</span>
                            <input
                                type="number"
                                value={Number(peak.toExponential(3))}
                                step={Number((peak / 10).toExponential(2))}
                                onChange={(event) => setColourScale(Number(event.target.value))}
                                className="w-full rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-right font-mono text-[11px] text-slate-200 outline-none focus:border-sky-400/60"
                            />
                        </label>
                        <div className="flex items-center gap-1 pt-1">
                            <span className="h-2 flex-1 rounded-l bg-[hsl(238,85%,50%)]" />
                            <span className="h-2 flex-1 bg-[hsl(178,85%,50%)]" />
                            <span className="h-2 flex-1 bg-[hsl(119,85%,50%)]" />
                            <span className="h-2 flex-1 bg-[hsl(60,85%,50%)]" />
                            <span className="h-2 flex-1 rounded-r bg-[hsl(0,85%,50%)]" />
                        </div>
                        <p className="text-[10px] text-slate-600">0 → |u| máx</p>
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
