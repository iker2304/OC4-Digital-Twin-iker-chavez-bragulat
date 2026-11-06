/**
 * Small async helpers for the model download.
 *
 * The model is ~38 MB. A plain `await fetch(...).arrayBuffer()` gives no
 * feedback and — worse — never settles if the connection stalls, which shows up
 * as an app stuck on "Cargando modelo…" with nothing to act on. These two
 * helpers turn that into visible progress and a bounded wait.
 */

export interface DownloadProgress {
    loaded: number;
    /** `null` when the server does not send Content-Length. */
    total: number | null;
}

export class TimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TimeoutError';
    }
}

/** Rejects when `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

/**
 * Downloads a URL reporting progress, aborting only when the transfer *stalls*.
 *
 * A total-duration timeout looks equivalent and is not: through a tunnel 38 MB
 * can legitimately take minutes, and cutting it off in the middle turns a slow
 * but working download into an error. What actually needs bounding is silence —
 * no bytes for `stallTimeoutMs` — with a generous overall ceiling as a backstop.
 *
 * Falls back to `arrayBuffer()` when the body is not streamable.
 */
export async function fetchWithProgress(
    url: string,
    options: {
        onProgress?: (progress: DownloadProgress) => void;
        /** No bytes received for this long → give up. */
        stallTimeoutMs?: number;
        /** Absolute ceiling, in case the link is slow but never silent. */
        timeoutMs?: number;
        signal?: AbortSignal;
    } = {}
): Promise<Uint8Array> {
    const { onProgress, stallTimeoutMs = 30000, timeoutMs = 900000 } = options;
    const controller = new AbortController();
    let reason: 'stall' | 'total' | null = null;

    let stallTimer = setTimeout(() => {
        reason = 'stall';
        controller.abort();
    }, stallTimeoutMs);
    const totalTimer = setTimeout(() => {
        reason = 'total';
        controller.abort();
    }, timeoutMs);
    const touch = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
            reason = 'stall';
            controller.abort();
        }, stallTimeoutMs);
    };

    if (options.signal) {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`No se pudo descargar el modelo (HTTP ${response.status} ${response.statusText})`);
        }

        const header = response.headers.get('content-length');
        const total = header ? Number(header) : null;
        if (!response.body) {
            const buffer = new Uint8Array(await response.arrayBuffer());
            onProgress?.({ loaded: buffer.byteLength, total: total ?? buffer.byteLength });
            return buffer;
        }

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        for (; ;) {
            const { done, value } = await reader.read();
            if (done) break;
            touch();
            if (!value) continue;
            chunks.push(value);
            loaded += value.byteLength;
            onProgress?.({ loaded, total });
        }

        const out = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return out;
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError' && reason === 'stall') {
            throw new TimeoutError(
                `La descarga se quedó parada más de ${Math.round(stallTimeoutMs / 1000)} s sin recibir datos`
            );
        }
        if (error instanceof Error && error.name === 'AbortError' && reason === 'total') {
            throw new TimeoutError(
                `La descarga no terminó en ${Math.round(timeoutMs / 60000)} min`
            );
        }
        throw error;
    } finally {
        clearTimeout(stallTimer);
        clearTimeout(totalTimer);
    }
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Persistent store for the model bytes.
 *
 * The HTTP cache alone is not dependable for a 38 MB asset — browsers evict it,
 * and a partially downloaded (aborted) response is not reusable at all — so
 * every reload paid the full transfer again. That matters twice over here: it is
 * 38 MB through a tunnel, and re-downloading it right before creating a WASM
 * session is exactly the moment when a phone has the least memory to spare.
 *
 * One fetch per device, then instant starts.
 */
const MODEL_CACHE = 'oc4-models-v1';

export async function readModelCache(url: string): Promise<Uint8Array | null> {
    if (typeof caches === 'undefined') return null;
    try {
        const cache = await caches.open(MODEL_CACHE);
        const hit = await cache.match(url);
        if (!hit) return null;
        return new Uint8Array(await hit.arrayBuffer());
    } catch {
        return null;
    }
}

/** Best-effort: quota errors must never break a working session. */
export async function writeModelCache(url: string, bytes: Uint8Array): Promise<boolean> {
    if (typeof caches === 'undefined') return false;
    try {
        const cache = await caches.open(MODEL_CACHE);
        // A `Blob` is a valid `BodyInit` and, unlike a raw `Uint8Array`
        // (`Uint8Array<ArrayBufferLike>`), does not fight the DOM typings.
        await cache.put(
            url,
            new Response(new Blob([bytes as BlobPart]), {
                headers: { 'Content-Type': 'application/octet-stream' },
            })
        );
        return true;
    } catch (error) {
        console.warn('[model] no se pudo guardar el modelo en el dispositivo:', error);
        return false;
    }
}

export async function clearModelCache(): Promise<boolean> {
    if (typeof caches === 'undefined') return false;
    try {
        return await caches.delete(MODEL_CACHE);
    } catch {
        return false;
    }
}
