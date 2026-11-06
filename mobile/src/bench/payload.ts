/**
 * The wire format of one benchmark run.
 *
 * Both the internal `/bench` page and the public `/benchmark-public/` wizard post
 * runs, and the server groups them by `(model, device)`. If the two pages built
 * the body separately they would drift — a missing `modelFingerprint` here, a
 * different field name there — and the plot would show two buckets for the same
 * model. So the body is built in exactly one place.
 */
import type { ModelInfo } from '../types';

export interface RunPayloadInput {
    device: { id: string; name: string; category: string; hardware: unknown };
    scenario: string;
    samples: unknown[];
    mean: Record<string, number | null>;
    /** Probed hardware, used when the profile has none (public flow). */
    hardware: unknown;
    runtime: { provider: string | null; note: string | null };
    model: ModelInfo | null;
    /** Free-form extras (e.g. the public profile's owner). */
    extra?: Record<string, unknown>;
}

export function buildRunPayload({
    device,
    scenario,
    samples,
    mean,
    hardware,
    runtime,
    model,
    extra,
}: RunPayloadInput): Record<string, unknown> {
    return {
        deviceId: device.id,
        deviceName: device.name,
        category: device.category,
        scenario,
        hardware: device.hardware ?? hardware,
        runtime: { ...runtime, isolated: window.crossOriginIsolated },
        /**
         * The model is half of the row.
         *
         * `modelFile` is what the user recognises, `modelFingerprint` is what
         * tells two exports of `best.onnx` apart. The server builds the id from
         * both.
         */
        modelFile: model?.name ?? null,
        modelFingerprint: model?.fingerprint ?? null,
        modelBytes: model?.bytes ?? null,
        modelInputSize: model?.inputSize ?? null,
        modelTask: model?.kind ?? null,
        modelKeypoints: model?.numKeypoints ?? null,
        samples,
        mean,
        ...extra,
    };
}

/** `fetch` for a run, with the failure turned into a readable string. */
export async function postRun(apiBase: string, payload: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${apiBase}/bench`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${detail.slice(0, 120)}`);
    }
}
