/**
 * `/benchmark-public/` — the wizard someone reaches by scanning a QR code.
 *
 * Two steps, because the two questions are different: *what machine is this*
 * (calibration) and *what can it do with each model* (the suite). The internal
 * `/bench` page assumes you know which device you are on and which model you want
 * to test; this one has to work for a stranger with an unknown phone.
 *
 * Nothing here invents measurement: it uses the same engine, the same synthetic
 * camera and the same pose solve as the app, and posts the same payload through
 * `payload.ts`. What it adds is the scaffolding a stranger needs — a form, a
 * language switch, a wake lock so the screen does not sleep mid-test, and a
 * progress line that says which model and which test it is on.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, withBase } from '../lib/env';
import { filterBenchmarkModels } from '../lib/modelNames';
import { useAppStore } from '../store/appStore';
import { useDetectionEngine } from '../lib/inference/useDetectionEngine';
import { updatePose } from '../lib/pose/poseTracker';
import { SCENARIOS, SceneSource } from './scenarios';
import type { ScenarioId } from './scenarios';
import { calibrateDevice } from './calibration';
import type { Calibration } from './calibration';
import { guessCategory, probeHardware, slugify } from './hardware';
import type { Category, Hardware } from './hardware';
import { LOCALES, detectLocale, rememberLocale, translate } from './i18n';
import type { Locale } from './i18n';
import { buildRunPayload, postRun } from './payload';
import { round, stats } from './stats';

/** Samples kept per scenario, after two discarded warm-up runs (same as /bench). */
const SAMPLES = 8;

interface ServerModel {
    file: string;
    url: string;
    bytes: number;
}

interface Sample {
    captureMs: number;
    preprocessMs: number;
    inferenceMs: number;
    postprocessMs: number;
    poseMs: number;
    readyMs: number;
    paintMs: number;
    detected: number;
    solved: boolean;
    score: number;
    rmsPx: number | null;
}

type Step = 1 | 2 | 3;

export function PublicBenchPage() {
    const [locale, setLocale] = useState<Locale>(() => detectLocale());
    const t = useCallback(
        (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
        [locale]
    );

    const [step, setStep] = useState<Step>(1);
    const [fullName, setFullName] = useState('');
    const [nick, setNick] = useState('');
    const [description, setDescription] = useState('');
    const [category, setCategory] = useState<Category>('portatil');
    const [calibration, setCalibration] = useState<Calibration | null>(null);
    const [hardware, setHardware] = useState<Hardware | null>(null);
    const [calibrating, setCalibrating] = useState(false);
    /** `percent` and `stage` while the calibration runs, so it is not a spinner. */
    const [calibProgress, setCalibProgress] = useState<{ percent: number; stage: string } | null>(null);

    const [models, setModels] = useState<ServerModel[]>([]);
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState('');
    /** Cases finished out of `models × tests`, for the percentage. */
    const [counts, setCounts] = useState({ done: 0, total: 0 });
    const [error, setError] = useState<string | null>(null);
    const [runsSaved, setRunsSaved] = useState(0);
    const [finished, setFinished] = useState<'done' | 'stopped' | null>(null);
    const [wakeLock, setWakeLock] = useState(false);
    const stopRequested = useRef(false);

    const { engine, loadFromUrl } = useDetectionEngine();
    /**
     * The engine the *loop* must use.
     *
     * `runSuite` is one long async function: it captures `engine` when the button
     * is pressed, and after `loadFromUrl` the hook returns a new engine bound to
     * the new session. Running the old one against the new model's input size is
     * exactly the `Got 480, Expected 224` crash, so every run reads the ref.
     */
    const engineRef = useRef(engine);
    useEffect(() => {
        engineRef.current = engine;
    }, [engine]);
    const provider = useAppStore((state) => state.model?.provider ?? null);
    const wasmNote = useAppStore((state) => state.wasmNote);

    const sourceRef = useRef<SceneSource | null>(null);
    const hostRef = useRef<HTMLDivElement | null>(null);
    const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

    const deviceId = useMemo(() => slugify(nick || 'dispositivo'), [nick]);
    const canContinue = fullName.trim().length > 1 && nick.trim().length > 1;

    /* ------------------------------------------------------------- machinery */

    useEffect(() => {
        void probeHardware().then((probed) => {
            setHardware(probed);
            setCategory((current) => (current === 'portatil' ? guessCategory(probed) : current));
        });
        fetch(`${API_BASE}/models`)
            .then((response) => (response.ok ? response.json() : null))
            .then((payload: { models?: ServerModel[] } | null) =>
                setModels(filterBenchmarkModels(payload?.models ?? []))
            )
            .catch(() => setModels([]));
    }, []);

    /** The synthetic camera: the same one `/bench` measures against. */
    useEffect(() => {
        const source = new SceneSource();
        sourceRef.current = source;
        void source
            .load(withBase('/test/'))
            .then(() => {
                hostRef.current?.appendChild(source.canvas);
                source.start();
            })
            .catch(() => {
                // Without the scenes there is nothing to measure, but the form must
                // still work: the error shows when the tests start.
            });
        return () => {
            source.stop();
            source.canvas.remove();
            sourceRef.current = null;
        };
    }, []);

    /**
     * Screen wake lock.
     *
     * A phone that sleeps mid-suite pauses timers and inference, and the run that
     * looks like a 4-second stall is really a locked screen. Re-acquired on every
     * visibility change because the OS releases it when the tab is hidden.
     */
    const requestWakeLock = useCallback(async () => {
        const api = (navigator as Navigator & { wakeLock?: { request: (type: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        if (!api) {
            setWakeLock(false);
            return;
        }
        try {
            wakeLockRef.current = await api.request('screen');
            setWakeLock(true);
        } catch {
            setWakeLock(false);
        }
    }, []);

    useEffect(() => {
        const onVisibility = () => {
            if (document.visibilityState === 'visible' && running) void requestWakeLock();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, [requestWakeLock, running]);

    useEffect(
        () => () => {
            void wakeLockRef.current?.release().catch(() => undefined);
            wakeLockRef.current = null;
        },
        []
    );

    /* ------------------------------------------------------------- step one */

    const runCalibration = useCallback(async () => {
        setCalibrating(true);
        setError(null);
        setCalibProgress({ percent: 0, stage: 'single' });
        try {
            const measured = await calibrateDevice((percent, stage) =>
                setCalibProgress({ percent, stage })
            );
            setCalibration(measured);
            const id = slugify(nick || 'dispositivo');
            await fetch(`${API_BASE}/bench/devices`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id,
                    name: nick.trim(),
                    category,
                    hardware: hardware ?? null,
                    // The public flow stores who ran it and the measured specs.
                    owner: fullName.trim(),
                    description: description.trim().slice(0, 200) || null,
                    calibration: measured,
                }),
            });
            setStep(2);
        } catch (cause) {
            setError(String(cause));
        } finally {
            setCalibrating(false);
            setCalibProgress(null);
        }
    }, [category, description, fullName, hardware, nick]);

    /* ------------------------------------------------------------- step two */

    /** One scenario: 2 warm-up samples plus SAMPLES measured ones. */
    const runOneScenario = useCallback(
        async (scenario: ScenarioId): Promise<Sample[]> => {
            const source = sourceRef.current;
            const current = engineRef.current;
            if (!source || !current) return [];
            if (scenario === 'video') await source.ensurePlaying(1500);
            source.scenario = scenario;
            const { width, height } = source.canvas;
            const app = useAppStore.getState();
            const samples: Sample[] = [];
            let previous = app.pose;
            for (let index = 0; index < SAMPLES + 2; index += 1) {
                const started = performance.now();
                const captureMs = source.frame();
                const result = await current.run(source.canvas, width, height, {
                    confidence: app.confidence,
                    iou: app.iou,
                    maxDetections: app.maxDetections,
                });
                const poseStart = performance.now();
                const tracked = updatePose({
                    detections: result.detections,
                    sourceWidth: width,
                    sourceHeight: height,
                    previous,
                    options: {
                        minScore: app.keypointMinScore,
                        horizontalFovDeg: app.poseHfovDeg,
                        poseAgeMs: Number.POSITIVE_INFINITY,
                        frameMs: 100,
                    },
                });
                const poseMs = performance.now() - poseStart;
                previous = tracked.pose ?? previous;
                const readyMs = performance.now() - started;
                await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
                await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
                const paintMs = performance.now() - started;
                if (index >= 2) {
                    samples.push({
                        captureMs: round(captureMs),
                        preprocessMs: round(result.preprocessMs),
                        inferenceMs: round(result.inferenceMs),
                        postprocessMs: round(result.postprocessMs),
                        poseMs: round(poseMs),
                        readyMs: round(readyMs),
                        paintMs: round(paintMs),
                        detected: result.detections.length,
                        solved: tracked.accepted,
                        score:
                            result.detections.length > 0
                                ? round(
                                    result.detections.reduce((sum, d) => sum + d.score, 0) /
                                    result.detections.length
                                )
                                : 0,
                        rmsPx:
                            tracked.solved && Number.isFinite(tracked.pose?.rmsError)
                                ? round(tracked.pose?.rmsError ?? 0)
                                : null,
                    });
                }
            }
            return samples;
        },
        []
    );

    const runSuite = useCallback(async () => {
        if (running || models.length === 0) return;
        setError(null);
        setFinished(null);
        setRunsSaved(0);
        stopRequested.current = false;
        setRunning(true);
        setCounts({ done: 0, total: models.length * SCENARIOS.length });
        await requestWakeLock();
        let saved = 0;
        try {
            for (let index = 0; index < models.length; index += 1) {
                const file = models[index];
                if (stopRequested.current) break;
                setProgress(t('public.step2.loading', { index: index + 1, total: models.length, name: file.file }));
                try {
                    await loadFromUrl(withBase(file.url));
                    // The store is the source of truth for the input size the
                    // preprocessor uses; wait for it to name the new model before
                    // feeding it a frame.
                    const deadline = performance.now() + 8000;
                    while (useAppStore.getState().modelName !== file.file && performance.now() < deadline) {
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    }
                } catch (cause) {
                    setError(t('public.step2.error', { name: file.file, error: String(cause) }));
                    continue;
                }
                for (let test = 0; test < SCENARIOS.length; test += 1) {
                    if (stopRequested.current) break;
                    const scenario = SCENARIOS[test];
                    setCounts({
                        done: index * SCENARIOS.length + test,
                        total: models.length * SCENARIOS.length,
                    });
                    setProgress(
                        t('public.step2.testing', {
                            index: index + 1,
                            total: models.length,
                            test: scenario.label,
                            done: test + 1,
                            tests: SCENARIOS.length,
                        })
                    );
                    const samples = await runOneScenario(scenario.id);
                    if (samples.length === 0) continue;
                    const mean = {
                        captureMs: stats(samples.map((s) => s.captureMs)).mean,
                        preprocessMs: stats(samples.map((s) => s.preprocessMs)).mean,
                        inferenceMs: stats(samples.map((s) => s.inferenceMs)).mean,
                        postprocessMs: stats(samples.map((s) => s.postprocessMs)).mean,
                        poseMs: stats(samples.map((s) => s.poseMs)).mean,
                        readyMs: stats(samples.map((s) => s.readyMs)).mean,
                        paintMs: stats(samples.map((s) => s.paintMs)).mean,
                        detected: stats(samples.map((s) => s.detected)).mean,
                        solvedRate: round(
                            (samples.filter((s) => s.solved).length / Math.max(1, samples.length)) * 100
                        ),
                        score: stats(samples.map((s) => s.score)).mean,
                        rmsPx:
                            stats(
                                samples.map((s) => s.rmsPx).filter((value): value is number => value !== null)
                            ).mean || null,
                    };
                    setProgress(t('public.step2.saving'));
                    try {
                        await postRun(
                            API_BASE,
                            buildRunPayload({
                                device: { id: deviceId, name: nick.trim(), category, hardware: hardware ?? null },
                                scenario: scenario.id,
                                samples,
                                mean,
                                hardware,
                                runtime: { provider, note: wasmNote },
                                model: useAppStore.getState().model,
                                extra: { publicRun: true, owner: fullName.trim() },
                            })
                        );
                        saved += 1;
                        setRunsSaved(saved);
                    } catch (cause) {
                        setError(String(cause));
                    }
                }
            }
            setFinished(stopRequested.current ? 'stopped' : 'done');
            if (!stopRequested.current) setStep(3);
        } finally {
            setRunning(false);
            setProgress('');
            void wakeLockRef.current?.release().catch(() => undefined);
            wakeLockRef.current = null;
            setWakeLock(false);
        }
    }, [category, deviceId, fullName, hardware, loadFromUrl, models, nick, provider, requestWakeLock, runOneScenario, running, t, wasmNote]);

    /* ------------------------------------------------------------------- ui */

    return (
        <div className="min-h-dvh bg-slate-950 px-4 py-6 pb-16 text-slate-100">
            {/*
             * Blocking overlay while calibrating.
             *
             * The stages are chunked and yield to the event loop, but a phone still
             * feels every 30 ms of solid arithmetic: without something on screen the
             * page looks frozen and people start tapping. The modal goes up before
             * the first measurement and comes down when the last one ends.
             */}
            {calibrating ? (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-6 backdrop-blur-sm"
                    role="alertdialog"
                    aria-busy="true"
                    aria-live="polite"
                    aria-label={t('public.action.calibrating')}
                >
                    <div className="w-full max-w-sm space-y-3 rounded-2xl border border-white/10 bg-slate-900 p-5 text-center shadow-2xl">
                        <span className="mx-auto block h-8 w-8 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
                        <p className="text-sm font-semibold text-slate-100">{t('public.action.calibrating')}</p>
                        <p className="text-[11px] text-sky-300">
                            {calibProgress ? `${t(`public.stage.${calibProgress.stage}`)} · ${calibProgress.percent}%` : ''}
                        </p>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                            <div
                                className="h-full rounded-full bg-sky-400 transition-[width] duration-200"
                                style={{ width: `${calibProgress?.percent ?? 0}%` }}
                            />
                        </div>
                        <p className="text-[10px] text-slate-500">{t('public.calib.takes')}</p>
                    </div>
                </div>
            ) : null}
            <div className="mx-auto max-w-3xl space-y-5">
                <header className="space-y-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <h1 className="text-lg font-semibold">{t('public.title')}</h1>
                        <div className="flex items-center gap-1 text-[11px] text-slate-400">
                            <span className="sr-only">{t('public.language')}</span>
                            {LOCALES.map((entry) => (
                                <button
                                    key={entry.id}
                                    type="button"
                                    onClick={() => {
                                        setLocale(entry.id);
                                        rememberLocale(entry.id);
                                    }}
                                    aria-pressed={locale === entry.id}
                                    className={`rounded-md border px-2 py-0.5 ${locale === entry.id
                                            ? 'border-sky-400 bg-sky-500/15 text-sky-100'
                                            : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                                        }`}
                                >
                                    {entry.id.toUpperCase()}
                                </button>
                            ))}
                        </div>
                    </div>
                    <p className="text-xs text-slate-400">{t('public.subtitle')}</p>
                </header>

                <ol className="flex gap-2 text-[11px]">
                    {[1, 2].map((value) => (
                        <li
                            key={value}
                            className={`flex-1 rounded-lg border px-2 py-1 text-center ${step >= value
                                    ? 'border-sky-400/60 bg-sky-500/10 text-sky-200'
                                    : 'border-white/10 bg-white/[0.03] text-slate-500'
                                }`}
                        >
                            {t('public.step', { n: value })}
                        </li>
                    ))}
                </ol>

                {step === 1 ? (
                    <section className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
                        <h2 className="text-sm font-semibold">{t('public.step1.title')}</h2>
                        <p className="text-[11px] text-slate-400">{t('public.step1.hint')}</p>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="space-y-1 text-[11px] text-slate-300">
                                <span>
                                    {t('public.field.fullName')} <span className="text-rose-300">*</span>
                                </span>
                                <input
                                    value={fullName}
                                    onChange={(event) => setFullName(event.target.value)}
                                    placeholder={t('public.field.fullName.placeholder')}
                                    className="h-11 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
                                />
                            </label>
                            <label className="space-y-1 text-[11px] text-slate-300">
                                <span>
                                    {t('public.field.nick')} <span className="text-rose-300">*</span>
                                </span>
                                <input
                                    value={nick}
                                    onChange={(event) => setNick(event.target.value)}
                                    placeholder={t('public.field.nick.placeholder')}
                                    className="h-11 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
                                />
                            </label>
                            <label className="space-y-1 text-[11px] text-slate-300 sm:col-span-2">
                                <span>{t('public.field.description')}</span>
                                <input
                                    value={description}
                                    onChange={(event) => setDescription(event.target.value.slice(0, 200))}
                                    placeholder={t('public.field.description.placeholder')}
                                    className="h-11 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
                                />
                            </label>
                            <label className="space-y-1 text-[11px] text-slate-300">
                                <span>{t('public.field.category')}</span>
                                <select
                                    value={category}
                                    onChange={(event) => setCategory(event.target.value as Category)}
                                    className="h-11 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-slate-100 focus:border-sky-400/60 focus:outline-none"
                                >
                                    {(['sobremesa', 'portatil', 'movil'] as Category[]).map((value) => (
                                        <option key={value} value={value} className="bg-slate-900">
                                            {t(`public.category.${value}`)}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </div>

                        {calibration ? <CalibrationTable calibration={calibration} t={t} /> : null}

                        {calibProgress ? (
                            <div className="space-y-1">
                                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                                    <div
                                        className="h-full rounded-full bg-sky-400 transition-[width] duration-200"
                                        style={{ width: `${calibProgress.percent}%` }}
                                    />
                                </div>
                                <p className="text-[10px] text-slate-400">
                                    {calibProgress.percent}% ·{' '}
                                    {t(`public.stage.${calibProgress.stage}`)}
                                </p>
                            </div>
                        ) : null}
                        <button
                            type="button"
                            disabled={!canContinue || calibrating}
                            onClick={() => void runCalibration()}
                            className="min-h-11 w-full rounded-xl bg-sky-500 px-4 text-sm font-semibold text-slate-950 disabled:opacity-40 sm:w-auto"
                        >
                            {calibrating ? `${t('public.action.calibrating')}…` : t('public.action.calibrate')}
                        </button>
                        {error ? <p className="text-[11px] text-rose-300">{error}</p> : null}
                    </section>
                ) : null}

                {step === 2 ? (
                    <section className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
                        <h2 className="text-sm font-semibold">{t('public.step2.title')}</h2>
                        <p className="text-[11px] text-slate-400">{t('public.step2.hint')}</p>
                        <div className="relative overflow-hidden rounded-xl border border-white/10">
                            <div ref={hostRef} />
                        </div>
                        <p className="text-[11px] text-slate-400">
                            {models.length === 0 ? t('public.step2.empty') : t('public.step2.models', { n: models.length })}
                            {' · '}
                            {wakeLock ? t('public.step2.wakelock') : t('public.step2.nowakelock')}
                        </p>
                        {/*
                         * The calibration is known before the suite starts, so it is
                         * shown here instead of only in the summary: whoever is
                         * watching a twenty-minute run wants to know what machine is
                         * being classified while it happens.
                         */}
                        {calibration ? <CalibrationTable calibration={calibration} t={t} /> : null}
                        {counts.total > 0 ? (
                            <div className="space-y-1">
                                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                                    <div
                                        className="h-full rounded-full bg-sky-400 transition-[width] duration-300"
                                        style={{
                                            width: `${Math.round((counts.done / Math.max(1, counts.total)) * 100)}%`,
                                        }}
                                    />
                                </div>
                                <p className="text-right text-[10px] text-slate-400">
                                    {Math.round((counts.done / Math.max(1, counts.total)) * 100)}% ·{' '}
                                    {counts.done}/{counts.total}
                                </p>
                            </div>
                        ) : null}
                        <div className="flex flex-wrap items-center gap-2">
                            {!running ? (
                                <button
                                    type="button"
                                    disabled={models.length === 0}
                                    onClick={() => void runSuite()}
                                    className="min-h-11 rounded-xl bg-sky-500 px-4 text-sm font-semibold text-slate-950 disabled:opacity-40"
                                >
                                    {t('public.action.start')}
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => {
                                        stopRequested.current = true;
                                    }}
                                    className="min-h-11 rounded-xl border border-rose-400/40 bg-rose-500/10 px-4 text-sm font-semibold text-rose-200"
                                >
                                    {t('public.action.stop')}
                                </button>
                            )}
                            {running ? <span className="text-[11px] text-sky-200">{progress}</span> : null}
                            {!running && runsSaved > 0 ? (
                                <span className="text-[11px] text-emerald-300">
                                    {finished === 'stopped'
                                        ? t('public.step2.stopped', { runs: runsSaved })
                                        : t('public.step2.done', { runs: runsSaved, models: models.length })}
                                </span>
                            ) : null}
                        </div>
                        {error ? <p className="text-[11px] text-rose-300">{error}</p> : null}
                        <p className="text-[10px] text-slate-500">{t('public.step2.keep')}</p>
                    </section>
                ) : null}

                {step === 3 ? (
                    <section className="space-y-2 rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-4">
                        <h2 className="text-sm font-semibold text-emerald-200">{t('public.results.title')}</h2>
                        <p className="text-[11px] text-emerald-100/80">
                            {t('public.step2.done', { runs: runsSaved, models: models.length })}
                        </p>
                        <p className="text-[11px] text-emerald-100/70">{t('public.results.hint')}</p>
                        {calibration ? <CalibrationTable calibration={calibration} t={t} /> : null}
                        <button
                            type="button"
                            onClick={() => {
                                setStep(1);
                                setRunsSaved(0);
                                setFinished(null);
                            }}
                            className="min-h-11 rounded-xl border border-white/15 px-4 text-sm text-slate-100 hover:bg-white/5"
                        >
                            {t('public.action.restart')}
                        </button>
                    </section>
                ) : null}
            </div>
        </div>
    );
}

/** The calibration numbers, in the units they were measured in. */
function CalibrationTable({
    calibration,
    t,
}: {
    calibration: Calibration;
    t: (key: string, vars?: Record<string, string | number>) => string;
}) {
    const rows: Array<[string, string]> = [
        [t('public.calib.cpuSingle'), `${calibration.cpuSingle.toLocaleString()} op/ms`],
        [
            t('public.calib.sustained'),
            `${calibration.cpuSustained.toLocaleString()} op/ms · ${Math.round(calibration.throttle * 100)}%`,
        ],
        [t('public.calib.throttle'), `${Math.round((1 - calibration.throttle) * 100)}%`],
        [t('public.calib.spread'), `${calibration.cpuSpread}%`],
        [
            t('public.calib.cpuMulti'),
            `${calibration.cpuMulti.toLocaleString()} op/ms · ${calibration.workers} ${t('public.calib.threads')}`,
        ],
        [
            t('public.calib.scaling'),
            `${calibration.scaling}× · ${calibration.cores} ${t('public.calib.cores').toLowerCase()} · ${Math.round(
                calibration.scalingEfficiency * 100
            )}% ${t('public.calib.efficiency').toLowerCase()}`,
        ],
        [
            t('public.calib.memory'),
            calibration.memoryGb ? `${calibration.memoryGb} GB` : t('public.calib.notExposed'),
        ],
        [
            t('public.calib.buffer'),
            calibration.sustainableReliable
                ? `${calibration.sustainableMb} MB${
                      calibration.sustainableIsCap ? ` (${t('public.calib.ceiling')})` : ''
                  } · ${calibration.frameBaseMs} ms base · ${calibration.fillMbS.toLocaleString()} MB/s`
                : `${calibration.sustainableMb} MB · ${t('public.calib.unreliable')}`,
        ],
        [
            t('public.calib.heap'),
            calibration.heapLimitMb ? `${calibration.heapLimitMb} MB` : t('public.calib.notExposed'),
        ],
        [t('public.calib.gpu'), calibration.gpuRenderer ?? t('public.calib.hidden')],
        [
            t('public.calib.gpuDraw'),
            calibration.gpuMegapixelsS
                ? `${calibration.gpuMegapixelsS.toLocaleString()} MP/s`
                : t('public.calib.notExposed'),
        ],
        [
            t('public.calib.webgpu'),
            calibration.webgpu
                ? (calibration.webgpuInfo ?? t('public.calib.yes')) +
                  (calibration.webgpuFeatures ? ` · ${calibration.webgpuFeatures} features` : '')
                : t('public.calib.no'),
        ],
        [
            t('public.calib.wasm'),
            `${calibration.wasmSimd ? 'SIMD' : 'sin SIMD'} · ${
                calibration.wasmThreads ? 'threads' : '1 hilo'
            }`,
        ],
        [t('public.calib.timer'), `${calibration.timerMs} ms`],
        [t('public.calib.score'), `${calibration.score} · ${t(`public.calib.tier.${calibration.tier}`)}`],
        [t('public.calib.duration'), `${(calibration.durationMs / 1000).toFixed(1)} s`],
    ];
    return (
        <table className="w-full border-collapse text-[11px]">
            <tbody>
                {rows.map(([label, value]) => (
                    <tr key={label} className="border-t border-white/5">
                        <td className="py-1 pr-2 text-slate-400">{label}</td>
                        <td className="py-1 text-right text-slate-100">{value}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
