/**
 * Contour map of a mode shape over the twin's mesh.
 *
 * `scripts/bake-mode-map.mjs` does the expensive part offline and leaves ~1.7 MB
 * of compact data: **one solver-node index per vertex** plus the **mode vector**
 * per node. Storing vectors (not just magnitudes) is what makes the map react:
 *
 *     u(v, t) = φ(v) · q(t)
 *
 * i.e. the mode shape scaled by the modal coordinate measured at that instant.
 * The colour shows the shape (where it moves most) and the amplitude makes it
 * pulse; the deformation moves the geometry along the same vector, so a
 * horizontal swing shows as a gradient across the hull instead of a flat tint.
 *
 * Caveat worth keeping in mind: the solver mesh and the twin are *different*
 * meshes, so this is a visual contour of the mode over the twin, not a strict FE
 * result on this geometry.
 */
import { withBase } from '../env';

export const MODE_MAP_URL = withBase('/models/oc4-mode-map.json');

export interface ModeMapEntry {
    label: string;
    freqHz: number;
    /** Dominant axis of the modal mass, in the solver's axes. */
    axis: 'x' | 'y' | 'z';
    /** Peak component of the shape, in solver units (for reference). */
    peak: number;
    /** Three int8 per solver node, normalised to ±127. */
    values: Int8Array;
}

export interface ModeMap {
    vertexCount: number;
    nodeCount: number;
    /** One uint16 per vertex: which solver node it maps to. */
    nodeIndex: Uint16Array;
    modes: ModeMapEntry[];
}

/**
 * The heavy arrays are served as **binary**, not base64.
 *
 * `atob` on a one-megabyte string is fragile (some browsers answer
 * "String contains an invalid character" and there is nothing to do about it),
 * and the base64 form is a third bigger on the wire. Two fetches, no decoding.
 *
 * Everything carries a cache-busting token: `/models/` is served with a one-day
 * `max-age`, and a stale metadata file from the base64 era made the app request
 * `…/models/undefined` and receive the SPA `index.html` — which then failed as
 * "índice corrupto: 1095 B". A 510-byte file is not worth caching.
 */
async function fetchBytes(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`no se pudo cargar ${url} (HTTP ${response.status})`);
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
        throw new Error(`el servidor devolvió HTML para ${url}: el fichero no existe en este despliegue`);
    }
    return response.arrayBuffer();
}

export async function loadModeMap(): Promise<ModeMap> {
    const token = `v=${Date.now()}`;
    const response = await fetch(`${MODE_MAP_URL}?${token}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`no se pudo cargar el mapa modal (HTTP ${response.status})`);
    const raw = (await response.json()) as {
        vertexCount?: number;
        nodeCount?: number;
        nodeIndex?: string;
        modes?: Array<{
            label: string;
            freqHz: number;
            axis: 'x' | 'y' | 'z';
            peak: number;
            file: string;
        }>;
    };

    // A cached copy from the base64 era has no `nodeIndex`/`file` at all.
    if (!raw.nodeIndex || !Array.isArray(raw.modes) || typeof raw.vertexCount !== 'number') {
        throw new Error(
            'el mapa modal cacheado no tiene el formato actual: cierra la pestaña y vuelve a abrir la app'
        );
    }

    const base = MODE_MAP_URL.slice(0, MODE_MAP_URL.lastIndexOf('/') + 1);
    const [indexBuffer, ...modeBuffers] = await Promise.all([
        fetchBytes(`${base}${raw.nodeIndex}?${token}`),
        ...raw.modes.map((mode) => fetchBytes(`${base}${mode.file}?${token}`)),
    ]);

    if (indexBuffer.byteLength !== raw.vertexCount * 2) {
        throw new Error(
            `índice modal corrupto: ${indexBuffer.byteLength} B para ${raw.vertexCount} vértices`
        );
    }

    return {
        vertexCount: raw.vertexCount,
        nodeCount: raw.nodeCount ?? 0,
        nodeIndex: new Uint16Array(indexBuffer),
        modes: raw.modes.map((mode, index) => ({
            label: mode.label,
            freqHz: mode.freqHz,
            axis: mode.axis,
            peak: mode.peak,
            values: new Int8Array(modeBuffers[index]),
        })),
    };
}

/**
 * Expands the per-node vectors into one direction per vertex, ready to become a
 * geometry attribute (three handles `normalized: true` for int8).
 */
export function vertexDirections(map: ModeMap, modeIndex: number): Int8Array {
    const mode = map.modes[modeIndex];
    if (!mode) return new Int8Array(0);
    const out = new Int8Array(map.vertexCount * 3);
    for (let vertex = 0; vertex < map.vertexCount; vertex += 1) {
        const node = map.nodeIndex[vertex];
        out[vertex * 3] = mode.values[node * 3];
        out[vertex * 3 + 1] = mode.values[node * 3 + 1];
        out[vertex * 3 + 2] = mode.values[node * 3 + 2];
    }
    return out;
}

/**
 * Turbo-ish ramp: dark blue → cyan → green → yellow → red.
 * Cheap enough to run over 400k vertices once when the map is applied.
 */
export function rampColor(t: number): [number, number, number] {
    const x = Math.min(1, Math.max(0, t));
    const r = Math.min(1, Math.max(0, 1.5 - Math.abs(4 * x - 3)));
    const g = Math.min(1, Math.max(0, 1.5 - Math.abs(4 * x - 2)));
    const b = Math.min(1, Math.max(0, 1.5 - Math.abs(4 * x - 1)));
    return [r, g, b];
}
