/**
 * Compares the inference cost of two ONNX models in the same environment.
 *
 * The absolute numbers are not the phone's — it is Node on a laptop — but the
 * *ratio* between two files of the same model is what matters when deciding
 * whether an int8 export is worth it. Accuracy belongs to `npm run verify:photo`.
 *
 * Usage: npm run bench:model -- public/models/yolo-pose-s-640.onnx public/models/yolo-pose-s-640-int8.onnx
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-web';

ort.env.logLevel = 'error';
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;
ort.env.wasm.wasmPaths = pathToFileURL(
    join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist') + '/'
).href;

const RUNS = 5;

async function measure(path: string): Promise<{ ms: number; size: number }> {
    const bytes = readFileSync(path);
    const session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
    });

    const holder = session as unknown as {
        inputMetadata?: Array<{ name: string; shape?: readonly (number | string)[] }>;
    };
    const meta = holder.inputMetadata?.[0];
    const dims = (meta?.shape ?? [1, 3, 640, 640]).map((dim) =>
        typeof dim === 'number' ? dim : Number(dim)
    );
    const size = dims.every((dim) => dim > 0) ? dims.reduce((a, b) => a * b, 1) : 3 * 640 * 640;
    const name = meta?.name ?? session.inputNames[0];

    const times: number[] = [];
    for (let run = 0; run <= RUNS; run += 1) {
        const input = new ort.Tensor('float32', new Float32Array(size).fill(0.4), dims as number[]);
        const started = performance.now();
        await session.run({ [name]: input });
        if (run > 0) times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);

    const releasable = session as unknown as { release?: () => Promise<void> };
    await releasable.release?.().catch(() => undefined);

    return { ms: times[Math.floor(times.length / 2)], size: bytes.byteLength };
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
    console.error('Uso: npm run bench:model -- modelo.onnx [otro.onnx]');
    process.exit(1);
}

const results: Array<{ path: string; ms: number; size: number }> = [];
for (const path of paths) {
    const result = await measure(path);
    results.push({ path, ...result });
    console.log(`${path.padEnd(38)} ${result.ms.toFixed(0).padStart(6)} ms   ${(result.size / 1e6).toFixed(1)} MB`);
}

if (results.length === 2) {
    const [first, second] = results;
    const speedup = first.ms / second.ms;
    console.log(`\n${second.path} es ${speedup.toFixed(2)}× ${speedup >= 1 ? 'más rápido' : 'más lento'}`);
}
