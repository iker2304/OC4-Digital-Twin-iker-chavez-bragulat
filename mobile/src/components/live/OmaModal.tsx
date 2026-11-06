/**
 * Modal analysis in a sheet: the live spectrum of what the rigid pose cannot
 * explain, and the gain that turns that motion into visible movement of the twin.
 *
 * The chart is drawn on a canvas at ~10 Hz from `modalTracker.spectrum()`. It is
 * deliberately *not* a React re-render per sample: 96 samples × 22 series is a
 * cheap FFT, but re-rendering a chart of 200 points through the DOM every frame
 * is not.
 */
import { useEffect, useRef, useState } from 'react';
import { Activity, X } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { Button, Chip, SliderRow } from '../ui/primitives';
import { modalTracker } from '../../lib/oma/modalTracker';
import type { OmaSnapshot } from '../../lib/oma/modalTracker';
import { NATURAL_MODES, observableModes } from '../../lib/oma/naturalModes';
import { loadModeMap } from '../../lib/oma/modeMap';

const WINDOW_MS = 100;
/** Frequencies above this are not resolvable at the detector's frame rate. */
const MAX_HZ = 3;

export function OmaModal() {
    const open = useAppStore((state) => state.omaOpen);
    const gain = useAppStore((state) => state.omaGain);
    const colorMode = useAppStore((state) => state.omaColorMode);
    const modeMap = useAppStore((state) => state.omaModeMap);
    const blend = useAppStore((state) => state.omaBlend);
    const omaError = useAppStore((state) => state.omaError);
    const [mapBusy, setMapBusy] = useState(false);
    const close = () => useAppStore.setState({ omaOpen: false });
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [snapshot, setSnapshot] = useState<OmaSnapshot | null>(null);
    const [samples, setSamples] = useState(0);

    useEffect(() => {
        if (!open) return;
        const timer = setInterval(() => {
            const next = modalTracker.spectrum();
            setSnapshot(next);
            setSamples(modalTracker.samples);
        }, WINDOW_MS);
        return () => clearInterval(timer);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ratio = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
            canvas.width = width * ratio;
            canvas.height = height * ratio;
        }
        const context = canvas.getContext('2d');
        if (!context) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);

        // Grid: 0.5 Hz steps, the range where a floating platform actually moves.
        context.strokeStyle = 'rgba(148, 163, 184, 0.18)';
        context.fillStyle = 'rgba(148, 163, 184, 0.75)';
        context.font = '10px ui-monospace, monospace';
        context.lineWidth = 1;
        for (let hz = 0; hz <= MAX_HZ; hz += 0.5) {
            const x = (hz / MAX_HZ) * width;
            context.beginPath();
            context.moveTo(x, 0);
            context.lineTo(x, height);
            context.stroke();
            if (hz > 0) context.fillText(`${hz}`, x + 3, height - 4);
        }

        if (!snapshot || snapshot.magnitudes.length < 2) return;
        const peak = Math.max(...snapshot.magnitudes.slice(1), 1e-9);
        context.beginPath();
        context.strokeStyle = '#38bdf8';
        context.lineWidth = 1.5;
        snapshot.magnitudes.forEach((value, index) => {
            const hz = snapshot.frequencies[index];
            if (hz > MAX_HZ) return;
            const x = (hz / MAX_HZ) * width;
            const y = height - Math.min(1, value / peak) * (height - 14);
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
        });
        context.stroke();

        for (const candidate of snapshot.peaks) {
            if (candidate.prominence < 1.6) continue;
            const x = (candidate.freqHz / MAX_HZ) * width;
            context.strokeStyle = 'rgba(251, 191, 36, 0.8)';
            context.setLineDash([3, 3]);
            context.beginPath();
            context.moveTo(x, 0);
            context.lineTo(x, height);
            context.stroke();
            context.setLineDash([]);
        }

        /**
         * Theoretical modes on top of the measurement: this is the whole point of
         * the chart. If a measured peak sits on a green line, the platform really
         * is moving in that mode; if the line has nothing under it, that mode is
         * not being excited (or the frame rate cannot see it).
         */
        for (const mode of NATURAL_MODES) {
            if (mode.freqHz > MAX_HZ) continue;
            const x = (mode.freqHz / MAX_HZ) * width;
            context.strokeStyle = 'rgba(52, 211, 153, 0.55)';
            context.lineWidth = 1;
            context.beginPath();
            context.moveTo(x, 0);
            context.lineTo(x, height);
            context.stroke();
        }
    }, [snapshot, open]);

    if (!open) return null;

    const strongest = snapshot?.peaks[0] ?? null;

    return (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 p-3 sm:items-center">
            <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-slate-950/95 p-4 shadow-2xl">
                <div className="mb-2 flex items-center justify-between">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                        <Activity className="h-4 w-4 text-sky-400" /> Modos (OMA)
                    </h2>
                    <button
                        type="button"
                        aria-label="Cerrar modos"
                        onClick={close}
                        className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white/10"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <p className="mb-2 text-[11px] text-slate-400">
                    Espectro del residuo de reproyección de los 11 keypoints: la parte que la pose rígida no
                    explica. En un sólido rígido perfecto esto es ruido plano, y se ve como tal.
                </p>

                <canvas ref={canvasRef} className="h-28 w-full rounded-lg bg-slate-900/60" />

                <div className="mt-2 flex flex-wrap gap-1.5">
                    {snapshot ? (
                        <>
                            <Chip tone="neutral">{snapshot.samples} muestras</Chip>
                            <Chip tone="neutral">{snapshot.sampleRate.toFixed(1)} Hz</Chip>
                            {snapshot.peaks.slice(0, 3).map((peak) => (
                                <Chip
                                    key={peak.freqHz.toFixed(3)}
                                    tone={peak.prominence > 2 ? 'info' : 'neutral'}
                                >
                                    {peak.freqHz.toFixed(2)} Hz · {peak.magnitude.toFixed(2)} px
                                </Chip>
                            ))}
                        </>
                    ) : (
                        <Chip tone="warn">
                            {samples < 48
                                ? `recopilando… ${samples}/48 muestras`
                                : 'necesita unas cuantas detecciones seguidas'}
                        </Chip>
                    )}
                </div>

                {strongest && strongest.prominence < 1.6 ? (
                    <p className="mt-2 text-[11px] text-slate-500">
                        Ningún pico destaca sobre el ruido: no hay deformación medible (lo esperable en un
                        cuerpo rígido).
                    </p>
                ) : null}

                {/* Modos teóricos contra lo medido: la comparación es el dato. */}
                {snapshot ? (
                    <div className="mt-3 space-y-1">
                        <p className="text-[11px] text-slate-500">
                            Verde = modo teórico del análisis modal. Amarillo = pico medido.
                        </p>
                        {observableModes(snapshot.sampleRate).map((mode) => {
                            const nearest = snapshot.peaks.reduce<{ freqHz: number; delta: number } | null>(
                                (best, peak) => {
                                    const delta = Math.abs(peak.freqHz - mode.freqHz);
                                    return !best || delta < best.delta ? { freqHz: peak.freqHz, delta } : best;
                                },
                                null
                            );
                            const matches = nearest && nearest.delta < 0.15;
                            return (
                                <div key={mode.id} className="flex items-center justify-between gap-2 text-[11px]">
                                    <span className="text-slate-300">
                                        {mode.label} · {mode.freqHz.toFixed(2)} Hz
                                    </span>
                                    <span className={matches ? 'text-emerald-300' : 'text-slate-500'}>
                                        {matches
                                            ? `pico a ${nearest?.freqHz.toFixed(2)} Hz (Δ${nearest?.delta.toFixed(2)})`
                                            : 'sin pico'}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                ) : null}

                <div className="mt-3">
                    <SliderRow
                        label="Amplificación del movimiento"
                        value={gain}
                        min={1}
                        max={200}
                        step={1}
                        onChange={(value) => useAppStore.setState({ omaGain: value })}
                        format={(value) => `×${value.toFixed(0)}`}
                        hint="Cuánto se exagera el residuo medido al mover el gemelo."
                    />
                </div>

                <div className="mt-2 flex gap-2">
                    <Button
                        variant={colorMode === null ? 'outline' : 'primary'}
                        full
                        disabled={mapBusy}
                        onClick={() => {
                            if (colorMode !== null) {
                                useAppStore.setState({ omaColorMode: null });
                                return;
                            }
                            // Start: load the contour once, then pick the mode that
                            // matches the strongest measured peak.
                            setMapBusy(true);
                            void (async () => {
                                try {
                                    const map = modeMap ?? (await loadModeMap());
                                    const peaks = snapshot?.peaks ?? [];
                                    const target = peaks[0]?.freqHz ?? null;
                                    let index = 0;
                                    if (target !== null) {
                                        let best = Infinity;
                                        map.modes.forEach((mode, position) => {
                                            const delta = Math.abs(mode.freqHz - target);
                                            if (delta < best) {
                                                best = delta;
                                                index = position;
                                            }
                                        });
                                    }
                                    useAppStore.setState({ omaModeMap: map, omaColorMode: index });
                                } catch (cause) {
                                    useAppStore.setState({
                                        omaError: cause instanceof Error ? cause.message : String(cause),
                                    });
                                } finally {
                                    setMapBusy(false);
                                }
                            })();
                        }}
                    >
                        {mapBusy
                            ? 'Cargando el mapa…'
                            : colorMode === null
                                ? 'Activar mapa de colores'
                                : 'Desactivar mapa de colores'}
                    </Button>
                    <Button variant="ghost" full onClick={close}>
                        Cerrar
                    </Button>
                </div>

                {colorMode !== null && blend && blend.length > 0 ? (
                    <div className="mt-2 space-y-1">
                        <p className="text-[11px] text-emerald-300/90">
                            Contorno animado con {blend.length} modos superpuestos:
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                            {blend.map((mode) => (
                                <Chip key={mode.label} tone="good">
                                    {mode.label} · {mode.freqHz.toFixed(2)} Hz
                                </Chip>
                            ))}
                        </div>
                    </div>
                ) : null}

                {omaError ? <p className="mt-2 text-[11px] text-rose-300">{omaError}</p> : null}
            </div>
        </div>
    );
}
