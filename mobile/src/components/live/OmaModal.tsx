/**
 * Modal de la malla FEM de las palas.
 *
 * Antes este panel era el análisis modal (OMA): espectro del residuo de los
 * keypoints y mapas de color sintéticos por modo. Eso ya no está: aquí solo queda
 * el campo FEM de las palas —el mismo que se calibra en `/rotor-fem/`— y la
 * evolución de ω y su derivada, que es lo que alimenta el mapa de color.
 *
 * El gráfico se dibuja en un canvas cada 150 ms desde la traza que escribe
 * `BladeFem`; no hay re-render por muestra.
 */
import { useEffect, useRef, useState } from 'react';
import { Activity, X } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { Button, SliderRow } from '../ui/primitives';
import { bladeTrace } from '../../lib/fem/bladeTrace';
import type { BladeSample } from '../../lib/fem/bladeTrace';

/** Un minuto de traza a 5 Hz. */
const WINDOW = 300;

export function OmaModal() {
    const open = useAppStore((state) => state.omaOpen);
    const bladeEnabled = useAppStore((state) => state.bladeFemEnabled);
    const bladeDeform = useAppStore((state) => state.bladeFemDeform);
    const bladeNonDimensional = useAppStore((state) => state.bladeFemNonDimensional);
    const bladeField = useAppStore((state) => state.bladeFemField);
    const bladeGain = useAppStore((state) => state.bladeFemGain);
    const bladeInertia = useAppStore((state) => state.bladeFemInertia);
    const bladeOpacity = useAppStore((state) => state.bladeFemOpacity);
    const bladeStatus = useAppStore((state) => state.bladeFemStatus);
    const [trace, setTrace] = useState<BladeSample[]>([]);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const close = () => useAppStore.setState({ omaOpen: false });

    // Muestreo de la traza mientras el modal está abierto.
    useEffect(() => {
        if (!open) return;
        const timer = setInterval(() => setTrace([...bladeTrace.samples()]), 150);
        return () => clearInterval(timer);
    }, [open]);

    // Dibujo de ω (azul) y α (ámbar), cada una con su propia escala.
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

        // Rejilla con el cero en el centro: las dos series son simétricas.
        context.strokeStyle = 'rgba(148, 163, 184, 0.18)';
        context.lineWidth = 1;
        for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
            const y = fraction * height;
            context.beginPath();
            context.moveTo(0, y);
            context.lineTo(width, y);
            context.stroke();
        }

        const samples = trace.slice(-WINDOW);
        if (samples.length < 2) return;

        const peak = (pick: (sample: BladeSample) => number) => ({
            value: Math.max(...samples.map((sample) => Math.abs(pick(sample))), 1e-6),
            pick,
        });

        const draw = (
            series: { value: number; pick: (sample: BladeSample) => number },
            colour: string,
            lineWidth: number
        ) => {
            context.beginPath();
            context.strokeStyle = colour;
            context.lineWidth = lineWidth;
            samples.forEach((sample, index) => {
                const x = (index / (samples.length - 1)) * width;
                const y = height / 2 - (series.pick(sample) / series.value) * (height / 2 - 4);
                if (index === 0) context.moveTo(x, y);
                else context.lineTo(x, y);
            });
            context.stroke();
        };

        draw(peak((sample) => sample.omega), '#38bdf8', 1.6);
        draw(peak((sample) => sample.alpha), 'rgba(251, 191, 36, 0.9)', 1.2);
    }, [trace, open]);

    if (!open) return null;

    const last = trace.length > 0 ? trace[trace.length - 1] : null;

    return (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 p-3 sm:items-center">
            <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-slate-950/95 p-4 shadow-2xl">
                <div className="mb-2 flex items-center justify-between">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                        <Activity className="h-4 w-4 text-sky-400" /> Malla FEM de las palas
                    </h2>
                    <button
                        type="button"
                        aria-label="Cerrar"
                        onClick={close}
                        className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white/10"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
                    Los cinco casos del solver sumados con los pesos que salen del ángulo del rotor.
                    El color se escala al máximo del campo de cada instante, así que la forma se ve
                    aunque la carga sea pequeña.
                </p>

                <canvas ref={canvasRef} className="h-28 w-full rounded-lg bg-slate-900/60" />
                <div className="mt-1 flex flex-wrap items-center justify-between gap-1 text-[10px] text-slate-500">
                    <span className="flex items-center gap-1.5">
                        <span className="inline-block h-0.5 w-4 rounded bg-sky-400" /> ω
                        <span className="w-14 font-mono text-slate-300">
                            {last ? last.omega.toFixed(2) : '—'}
                        </span>
                        <span className="ml-2 inline-block h-0.5 w-4 rounded bg-amber-400" /> α
                        <span className="w-14 font-mono text-slate-300">
                            {last ? last.alpha.toFixed(2) : '—'}
                        </span>
                    </span>
                    <span>{trace.length} muestras</span>
                </div>

                {!bladeEnabled ? (
                    <p className="mt-2 rounded-lg bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
                        La malla está apagada: activa el interruptor de abajo para pintarla.
                    </p>
                ) : null}

                <label className="mt-3 flex items-center justify-between gap-2 border-t border-white/10 pt-3 text-[11px] text-slate-300">
                    <span className="font-semibold">Pintar la malla sobre el gemelo</span>
                    <input
                        type="checkbox"
                        checked={bladeEnabled}
                        onChange={(event) =>
                            useAppStore.setState({ bladeFemEnabled: event.target.checked })
                        }
                    />
                </label>

                {bladeEnabled ? (
                    <div className="mt-2 space-y-2">
                        <div className="flex flex-wrap gap-1.5">
                            {(
                                [
                                    ['signed', 'con signo ±'],
                                    ['magnitude', 'módulo |u|'],
                                ] as const
                            ).map(([id, label]) => (
                                <button
                                    key={id}
                                    type="button"
                                    onClick={() => useAppStore.setState({ bladeFemField: id })}
                                    className={`rounded-full px-2 py-0.5 text-[10px] transition ${bladeField === id
                                            ? 'bg-sky-500/20 text-sky-300'
                                            : 'bg-white/5 text-slate-400 hover:bg-white/10'
                                        }`}
                                >
                                    {label}
                                </button>
                            ))}
                            <button
                                type="button"
                                onClick={() => useAppStore.setState({ bladeFemDeform: !bladeDeform })}
                                className={`rounded-full px-2 py-0.5 text-[10px] transition ${bladeDeform
                                        ? 'bg-sky-500/20 text-sky-300'
                                        : 'bg-white/5 text-slate-400 hover:bg-white/10'
                                    }`}
                            >
                                deformada
                            </button>
                            {bladeDeform ? (
                                <button
                                    type="button"
                                    onClick={() =>
                                        useAppStore.setState({
                                            bladeFemNonDimensional: !bladeNonDimensional,
                                            bladeFemGain: !bladeNonDimensional ? 5 : 1e6,
                                        })
                                    }
                                    className={`rounded-full px-2 py-0.5 text-[10px] transition ${bladeNonDimensional
                                            ? 'bg-sky-500/20 text-sky-300'
                                            : 'bg-white/5 text-slate-400 hover:bg-white/10'
                                        }`}
                                >
                                    no dimensional
                                </button>
                            ) : null}
                        </div>

                        <SliderRow
                            label="Inercia del filtro de ω"
                            value={bladeInertia}
                            min={0.1}
                            max={4}
                            step={0.1}
                            onChange={(value) => useAppStore.setState({ bladeFemInertia: value })}
                            format={(value) => `${value.toFixed(1)} s`}
                            hint="Cuánto se suaviza la ω que sale del trackeo de keypoints (y con ella α)."
                        />
                        {bladeDeform ? (
                            <SliderRow
                                label={
                                    bladeNonDimensional
                                        ? 'Deformación (% de la pala)'
                                        : 'Escala de la deformación'
                                }
                                value={bladeGain}
                                min={bladeNonDimensional ? 0.5 : 10000}
                                max={bladeNonDimensional ? 20 : 5000000}
                                step={bladeNonDimensional ? 0.5 : 10000}
                                onChange={(value) => useAppStore.setState({ bladeFemGain: value })}
                                format={(value) =>
                                    bladeNonDimensional
                                        ? `${value.toFixed(1)} %`
                                        : `×${value.toExponential(1)}`
                                }
                            />
                        ) : null}
                        <SliderRow
                            label="Opacidad del contorno"
                            value={bladeOpacity}
                            min={0.2}
                            max={1}
                            step={0.05}
                            onChange={(value) => useAppStore.setState({ bladeFemOpacity: value })}
                            format={(value) => `${Math.round(value * 100)} %`}
                            hint="Con menos opacidad se ve la geometría del gemelo debajo del mapa."
                        />

                        <p className="text-[10px] text-slate-500">
                            {bladeStatus
                                ? bladeStatus.error
                                    ? `error: ${bladeStatus.error}`
                                    : `${bladeStatus.painted} primitivas · campo ${(bladeStatus.min * 1e6).toFixed(1)} … ${(bladeStatus.max * 1e6).toFixed(1)} µm`
                                : 'cargando el horneado…'}
                        </p>
                    </div>
                ) : null}

                <div className="mt-3">
                    <Button variant="ghost" full onClick={close}>
                        Cerrar
                    </Button>
                </div>
            </div>
        </div>
    );
}
