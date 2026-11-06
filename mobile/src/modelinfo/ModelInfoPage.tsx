import { useEffect, useMemo, useState } from 'react';
import { withBase } from '../lib/env';

/**
 * Resumen de cada modelo entrenado, por clase.
 *
 * Nace de un fallo real: la mAP global de estos modelos rondaba 0,5 y parecía
 * aceptable, pero era la media de un 0,99 de turbina y un **0,00** de rotor. La
 * métrica agregada escondía que los keypoints del rotor se predecían al azar, así
 * que esta pantalla no enseña medias: enseña turbina y rotor por separado, con
 * caja y pose, y la evolución época a época.
 *
 * Los datos los genera `scripts/model-info.py` a partir de `results.csv` y de una
 * validación sobre el split elegido; aquí solo se pinta.
 */

interface MetricSet {
    precision: number;
    recall: number;
    map50: number;
    map50_95: number;
}

interface ClassInfo {
    id: number;
    name: string;
    box: MetricSet;
    pose: MetricSet;
}

interface SeriesPoint {
    epoch: number;
    box_map50: number | null;
    box_map50_95: number | null;
    pose_map50: number | null;
    pose_map50_95: number | null;
    seconds: number;
}

interface Summary {
    run: string;
    imgsz: number;
    split: string;
    training: Record<string, unknown>;
    overall: { box: MetricSet; pose: MetricSet };
    classes: ClassInfo[];
    series: SeriesPoint[];
    csv: string;
    bestEpoch: SeriesPoint | null;
    epochsDone: number;
}

interface IndexEntry {
    run: string;
    imgsz: number;
    epochs: number;
    poseMap50: number;
    rotorPoseMap50: number | null;
    weightsAt: string | null;
}

const INDEX_URL = withBase('/model-info/index.json');
const summaryUrl = (run: string) => withBase(`/model-info/${run}.json`);
const csvUrl = (run: string) => withBase(`/model-info/${run}.csv`);

/**
 * Las dos familias que se comparan aquí.
 *
 * Se deduce del nombre del run (`nano640_coco`, `nano`, `small-s-640`…) para no
 * tener que mantener un campo más en el índice y para que un run nuevo aparezca
 * en su fila sin tocar esto.
 */
const FAMILIES = [
    { id: 'nano', label: 'nano' },
    { id: 'small', label: 'small' },
    { id: 'otros', label: 'otros' },
] as const;

function familyOf(run: string): string {
    if (/nano/i.test(run)) return 'nano';
    if (/small|(^|[-_])s(\d|[-_])/i.test(run)) return 'small';
    return 'otros';
}

/** `0,9732` → `97,3 %`; un `0,00` se lee muchísimo antes que un `0.0041`. */
const pct = (value: number | null | undefined) =>
    typeof value === 'number' ? `${(value * 100).toFixed(1)} %` : '—';

/**
 * Verde por encima del 90 %, ámbar entre 60 y 90, rojo por debajo.
 *
 * El umbral alto no es capricho: en pose, una mAP50 por debajo del 60 % significa
 * que el modelo coloca los keypoints en otro sitio, no "un poco peor".
 */
function tone(value: number | null | undefined): string {
    if (typeof value !== 'number') return 'text-slate-500';
    if (value >= 0.9) return 'text-emerald-300';
    if (value >= 0.6) return 'text-amber-300';
    return 'text-rose-400';
}

function MetricRow({ label, set, kind }: { label: string; set: MetricSet; kind: string }) {
    return (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-white/5 py-1.5">
            <span className="text-[11px] text-slate-400">
                {label} <span className="text-slate-600">· {kind}</span>
            </span>
            <span className="flex gap-4 font-mono text-[11px]">
                <span className="text-slate-400">
                    P <span className="text-slate-200">{pct(set.precision)}</span>
                </span>
                <span className="text-slate-400">
                    R <span className="text-slate-200">{pct(set.recall)}</span>
                </span>
                <span className="text-slate-400">
                    mAP50 <span className={tone(set.map50)}>{pct(set.map50)}</span>
                </span>
                <span className="text-slate-400">
                    mAP50-95 <span className="text-slate-200">{pct(set.map50_95)}</span>
                </span>
            </span>
        </div>
    );
}

function ClassCard({ entry }: { entry: ClassInfo }) {
    const rotor = entry.name.toLowerCase().startsWith('rotor');
    return (
        <div
            className={`space-y-1 rounded-xl border p-3 ${rotor ? 'border-rose-400/20 bg-rose-400/[0.04]' : 'border-white/10 bg-white/[0.03]'
                }`}
        >
            <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-semibold text-slate-100">{entry.name}</h3>
                <span className="text-[10px] text-slate-500">clase {entry.id}</span>
            </div>
            <MetricRow label="Pose · keypoints" set={entry.pose} kind="11 puntos" />
            <MetricRow label="Caja" set={entry.box} kind="detección" />
        </div>
    );
}

/** Evolución de mAP50 por época: dos líneas, caja y pose. */
function Evolution({ summary }: { summary: Summary }) {
    const points = useMemo(
        () => summary.series.filter((point) => point.pose_map50 !== null || point.box_map50 !== null),
        [summary.series]
    );

    if (points.length < 2) {
        return (
            <p className="text-[11px] text-slate-500">
                Sin `results.csv` para este modelo: no hay serie que dibujar.
            </p>
        );
    }

    const width = 720;
    const height = 220;
    const padLeft = 38;
    const padBottom = 22;
    const maxEpoch = points[points.length - 1].epoch;
    const x = (epoch: number) => padLeft + ((epoch - 1) / Math.max(1, maxEpoch - 1)) * (width - padLeft - 8);
    const y = (value: number) => 8 + (1 - value) * (height - padBottom - 8);

    const line = (key: 'box_map50' | 'pose_map50') =>
        points
            .filter((point) => point[key] !== null)
            .map((point) => `${x(point.epoch).toFixed(1)},${y(point[key] as number).toFixed(1)}`)
            .join(' ');

    return (
        <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full select-none" role="img"
            aria-label="mAP50 por época, caja y pose">
            {[0, 0.25, 0.5, 0.75, 1].map((value) => (
                <g key={value}>
                    <line x1={padLeft} x2={width - 8} y1={y(value)} y2={y(value)}
                        stroke="rgba(148,163,184,0.12)" strokeWidth={1} />
                    <text x={padLeft - 4} y={y(value) + 3} textAnchor="end" fontSize={8} fill="#94a3b8">
                        {Math.round(value * 100)}
                    </text>
                </g>
            ))}
            {[1, Math.round(maxEpoch / 2), maxEpoch].map((epoch) => (
                <text key={epoch} x={x(epoch)} y={height - 8} textAnchor="middle" fontSize={8} fill="#94a3b8">
                    {epoch}
                </text>
            ))}
            <polyline points={line('box_map50')} fill="none" stroke="#38bdf8" strokeWidth={1.6} strokeOpacity={0.75} />
            <polyline points={line('pose_map50')} fill="none" stroke="#34d399" strokeWidth={1.6} strokeOpacity={0.9} />
            {summary.bestEpoch ? (
                <g>
                    <line x1={x(summary.bestEpoch.epoch)} x2={x(summary.bestEpoch.epoch)} y1={8}
                        y2={height - padBottom} stroke="rgba(251,191,36,0.5)" strokeDasharray="3 3" />
                    <text x={x(summary.bestEpoch.epoch) + 3} y={14} fontSize={8} fill="#fbbf24">
                        mejor época {summary.bestEpoch.epoch}
                    </text>
                </g>
            ) : null}
            <text x={padLeft} y={height - 8} fontSize={8} fill="#94a3b8">época</text>
        </svg>
    );
}

export function ModelInfoPage() {
    const [index, setIndex] = useState<IndexEntry[] | null>(null);
    const [run, setRun] = useState<string | null>(null);
    const [summary, setSummary] = useState<Summary | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch(INDEX_URL)
            .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
            .then((payload: { models?: IndexEntry[] }) => {
                const models = payload.models ?? [];
                setIndex(models);
                if (models.length > 0) setRun(models[models.length - 1].run);
            })
            .catch(() => setError('No pude leer /model-info/index.json'));
    }, []);

    useEffect(() => {
        if (!run) return;
        let cancelled = false;
        setSummary(null);
        fetch(summaryUrl(run))
            .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
            .then((payload: Summary) => {
                if (!cancelled) setSummary(payload);
            })
            .catch(() => setError(`No pude leer el resumen de ${run}`));
        return () => {
            cancelled = true;
        };
    }, [run]);

    const current = index?.find((entry) => entry.run === run) ?? null;

    return (
        <div className="min-h-dvh bg-slate-950 px-4 py-6 pb-16 text-slate-100">
            <div className="mx-auto max-w-5xl space-y-6">
                <header className="space-y-1">
                    <h1 className="text-2xl font-semibold">Información de modelos</h1>
                    <p className="text-[11px] text-slate-400">
                        Métricas por clase, validadas sobre el split{' '}
                        <code className="text-slate-300">{summary?.split ?? 'val'}</code> del dataset completo
                        (3.087 imágenes). Generado por <code className="text-slate-300">scripts/model-info.py</code>.
                    </p>
                </header>

                {error ? (
                    <p className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[11px] text-rose-200">
                        {error}
                    </p>
                ) : null}

                <section className="space-y-2">
                    <h2 className="text-sm font-semibold text-slate-300">Modelo</h2>
                    {/*
                        Una fila por familia: los nano son los que se entrenan aquí
                        (con su curva de épocas); los small solo existen como `.onnx`
                        desplegado, así que se validan tal cual y no tienen serie.
                    */}
                    {FAMILIES.map((family) => {
                        const entries = (index ?? []).filter((entry) => familyOf(entry.run) === family.id);
                        if (entries.length === 0) return null;
                        return (
                            <div key={family.id} className="space-y-1">
                                <h3 className="text-[10px] uppercase tracking-wide text-slate-500">{family.label}</h3>
                                <div className="flex flex-wrap gap-2">
                                    {entries.map((entry) => (
                                        <button
                                            key={entry.run}
                                            type="button"
                                            onClick={() => setRun(entry.run)}
                                            className={`rounded-lg border px-3 py-1.5 text-left text-[11px] transition ${entry.run === run
                                                    ? 'border-sky-400/60 bg-sky-400/10 text-slate-100'
                                                    : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.07]'
                                                }`}
                                        >
                                            <span className="block font-medium">{entry.run}</span>
                                            <span className="block text-[10px] text-slate-500">
                                                {entry.imgsz} px ·{' '}
                                                {entry.epochs > 0 ? `${entry.epochs} épocas` : 'sin log'} · rotor{' '}
                                                <span className={tone(entry.rotorPoseMap50)}>{pct(entry.rotorPoseMap50)}</span>
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                    {index === null && !error ? <span className="text-[11px] text-slate-500">cargando…</span> : null}
                </section>

                {summary && current ? (
                    <>
                        <section className="space-y-2">
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <h2 className="text-sm font-semibold text-slate-300">Métricas por clase</h2>
                                <span className="text-[11px] text-slate-500">
                                    {summary.epochsDone} épocas · entrada {summary.imgsz} px
                                    {summary.training.weightsAt ? ` · pesos ${String(summary.training.weightsAt).slice(0, 16).replace('T', ' ')}` : ''}
                                </span>
                            </div>
                            <div className="grid gap-2 sm:grid-cols-2">
                                {summary.classes.map((entry) => (
                                    <ClassCard key={entry.id} entry={entry} />
                                ))}
                            </div>
                            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                                <h3 className="mb-1 text-[11px] font-semibold text-slate-300">Global (media de las dos clases)</h3>
                                <MetricRow label="Pose · keypoints" set={summary.overall.pose} kind="11 puntos" />
                                <MetricRow label="Caja" set={summary.overall.box} kind="detección" />
                            </div>
                        </section>

                        <section className="space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <h2 className="text-sm font-semibold text-slate-300">Evolución por época</h2>
                                <span className="flex items-center gap-3 text-[10px] text-slate-400">
                                    <span className="inline-flex items-center gap-1">
                                        <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> pose mAP50
                                    </span>
                                    <span className="inline-flex items-center gap-1">
                                        <span className="inline-block h-2 w-2 rounded-full bg-sky-400" /> caja mAP50
                                    </span>
                                    {summary.csv ? (
                                        <a
                                            href={csvUrl(summary.run)}
                                            download
                                            className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-slate-300 hover:bg-white/10"
                                        >
                                            Descargar results.csv
                                        </a>
                                    ) : (
                                        <span className="text-slate-600">sin results.csv (solo .onnx)</span>
                                    )}
                                </span>
                            </div>
                            <Evolution summary={summary} />
                        </section>

                        <section className="space-y-1 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                            <h2 className="text-sm font-semibold text-slate-300">Cómo se entrenó</h2>
                            <dl className="grid gap-x-6 gap-y-1 text-[11px] sm:grid-cols-2">
                                {[
                                    ['pesos de partida', summary.training.model],
                                    ['imgsz', summary.training.imgsz],
                                    ['épocas', summary.training.epochs],
                                    ['batch', summary.training.batch],
                                    ['optimizador', summary.training.optimizer],
                                    ['lr0', summary.training.lr0],
                                    ['patience', summary.training.patience],
                                    ['workers', summary.training.workers],
                                ].map(([label, value]) => (
                                    <div key={String(label)} className="flex justify-between border-b border-white/5 py-1">
                                        <dt className="text-slate-500">{String(label)}</dt>
                                        <dd className="font-mono text-slate-200">
                                            {value === undefined || value === null ? '—' : String(value).split(/[\\/]/).pop()}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        </section>
                    </>
                ) : (
                    <p className="text-[11px] text-slate-500">{run ? 'cargando resumen…' : ''}</p>
                )}
            </div>
        </div>
    );
}
