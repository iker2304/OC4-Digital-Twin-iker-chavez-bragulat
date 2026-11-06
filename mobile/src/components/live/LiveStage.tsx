/**
 * Live capture screen.
 *
 * One component, two arrangements. `orientation === 'landscape'` turns the page
 * into a cockpit: full-bleed stage, blend slider on a left rail, controls on a
 * collapsible right rail. Portrait keeps the stage on top and puts the controls
 * in a bottom sheet. The layers themselves are identical in both.
 */
import { useCallback, useState } from 'react';
import { ChevronDown, LogOut, SlidersHorizontal, X, Activity } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import type { Detection, LayoutMode } from '../../types';
import { cn } from '../../lib/cn';
import { Chip } from '../ui/primitives';
import { CameraStack } from './CameraStack';
import { setFrameSource } from '../../lib/camera/frameSource';
import { BlendSlider } from './BlendSlider';
import { ControlPanel } from './ControlPanel';
import { OmaModal } from './OmaModal';
import type { ControlPanelProps } from './ControlPanel';

/**
 * One-line answer to "why is the twin not sitting on the detection?".
 *
 * The settings panel carries the full readout, but the question comes up while
 * looking at the camera, so the number that matters has to be on screen without
 * opening anything: how many keypoints actually feed the solver, whether a pose
 * came out of it, and — the subtle one — how old that pose is. A frozen twin is
 * almost always a pose that stopped being refreshed, which is a different
 * problem (and a different fix) from one that never solved.
 */
function PoseStatusChip() {
    const poseEnabled = useAppStore((state) => state.poseEnabled);
    const pose = useAppStore((state) => state.pose);
    const poseUpdatedAt = useAppStore((state) => state.poseUpdatedAt);
    const reacquired = useAppStore((state) => state.poseReacquired);
    const detections = useAppStore((state) => state.detections);
    const minScore = useAppStore((state) => state.keypointMinScore);
    // Subscribed so the chip re-renders (and the age counts up) every frame.
    const inferenceMs = useAppStore((state) => state.metrics.inferenceMs);

    if (!poseEnabled) return <Chip tone="neutral">pnp off</Chip>;

    const best = detections.reduce<Detection | null>((acc, item) => {
        if (!item.keypoints?.length) return acc;
        return !acc || item.score > acc.score ? item : acc;
    }, null);
    const total = best?.keypoints?.length ?? 0;
    const strong = best?.keypoints?.filter((point) => point.score >= minScore).length ?? 0;

    if (pose) {
        const ageMs = poseUpdatedAt ? Date.now() - poseUpdatedAt : 0;
        if (ageMs > 1500) {
            return <Chip tone="warn">pnp: congelada {(ageMs / 1000).toFixed(1)} s</Chip>;
        }
        const [tx, ty, tz] = pose.tvec;
        const distance = Math.hypot(tx, ty, tz);
        // Slow inference is the reason the overlay feels desynchronised, so it is
        // worth saying out loud instead of letting it look like a frozen twin.
        if (inferenceMs > 500) {
            return <Chip tone="warn">pnp ok · {Math.round(inferenceMs)} ms/frame</Chip>;
        }
        return (
            <Chip tone={reacquired ? 'warn' : 'good'}>
                {reacquired ? 'pnp: reenganchando · ' : `pnp ${pose.inliers}/${total} · `}
                {pose.rmsError.toFixed(1)} px · {distance.toFixed(2)} m
            </Chip>
        );
    }

    if (!best) return <Chip tone="warn">pnp: sin detección</Chip>;
    if (strong < 4) return <Chip tone="warn">pnp: kpts {strong}/{total}</Chip>;
    return <Chip tone="warn">pnp: sin solución</Chip>;
}

function TopBar({ onExit, compact }: { onExit: () => void; compact?: boolean }) {
    const modelKind = useAppStore((state) => state.model?.kind ?? null);
    const modelStatus = useAppStore((state) => state.modelStatus);
    const cameraStatus = useAppStore((state) => state.cameraStatus);
    const gyroStatus = useAppStore((state) => state.gyroStatus);
    const telemetryStatus = useAppStore((state) => state.telemetryStatus);
    const twinFallback = useAppStore((state) => state.twinModelFallback);

    return (
        <div
            className={cn(
                'flex items-center gap-2 px-3 py-2',
                compact ? 'absolute inset-x-0 top-0 z-40 bg-gradient-to-b from-slate-950/80 to-transparent' : 'shrink-0'
            )}
        >
            <button
                type="button"
                onClick={onExit}
                aria-label="Salir de la captura"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/5 text-slate-200 transition-colors hover:bg-white/10"
            >
                <LogOut className="h-4 w-4" />
            </button>

            {!compact ? (
                <h1 className="mr-auto truncate text-sm font-semibold text-slate-200">En directo</h1>
            ) : (
                <div className="mr-auto" />
            )}

            <div className="flex flex-wrap items-center justify-end gap-1.5">
                <Chip tone={cameraStatus === 'ready' ? 'good' : cameraStatus === 'error' ? 'bad' : 'warn'}>
                    cámara
                </Chip>
                <Chip tone={modelStatus === 'error' ? 'bad' : modelKind ? 'info' : 'neutral'}>
                    {modelStatus === 'error'
                        ? 'modelo: error'
                        : modelKind
                            ? `onnx · ${modelKind}`
                            : modelStatus === 'loading'
                                ? 'cargando…'
                                : 'sin modelo'}
                </Chip>
                <Chip tone={twinFallback ? 'warn' : 'neutral'}>
                    {twinFallback ? 'gemelo genérico' : 'gemelo glb'}
                </Chip>
                <Chip tone={gyroStatus === 'granted' ? 'good' : 'neutral'}>giro</Chip>
                <PoseStatusChip />
                {telemetryStatus === 'online' ? <Chip tone="good">telemetría</Chip> : null}
            </div>
        </div>
    );
}

export interface LiveStageProps extends ControlPanelProps {
    attachVideo: (element: HTMLVideoElement | null) => void;
    orientation: LayoutMode;
    onExit: () => void;
}

export function LiveStage({ attachVideo, orientation, onExit, ...controlProps }: LiveStageProps) {
    const blend = useAppStore((state) => state.blend);
    const update = useAppStore((state) => state.update);
    const [sheetOpen, setSheetOpen] = useState(false);
    const landscape = orientation === 'landscape';

    // The settings sheet needs "the current frame" for the lighting estimate and
    // has no clean path to the element; register it here, at the one place that
    // already owns it.
    const attachSource = useCallback(
        (element: HTMLVideoElement | null) => {
            setFrameSource(element);
            attachVideo(element);
        },
        [attachVideo]
    );

    const setBlend = (value: number) => update({ blend: value });

    if (landscape) {
        return (
            <div className="fixed inset-0 bg-slate-950 text-slate-100">
                <CameraStack
                    attachVideo={attachSource}
                    lowDetail={sheetOpen}
                    className="absolute inset-0 h-full w-full"
                />

                <TopBar onExit={onExit} compact />

                {/* Left rail: the blend control is the primary interaction, so it gets a
            dedicated full-height rail instead of a thumb-sized widget. The rail
            itself must not swallow clicks — it spans the whole left edge and
            would cover the exit button in the top bar. */}
                <div className="pointer-events-none absolute inset-y-0 left-0 z-30 flex flex-col items-center justify-center gap-2 pl-[max(0.75rem,env(safe-area-inset-left))]">
                    <div className="pointer-events-auto flex max-h-full items-center">
                        <BlendSlider orientation="vertical" value={blend} onChange={setBlend} className="max-h-[70vh]" />
                    </div>
                    <button
                        type="button"
                        onClick={() => update({ omaOpen: true })}
                        aria-label="Abrir modos (OMA)"
                        className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-slate-950/90 transition-colors hover:bg-slate-900/90"
                    >
                        <Activity className="h-5 w-5 text-sky-300" />
                    </button>
                </div>

                <OmaModal />

                {/* Right rail: collapsible controls. */}
                <div className="absolute inset-y-0 right-0 z-40 flex items-start pr-[max(0.75rem,env(safe-area-inset-right))]">
                    {sheetOpen ? (
                        <div className="mt-[max(3.5rem,env(safe-area-inset-top))] flex max-h-[calc(100%-5rem)] w-[19rem] flex-col rounded-2xl border border-white/10 bg-slate-950/95 shadow-2xl">
                            <div className="flex shrink-0 items-center justify-between px-3 py-2">
                                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                                    Ajustes
                                </span>
                                <button
                                    type="button"
                                    aria-label="Cerrar ajustes"
                                    onClick={() => setSheetOpen(false)}
                                    className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white/10"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            </div>
                            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
                                <ControlPanel {...controlProps} />
                            </div>
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setSheetOpen(true)}
                            aria-label="Abrir ajustes"
                            className="mt-[max(3.5rem,env(safe-area-inset-top))] flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-slate-950/90 transition-colors hover:bg-slate-900/90"
                        >
                            <SlidersHorizontal className="h-5 w-5 text-slate-200" />
                        </button>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 flex flex-col bg-slate-950 text-slate-100">
            <div className="pt-[env(safe-area-inset-top)]">
                <TopBar onExit={onExit} />
            </div>

            <div className="relative min-h-0 flex-1">
                <CameraStack attachVideo={attachSource} className="h-full w-full" />
                <div className="absolute inset-x-3 bottom-3 z-40 flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                        <BlendSlider value={blend} onChange={setBlend} />
                    </div>
                    <button
                        type="button"
                        onClick={() => update({ omaOpen: true })}
                        aria-label="Abrir modos (OMA)"
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-slate-950/90 transition-colors hover:bg-slate-900/90"
                    >
                        <Activity className="h-5 w-5 text-sky-300" />
                    </button>
                </div>
                <OmaModal />
            </div>

            <div className="shrink-0 border-t border-white/10 bg-slate-950/95 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
                <button
                    type="button"
                    onClick={() => setSheetOpen((open) => !open)}
                    className="flex min-h-11 w-full items-center justify-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400"
                >
                    {sheetOpen ? 'Ocultar ajustes' : 'Mostrar ajustes'}
                    <ChevronDown className={cn('h-4 w-4 transition-transform', sheetOpen && 'rotate-180')} />
                </button>
                {sheetOpen ? (
                    <div className="max-h-[42vh] overflow-y-auto px-3 pb-3">
                        <ControlPanel {...controlProps} />
                    </div>
                ) : null}
            </div>
        </div>
    );
}
