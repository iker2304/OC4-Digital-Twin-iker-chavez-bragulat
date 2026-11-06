/**
 * «Iluminación» section of the settings sheet.
 *
 * Two backends, one button:
 *
 * - **Rápido (por defecto, sin modelo)**: `estimateSunDirection` reads the
 *   brightest blob of the sky in the current frame. A millisecond, nothing to
 *   download.
 * - **Modelo**: if the build ships `models/light.onnx`, it is used instead — and
 *   it is loaded *lazily*: nothing is fetched or instantiated until the button
 *   is pressed, with a real progress bar.
 *
 * Whatever comes out can be nudged with the two sliders, because a coarse
 * direction the user can correct beats an accurate one they cannot.
 */
import { useEffect, useState } from 'react';
import { Sun } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { Button, Chip, SliderRow } from '../ui/primitives';
import { getFrameSource } from '../../lib/camera/frameSource';
import { estimateLight, hasLightModel, loadLightSession } from '../../lib/light/lightModel';
import { estimateSunDirection } from '../../lib/light/sunDirection';
import { lightVectorModelSpace } from '../../lib/light/lightDirection';
import { intrinsicsFromFov } from '../../lib/pose/solvePnP';

/** Longest side of the frame used for the estimate: enough, and cheap. */
const ANALYSIS_SIZE = 640;

function framePixels(video: HTMLVideoElement) {
    const scale = Math.min(1, ANALYSIS_SIZE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('no se pudo preparar el frame');
    context.drawImage(video, 0, 0, width, height);
    return { data: context.getImageData(0, 0, width, height).data, width, height, scale };
}

export function LightSection() {
    const available = useAppStore((state) => state.lightAvailable);
    const progress = useAppStore((state) => state.lightProgress);
    const result = useAppStore((state) => state.lightResult);
    const confidence = useAppStore((state) => state.lightConfidence);
    const error = useAppStore((state) => state.lightError);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void hasLightModel().then((present) => {
            if (!cancelled) useAppStore.setState({ lightAvailable: present });
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const apply = (azimuthDeg: number, elevationDeg: number) => {
        const pose = useAppStore.getState().pose;
        useAppStore.setState({ lightVector: lightVectorModelSpace(azimuthDeg, elevationDeg, pose) });
    };

    const run = async () => {
        const video = getFrameSource();
        if (!video) {
            useAppStore.setState({ lightError: 'Activa la cámara: sin frame no hay nada que medir.' });
            return;
        }
        setBusy(true);
        useAppStore.setState({ lightError: null, lightProgress: 0 });
        try {
            if (available) {
                await loadLightSession((update) => {
                    const ratio = update.total ? update.loaded / update.total : 0;
                    useAppStore.setState({ lightProgress: ratio * 100 });
                });
                const estimate = await estimateLight(video);
                useAppStore.setState({ lightResult: estimate, lightConfidence: null });
                apply(estimate.azimuthDeg, estimate.elevationDeg ?? 45);
            } else {
                const frame = framePixels(video);
                const intrinsics = intrinsicsFromFov(
                    video.videoWidth,
                    video.videoHeight,
                    useAppStore.getState().poseHfovDeg
                );
                const scaled = {
                    fx: intrinsics.fx * frame.scale,
                    fy: intrinsics.fy * frame.scale,
                    cx: intrinsics.cx * frame.scale,
                    cy: intrinsics.cy * frame.scale,
                };
                const started = performance.now();
                const estimate = estimateSunDirection(
                    frame.data,
                    frame.width,
                    frame.height,
                    scaled,
                    useAppStore.getState().pose
                );
                if (!estimate) throw new Error('no se ha encontrado ninguna zona clara en el frame');
                const ms = performance.now() - started;
                useAppStore.setState({
                    lightResult: {
                        azimuthDeg: estimate.azimuthDeg,
                        elevationDeg: estimate.elevationDeg,
                        intensity: null,
                        ms,
                        provider: estimate.source === 'sky' ? 'cielo' : 'brillo',
                    },
                    lightConfidence: estimate.confidence,
                });
                apply(estimate.azimuthDeg, estimate.elevationDeg);
            }
        } catch (cause) {
            useAppStore.setState({
                lightError: cause instanceof Error ? cause.message : String(cause),
            });
        } finally {
            useAppStore.setState({ lightProgress: -1 });
            setBusy(false);
        }
    };

    const nudge = (patch: { azimuthDeg?: number; elevationDeg?: number }) => {
        const current = useAppStore.getState().lightResult;
        if (!current) return;
        const next = {
            ...current,
            azimuthDeg: patch.azimuthDeg ?? current.azimuthDeg,
            elevationDeg: patch.elevationDeg ?? current.elevationDeg,
        };
        useAppStore.setState({ lightResult: next });
        apply(next.azimuthDeg, next.elevationDeg ?? 45);
    };

    return (
        <section className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                <Sun className="h-4 w-4" /> Iluminación
            </h3>
            <p className="px-1 text-[11px] text-slate-400">
                Mide de dónde viene la luz en el frame actual y la aplica al gemelo. Sin modelo no hay nada que
                descargar: se lee el punto más brillante del cielo.
            </p>

            <Button
                variant="outline"
                full
                icon={<Sun className="h-4 w-4" />}
                disabled={busy}
                onClick={() => void run()}
            >
                {busy ? 'Midiendo…' : 'Detectar la luz de la escena'}
            </Button>

            {progress >= 0 ? (
                <div className="px-1">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                        <div
                            className="h-full rounded-full bg-sky-400 transition-[width] duration-200"
                            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                        />
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">{progress.toFixed(0)} %</p>
                </div>
            ) : null}

            {result ? (
                <>
                    <div className="flex flex-wrap gap-1.5">
                        <Chip tone="info">azimut {result.azimuthDeg.toFixed(0)}°</Chip>
                        {result.elevationDeg !== null ? (
                            <Chip tone="info">elevación {result.elevationDeg.toFixed(0)}°</Chip>
                        ) : null}
                        {confidence !== null ? (
                            <Chip tone={confidence > 0.45 ? 'good' : 'warn'}>
                                confianza {(confidence * 100).toFixed(0)} %
                            </Chip>
                        ) : null}
                        <Chip tone="neutral">
                            {result.provider} · {result.ms.toFixed(1)} ms
                        </Chip>
                    </div>
                    <SliderRow
                        label="Azimut (ajuste fino)"
                        value={result.azimuthDeg}
                        min={-180}
                        max={180}
                        step={1}
                        onChange={(value) => nudge({ azimuthDeg: value })}
                        format={(value) => `${value.toFixed(0)}°`}
                        hint="0° es de frente a la cámara. Corrige lo que la estimación no acierte."
                    />
                    {result.elevationDeg !== null ? (
                        <SliderRow
                            label="Altura del sol"
                            value={result.elevationDeg}
                            min={0}
                            max={90}
                            step={1}
                            onChange={(value) => nudge({ elevationDeg: value })}
                            format={(value) => `${value.toFixed(0)}°`}
                        />
                    ) : null}
                    <Button
                        variant="ghost"
                        full
                        onClick={() =>
                            useAppStore.setState({
                                lightResult: null,
                                lightVector: null,
                                lightConfidence: null,
                                lightError: null,
                            })
                        }
                    >
                        Quitar la luz medida
                    </Button>
                </>
            ) : null}

            {error ? <p className="px-1 text-[11px] text-rose-300">{error}</p> : null}
        </section>
    );
}
