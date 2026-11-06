/**
 * ONNX model picker.
 *
 * Inference happens entirely in the browser, so "loading a model" just means
 * reading a `.onnx` file the user already has on the phone (or fetching a URL).
 * The optional sidecar lets a custom-trained model bring its own class names.
 */
import { useEffect, useRef, useState } from 'react';
import { FileUp, Link2, Loader2, ShieldCheck, SlidersHorizontal, Sparkles, Tags, Trash2, X } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { Button, Chip } from './ui/primitives';
import { ModelSpecPicker } from './ModelSpecPicker';
import { formatBytes, clearModelCache } from '../lib/async';
import { clearSavedOrtMode } from '../lib/inference/ortAssets';
import { API_BASE, withBase } from '../lib/env';
import { filterBenchmarkModels, parseModelFile } from '../lib/modelNames';
import { cn } from '../lib/cn';

/** What `/api/models` advertises: the `.onnx` files this deployment serves. */
interface ServerModel {
    file: string;
    url: string;
    bytes: number;
}

export interface ModelPickerProps {
    onFile: (file: File, labelsFile?: File | null) => void | Promise<void>;
    onUrl: (url: string) => void | Promise<void>;
    /** Optional model shipped inside `public/models` and advertised in `.env`. */
    bundledModelUrl?: string;
    compact?: boolean;
    className?: string;
}

export function ModelPicker({
    onFile,
    onUrl,
    bundledModelUrl,
    compact,
    className,
}: ModelPickerProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const labelsRef = useRef<HTMLInputElement>(null);
    const [dragging, setDragging] = useState(false);
    const [pendingLabels, setPendingLabels] = useState<File | null>(null);
    const [url, setUrl] = useState('');
    /** Files the server serves, for the advanced picker; empty when offline. */
    const [serverModels, setServerModels] = useState<ServerModel[]>([]);
    const [advanced, setAdvanced] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch(`${API_BASE}/models`)
            .then((response) => (response.ok ? response.json() : null))
            .then((payload: { models?: ServerModel[] } | null) => {
                if (!cancelled && payload?.models) {
                    setServerModels(filterBenchmarkModels(payload.models));
                }
            })
            .catch(() => {
                // Static hosting with no API: the rest of the picker still works.
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const status = useAppStore((state) => state.modelStatus);
    const error = useAppStore((state) => state.modelError);
    const info = useAppStore((state) => state.model);
    const modelName = useAppStore((state) => state.modelName);
    const fallbackNote = useAppStore((state) => state.wasmNote);
    const progress = useAppStore((state) => state.modelProgress);

    const busy = status === 'loading';
    const downloading = Boolean(progress && (progress.total === null || progress.loaded < progress.total));
    const percent =
        progress && progress.total && progress.total > 0
            ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
            : null;
    const phase = !busy
        ? null
        : downloading
            ? `Descargando modelo… ${percent !== null ? `${percent}%` : ''}`
            : 'Inicializando el modelo… (en el móvil puede tardar unos segundos)';

    const pick = async (file: File | undefined | null) => {
        if (!file) return;
        await onFile(file, pendingLabels);
        setPendingLabels(null);
    };

    /**
     * Deployed models that can be picked by architecture / size / quantisation.
     *
     * A URL, not a `File`: these live on the server that served this page, so the
     * same code path as a pasted link applies, including the fingerprint check.
     */
    const specChoices = serverModels.flatMap((entry) => {
        const spec = parseModelFile(entry.file);
        if (!spec) return [];
        return [{ file: entry.file, spec, value: withBase(entry.url), detail: formatBytes(entry.bytes) }];
    });

    return (
        <div className={cn('space-y-3', className)}>
            <div
                onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    void pick(event.dataTransfer.files?.[0]);
                }}
                className={cn(
                    'rounded-2xl border-2 border-dashed p-4 text-center transition-colors',
                    dragging ? 'border-sky-400 bg-sky-500/10' : 'border-white/15 bg-white/[0.03]',
                    compact && 'p-3'
                )}
            >
                <input
                    ref={inputRef}
                    type="file"
                    accept=".onnx,application/octet-stream"
                    className="hidden"
                    onChange={(event) => {
                        void pick(event.target.files?.[0]);
                        event.target.value = '';
                    }}
                />
                <input
                    ref={labelsRef}
                    type="file"
                    accept=".txt,.names,.labels"
                    className="hidden"
                    onChange={(event) => setPendingLabels(event.target.files?.[0] ?? null)}
                />

                <FileUp className={cn('mx-auto text-sky-400', compact ? 'h-5 w-5' : 'h-7 w-7')} />
                <p className="mt-2 text-sm font-medium text-slate-200">
                    {phase ?? 'Arrastra tu .onnx aquí'}
                </p>
                {busy && progress ? (
                    <div className="mx-auto mt-2 w-full max-w-xs">
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                            <div
                                className={cn(
                                    'h-full rounded-full bg-sky-400 transition-[width] duration-200',
                                    percent === null && 'animate-pulse'
                                )}
                                style={{ width: `${percent ?? 100}%` }}
                            />
                        </div>
                        <p className="mt-1 font-mono text-[11px] text-slate-500">
                            {formatBytes(progress.loaded)}
                            {progress.total ? ` / ${formatBytes(progress.total)}` : ''}
                        </p>
                    </div>
                ) : null}
                {!busy ? (
                    <p className="mt-1 text-xs text-slate-500">
                        YOLOv8/v11 detección o pose. Se ejecuta en el dispositivo: nada sale del móvil.
                    </p>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                    <Button
                        variant="primary"
                        disabled={busy}
                        icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
                        onClick={() => inputRef.current?.click()}
                    >
                        Elegir archivo
                    </Button>
                    <Button
                        variant="outline"
                        disabled={busy}
                        icon={<Tags className="h-4 w-4" />}
                        onClick={() => labelsRef.current?.click()}
                    >
                        {pendingLabels ? pendingLabels.name.slice(0, 14) : 'Etiquetas'}
                    </Button>
                    {pendingLabels ? (
                        <Button variant="ghost" icon={<X className="h-4 w-4" />} onClick={() => setPendingLabels(null)}>
                            Quitar
                        </Button>
                    ) : null}
                </div>

                {bundledModelUrl ? (
                    <Button
                        variant="ghost"
                        className="mt-2"
                        disabled={busy}
                        icon={<Sparkles className="h-4 w-4" />}
                        onClick={() => void onUrl(bundledModelUrl)}
                    >
                        Recargar el modelo incluido
                    </Button>
                ) : null}
                <Button
                    variant="ghost"
                    className="mt-1"
                    disabled={busy}
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() =>
                        void clearModelCache()
                            .then(() => clearSavedOrtMode())
                            .then(() => onUrl(bundledModelUrl ?? ''))
                    }
                >
                    Borrar el modelo guardado y recargar
                </Button>
            </div>

            {specChoices.length > 0 ? (
                <div className="space-y-2">
                    <button
                        type="button"
                        onClick={() => setAdvanced((current) => !current)}
                        aria-pressed={advanced}
                        className={cn(
                            'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border px-4 text-sm transition-colors',
                            advanced
                                ? 'border-sky-400/60 bg-sky-500/15 text-sky-100'
                                : 'border-white/15 text-slate-100 hover:bg-white/5 active:bg-white/10'
                        )}
                    >
                        <SlidersHorizontal className="h-4 w-4" />
                        {advanced ? 'Ocultar avanzado' : 'Avanzado: arquitectura, píxeles y cuantización'}
                    </button>
                    {advanced ? (
                        <ModelSpecPicker
                            choices={specChoices}
                            currentFile={modelName ?? null}
                            busy={busy}
                            onPick={(modelUrl) => void onUrl(modelUrl)}
                            hint="Modelos que sirve este despliegue. Cada combinación es un modelo distinto: cambia el plano de referencia de los tests."
                        />
                    ) : null}
                </div>
            ) : null}

            <div className="flex gap-2">
                <div className="relative flex-1">
                    <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />                    <input
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                        placeholder="https://…/modelo.onnx"
                        inputMode="url"
                        className="h-11 w-full rounded-xl border border-white/10 bg-white/5 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
                    />
                </div>
                <Button
                    variant="outline"
                    disabled={busy || url.trim().length === 0}
                    onClick={() => void onUrl(url.trim())}
                >
                    Cargar
                </Button>
            </div>

            {status === 'ready' && info ? (
                <div className="space-y-2 rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-emerald-200">
                        <ShieldCheck className="h-4 w-4" />
                        {modelName}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Chip tone="info">{info.kind === 'pose' ? `pose · ${info.numKeypoints} kpts` : `detección · ${info.numClasses || '?'} clases`}</Chip>
                        <Chip>{info.inputSize}×{info.inputSize}</Chip>
                        <Chip tone={info.provider === 'webgpu' ? 'good' : 'neutral'}>{info.provider}</Chip>
                        <Chip>{info.inputShape.join('×')}</Chip>
                    </div>
                    {fallbackNote ? <p className="text-[11px] text-emerald-200/70">{fallbackNote}</p> : null}
                </div>
            ) : null}

            {status === 'error' ? (
                <div className="space-y-2 rounded-xl border border-rose-400/25 bg-rose-500/10 p-3 text-xs text-rose-200">
                    <p className="font-semibold">No se pudo cargar el modelo</p>
                    <p className="mt-1 max-h-56 select-text overflow-y-auto whitespace-pre-wrap break-words opacity-90">
                        {error}
                    </p>
                    {bundledModelUrl ? (
                        <Button
                            variant="outline"
                            full
                            icon={<Sparkles className="h-4 w-4" />}
                            onClick={() => void onUrl(bundledModelUrl)}
                        >
                            Reintentar con el modelo incluido
                        </Button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
