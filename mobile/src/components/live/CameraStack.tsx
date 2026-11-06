/**
 * The z-stack: camera video at the bottom, WebGL twin above it, 2D detection
 * overlay on top. Only the top two layers are interactive-free (`pointer-events:
 * none`) so the video area never steals taps from the controls.
 *
 * The bottom layer is either the live `<video>` or — with `syncFrame`, the
 * default — the canvas holding the exact frame that was inferred, so the
 * overlay always draws on the image its detections came from.
 */
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { AlertTriangle, Loader2, VideoOff } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { cn } from '../../lib/cn';
import { syncedFrameCanvas } from '../../lib/camera/syncedFrame';
import { TwinLayer } from '../overlay/TwinLayer';
import { DetectionLayer } from '../overlay/DetectionLayer';
import { CameraAccessNotice } from '../ui/CameraAccessNotice';

export function CameraStack({
    attachVideo,
    className,
    lowDetail = false,
}: {
    attachVideo: (element: HTMLVideoElement | null) => void;
    className?: string;
    lowDetail?: boolean;
}) {
    const blend = useAppStore((state) => state.blend);
    const showTwin = useAppStore((state) => state.showTwin);
    const twinOpacity = useAppStore((state) => state.twinOpacity);
    const mirrored = useAppStore((state) => state.mirrored);
    const poseEnabled = useAppStore((state) => state.poseEnabled);
    const cameraStatus = useAppStore((state) => state.cameraStatus);
    const cameraError = useAppStore((state) => state.cameraError);
    const modelStatus = useAppStore((state) => state.modelStatus);
    const modelError = useAppStore((state) => state.modelError);
    const twinModelReady = useAppStore((state) => state.twinModelReady);
    const twinModelFallback = useAppStore((state) => state.twinModelFallback);
    const syncFrame = useAppStore((state) => state.syncFrame);

    const twinVisible = showTwin && blend > 0.01;
    /**
     * Mirroring is a selfie convention: it flips the preview but not the frames
     * the model actually sees. In PnP mode the twin is drawn in the intrinsic
     * frame of those frames, so a mirrored preview would put the 3D layer on the
     * wrong side of the image — the twin would look like it refuses to line up.
     */
    const previewMirrored = mirrored && !poseEnabled;

    /**
     * The inferred frame is a canvas owned by the inference loop, mounted here
     * instead of the live `<video>`. Same element the model read, so the boxes
     * land on the pixels they were computed from.
     */
    const frameHost = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!syncFrame) return;
        const host = frameHost.current;
        if (!host) return;
        const canvas = syncedFrameCanvas();
        host.appendChild(canvas);
        return () => {
            // The canvas is a shared singleton: detach, never destroy. Hide it too,
            // so re-entering the live view does not show a stale frame from the
            // previous session before the first capture lands.
            canvas.remove();
            canvas.style.opacity = '0';
        };
    }, [syncFrame]);

    return (
        <div className={cn('relative overflow-hidden bg-slate-950', className)}>
            <video
                ref={attachVideo}
                autoPlay
                playsInline
                muted
                disablePictureInPicture
                className="absolute inset-0 h-full w-full object-cover"
                style={{ transform: previewMirrored ? 'scaleX(-1)' : undefined }}
            />

            {syncFrame ? (
                <div
                    ref={frameHost}
                    className="pointer-events-none absolute inset-0"
                    style={{ transform: previewMirrored ? 'scaleX(-1)' : undefined }}
                />
            ) : null}

            {showTwin ? (
                <div
                    className="pointer-events-none absolute inset-0 z-10 transition-opacity duration-150"
                    style={{ opacity: blend * twinOpacity }}
                >
                    <TwinLayer active={twinVisible} lowDetail={lowDetail} />
                </div>
            ) : null}

            <div className="pointer-events-none absolute inset-0 z-20">
                <DetectionLayer />
            </div>

            {/* Soft frame: makes the overlay feel like a viewfinder. */}
            <div className="pointer-events-none absolute inset-0 z-30 shadow-[inset_0_0_120px_rgba(2,6,23,0.75)]" />

            {cameraStatus === 'requesting' ? (
                <StatusBanner icon={<Loader2 className="h-4 w-4 animate-spin" />} tone="info">
                    Solicitando acceso a la cámara…
                </StatusBanner>
            ) : null}

            {/* The 3D asset is ~10 MB: on a phone it takes a few seconds, and staring
          at an empty camera with no explanation reads as a broken overlay. */}
            {showTwin && !twinModelReady && !twinModelFallback ? (
                <StatusBanner icon={<Loader2 className="h-4 w-4 animate-spin" />} tone="info">
                    Cargando el gemelo 3D…
                </StatusBanner>
            ) : null}

            {cameraStatus === 'error' ? (
                <StatusBanner icon={<VideoOff className="h-4 w-4" />} tone="bad">
                    {cameraError ?? 'No se pudo iniciar la cámara.'}
                </StatusBanner>
            ) : null}

            {/* Only renders when the API is genuinely unavailable (insecure origin,
          embedded browser...). The top banner carries the actionable fixes. */}
            {cameraStatus === 'error' ? (
                <div className="pointer-events-auto absolute inset-x-0 top-0 z-40 flex justify-center p-3">
                    <CameraAccessNotice className="max-w-md backdrop-blur-md" />
                </div>
            ) : null}

            {cameraStatus === 'ready' && !showTwin ? (
                <StatusBanner icon={<AlertTriangle className="h-4 w-4" />} tone="warn">
                    Capa 3D desactivada
                </StatusBanner>
            ) : null}

            {/* A model that downloaded but failed to start would otherwise only
          show up as "no detection at all", with the reason buried in the
          settings sheet. */}
            {modelStatus === 'error' ? (
                <StatusBanner icon={<AlertTriangle className="h-4 w-4" />} tone="bad">
                    El modelo no arrancó: {shorten(modelError)}
                </StatusBanner>
            ) : null}
        </div>
    );
}

/** Keeps the banner readable: ORT messages are long and full of stack traces. */
function shorten(message: string | null, limit = 160): string {
    if (!message) return 'motivo desconocido';
    const flat = message.replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function StatusBanner({
    icon,
    tone,
    children,
}: {
    icon: ReactNode;
    tone: 'info' | 'warn' | 'bad';
    children: ReactNode;
}) {
    const tones = {
        info: 'bg-slate-900/85 text-slate-200 border-white/10',
        warn: 'bg-amber-500/15 text-amber-100 border-amber-400/30',
        bad: 'bg-rose-500/15 text-rose-100 border-rose-400/30',
    } as const;
    return (
        <div className="absolute inset-x-0 bottom-0 z-40 flex justify-center p-3">
            <div
                className={cn(
                    'flex max-w-md items-start gap-2 rounded-xl border px-3 py-2 text-xs backdrop-blur-md',
                    tones[tone]
                )}
            >
                <span className="mt-0.5 shrink-0">{icon}</span>
                <span>{children}</span>
            </div>
        </div>
    );
}
