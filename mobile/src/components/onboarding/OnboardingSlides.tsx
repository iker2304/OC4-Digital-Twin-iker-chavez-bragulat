/**
 * Onboarding deck.
 *
 * Content only — the card container and the paged scrolling live in
 * `ui/StepDeck.tsx`. Every string goes through `useI18n()` so the deck can be
 * shown in castellano, English or català.
 *
 * Each card is a full-viewport section with a layout that adapts to the
 * orientation: two columns in landscape (text / visual), stacked in portrait.
 */
import {
    ArrowDown,
    Camera,
    Cpu,
    Cuboid,
    Eye,
    Gauge,
    Move3d,
    ScanEye,
    Smartphone,
    Sparkles,
    Video,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Chip } from '../ui/primitives';
import { StepCard } from '../ui/StepDeck';
import { CameraAccessNotice } from '../ui/CameraAccessNotice';
import { useI18n } from '../../i18n';
import { withBase } from '../../lib/env';
import { cn } from '../../lib/cn';
import type { LayoutMode } from '../../types';

export function Slide({
    children,
    layout,
    className,
}: {
    children: ReactNode;
    layout: LayoutMode;
    className?: string;
}) {
    return (
        <StepCard className={className}>
            <div
                className={cn(
                    'w-full',
                    layout === 'landscape'
                        ? 'grid max-w-5xl grid-cols-2 items-center gap-8'
                        : 'flex max-w-md flex-col items-center text-center'
                )}
            >
                {children}
            </div>
        </StepCard>
    );
}

export function SlideBadge({ children }: { children: ReactNode }) {
    return (
        <span className="mb-4 inline-flex items-center gap-2 rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-sky-200">
            {children}
        </span>
    );
}

export function SlideTitle({ children }: { children: ReactNode }) {
    return (
        <h2 className="text-2xl font-extrabold leading-tight text-white sm:text-3xl">{children}</h2>
    );
}

export function SlideText({ children }: { children: ReactNode }) {
    return <p className="mt-3 text-sm leading-relaxed text-slate-400">{children}</p>;
}

/* ------------------------------------------------------------------ slides */

export function HeroSlide({ layout, onScrollHint }: { layout: LayoutMode; onScrollHint: () => void }) {
    const { t } = useI18n();

    /**
     * La foto va como capa muy atenuada: es un fotograma real del vídeo de prueba
     * (t = 4 s) con la detección dibujada encima, para enseñar en un vistazo lo que
     * hace la app. Encima, centrada y grande, la pista de deslizar.
     */
    const visual = (
        <div
            className={cn(
                'relative',
                layout === 'landscape' ? 'justify-self-end' : 'mx-auto mt-8 w-full max-w-[260px]'
            )}
        >
            <img
                src={withBase('/test/hero-frame.jpg')}
                alt={t('hero.imageAlt')}
                loading="lazy"
                className="mx-auto h-auto w-auto max-h-[58vh] max-w-full rounded-2xl border border-white/10 object-contain opacity-45 shadow-2xl shadow-sky-500/10"
            />
            <button
                type="button"
                onClick={onScrollHint}
                className="absolute inset-0 grid place-content-center justify-items-center gap-2.5 text-slate-200/90 transition-colors hover:text-white"
            >
                <span className="text-[15px] font-semibold uppercase tracking-[0.3em] drop-shadow-[0_1px_6px_rgba(2,6,23,0.9)]">
                    {t('hero.scroll')}
                </span>
                <ArrowDown className="h-9 w-9 animate-bounce drop-shadow-[0_1px_6px_rgba(2,6,23,0.9)]" />
            </button>
        </div>
    );

    const titulo = (
        <div className={cn('min-w-0', layout === 'portrait' && 'text-center')}>
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-sky-400/80">
                {t('hero.kicker')}
            </p>
            <h2 className="mt-2 bg-gradient-to-r from-sky-300 via-cyan-200 to-emerald-300 bg-clip-text text-3xl font-extrabold leading-none tracking-tight text-transparent sm:text-4xl lg:text-5xl">
                {t('hero.title')}
            </h2>
        </div>
    );

    const descripcion = (
        <p className={cn('text-sm leading-relaxed text-slate-400', layout === 'portrait' && 'mt-4 text-center')}>
            {t('hero.text.before')}
            <strong className="text-slate-300">{t('hero.text.strong')}</strong>
            {t('hero.text.after')}
        </p>
    );

    if (layout === 'portrait') {
        return (
            <StepCard>
                <div className="flex w-full max-w-sm flex-col items-center pb-10">
                    {titulo}
                    {descripcion}
                    {visual}
                </div>
            </StepCard>
        );
    }

    /**
     * Dos columnas: a la izquierda título y descripción, a la derecha la imagen
     * con la pista de deslizar debajo.
     */
    return (
        <StepCard>
            <div className="grid w-full max-w-5xl grid-cols-1 gap-8 pb-8 md:grid-cols-[minmax(0,1fr)_minmax(0,340px)] md:items-center md:gap-x-12">
                <div className="min-w-0">
                    {titulo}
                    <div className="mt-6">{descripcion}</div>
                </div>
                {visual}
            </div>
        </StepCard>
    );
}

export function ConceptSlide({ layout }: { layout: LayoutMode }) {
    const { t } = useI18n();
    const items = [
        { icon: ScanEye, title: t('concept.vision.title'), text: t('concept.vision.text') },
        { icon: Cuboid, title: t('concept.twin.title'), text: t('concept.twin.text') },
        { icon: Move3d, title: t('concept.domain.title'), text: t('concept.domain.text') },
    ];

    return (
        <Slide layout={layout}>
            <div className={cn(layout === 'portrait' && 'w-full')}>
                <SlideBadge>
                    <Eye className="h-3 w-3" /> {t('concept.badge')}
                </SlideBadge>
                <SlideTitle>{t('concept.title')}</SlideTitle>
                <SlideText>{t('concept.text')}</SlideText>
            </div>

            <div className={cn('space-y-3', layout === 'portrait' && 'mt-6 w-full text-left')}>
                {items.map((item) => (
                    <div
                        key={item.title}
                        className="flex gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3"
                    >
                        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-300">
                            <item.icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-sm font-semibold text-slate-200">{item.title}</p>
                            <p className="mt-0.5 text-xs leading-relaxed text-slate-400">{item.text}</p>
                        </div>
                    </div>
                ))}
            </div>
        </Slide>
    );
}

export function PipelineSlide({ layout }: { layout: LayoutMode }) {
    const { t } = useI18n();
    const steps = [
        { icon: Camera, label: t('pipeline.step1.label'), text: t('pipeline.step1.text') },
        { icon: Cpu, label: t('pipeline.step2.label'), text: t('pipeline.step2.text') },
        { icon: Video, label: t('pipeline.step3.label'), text: t('pipeline.step3.text') },
        { icon: Gauge, label: t('pipeline.step4.label'), text: t('pipeline.step4.text') },
    ];

    return (
        <Slide layout={layout}>
            <div>
                <SlideBadge>
                    <Sparkles className="h-3 w-3" /> {t('pipeline.badge')}
                </SlideBadge>
                <SlideTitle>{t('pipeline.title')}</SlideTitle>
                <SlideText>{t('pipeline.text')}</SlideText>
                <div className="mt-5 flex flex-wrap gap-2">
                    <Chip tone="good">{t('pipeline.chip.webgpu')}</Chip>
                    <Chip tone="good">{t('pipeline.chip.threads')}</Chip>
                </div>
            </div>

            <ol className={cn('space-y-3', layout === 'portrait' && 'mt-6')}>
                {steps.map((step) => (
                    <li key={step.label} className="flex items-start gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-sky-400/30 bg-slate-900 text-sky-300">
                            <step.icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 pt-1">
                            <p className="text-sm font-semibold text-slate-200">{step.label}</p>
                            <p className="text-xs text-slate-400">{step.text}</p>
                        </div>
                    </li>
                ))}
            </ol>
        </Slide>
    );
}

export function ModelSlide({ layout, children }: { layout: LayoutMode; children: ReactNode }) {
    const { t } = useI18n();
    return (
        <Slide layout={layout}>
            <div>
                <SlideBadge>
                    <Cpu className="h-3 w-3" /> {t('model.badge')}
                </SlideBadge>
                <SlideTitle>{t('model.title')}</SlideTitle>
                <SlideText>
                    {t('model.text.before')}
                    <code className="mx-1 rounded bg-white/10 px-1 text-slate-300">.txt</code>
                    {t('model.text.after')}
                </SlideText>
                <p className="mt-3 text-xs text-slate-500">{t('model.note')}</p>
            </div>
            <div className={cn(layout === 'portrait' && 'mt-6 w-full')}>{children}</div>
        </Slide>
    );
}

export function ReadySlide({
    layout,
    onEnter,
    canEnter,
    cameraHint,
}: {
    layout: LayoutMode;
    onEnter: () => void;
    canEnter: boolean;
    /** Explanation shown when the camera cannot be used at all. */
    cameraHint?: string | null;
}) {
    const { t } = useI18n();
    return (
        <Slide layout={layout}>
            <div>
                <SlideBadge>
                    <Smartphone className="h-3 w-3" /> {t('ready.badge')}
                </SlideBadge>
                <SlideTitle>{t('ready.title')}</SlideTitle>
                <SlideText>{t('ready.text')}</SlideText>
                <ul className="mt-4 space-y-2 text-xs text-slate-400">
                    <li>{t('ready.list1')}</li>
                    <li>{t('ready.list2')}</li>
                    <li>{t('ready.list3')}</li>
                </ul>
            </div>
            <div className={cn('flex flex-col items-stretch gap-3', layout === 'landscape' ? 'justify-center' : 'mt-6')}>
                <Button
                    variant="primary"
                    onClick={onEnter}
                    className="min-h-14 text-base"
                    icon={<Camera className="h-5 w-5" />}
                >
                    {t('ready.enter')}
                </Button>
                {!canEnter ? (
                    cameraHint ? (
                        <CameraAccessNotice />
                    ) : (
                        <p className="text-center text-[11px] text-amber-300/90">{t('ready.hint')}</p>
                    )
                ) : null}
            </div>
        </Slide>
    );
}
