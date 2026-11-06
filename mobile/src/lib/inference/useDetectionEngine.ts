import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { DetectionEngine } from './engine';
import { benchmarkThreads, saveThreadCount, wasmNote } from './ortAssets';
import { BUNDLED_MODEL_URL } from '../env';
import { labelsFromText } from '../labels';

export interface LoadOptions {
    /** Optional sidecar with one class name per line (`model.names.txt`). */
    labelsFile?: File | null;
    taskOverride?: 'auto' | 'detect' | 'pose';
    preferWebGpu?: boolean;
    /**
     * Fail quietly. Used by the automatic load on startup: if the bundled model is
     * not there, the app must stay usable instead of showing an error banner.
     */
    silent?: boolean;
}

/** A download that stops receiving bytes for this long is treated as dead. */
const LOAD_TIMEOUT_MS = 45000;
/** Session creation on a 38 MB model can legitimately take this long on a phone. */
const SESSION_TIMEOUT_MS = 120000;

/**
 * A model can ship its class names next to it, which is how a custom-trained
 * export avoids the generic `class 0, class 1` labels.
 *
 *   public/models/yolo-pose-s-640.onnx + yolo-pose-s-640.labels.txt
 */
async function fetchSidecarLabels(url: string): Promise<string[] | null> {
    const candidates = [
        url.replace(/\.onnx$/i, '.labels.txt'),
        `${url}.labels.txt`,
        url.replace(/\.onnx$/i, '.names.txt'),
    ];
    for (const candidate of candidates) {
        try {
            const response = await fetch(candidate);
            if (!response.ok) continue;
            // A static server that serves a single-page app answers 200 with the
            // index.html for any unknown path, so a missing sidecar arrives as
            // markup. Without this guard the class names become `<!doctype html>`
            // and the labels show up as HTML source inside every bounding box.
            const contentType = response.headers.get('content-type') ?? '';
            if (/html|xml|json/i.test(contentType)) continue;
            const text = await response.text();
            if (/^\s*</.test(text)) continue;
            const names = labelsFromText(text);
            if (names.length > 0) return names;
        } catch {
            // Missing sidecar is not an error: fall back to COCO/generic labels.
        }
    }
    return null;
}

/**
 * Turns ORT's terse failures into something actionable.
 *
 * `RangeError: out of memory` is by far the most common one on phones and has a
 * specific cause worth naming: the WASM heap could not grow because the previous
 * session had not been reclaimed yet.
 */
function explainLoadFailure(raw: string): string {
    if (/out of memory|RangeError|RuntimeError: memory/i.test(raw)) {
        return (
            'WebAssembly no pudo reservar la memoria que pide el runtime. No es el tamaño del ' +
            'modelo (38 MB es poco): es la reserva de memoria que hace el modo multi-hilo. ' +
            'Ajustes → Modelo ONNX: prueba a desactivar «Preferir WebGPU» y vuelve a cargar. ' +
            `Detalle por intento — ${raw}`
        );
    }
    return raw;
}

/**
 * Owns the lifetime of the ONNX session and mirrors its state into the store so
 * any component can render model status.
 */
export function useDetectionEngine() {
    const [engine, setEngine] = useState<DetectionEngine | null>(null);
    const engineRef = useRef<DetectionEngine | null>(null);
    /** Guards against overlapping loads: two sessions at once is an OOM. */
    const loadingRef = useRef(false);

    const replace = useCallback((next: DetectionEngine | null, name: string | null) => {
        engineRef.current?.dispose();
        engineRef.current = next;
        setEngine(next);
        useAppStore.setState({
            model: next?.info ?? null,
            modelName: name,
            provider: next?.info.provider ?? null,
            modelStatus: next ? 'ready' : 'idle',
            modelError: null,
            modelProgress: null,
            wasmNote: wasmNote(),
            detections: [],
        });
    }, []);

    const load = useCallback(
        async (source: { file?: File; url?: string; name?: string }, options: LoadOptions = {}) => {
            if (loadingRef.current) {
                console.warn('[model] ya hay una carga en curso; se ignora la nueva petición');
                return;
            }
            loadingRef.current = true;

            /**
             * Release the live session *before* allocating the next one.
             *
             * This is the difference between working and `RangeError: out of
             * memory`. A loaded session holds the weights inside the WASM heap
             * plus its own working arena (~40 MB here), and `release()` frees
             * that memory asynchronously. Creating the second session while the
             * first is still resident doubles the footprint and the new
             * `initWasm()` runs out of memory — while a plain page refresh, with
             * a single session, works fine.
             */
            const previous = engineRef.current;
            engineRef.current = null;
            setEngine(null);
            useAppStore.setState({ model: null, provider: null });
            if (previous) {
                await previous.dispose();
                // Release is asynchronous on the WASM side: give the browser a
                // moment to actually reclaim the pages before asking for them
                // again.
                await new Promise((resolve) => setTimeout(resolve, 400));
            }

            try {
                const taskOverride = options.taskOverride ?? useAppStore.getState().taskOverride;
                const preferWebGpu =
                    options.preferWebGpu ?? useAppStore.getState().preferWebGpu;

                useAppStore.setState({
                    modelStatus: 'loading',
                    modelError: null,
                    modelProgress: null,
                    taskOverride,
                    provider: null,
                });

                let customLabels: string[] | null;
                if (options.labelsFile) {
                    customLabels = labelsFromText(await options.labelsFile.text());
                } else if (source.url) {
                    customLabels = await fetchSidecarLabels(source.url);
                } else {
                    customLabels = null;
                }

                try {
                    const config = {
                        name: source.name ?? source.file?.name ?? source.url ?? 'modelo',
                        taskOverride,
                        customLabels,
                        preferWebGpu,
                    };

                    const created = source.file
                        ? await DetectionEngine.fromFile(source.file, config)
                        : await DetectionEngine.fromUrl(source.url ?? BUNDLED_MODEL_URL, config, {
                            // Visible progress: the model is ~38 MB, and a silent
                            // spinner is indistinguishable from a hang.
                            onProgress: ({ loaded, total }) =>
                                useAppStore.setState({ modelProgress: { loaded, total } }),
                            downloadTimeoutMs: LOAD_TIMEOUT_MS,
                            timeoutMs: SESSION_TIMEOUT_MS,
                        });

                    replace(created, config.name);
                    useAppStore.setState({ customLabels });
                } catch (error) {
                    const raw = error instanceof Error ? error.message : String(error);
                    const message =
                        error instanceof Error && error.name === 'TimeoutError'
                            ? `${raw}. El modelo son ~38 MB: si estás en el móvil, revisa la conexión y reintenta.`
                            : explainLoadFailure(raw);

                    /**
                     * Quiet mode is only for "there is nothing to load": the app
                     * must stay usable before `npm run sync:models` has been run.
                     * A runtime that failed to start is a real failure and has to
                     * be shown, otherwise the only symptom is a `sin modelo` chip
                     * with no explanation of why the 38 MB download was useless.
                     */
                    const nothingToLoad = /HTTP 40[34]/.test(raw);
                    if (options.silent && nothingToLoad) {
                        console.warn(`[model] no hay modelo incluido (${message})`);
                        useAppStore.setState({
                            modelStatus: 'idle',
                            modelError: null,
                            modelProgress: null,
                            model: null,
                            provider: null,
                        });
                        return;
                    }
                    useAppStore.setState({
                        modelStatus: 'error',
                        modelError: message,
                        modelProgress: null,
                        model: null,
                        provider: null,
                    });
                }
            } finally {
                loadingRef.current = false;
            }
        },
        [replace]
    );

    const loadFromFile = useCallback(
        (file: File, labelsFile?: File | null) => load({ file, name: file.name }, { labelsFile }),
        [load]
    );

    const loadFromUrl = useCallback(
        (url: string, options: LoadOptions = {}) =>
            load({ url, name: url.split('/').pop() ?? url }, options),
        [load]
    );

    const unload = useCallback(() => replace(null, null), [replace]);

    /**
     * Runs the per-device thread benchmark and applies the winner.
     *
     * Behind a button on purpose: it costs 30-60 s (each configuration loads the
     * model again) and it is only meaningful with the phone cool. The result is
     * stored, so it is a calibration, not something that runs every launch.
     */
    const benchmark = useCallback(async () => {
        if (loadingRef.current) return;
        useAppStore.setState({ benchRunning: true, benchProgress: 'preparando…', benchResult: null });
        try {
            const results = await benchmarkThreads({
                modelUrl: BUNDLED_MODEL_URL,
                onProgress: (message) => useAppStore.setState({ benchProgress: message }),
            });
            const summary = results
                .map((entry) => `${entry.threads}: ${entry.ms === null ? '—' : Math.round(entry.ms)} ms`)
                .join(' · ');
            const usable = results.filter((entry) => entry.ms !== null) as Array<{
                threads: number;
                ms: number;
            }>;
            if (usable.length === 0) {
                useAppStore.setState({ benchResult: `Sin medición válida. ${summary}` });
                return;
            }
            const best = usable.reduce((a, b) => (b.ms < a.ms ? b : a));
            saveThreadCount(best.threads);
            useAppStore.setState({
                // `env.wasm.numThreads` is read when ORT instantiates its module,
                // and the worker that runs the session is reused, so the winning
                // count only becomes real on the next page load. Say it instead of
                // pretending the session was re-created with it.
                benchResult: `${summary} → usando ${best.threads} hilos (recarga la página para aplicarlo)`,
            });
            // Re-create the session so the measured setting is in effect now.
            await load({
                url: BUNDLED_MODEL_URL,
                name: BUNDLED_MODEL_URL.split('/').pop() ?? 'modelo',
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            useAppStore.setState({ benchResult: `No se pudo medir: ${message}` });
        } finally {
            useAppStore.setState({ benchRunning: false, benchProgress: null });
        }
    }, [load]);

    useEffect(
        () => () => {
            void engineRef.current?.dispose();
        },
        []
    );

    return { engine, loadFromFile, loadFromUrl, unload, benchmark, bundledModelUrl: BUNDLED_MODEL_URL };
}
