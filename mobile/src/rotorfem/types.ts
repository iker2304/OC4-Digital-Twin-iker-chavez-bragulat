/**
 * Tipos de los datos que genera `scripts/fem-to-json.py`.
 *
 * Los tres JSON viven en `public/rotor-fem/` y son estáticos: la página los pide
 * por `fetch` y no hay backend de por medio.
 */

/** `mesh.json` — malla compartida por todos los casos, en el frame de referencia. */
export interface FemMesh {
    nodeCount: number;
    triangleCount: number;
    /** xyz intercalados, en metros (3 × nodeCount). */
    positions: number[];
    /** Índices de triángulo, 0-based (3 × triangleCount). */
    indices: number[];
    signature: string;
    /** Caso cuyo sistema de ejes define la malla. */
    frame: string;
}

export interface FemStats {
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
}

/** `<caso>.json` — un caso de carga. */
export interface FemCase {
    case: string;
    nodeCount: number;
    stats: FemStats;
    /** |u| por nodo, en metros. */
    magnitudes: number[];
    /** Malla compartida (nombre de fichero) o la suya, si no se pudo alinear. */
    mesh?: string;
    positions?: number[];
    indices?: number[];
    triangleCount?: number;
    alignedTo: string | null;
    frameRotation: number[][] | null;
    frameResidual: number | null;
    frameNote: string | null;
    source: { dat: string; res: string };
    warnings: { nodesWithoutResult: number };
}

/** `index.json` — qué casos hay, sin pedir ninguno. */
export interface FemIndex {
    reference: string;
    mesh: string | null;
    cases: Array<{ case: string; nodeCount: number; max: number; p95: number }>;
}

/**
 * `blade-glb.json` — los resultados FEM interpolados sobre **las mallas de pala
 * del propio `.glb`** (lo genera `scripts/fem-bake-blade.py`).
 *
 * Así el mapa de color se pinta sobre la geometría que se ve, sin desajuste: la
 * malla del solver solo se usa para calcular, no para dibujar.
 */
export interface BladePrimitive {
    node: number;
    name: string;
    primitive: number;
    count: number;
    checksum: string;
}

export interface BladeBake {
    glb: string;
    blades: Record<
        string,
        {
            nodes: string[];
            vertexCount: number;
            primitives: BladePrimitive[];
            /** Eje largo de la pala (unitario, en el frame del `.glb`). */
            axis: [number, number, number];
            icp: {
                median: number;
                p95: number;
                max: number;
                fromReference: string | null;
            };
        }
    >;
    cases: Record<
        string,
        {
            /** Valor real (m) que corresponde al 255 de cada pala. */
            peaks: Record<string, number>;
            /** 60.200 bytes por pala, en base64, en el orden de `blades[x].primitives`. */
            values: Record<string, string>;
            farNeighbour: Record<string, number>;
            /**
             * Componentes con signo de los casos de gravedad (`blade-x/y/z`), en
             * base64 de `int8`. Sin ellos no se pueden superponer cargas: sumar
             * módulos no es lo mismo, y con pesos negativos ni siquiera está
             * definido.
             */
            vectors: Record<string, { x: string; y: string; z: string }>;
            /** Valor real (m) que corresponde al 127 de cada componente. */
            vectorPeaks: Record<string, number>;
        }
    >;
}

/** Anclaje del rotor sobre el gemelo, en el frame del `.glb`. */
export interface Anchor {
    /** Centro del rotor, en metros (frame de la escena, Y arriba). */
    position: [number, number, number];
    /** Orientación del eje del rotor, en grados (orden XYZ). */
    rotation: [number, number, number];
    /** Desplazamiento radial del modelo respecto al centro, en metros. */
    radial: number;
    /** Acimut de la primera pala, en grados; las otras dos van a +120° y +240°. */
    azimuth: number;
}

/**
 * Valores de partida: el buje según `src/lib/pose/rotorAngle.ts`
 * (`ROTOR_HUB = 0.0009, 1.145, −0.2576`) y 90° de acimut, que es donde está la
 * primera pala del `.glb` (`BLADE_AZIMUTHS_DEG = [330, 90, 210]`).
 */
export const DEFAULT_ANCHOR: Anchor = {
    position: [0.0009, 1.145, -0.2576],
    rotation: [0, 0, 0],
    radial: 0,
    azimuth: 90,
};
