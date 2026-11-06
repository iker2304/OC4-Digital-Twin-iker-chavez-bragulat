/**
 * Onboarding scroller.
 *
 * A vertical scroll-snap deck: one full-viewport slide at a time, driven by
 * native scrolling (so it inherits momentum and works with accessibility
 * gestures) and an IntersectionObserver for the progress rail.
 */
import { useCallback, useState, useRef } from 'react';
import { CameraOff, ChevronRight, Loader2, Radio, ShieldCheck, SwitchCamera } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import type { LayoutMode } from '../../types';
import type { VideoDeviceInfo } from '../../lib/camera/useCameraStream';
import { cameraAccess } from '../../lib/env';
import { Button, Chip } from '../ui/primitives';
import { CameraAccessNotice } from '../ui/CameraAccessNotice';
import { LanguageSwitch } from '../ui/LanguageSwitch';
import { StepDeck, type StepDeckHandle } from '../ui/StepDeck';
import { useI18n } from '../../i18n';
import { ModelPicker } from '../ModelPicker';
import { cn } from '../../lib/cn';
import {
    ConceptSlide,
    HeroSlide,
    ModelSlide,
    PipelineSlide,
    ReadySlide,
    Slide,
    SlideBadge,
    SlideText,
    SlideTitle,
} from './OnboardingSlides';

const SLIDE_COUNT = 6;

function ProgressRail({
    count,
    index,
    layout,
    onSelect,
}: {
    count: number;
    index: number;
    layout: LayoutMode;
    onSelect: (index: number) => void;
}) {
    const { t } = useI18n();
    return (
        <div
            className={cn(
                'fixed z-50 flex gap-1.5',
                layout === 'landscape'
                    ? 'bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 flex-row'
                    : 'right-[max(0.75rem,env(safe-area-inset-right))] top-1/2 -translate-y-1/2 flex-col'
            )}
        >
            {Array.from({ length: count }, (_, dot) => (
                <button
                    key={dot}
                    type="button"
                    aria-label={`${t('a11y.section')} ${dot + 1}`}
                    onClick={() => onSelect(dot)}
                    className={cn(
                        'rounded-full transition-all',
                        layout === 'landscape' ? 'h-1.5' : 'w-1.5',
                        dot === index
                            ? cn('bg-sky-400', layout === 'landscape' ? 'w-6' : 'h-6')
                            : cn('bg-white/20 hover:bg-white/40', layout === 'landscape' ? 'w-1.5' : 'h-1.5')
                    )}
                />
            ))}
        </div>
    );
}

function CameraSlide({
    layout,
    attachVideo,
    startCamera,
    listDevices,
}: {
    layout: LayoutMode;
    attachVideo: (element: HTMLVideoElement | null) => void;
    startCamera: (options?: {
        deviceId?: string | null;
        facing?: 'environment' | 'user';
    }) => Promise<boolean>;
    listDevices: () => Promise<VideoDeviceInfo[]>;
}) {
    const status = useAppStore((state) => state.cameraStatus);
    const error = useAppStore((state) => state.cameraError);
    const deviceId = useAppStore((state) => state.deviceId);
    const facing = useAppStore((state) => state.facing);
    const access = cameraAccess();
    const { t } = useI18n();

    const [devices, setDevices] = useState<VideoDeviceInfo[]>([]);
    const [busy, setBusy] = useState(false);

    const enable = async (options?: { deviceId?: string | null; facing?: 'environment' | 'user' }) => {
        if (!access.available) return;
        setBusy(true);
        const ok = await startCamera(options);
        if (ok) setDevices(await listDevices());
        setBusy(false);
    };

    return (
        <Slide layout={layout}>
            <div>
                <SlideBadge>
                    <CameraOff className="h-3 w-3" /> {t('camera.badge')}
                </SlideBadge>
                <SlideTitle>{t('camera.title')}</SlideTitle>
                <SlideText>
                    {t('camera.text.before')}
                    <code className="rounded bg-white/10 px-1 text-slate-300">localhost</code>
                    {t('camera.text.after')}
                </SlideText>

                <CameraAccessNotice className="mt-4" />

                {status === 'error' && error && access.available ? (
                    <div className="mt-3 rounded-xl border border-rose-400/25 bg-rose-500/10 p-3 text-xs text-rose-200">
                        {error}
                    </div>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                        variant={status === 'ready' ? 'outline' : 'primary'}
                        disabled={busy || status === 'requesting' || !access.available}
                        icon={
                            busy || status === 'requesting' ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Radio className="h-4 w-4" />
                            )
                        }
                        onClick={() => void enable()}
                    >
                        {status === 'ready' ? 'Reiniciar cámara' : 'Permitir y activar'}
                    </Button>
                    {status === 'ready' ? (
                        <Button
                            icon={<SwitchCamera className="h-4 w-4" />}
                            disabled={busy}
                            onClick={() =>
                                void enable({ facing: facing === 'environment' ? 'user' : 'environment', deviceId: null })
                            }
                        >
                            Girar
                        </Button>
                    ) : null}
                </div>

                {devices.length > 0 ? (
                    <div className="mt-4 space-y-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                            Cámaras disponibles ({devices.length})
                        </p>
                        {devices.map((device) => (
                            <button
                                key={device.deviceId}
                                type="button"
                                onClick={() => void enable({ deviceId: device.deviceId })}
                                className={cn(
                                    'flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors',
                                    device.deviceId === deviceId
                                        ? 'border-sky-400/50 bg-sky-500/10'
                                        : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'
                                )}
                            >
                                <SwitchCamera className="h-4 w-4 shrink-0 text-slate-400" />
                                <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{device.label}</span>
                                {device.facing !== 'unknown' ? (
                                    <Chip>{device.facing === 'environment' ? 'trasera' : 'frontal'}</Chip>
                                ) : null}
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>

            <div className={cn(layout === 'portrait' && 'mt-6 w-full')}>
                <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-slate-950">
                    <video
                        ref={attachVideo}
                        autoPlay
                        playsInline
                        muted
                        className="h-full w-full object-cover"
                    />
                    {status !== 'ready' ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-500">
                            <CameraOff className="h-6 w-6" />
                            <span className="text-xs">Sin señal de cámara</span>
                        </div>
                    ) : null}
                </div>
                <p className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-slate-500">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Procesamiento local, sin subida de vídeo
                </p>
            </div>
        </Slide>
    );
}

export interface OnboardingProps {
    layout: LayoutMode;
    onEnter: () => void;
    onModelFile: (file: File, labelsFile?: File | null) => void | Promise<void>;
    onModelUrl: (url: string) => void | Promise<void>;
    bundledModelUrl?: string;
    attachVideo: (element: HTMLVideoElement | null) => void;
    startCamera: (options?: {
        deviceId?: string | null;
        facing?: 'environment' | 'user';
    }) => Promise<boolean>;
    listDevices: () => Promise<VideoDeviceInfo[]>;
}

export function Onboarding({
    layout,
    onEnter,
    onModelFile,
    onModelUrl,
    bundledModelUrl,
    attachVideo,
    startCamera,
    listDevices,
}: OnboardingProps) {
    const deck = useRef<StepDeckHandle>(null);
    const [index, setIndex] = useState(0);
    const { t } = useI18n();
    const cameraStatus = useAppStore((state) => state.cameraStatus);
    const access = cameraAccess();

    const goTo = useCallback((target: number) => deck.current?.goTo(target), []);

    return (
        <div className="relative bg-slate-950 text-slate-100">
            <header className="pointer-events-none fixed inset-x-0 top-0 z-50 flex items-center justify-between gap-3 px-[max(1.25rem,env(safe-area-inset-left))] pt-[max(1rem,env(safe-area-inset-top))]">
                <div className="pointer-events-auto flex items-center gap-2">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/20 text-[10px] font-black text-sky-300">
                        OC4
                    </div>
                    <span className="hidden text-xs font-semibold tracking-wide text-slate-400 sm:inline">
                        {t('nav.brand')}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <LanguageSwitch />
                    <button
                        type="button"
                        onClick={() => goTo(SLIDE_COUNT - 1)}
                        className="pointer-events-auto flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200"
                    >
                        {t('nav.skip')} <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                </div>
            </header>

            <ProgressRail count={SLIDE_COUNT} index={index} layout={layout} onSelect={goTo} />

            <StepDeck ref={deck} count={SLIDE_COUNT} onIndexChange={setIndex}>
                <HeroSlide layout={layout} onScrollHint={() => goTo(1)} />
                <ConceptSlide layout={layout} />
                <PipelineSlide layout={layout} />
                <ModelSlide layout={layout}>
                    <ModelPicker
                        onFile={onModelFile}
                        onUrl={onModelUrl}
                        bundledModelUrl={bundledModelUrl}
                    />
                </ModelSlide>
                <CameraSlide
                    layout={layout}
                    attachVideo={attachVideo}
                    startCamera={startCamera}
                    listDevices={listDevices}
                />
                <ReadySlide
                    layout={layout}
                    onEnter={onEnter}
                    canEnter={cameraStatus === 'ready'}
                    cameraHint={access.available ? null : access.message}
                />
            </StepDeck>
        </div>
    );
}
