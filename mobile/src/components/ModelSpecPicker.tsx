/**
 * Pick a model by what it *is*, not by file name.
 *
 * Both the app's loader and the bench page offer the same three knobs
 * (architecture, input size, quantisation) over the same set of files, and both
 * must be honest about which combinations exist. This component only draws the
 * rows: the caller decides what a choice means (fetch a URL, load a `File`).
 *
 * Disabled is a real answer here. A combination that was never exported cannot
 * be clicked.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { FAMILY_LABELS, describeSpec, type ModelSpec } from '../lib/modelNames';

export interface SpecChoice<T> {
    /** File name, e.g. `yolo-pose-s-480-int8.onnx`. */
    file: string;
    spec: ModelSpec;
    /** Extra text for the summary line: size, run count… */
    detail?: string;
    /** Handed back to `onPick` when this combination is selected. */
    value: T;
}

export function ModelSpecPicker<T>({
    choices,
    currentFile,
    busy = false,
    onPick,
    hint,
}: {
    choices: Array<SpecChoice<T>>;
    currentFile: string | null;
    busy?: boolean;
    onPick: (value: T) => void;
    /** Replaces the default explanation under the rows. */
    hint?: string;
}) {
    /** Staged selection; `null` means "whatever is loaded right now". */
    const [staged, setStaged] = useState<ModelSpec | null>(null);

    if (choices.length === 0) {
        return (
            <p className="text-[11px] text-slate-500">
                Ningún fichero sigue el patrón{' '}
                <code>yolo-pose-&lt;familia&gt;[-coco]-&lt;px&gt;[-int8].onnx</code>, así que no hay nada
                que desglosar.
            </p>
        );
    }

    const selected =
        staged ?? choices.find((choice) => choice.file === currentFile)?.spec ?? choices[0].spec;

    const sizes = [...new Set(choices.map((choice) => choice.spec.size))].sort((left, right) => right - left);
    const families = [...new Set(['n', ...choices.map((choice) => choice.spec.family)])].sort();

    /**
     * The closest combination that actually exists.
     *
     * Requiring the exact combination made a whole row look dead: with
     * `small · 640 · int8` selected, 400 px and 360 px were disabled because
     * there is no int8 small at those sizes — even though the nano does exist
     * there. The size is the thing the user is reasoning about, so pressing it
     * now moves the other axes as little as possible: same family first, then
     * same quantisation. The summary line names what will actually load.
     */
    const closestFor = (patch: Partial<ModelSpec>): SpecChoice<T> | null => {
        const candidates = choices.filter((choice) =>
            (Object.keys(patch) as Array<keyof ModelSpec>).every(
                (key) => choice.spec[key] === patch[key]
            )
        );
        if (candidates.length === 0) return null;
        const score = (choice: SpecChoice<T>) =>
            (patch.family === undefined && choice.spec.family === selected.family ? 2 : 0) +
            (patch.size === undefined && choice.spec.size === selected.size ? 1 : 0) +
            (patch.quant === undefined && choice.spec.quant === selected.quant ? 1 : 0);
        return [...candidates].sort((left, right) => score(right) - score(left))[0];
    };

    const choose = (patch: Partial<ModelSpec>) => {
        const choice = closestFor(patch);
        if (!choice) return;
        setStaged(choice.spec);
        if (choice.file !== currentFile && !busy) onPick(choice.value);
    };

    /** What the summary line names: the file behind the current selection. */
    const target = closestFor(selected);

    return (
        <div className="space-y-1.5 rounded-xl border border-white/10 bg-slate-900/40 p-2.5">
            <Row label="Arquitectura">
                {families.map((family) => {
                    const enabled = closestFor({ family }) !== null;
                    return (
                        <Chip
                            key={family}
                            active={selected.family === family}
                            disabled={!enabled || busy}
                            title={
                                enabled
                                    ? `Familia ${FAMILY_LABELS[family] ?? family}`
                                    : `Sin .onnx de la familia ${FAMILY_LABELS[family] ?? family}: ${family === 'n' ? 'todavía no está entrenada' : 'no está desplegada'
                                    }`
                            }
                            onClick={() => choose({ family })}
                        >
                            {FAMILY_LABELS[family] ?? family}
                        </Chip>
                    );
                })}
            </Row>
            <Row label="Píxeles">
                {sizes.map((size) => {
                    const enabled = closestFor({ size }) !== null;
                    return (
                        <Chip
                            key={size}
                            active={selected.size === size}
                            disabled={!enabled || busy}
                            title={enabled ? `Entrada ${size}×${size}` : `No hay ${size} px con esa familia y cuantización`}
                            onClick={() => choose({ size })}
                        >
                            {size}
                        </Chip>
                    );
                })}
            </Row>
            <Row label="Cuantización">
                {(['fp32', 'int8'] as const).map((quant) => {
                    const enabled = closestFor({ quant }) !== null;
                    return (
                        <Chip
                            key={quant}
                            active={selected.quant === quant}
                            disabled={!enabled || busy}
                            title={
                                quant === 'fp32'
                                    ? 'fp32: pesos completos, algo más preciso y el triple de tamaño'
                                    : 'int8: cuantizado, ~4× menos memoria y más rápido en WASM'
                            }
                            onClick={() => choose({ quant })}
                        >
                            {quant}
                        </Chip>
                    );
                })}
            </Row>
            <p className="text-[10px] text-slate-400">
                {target ? (
                    <>
                        <span className="hidden sm:inline">{describeSpec(target.spec)} · </span>
                        <span className="text-sky-300">{target.file}</span>
                        {target.detail ? <span className="text-slate-500"> · {target.detail}</span> : null}
                    </>
                ) : (
                    'Esa combinación no está desplegada: elige otra o exporta el .onnx.'
                )}
            </p>
            <p className="text-[10px] text-slate-500">
                {hint ??
                    'Cada combinación es un modelo distinto: cambiar de píxeles o de cuantización abre otra clasificación.'}
            </p>
        </div>
    );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-24 shrink-0 text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
            {children}
        </div>
    );
}

function Chip({
    active,
    disabled,
    title,
    onClick,
    children,
}: {
    active: boolean;
    disabled: boolean;
    title: string;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            title={title}
            onClick={onClick}
            aria-pressed={active}
            className={`rounded-md border px-2 py-0.5 text-[11px] ${active
                    ? 'border-sky-400 bg-sky-500/20 text-sky-100'
                    : disabled
                        ? 'border-white/5 bg-white/[0.02] text-slate-600'
                        : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                } disabled:cursor-not-allowed`}
        >
            {children}
        </button>
    );
}
